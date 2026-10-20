/* =====================================================================
   Persistent dashboard cache (IndexedDB).
   Stage 3 Step 3B: cache persistence reads/writes shared state directly.
   ===================================================================== */

import {
  ledgerCache,
  ledgerCacheSyncAt,
  deferredPeriods,
  deferredPeriodOverrides,
  rawCitizens,
  allCitizens,
  setPeriodStatsCache,
  setRawCitizens,
  setAllCitizens,
  invalidateStatsMemo
} from "./state.js";
import { firestoreTimeMs } from "./util.js";

const DASHBOARD_CACHE_DB = "nsnvc-dashboard-cache";
const DASHBOARD_CACHE_VERSION = 1;

export function createDashboardCache(){
  let dashboardCacheReady = null;

  function openDashboardCache(){
    if(dashboardCacheReady) return dashboardCacheReady;
    dashboardCacheReady = new Promise((resolve,reject)=>{
      if(!("indexedDB" in window)){ resolve(null); return; }
      const req=indexedDB.open(DASHBOARD_CACHE_DB,DASHBOARD_CACHE_VERSION);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains("citizens")) db.createObjectStore("citizens",{keyPath:"id"});
        if(!db.objectStoreNames.contains("ledgers")) db.createObjectStore("ledgers",{keyPath:"id"});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    }).catch(err=>{
      console.warn("Persistent dashboard cache unavailable:",err);
      dashboardCacheReady=null;
      return null;
    });
    return dashboardCacheReady;
  }

  async function readDashboardCache(){
    const db=await openDashboardCache();
    if(!db) return null;
    return new Promise(resolve=>{
      const tx=db.transaction(["citizens","ledgers"],"readonly");
      const citizensReq=tx.objectStore("citizens").getAll();
      const ledgersReq=tx.objectStore("ledgers").getAll();
      tx.oncomplete=()=>{
        // Treat IndexedDB as a fast starting point, not as authoritative data.
        // Do not discard useful snapshots just because the user has been away
        // for more than a week. The live Firestore subscription replaces citizen
        // summaries, and ledger sync timestamps let the store refresh changed data.
        resolve({citizens:citizensReq.result,ledgers:ledgersReq.result});
      };
      tx.onerror=()=>resolve(null);
    });
  }

  function writeDashboardCache(citizens, ledgers, options={}){
    const forceRefreshIds=new Set(options.forceRefreshIds||[]);
    openDashboardCache().then(db=>{
      if(!db) return;
      try{
        const tx=db.transaction(["citizens","ledgers"],"readwrite");
        const citizenStore=tx.objectStore("citizens");
        const ledgerStore=tx.objectStore("ledgers");
        const cachedAt=Date.now();
        for(const c of (citizens||[])){
          const copy={...c};
          delete copy.ledger;
          citizenStore.put({...copy,cachedAt});
        }
        for(const [id,entries] of Object.entries(ledgers||{})){
          ledgerStore.put({
            id,
            entries:entries||[],
            cachedAt,
            syncAt:forceRefreshIds.has(id) ? 0 : (firestoreTimeMs((citizens||[]).find(c=>c.id===id)?.updatedAt)||cachedAt)
          });
        }
      }catch(err){
        console.warn("Failed to write dashboard cache:",err);
      }
    }).catch(()=>{});
  }

  async function hydrateDashboardCache(){
    try{
      const cached=await readDashboardCache();
      if(!cached) return false;

      if(cached.citizens.length){
        const citizens=cached.citizens.map(({cachedAt,...c})=>c);
        setRawCitizens(citizens);
        setAllCitizens(citizens.slice());
      }

      if(cached.ledgers.length){
        for(const item of cached.ledgers){
          ledgerCache.set(item.id,item.entries||[]);
          ledgerCacheSyncAt.set(item.id,Number(item.syncAt||item.cachedAt||0));
        }
        setPeriodStatsCache(null);
        invalidateStatsMemo();
      }

      const needsLedger = Boolean(
        deferredPeriods.length ||
        Object.keys(deferredPeriodOverrides).length
      );
      if(rawCitizens.length && needsLedger && cached.ledgers.length){
        setAllCitizens(rawCitizens.map(c=>({...c,ledger:ledgerCache.get(c.id)||[]})));
      }

      return allCitizens.length > 0;
    }catch(err){
      console.warn("Failed to hydrate dashboard cache:",err);
    }
    return false;
  }

  return {openDashboardCache,readDashboardCache,writeDashboardCache,hydrateDashboardCache};
}
