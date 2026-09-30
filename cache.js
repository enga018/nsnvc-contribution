/* =====================================================================
   Persistent dashboard cache (IndexedDB).
   Stage 3 Step 2: cache persistence is isolated from the DOM.
   ===================================================================== */

const DASHBOARD_CACHE_DB = "nsnvc-dashboard-cache";
const DASHBOARD_CACHE_VERSION = 1;
const DASHBOARD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createDashboardCache(host){
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
        const now=Date.now();
        const citizens=citizensReq.result.filter(x=>now-(x.cachedAt||0)<=DASHBOARD_CACHE_MAX_AGE_MS);
        const ledgers=ledgersReq.result.filter(x=>now-(x.cachedAt||0)<=DASHBOARD_CACHE_MAX_AGE_MS);
        resolve({citizens,ledgers});
      };
      tx.onerror=()=>resolve(null);
    });
  }

  function writeDashboardCache(citizens, ledgers){
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
            syncAt:host.firestoreTimeMs((citizens||[]).find(c=>c.id===id)?.updatedAt)||cachedAt
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
        host.rawCitizens=cached.citizens.map(({cachedAt,...c})=>c);
        host.allCitizens=host.rawCitizens.slice();
      }

      if(cached.ledgers.length){
        for(const item of cached.ledgers){
          host.ledgerCache.set(item.id,item.entries||[]);
          host.ledgerCacheSyncAt.set(item.id,Number(item.syncAt||item.cachedAt||0));
        }
        host.periodStatsCache=null;
        host.invalidateStatsMemo();
      }

      const needsLedger = Boolean(
        host.deferredPeriods.length ||
        Object.keys(host.deferredPeriodOverrides).length
      );
      if(host.rawCitizens.length && needsLedger && cached.ledgers.length){
        host.allCitizens=host.rawCitizens.map(c=>({...c,ledger:host.ledgerCache.get(c.id)||[]}));
      }

      return host.allCitizens.length > 0;
    }catch(err){
      console.warn("Failed to hydrate dashboard cache:",err);
    }
    return false;
  }

  return {openDashboardCache,readDashboardCache,writeDashboardCache,hydrateDashboardCache};
}
