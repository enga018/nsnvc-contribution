/* =====================================================================
   NSNVC data stores (local + Firebase).
   =====================================================================
   Extracted from index.html in refactor stage 2b. Each factory is handed a
   `host` object with the app's mutable state exposed as getters (so
   reassignment is observed, not snapshotted) plus the helper functions it
   needs. Both expose the same store.* interface, so callers don't change.

   `fs` in makeFirebaseStore is the Firestore module (injected), not the
   Node filesystem.
   ===================================================================== */

export function makeLocalStore(host){
  const KEY="nsn_contrib_v1";
  let data=null;
  try{ const raw=localStorage.getItem(KEY); if(raw) data=JSON.parse(raw); }catch(e){}
  if(!data) data=seedData();

  // --- PERMANENT MIGRATION: add entryId and save ---
  let migrated = false;
  for(const [id, c] of Object.entries(data.citizens)){
    if(c.ledger){
      let needPersist = false;
      for(let i=0; i<c.ledger.length; i++){
        if(!c.ledger[i].entryId){
          c.ledger[i].entryId = String(Date.now() + Math.random() * 10000) + '-' + i;
          needPersist = true;
        }
      }
      if(needPersist) migrated = true;
    }
  }
  if(migrated) {
    try{ localStorage.setItem(KEY, JSON.stringify(data)); }catch(e){}
    console.log("Local migration complete: added entryId to all ledger entries.");
  }
  // --- end migration ---

  let clock = Date.now();
  const listeners=new Set();
  const authCbs=new Set();
  let loggedIn=false;
  const persist=()=>{ try{ localStorage.setItem(KEY, JSON.stringify(data)); }catch(e){} };
  const sortedList=()=>Object.entries(data.citizens)
    .map(([id,c])=>({ id, jobCard:c.jobCard, cardNo:c.cardNo, name:c.name, phone:c.phone,
                      totalCharged:c.totalCharged, totalPaid:c.totalPaid, balance:c.balance, deferredTotal:c.deferredTotal||0 }))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const notify=()=>listeners.forEach(cb=>cb(sortedList()));
  function recalcTotals(c){
    const entries=c.ledger||[];
    let grossCharges=0, totalPaid=0, totalWaived=0;
    for(const e of entries){
      const amt=Number(e.amount)||0;
      if(e.type==="charge" || e.type==="sanitationFee") grossCharges+=amt;
      else if(e.type==="payment") totalPaid+=amt;
      else if(e.type==="forgive") totalWaived+=amt;
    }
    const allocation=host.allocateLedgerPayments(entries, c.id);
    c.totalCharged = Math.max(0, grossCharges - Math.min(grossCharges, totalWaived));
    c.totalPaid = totalPaid;
    c.deferredTotal = allocation.deferredRemaining;
    c.balance = allocation.owed.reduce((sum,o)=>sum+o.remaining,0) - allocation.unappliedPayment;
    return c;
  }
  return {
    isLocal:true,
    async getLedger(id){ const c=data.citizens[id]; if(!c) return [];
      return [...(c.ledger||[])].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)); },
    subscribe(cb){ listeners.add(cb); cb(sortedList()); return ()=>listeners.delete(cb); },
    async listOwing(){
      const list=[]; 
      for(const [id,c] of Object.entries(data.citizens)){
        const effBal = host.getEffectiveBalance(c);
        if(effBal > 0) list.push({ id, jobCard:c.jobCard, cardNo:c.cardNo, name:c.name,
                          totalCharged:c.totalCharged, totalPaid:c.totalPaid, balance:effBal });
      }
      return list;
    },
    async exists(id){ return !!data.citizens[id]; },
    async addCitizen(id, d){ data.citizens[id]={...d, ledger:[], pendingPayments:[], createdAt:++clock, updatedAt:++clock}; persist(); notify(); },
    async addEntry(id, type, amount, note, date, deferred=false){
      const c=data.citizens[id]; if(!c) throw new Error("missing");
      const entryId = String(++clock);
      const entry = { entryId, type, amount, note, date, deferred: deferred || false, createdAt: clock };
      if(!c.ledger) c.ledger=[];
      c.ledger.push(entry);
      recalcTotals(c);
      c.updatedAt=++clock; persist(); notify(); host.invalidateLedgerCache(id);
    },
    async forgiveDebt(id, amount, note){
      const c=data.citizens[id]; if(!c) throw new Error("missing");
      const entryId = String(++clock);
      const entry = { entryId, type:"forgive", amount, note, date:host.todayISO(), deferred:false, createdAt:clock };
      c.ledger.push(entry);
      recalcTotals(c);
      c.updatedAt=++clock; persist(); notify(); host.invalidateLedgerCache(id);
    },
    async confirmPendingPayment(id, pendingId){
      const c=data.citizens[id]; if(!c) return;
      const idx = c.pendingPayments.findIndex(p=>p.id===pendingId);
      if(idx<0) return;
      const pp = c.pendingPayments[idx];
      if(pp.status!=="pending") return;
      const entryId = String(++clock);
      const entry = { entryId, type:"payment", amount:pp.amount, note:"UPI", date:pp.date, deferred:false, createdAt:clock };
      c.ledger.push(entry);
      recalcTotals(c);
      pp.status="confirmed";
      c.updatedAt=++clock; persist(); notify(); host.invalidateLedgerCache(id);
    },
    async deleteEntry(id, entryId){
      const c=data.citizens[id]; if(!c) return;
      const idx = c.ledger.findIndex(e => e.entryId === entryId);
      if(idx<0) return;
      c.ledger.splice(idx,1);
      recalcTotals(c);
      c.updatedAt=++clock; persist(); notify(); host.invalidateLedgerCache(id);
    },
    async editEntry(id, entryId, updates){
      const c=data.citizens[id]; if(!c) return;
      const idx = c.ledger.findIndex(e => e.entryId === entryId);
      if(idx<0) return;
      const e = c.ledger[idx];
      if(updates.amount!==undefined) e.amount=updates.amount;
      if(updates.note!==undefined) e.note=updates.note;
      if(updates.date!==undefined) e.date=updates.date;
      recalcTotals(c);
      c.updatedAt=++clock; persist(); notify(); host.invalidateLedgerCache(id);
    },
    async getPendingPayments(){
      const all=[];
      for(const [id,c] of Object.entries(data.citizens)){
        for(const p of (c.pendingPayments||[])){
          if(p.status==="pending") all.push({ citizenId:id, ...p, name:c.name, jobCard:c.jobCard });
        }
      }
      return all;
    },
    async deleteCitizen(id){ delete data.citizens[id]; persist(); notify(); host.invalidateLedgerCache(id); },
    async bulkAppendCharges(items, onProgress){
      let n=0;
      for(const it of items){
        let c=data.citizens[it.id];
        if(!c){ c={ jobCard:it.jobCard, cardNo:it.cardNo, name:it.name, phone:"",
                    totalCharged:0, totalPaid:0, balance:0, deferredTotal:0, createdAt:++clock, updatedAt:++clock, ledger:[], pendingPayments:[] };
                data.citizens[it.id]=c; }
        const isDeferred = it.deferred || false;
        const entryId = String(++clock);
        c.ledger.push({ entryId, type:"charge", amount:it.amount, note:it.note, date:"", deferred:isDeferred, createdAt:clock });
        recalcTotals(c);
        c.updatedAt=++clock;
        if((++n % 50)===0 && onProgress) onProgress(n, items.length);
      }
      persist(); notify(); host.invalidateLedgerCache(); if(onProgress) onProgress(items.length, items.length);
      return items.length;
    },
    async bulkAppendPayments(items, onProgress){
      let n=0;
      for(const it of items){
        const c=data.citizens[it.id]; if(!c) continue;
        const entryId = String(++clock);
        c.ledger.push({ entryId, type:"payment", amount:it.amount, note:it.note, date:it.date||"", deferred:false, createdAt:clock });
        recalcTotals(c);
        c.updatedAt=++clock;
        if((++n % 50)===0 && onProgress) onProgress(n, items.length);
      }
      persist(); notify(); host.invalidateLedgerCache(); if(onProgress) onProgress(items.length, items.length);
      return items.length;
    },
    async signIn(email, pass){
      if(pass !== "dev-mode-only") throw new Error("Invalid credentials for test mode. Use password: dev-mode-only");
      loggedIn=true;
      authCbs.forEach(cb=>cb(true));
      console.warn("⚠️ Test mode login - for development only. This app should run against Firebase in production.");
    },
    signOut(){ loggedIn=false; authCbs.forEach(cb=>cb(false)); },
    onAuth(cb){ authCbs.add(cb); cb(loggedIn); },
    async exportOwingCsv(){
      const owing = await this.listOwing();
      let csv = "Name,Job Card,Outstanding (₹),Payment History\n";
      for(const c of owing){
        const entries = host.ledgerCache.get(c.id) || ((data.citizens[c.id] && data.citizens[c.id].ledger) || []);
        const payments = entries.filter(e=>e.type==="payment").map(e=>`${host.entryLabel(e)} ${host.fmt(e.amount)}`).join("; ");
        csv += `"${host.esc(c.name)}","${host.esc(c.jobCard)}",${c.balance},"${host.esc(payments)}"\n`;
      }
      return csv;
    },
    async exportAll(){
      const citizens=Object.entries(data.citizens).map(([id,c])=>({id,jobCard:c.jobCard,cardNo:c.cardNo,name:c.name,phone:c.phone||"",totalCharged:c.totalCharged||0,totalPaid:c.totalPaid||0,balance:c.balance||0,deferredTotal:c.deferredTotal||0,pendingPayments:Array.isArray(c.pendingPayments)?c.pendingPayments.map(p=>({...p})):[],ledger:(c.ledger||[]).map(e=>({entryId:e.entryId,type:e.type,amount:e.amount,note:e.note,date:e.date||"",deferred:e.deferred||false,createdAtMs:typeof e.createdAt==="number"?e.createdAt:null}))}));
      return {app:"nsnvc-contribution",version:2,exportedAt:new Date().toISOString(),count:citizens.length,meta:{deferredPeriods:(data.meta&&data.meta.deferredPeriods)?JSON.parse(JSON.stringify(data.meta.deferredPeriods)):{periods:[],updatedAt:{}},deferredPeriodOverrides:(data.meta&&data.meta.deferredPeriodOverrides)?JSON.parse(JSON.stringify(data.meta.deferredPeriodOverrides)):{},imports:(data.meta&&data.meta.periods)?data.meta.periods.slice():[]},citizens};
    },
    async deleteAll(onProgress){data.citizens={};data.meta={periods:[],deferredUploads:[]};persist();notify();host.invalidateLedgerCache();if(onProgress)onProgress(1,1);},
    async renamePeriod(oldPeriod, newPeriod, onProgress){
      let count=0;
      for(const [id,c] of Object.entries(data.citizens)){
        if(c.ledger){
          for(const e of c.ledger){
            if(e.type==="charge" && e.note===oldPeriod){
              e.note=newPeriod;
              count++;
            }
          }
        }
      }
      persist(); notify();
      if(onProgress) onProgress(count, count);
      return count;
    },
    async getDeferredPeriods(){
      // Return the raw stored shape; onAuth normalizes it and writes the
      // normalized version back when it detects a legacy shape.
      return (data.meta && data.meta.deferredPeriods) || {periods:[],updatedAt:{}};
    },
    async setDeferredPeriods(periods){
      if(!data.meta) data.meta={};
      const next=Array.isArray(periods) ? periods.slice() : [];
      // Use the in-memory clock so a rename can carry a period's old timestamp
      // over, and preserve a timestampless period as 0 instead of stamping
      // "now" (see the Firebase store for why).
      const updatedAt={...deferredPeriodUpdatedAt};
      for(const p of next){
        if(!Object.prototype.hasOwnProperty.call(updatedAt,p)) updatedAt[p]=0;
      }
      for(const p of Object.keys(updatedAt)){
        if(!next.includes(p)) delete updatedAt[p];
      }
      data.meta.deferredPeriods={periods:next,updatedAt};
      host.deferredPeriodUpdatedAt={...updatedAt};
      persist();
    },
    async getDeferredPeriodOverrides(){
      // Raw stored shape; onAuth normalizes and writes back if legacy.
      return (data.meta && data.meta.deferredPeriodOverrides) || {};
    },
    async deleteMeta(name){
      if(data.meta) delete data.meta[name];
      persist();
    },
    async setDeferredPeriodOverrides(overrides){
      if(!data.meta) data.meta={};
      data.meta.deferredPeriodOverrides=overrides || {};
      persist();
    },
    async setCitizenChargeDeferred(citizenId, entryId, deferred){
      if(!data.meta) data.meta={};
      if(!data.meta.deferredPeriodOverrides) data.meta.deferredPeriodOverrides={};
      if(!data.meta.deferredPeriodOverrides[citizenId]) data.meta.deferredPeriodOverrides[citizenId]={};
      const key=String(entryId);
      const previous=data.meta.deferredPeriodOverrides[citizenId][key];
      const previousAt=previous && typeof previous==="object" ? previous.at : 0;
      data.meta.deferredPeriodOverrides[citizenId][key]={
        value:Boolean(deferred),
        at:host.nextDeferTimestamp(previousAt)
      };
      persist();
    },
    async importAll(backup,onProgress){
      if(!backup||!Array.isArray(backup.citizens))throw new Error("Not a valid backup file");const validTypes=["charge","payment","forgive","sanitationFee"];let done=0;data.citizens={};const meta=backup.meta&&typeof backup.meta==="object"?backup.meta:{};
      data.meta={...(data.meta||{}),deferredPeriods:meta.deferredPeriods&&typeof meta.deferredPeriods==="object"?JSON.parse(JSON.stringify(meta.deferredPeriods)):{periods:[],updatedAt:{}},deferredPeriodOverrides:meta.deferredPeriodOverrides&&typeof meta.deferredPeriodOverrides==="object"?JSON.parse(JSON.stringify(meta.deferredPeriodOverrides)):{},periods:Array.isArray(meta.imports)?meta.imports.slice():[]};
      for(const r of backup.citizens){const ledger=(r.ledger||[]).filter(e=>e&&validTypes.includes(e.type)&&e.amount).map(e=>{const amt=Number(e.amount);if(!Number.isFinite(amt)||amt<=0)return null;return {entryId:e.entryId||String(++clock),type:e.type,amount:amt,note:e.note||"",date:e.date||"",deferred:e.deferred||false,createdAt:e.createdAtMs||++clock};}).filter(Boolean);data.citizens[r.id]={jobCard:r.jobCard,cardNo:r.cardNo,name:r.name,phone:r.phone||"",totalCharged:r.totalCharged||0,totalPaid:r.totalPaid||0,balance:r.balance||0,deferredTotal:r.deferredTotal||0,createdAt:++clock,updatedAt:++clock,pendingPayments:Array.isArray(r.pendingPayments)?r.pendingPayments.map(p=>({...p})):[],ledger};recalcTotals(data.citizens[r.id]);if((++done%50)===0&&onProgress)onProgress(done,backup.citizens.length);}
      host.deferredPeriodUpdatedAt=normalizeDeferredPeriodState(data.meta.deferredPeriods).updatedAt;host.deferredPeriodOverrides=normalizeDeferredPeriodOverrides(data.meta.deferredPeriodOverrides).overrides;persist();notify();host.invalidateLedgerCache();if(onProgress)onProgress(backup.citizens.length,backup.citizens.length);return backup.citizens.length;
    },
    async getImportedPeriods(){ return (data.meta && data.meta.periods) ? data.meta.periods.slice() : []; },
    async recordImportedPeriod(p){ if(!data.meta) data.meta={periods:[]}; if(!data.meta.periods) data.meta.periods=[];
      if(!data.meta.periods.includes(p)) data.meta.periods.push(p); persist(); },
    async recalcAll(onProgress){
      // Decide whether the existing ledger cache is current before doing any
      // network work. For a small number of changed ledgers, fetch only those.
      // If many ledgers are stale, one collection-group read is substantially
      // faster than opening one Firestore subcollection per citizen.
      const recalcStart=performance.now();
      const citizens=Array.isArray(host.rawCitizens)?rawCitizens:[];
      const staleDetectionStart=performance.now();
      const changed=citizens.filter(c=>{
        const entries=host.ledgerCache.get(c.id);
        const cachedAt=host.ledgerCacheSyncAt.get(c.id)||0;
        const serverAt=host.firestoreTimeMs(c.updatedAt);
        return !Array.isArray(entries) || serverAt>cachedAt;
      });
      const staleDetectionMs=performance.now()-staleDetectionStart;

      let ledgers={};
      let usedCache=false;
      const firestoreReadStart=performance.now();
      let firestoreReadMs=0;

      if(citizens.length && changed.length===0){
        usedCache=true;
        for(const c of citizens) ledgers[c.id]=host.ledgerCache.get(c.id);
      }else if(changed.length>0 && changed.length<=20 && typeof this.refreshChangedLedgers==="function"){
        if(onProgress) onProgress(0,citizens.length);
        await this.refreshChangedLedgers(changed);
        for(const c of citizens) ledgers[c.id]=host.ledgerCache.get(c.id)||[];
      }else{
        // Bulk path: collectionGroup("ledger") is a single indexed Firestore
        // query and avoids hundreds/thousands of individual ledger reads.
        ledgers=await this.getAllLedgers();
      }
      firestoreReadMs=performance.now()-firestoreReadStart;

      const citizenIds=Object.keys(ledgers);
      const currentById=new Map(citizens.map(c=>[c.id,c]));
      const calculationStart=performance.now();
      let batch=fs.writeBatch(db),ops=0,done=0,writeCount=0;

      const calculationStartForWrite=calculationStart;
      let calculationMs=0;
      const writeStart=performance.now();

      const flush=async()=>{
        if(ops===0)return;
        await batch.commit();
        batch=fs.writeBatch(db);
        ops=0;
      };

      for(const id of citizenIds){
        const next=host.recalcFromLedger(ledgers[id]||[],id);
        const current=currentById.get(id);
        const changedSummary=!current ||
          Number(current.totalCharged||0)!==Number(next.totalCharged||0) ||
          Number(current.totalPaid||0)!==Number(next.totalPaid||0) ||
          Number(current.balance||0)!==Number(next.balance||0) ||
          Number(current.deferredTotal||0)!==Number(next.deferredTotal||0);

        if(changedSummary){
          // Derived totals do not update updatedAt; that timestamp marks real
          // ledger changes and drives cache synchronization.
          batch.set(fs.doc(db,"citizens",id),{
            totalCharged:next.totalCharged,
            totalPaid:next.totalPaid,
            balance:next.balance,
            deferredTotal:next.deferredTotal
          },{merge:true});
          ops++;
          writeCount++;
          if(ops>=300)await flush();
        }

        if((++done%25)===0&&onProgress)onProgress(done,citizenIds.length);
      }

      calculationMs=performance.now()-calculationStartForWrite;
      await flush();
      const firestoreWriteMs=performance.now()-writeStart;
      host.periodStatsCache=null;
      host.invalidateStatsMemo();
      if(onProgress)onProgress(citizenIds.length,citizenIds.length);
      const totalMs=performance.now()-recalcStart;
      console.log("Recalculate timing breakdown:",{
        citizens:citizenIds.length,
        staleLedgers:changed.length,
        writes:writeCount,
        usedCache,
        bulkRead:!usedCache && changed.length>20,
        staleDetectionMs:Math.round(staleDetectionMs),
        firestoreReadMs:Math.round(firestoreReadMs),
        calculationMs:Math.round(calculationMs),
        firestoreWriteMs:Math.round(firestoreWriteMs),
        totalMs:Math.round(totalMs)
      });
      return citizenIds.length;
    },
    async getAllLedgers(){
      const out={};
      for(const [id,c] of Object.entries(data.citizens)){ out[id]=[...(c.ledger||[])]; }
      host.ledgerCache.clear();
      for(const [id,entries] of Object.entries(out)) host.ledgerCache.set(id,entries);
      host.periodStatsCache=null;
      host.invalidateStatsMemo();
      return out;
    }
  };
}

function seedData(){
  let t=1;
  const k=()=>++t;
  return { citizens:{
    "MZ-07-001-005-001%2F3":{ jobCard:"MZ-07-001-005-001/3", cardNo:"3", name:"Lalrinmawia", phone:"",
      totalCharged:1000, totalPaid:300, balance:700, deferredTotal:0, createdAt:k(), updatedAt:k(),
      ledger:[
        { entryId:String(k()), type:"charge",  amount:500, note:"April 2026", date:"2026-04-03", deferred:false, createdAt:k() },
        { entryId:String(k()), type:"payment", amount:300, note:"cash",       date:"2026-04-12", deferred:false, createdAt:k() },
        { entryId:String(k()), type:"charge",  amount:500, note:"MAY1",        date:"", deferred:false, createdAt:k() }
      ], pendingPayments:[] },
    "MZ-07-001-005-001%2F18":{ jobCard:"MZ-07-001-005-001/18", cardNo:"18", name:"Lalduhawmi", phone:"",
      totalCharged:1000, totalPaid:800, balance:200, deferredTotal:0, createdAt:k(), updatedAt:k(),
      ledger:[
        { entryId:String(k()), type:"charge",  amount:500, note:"April 2026", date:"2026-04-03", deferred:false, createdAt:k() },
        { entryId:String(k()), type:"payment", amount:800, note:"paid extra", date:"2026-04-10", deferred:false, createdAt:k() },
        { entryId:String(k()), type:"charge",  amount:500, note:"MAY1",        date:"", deferred:false, createdAt:k() }
      ], pendingPayments:[] },
    "MZ-07-001-005-001%2F22":{ jobCard:"MZ-07-001-005-001/22", cardNo:"22", name:"Vanlalruata", phone:"",
      totalCharged:500, totalPaid:500, balance:0, deferredTotal:0, createdAt:k(), updatedAt:k(),
      ledger:[
        { entryId:String(k()), type:"charge",  amount:500, note:"April 2026", date:"2026-04-03", deferred:false, createdAt:k() },
        { entryId:String(k()), type:"payment", amount:500, note:"cash",       date:"2026-04-08", deferred:false, createdAt:k() }
      ], pendingPayments:[] }
  }};
}

export function makeFirebaseStore({ auth, db, fs, au }, host){
  // Ask Firestore to tell us when its queue of local writes has drained, so the
  // sync pill can show "Syncing changes…" and then disappear. waitForPendingWrites
  // resolves only after every queued write is acknowledged by the server, so it
  // stays pending while offline — which is exactly the state we want to reflect.
  let syncClearTimer=null;
  function markSyncing(){
    setSyncPending(true);
    clearTimeout(syncClearTimer);
    syncClearTimer=setTimeout(()=>{
      fs.waitForPendingWrites(db).then(()=>setSyncPending(false)).catch(()=>setSyncPending(false));
    }, 120);
  }
  return {
    isLocal:false,
    async getLedger(id){
      const q=fs.query(fs.collection(db,"citizens",id,"ledger"), fs.orderBy("createdAt","asc"));
      const snap = await fs.getDocs(q);
      return snap.docs.map(d=> {
        const data = d.data();
        if(!data.entryId) data.entryId = d.id;
        return data;
      });
    },
    async refreshChangedLedgers(citizens){
      const list=Array.isArray(citizens) ? citizens : [];
      const changed=list.filter(c=>{
        const serverAt=host.firestoreTimeMs(c.updatedAt);
        const cachedAt=host.ledgerCacheSyncAt.get(c.id)||0;
        return !Array.isArray(host.ledgerCache.get(c.id)) || serverAt>cachedAt;
      });
      if(!changed.length) return 0;

      // Read in bounded batches instead of one unbounded Promise.all. On the
      // very first sync (empty cache) this would otherwise open hundreds of
      // ledger subcollections at once, which is exactly the burst that makes
      // the first dashboard load slow. Batches of 20 keep the pipe full while
      // letting Firestore schedule reads in between.
      const results=[];
      const CHUNK=20;
      for(let i=0;i<changed.length;i+=CHUNK){
        const slice=changed.slice(i,i+CHUNK);
        const batch=await Promise.all(slice.map(async c=>{
          const entries=await this.getLedger(c.id);
          return [c.id,entries,host.firestoreTimeMs(c.updatedAt)||Date.now()];
        }));
        results.push(...batch);
      }
      const changedLedgers={};
      for(const [id,entries,syncAt] of results){
        host.ledgerCache.set(id,entries);
        host.ledgerCacheSyncAt.set(id,syncAt);
        changedLedgers[id]=entries;
      }
      host.periodStatsCache=null; host.invalidateStatsMemo();
      host.writeDashboardCache([],changedLedgers);
      return changed.length;
    },
    subscribe(cb, onError){
      const q=fs.query(fs.collection(db,"citizens"), fs.orderBy("name"));
      return fs.onSnapshot(q,
        snap=>{
          // A snapshot with pending writes means local changes have not reached
          // the server yet (always true while offline).
          if(snap.metadata && snap.metadata.hasPendingWrites) markSyncing();
          try{
            cb(snap.docs.map(d=>({ id:d.id, ...d.data() })));
          } catch(e){
            console.error("Error in subscribe callback:", e);
          }
        },
        error=>{
          // Surface this to the UI: a read failure (quota, rules, offline) must
          // not silently render an empty dashboard that looks like lost data.
          console.error("Firestore subscribe error:", error);
          if(typeof onError === "function"){ try{ onError(error); }catch(e){ console.error(e); } }
        }
      );
    },
    async listOwing(){
      const snap=await fs.getDocs(fs.collection(db,"citizens"));
      const needsLedger = host.deferredPeriods.length || Object.keys(host.deferredPeriodOverrides).length;
      if(!needsLedger){
        return snap.docs
          .map(d=>({ id:d.id, ...d.data(), balance:Number(d.data().balance || 0) }))
          .filter(c=>c.balance>0);
      }
      // One collection-group read for every ledger, instead of opening a
      // subcollection per household.
      const byId=await this.getAllLedgers();
      const results=snap.docs.map(d=>{
        const c={id:d.id, ...d.data()};
        const entries=byId[c.id] || [];
        const allocation=host.allocateLedgerPayments(entries, c.id);
        const effBal=allocation.owed.reduce((sum,o)=>sum+o.remaining,0)-allocation.unappliedPayment;
        return effBal>0 ? { ...c, balance:effBal } : null;
      });
      return results.filter(r=>r!==null);
    },
    async exists(id){ return (await fs.getDoc(fs.doc(db,"citizens",id))).exists(); },
    async addCitizen(id, d){
      if(typeof id !== 'string' || !id) throw new Error("Invalid citizen ID");
      if(!d.name || typeof d.name !== 'string') throw new Error("Citizen name is required");
      if(!d.jobCard || typeof d.jobCard !== 'string') throw new Error("Job card is required");
      await fs.setDoc(fs.doc(db,"citizens",id), {...d, createdAt:fs.serverTimestamp(), updatedAt:fs.serverTimestamp()});
    },
    async addEntry(id, type, amount, note, date, deferred=false){
      const validTypes = ["charge", "payment", "forgive", "sanitationFee"];
      if(!validTypes.includes(type)) throw new Error("Invalid entry type");
      const amt = Number(amount);
      if(!Number.isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
      const eRef=fs.doc(fs.collection(db,"citizens",id,"ledger"));
      const entry={ entryId:eRef.id, type, amount:amt, note, date, deferred, createdAt:Date.now() };
      // Never rebuild the cache from only the newly-created entry. If the
      // ledger was not already cached, load the complete history first.
      // Otherwise the next account render can temporarily appear to have
      // lost all previous transactions even though Firestore still has them.
      let entries=host.ledgerCache.get(id);
      if(!Array.isArray(entries)){
        entries=await this.getLedger(id);
      }else{
        entries=[...entries];
      }
      entries.push(entry);
      entries.sort((a,b)=>(a.createdAt?.seconds ? a.createdAt.seconds*1000 : Number(a.createdAt)||0) -
                          (b.createdAt?.seconds ? b.createdAt.seconds*1000 : Number(b.createdAt)||0));
      host.ledgerCache.set(id,entries); host.periodStatsCache=null; host.invalidateStatsMemo();

      // The ledger write and the cached citizen totals are independent writes.
      // Run them in parallel so a person-view payment does not wait for two
      // sequential Firestore round trips before the UI can refresh.
      const totals=host.recalcFromLedger(entries, id);
      try{
        await Promise.all([
          fs.setDoc(eRef, {
            entryId:eRef.id,
            type,
            amount:amt,
            note:String(note||""),
            date:String(date||""),
            deferred,
            createdAt:fs.serverTimestamp()
          }),
          fs.updateDoc(fs.doc(db,"citizens",id),{
            ...totals,
            updatedAt:fs.serverTimestamp()
          })
        ]);
      }catch(err){
        // addEntry updates host.ledgerCache before the network write so the person
        // view can render optimistically. Restore the previous cache if either
        // Firestore write fails.
        host.ledgerCache.set(id, entries.filter(e=>e.entryId!==eRef.id));
        host.periodStatsCache=null;
        host.invalidateStatsMemo();
        throw err;
      }
    },
    async forgiveDebt(id, amount, note){
      await this.addEntry(id, "forgive", amount, note, host.todayISO());
    },
    async confirmPendingPayment(id, pendingId){
      const ppRef=fs.doc(db,"citizens",id,"pendingPayments",pendingId);
      const snap=await fs.getDoc(ppRef);
      if(!snap.exists()) return;
      const pp=snap.data();
      if(pp.status!=="pending") return;
      await fs.updateDoc(ppRef,{ status:"confirmed" });
      await this.addEntry(id, "payment", pp.amount, "UPI", pp.date);
    },
    async getPendingPayments(){
      // Single collection-group read replaces the old N+1 query (one `citizens`
      // read plus one `pendingPayments` subcollection read per household),
      // which previously ran on every dashboard refresh. pendingPayments docs
      // carry a `status` field; we only want the still-pending rows. If the
      // query is rejected by Firestore rules or indexing, fall back to the
      // per-citizen reads in bounded batches of 20.
      let rows=[];
      try{
        const q=fs.query(
          fs.collectionGroup(db,"pendingPayments"),
          fs.where("status","==","pending")
        );
        const snap=await fs.getDocs(q);
        rows=snap.docs.map(d=>({ citizenId:d.ref.parent.parent.id, id:d.id, ...d.data() }));
      }catch(err){
        console.warn("collectionGroup pendingPayments query failed; reading per citizen.", err);
        const citizenSnap=await fs.getDocs(fs.collection(db,"citizens"));
        const ids=citizenSnap.docs.map(d=>d.id);
        for(let i=0;i<ids.length;i+=20){
          const slice=ids.slice(i,i+20);
          const batch=await Promise.all(slice.map(async id=>{
            const ppSnap=await fs.getDocs(fs.collection(db,"citizens",id,"pendingPayments"));
            return ppSnap.docs
              .filter(doc=>doc.data().status==="pending")
              .map(doc=>({ citizenId:id, id:doc.id, ...doc.data() }));
          }));
          rows.push(...batch.flat());
        }
      }
      if(!rows.length) return rows;
      // Attach the display name/jobCard. Prefer the in-memory citizen list;
      // fetch only the citizens we do not already have, in bounded batches.
      const byId=new Map((host.rawCitizens||[]).map(c=>[c.id,c]));
      const missing=[...new Set(rows.map(r=>r.citizenId).filter(id=>!byId.has(id)))];
      for(let i=0;i<missing.length;i+=20){
        await Promise.all(missing.slice(i,i+20).map(async id=>{
          try{
            const s=await fs.getDoc(fs.doc(db,"citizens",id));
            if(s.exists()) byId.set(id,s.data());
          }catch(e){}
        }));
      }
      return rows.map(r=>{
        const c=byId.get(r.citizenId);
        return c ? { ...r, name:c.name, jobCard:c.jobCard } : r;
      });
    },
    async deleteEntry(id, entryId){
      await fs.deleteDoc(fs.doc(db,"citizens",id,"ledger",entryId));
      const entries=host.ledgerCache.get(id)||[];
      const idx=entries.findIndex(x=>x.entryId===entryId);
      if(idx>=0) entries.splice(idx,1);
      host.ledgerCache.set(id,entries); host.periodStatsCache=null; host.invalidateStatsMemo();
      const totals=host.recalcFromLedger(entries, id);
      await fs.updateDoc(fs.doc(db,"citizens",id),{ ...totals, updatedAt:fs.serverTimestamp() });
    },
    async editEntry(id, entryId, updates){
      if(updates.amount !== undefined){
        const amt = Number(updates.amount);
        if(!Number.isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
        updates.amount = amt;
      }
      if(updates.note !== undefined) updates.note = String(updates.note || "");
      if(updates.date !== undefined) updates.date = String(updates.date || "");
      const ref=fs.doc(db,"citizens",id,"ledger",entryId);
      await fs.updateDoc(ref, updates);
      const entries=host.ledgerCache.get(id)||[];
      const e=entries.find(x=>x.entryId===entryId);
      if(e) Object.assign(e,updates);
      host.ledgerCache.set(id,entries); host.periodStatsCache=null; host.invalidateStatsMemo();
      const totals=host.recalcFromLedger(entries, id);
      await fs.updateDoc(fs.doc(db,"citizens",id),{ ...totals, updatedAt:fs.serverTimestamp() });
    },
    async deleteCitizen(id){
      const led=await fs.getDocs(fs.collection(db,"citizens",id,"ledger"));
      await Promise.all(led.docs.map(d=>fs.deleteDoc(d.ref)));
      const pp=await fs.getDocs(fs.collection(db,"citizens",id,"pendingPayments"));
      await Promise.all(pp.docs.map(d=>fs.deleteDoc(d.ref)));
      await fs.deleteDoc(fs.doc(db,"citizens",id));
      host.invalidateLedgerCache(id);
    },
    async bulkAppendCharges(items, onProgress){
      let batch=fs.writeBatch(db), ops=0, done=0;
      const flush=async()=>{ if(ops>0){ await batch.commit(); batch=fs.writeBatch(db); ops=0; } };
      for(const it of items){
        const cRef=fs.doc(db,"citizens",it.id);
        const eRef=fs.doc(fs.collection(db,"citizens",it.id,"ledger"));
        const def = it.deferred||false;
        batch.set(eRef,{ entryId:eRef.id, type:"charge", amount:it.amount, note:it.note, date:"", deferred:def, createdAt:fs.serverTimestamp() });
        batch.set(cRef,{ jobCard:it.jobCard, cardNo:it.cardNo, name:it.name,
          totalCharged:fs.increment(it.amount), balance:fs.increment(def?0:it.amount),
          deferredTotal:fs.increment(def?it.amount:0), updatedAt:fs.serverTimestamp() }, {merge:true});
        if(++ops>=400) await flush();
        if((++done % 50)===0 && onProgress) onProgress(done, items.length);
      }
      await flush();
      host.invalidateLedgerCache();
      if(onProgress) onProgress(items.length, items.length);
      return items.length;
    },
    async bulkAppendPayments(items, onProgress){
      let batch=fs.writeBatch(db), ops=0, done=0;
      const flush=async()=>{ if(ops>0){ await batch.commit(); batch=fs.writeBatch(db); ops=0; } };
      for(const it of items){
        const cRef=fs.doc(db,"citizens",it.id);
        const eRef=fs.doc(fs.collection(db,"citizens",it.id,"ledger"));
        batch.set(eRef,{ entryId:eRef.id, type:"payment", amount:it.amount, note:it.note||"Bank", date:it.date||"", deferred:false, createdAt:fs.serverTimestamp() });
        batch.set(cRef,{ totalPaid:fs.increment(it.amount), balance:fs.increment(-it.amount), updatedAt:fs.serverTimestamp() }, {merge:true});
        if(++ops>=400) await flush();
        if((++done % 50)===0 && onProgress) onProgress(done, items.length);
      }
      await flush();
      host.invalidateLedgerCache();
      if(onProgress) onProgress(items.length, items.length);
      return items.length;
    },
    async signIn(email, pass){ await au.signInWithEmailAndPassword(auth, email, pass); },
    signOut(){ au.signOut(auth); },
    onAuth(cb){ au.onAuthStateChanged(auth, u=>cb(!!u)); },
    async exportOwingCsv(){
      const owing = await this.listOwing();
      // listOwing() just populated the in-memory ledger cache via a single
      // collection-group read, so read payment history from there instead of
      // fetching each household's ledger again.
      let csv = "Name,Job Card,Outstanding (₹),Payment History\n";
      for(const c of owing){
        const entries = host.ledgerCache.get(c.id) || [];
        const payments = entries.filter(e=>e.type==="payment").map(e=>`${host.entryLabel(e)} ${host.fmt(e.amount)}`).join("; ");
        csv += `"${host.esc(c.name)}","${host.esc(c.jobCard)}",${c.balance},"${host.esc(payments)}"\n`;
      }
      return csv;
    },
    async exportAll(onProgress){
      if(onProgress)onProgress(0,3);const cSnap=await fs.getDocs(fs.collection(db,"citizens"));const byId={};cSnap.docs.forEach(d=>{const c=d.data();byId[d.id]={id:d.id,jobCard:c.jobCard,cardNo:c.cardNo,name:c.name,phone:c.phone||"",totalCharged:c.totalCharged||0,totalPaid:c.totalPaid||0,balance:c.balance||0,deferredTotal:c.deferredTotal||0,pendingPayments:[],ledger:[]};});
      const [deferredSnap,overrideSnap,importsSnap]=await Promise.all(["deferredPeriods","deferredPeriodOverrides","imports"].map(id=>fs.getDoc(fs.doc(db,"meta",id))));if(onProgress)onProgress(1,3);
      // One collection-group read each for all ledgers and all pending payments,
      // instead of two subcollection reads per household. If either query is
      // rejected, fall back to bounded per-citizen batches of 20.
      try{
        const [ledgerSnap,ppSnap]=await Promise.all([fs.getDocs(fs.collectionGroup(db,"ledger")),fs.getDocs(fs.collectionGroup(db,"pendingPayments"))]);
        ledgerSnap.docs.forEach(x=>{const ref=x.ref.parent.parent;if(!ref||!byId[ref.id])return;const e=x.data();byId[ref.id].ledger.push({entryId:e.entryId||x.id,type:e.type,amount:e.amount,note:e.note,date:e.date||"",deferred:e.deferred||false,createdAtMs:e.createdAt&&e.createdAt.toMillis?e.createdAt.toMillis():null});});
        ppSnap.docs.forEach(x=>{const ref=x.ref.parent.parent;if(!ref||!byId[ref.id])return;byId[ref.id].pendingPayments.push({id:x.id,...x.data()});});
      }catch(err){
        console.warn("Collection-group export read failed; reading subcollections per citizen.", err);
        const ids=Object.keys(byId);
        for(let i=0;i<ids.length;i+=20){
          await Promise.all(ids.slice(i,i+20).map(async id=>{
            const [led,pp]=await Promise.all([fs.getDocs(fs.collection(db,"citizens",id,"ledger")),fs.getDocs(fs.collection(db,"citizens",id,"pendingPayments"))]);
            led.docs.forEach(x=>{const e=x.data();byId[id].ledger.push({entryId:e.entryId||x.id,type:e.type,amount:e.amount,note:e.note,date:e.date||"",deferred:e.deferred||false,createdAtMs:e.createdAt&&e.createdAt.toMillis?e.createdAt.toMillis():null});});
            pp.docs.forEach(x=>byId[id].pendingPayments.push({id:x.id,...x.data()}));
          }));
        }
      }
      const citizens=Object.values(byId);citizens.forEach(c=>c.ledger.sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)));const meta={deferredPeriods:deferredSnap.exists()?deferredSnap.data():{periods:[],updatedAt:{}},deferredPeriodOverrides:overrideSnap.exists()?(overrideSnap.data().overrides||{}):{},imports:importsSnap.exists()?(importsSnap.data().periods||[]):[]};if(onProgress)onProgress(3,3);return {app:"nsnvc-contribution",version:2,exportedAt:new Date().toISOString(),count:citizens.length,meta,citizens};
    },
    async deleteAll(onProgress){
      if(onProgress)onProgress(0,2);const cSnap=await fs.getDocs(fs.collection(db,"citizens"));let batch=fs.writeBatch(db),ops=0;const flush=async()=>{if(ops>0){await batch.commit();batch=fs.writeBatch(db);ops=0;}};
      for(const d of cSnap.docs){const [led,pp]=await Promise.all([fs.getDocs(fs.collection(db,"citizens",d.id,"ledger")),fs.getDocs(fs.collection(db,"citizens",d.id,"pendingPayments"))]);for(const x of led.docs){batch.delete(x.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}for(const x of pp.docs){batch.delete(x.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}batch.delete(d.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}
      await flush();batch=fs.writeBatch(db);ops=0;for(const id of ["deferredPeriods","deferredPeriodOverrides","imports"]){batch.delete(fs.doc(db,"meta",id));if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}await flush();host.invalidateLedgerCache();markSyncing();
    },
    async renamePeriod(oldPeriod, newPeriod, onProgress){
      const cSnap=await fs.getDocs(fs.collection(db,"citizens"));
      // One collection-group read for all ledgers rather than a subcollection
      // per household. Falls back to bounded per-citizen batches if needed.
      const docs=[];
      try{
        const ledgerSnap=await fs.getDocs(fs.collectionGroup(db,"ledger"));
        docs.push(...ledgerSnap.docs);
      }catch(err){
        console.warn("Collection-group ledger read failed for rename; reading per citizen.", err);
        const ids=cSnap.docs.map(d=>d.id);
        for(let i=0;i<ids.length;i+=20){
          const chunks=await Promise.all(ids.slice(i,i+20).map(id=>fs.getDocs(fs.collection(db,"citizens",id,"ledger"))));
          for(const s of chunks) docs.push(...s.docs);
        }
      }
      let batch=fs.writeBatch(db), ops=0, count=0;
      const flush=async()=>{ if(ops>0){ await batch.commit(); batch=fs.writeBatch(db); ops=0; } };
      for(const ld of docs){
        if(ld.data().type==="charge" && ld.data().note===oldPeriod){
          batch.update(ld.ref, { note:newPeriod });
          if(++ops>=400) await flush();
          count++;
        }
      }
      await flush();
      host.invalidateLedgerCache();
      markSyncing();
      if(onProgress) onProgress(count, count);
      return count;
    },
    async getDeferredPeriods(){
      // Raw stored shape; onAuth normalizes it and writes the normalized version
      // back when it detects a legacy shape.
      const doc=await fs.getDoc(fs.doc(db,"meta","deferredPeriods"));
      if(doc.exists()) return doc.data();
      return {periods:[],updatedAt:{}};
    },
    async setDeferredPeriods(periods){
      const next=Array.isArray(periods) ? periods.slice() : [];
      const updatedAt={...deferredPeriodUpdatedAt};
      // Preserve a period that has no timestamp as 0 instead of stamping it
      // "now". Stamping here made a rename (or a legacy load) look like a fresh
      // defer, which silently overrode per-person restores under that period.
      // A genuine defer/redefer sets the timestamp first (togglePeriodDeferred),
      // and a rename carries the old value over.
      for(const p of next){
        if(!Object.prototype.hasOwnProperty.call(updatedAt,p)) updatedAt[p]=0;
      }
      for(const p of Object.keys(updatedAt)){
        if(!next.includes(p)) delete updatedAt[p];
      }
      host.deferredPeriodUpdatedAt={...updatedAt};
      await fs.setDoc(fs.doc(db,"meta","deferredPeriods"), { periods:next, updatedAt }, {merge:true});
      markSyncing();
    },
    async getDeferredPeriodOverrides(){
      // Raw stored shape; onAuth normalizes and writes back if legacy.
      const doc=await fs.getDoc(fs.doc(db,"meta","deferredPeriodOverrides"));
      if(doc.exists()) return doc.data().overrides||{};
      return {};
    },
    async deleteMeta(name){
      await fs.deleteDoc(fs.doc(db,"meta",name));
      markSyncing();
    },
    async setDeferredPeriodOverrides(overrides){
      await fs.setDoc(fs.doc(db,"meta","deferredPeriodOverrides"), { overrides:overrides||{} }, {merge:true});
      markSyncing();
    },
    async setCitizenChargeDeferred(citizenId, entryId, deferred){
      // Update the value and timestamp together so a later action can supersede an earlier one.
      // setDoc with an explicit mergeFields path creates the document on first
      // use. updateDoc here threw NOT_FOUND whenever meta/deferredPeriodOverrides
      // had never been created (the doc was also never written while the v1.33.9
      // 'host.'-prefix bug redirected writes to a different id) — that's why
      // Settings (period) defers worked but per-charge toggles failed.
      const cid=String(citizenId), eid=String(entryId), at=host.nextDeferTimestamp();
      const ref=fs.doc(db,"meta","deferredPeriodOverrides");
      await fs.setDoc(ref,
        { overrides: { [cid]: { [eid]: { value:Boolean(deferred), at } } } },
        { mergeFields: [`overrides.${cid}.${eid}`] });
      markSyncing();
    },
    async importAll(backup,onProgress){
      if(!backup||!Array.isArray(backup.citizens))throw new Error("Not a valid backup file");if(onProgress)onProgress(0,3);const old=await fs.getDocs(fs.collection(db,"citizens"));let batch=fs.writeBatch(db),ops=0;const flush=async()=>{if(ops>0){await batch.commit();batch=fs.writeBatch(db);ops=0;}};
      for(const d of old.docs){const [led,pp]=await Promise.all([fs.getDocs(fs.collection(db,"citizens",d.id,"ledger")),fs.getDocs(fs.collection(db,"citizens",d.id,"pendingPayments"))]);for(const x of led.docs){batch.delete(x.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}for(const x of pp.docs){batch.delete(x.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}batch.delete(d.ref);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}await flush();if(onProgress)onProgress(1,3);
      const meta=backup.meta&&typeof backup.meta==="object"?backup.meta:{};for(const [id,value] of [["deferredPeriods",meta.deferredPeriods&&typeof meta.deferredPeriods==="object"?meta.deferredPeriods:{periods:[],updatedAt:{}}],["deferredPeriodOverrides",{overrides:meta.deferredPeriodOverrides&&typeof meta.deferredPeriodOverrides==="object"?meta.deferredPeriodOverrides:{}}],["imports",{periods:Array.isArray(meta.imports)?meta.imports:[]}]]){batch.set(fs.doc(db,"meta",id),value);if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}await flush();batch=fs.writeBatch(db);ops=0;let done=0;const validTypes=["charge","payment","forgive","sanitationFee"];
      for(const r of backup.citizens){const cRef=fs.doc(db,"citizens",r.id);batch.set(cRef,{jobCard:r.jobCard,cardNo:r.cardNo,name:r.name,phone:r.phone||"",totalCharged:r.totalCharged||0,totalPaid:r.totalPaid||0,balance:r.balance||0,deferredTotal:r.deferredTotal||0,updatedAt:fs.serverTimestamp()});if(++ops>=FIRESTORE_BATCH_SIZE)await flush();for(const e of (r.ledger||[])){if(!e||!validTypes.includes(e.type)||!e.amount)continue;const amt=Number(e.amount);if(!Number.isFinite(amt)||amt<=0)continue;const eRef=fs.doc(fs.collection(db,"citizens",r.id,"ledger"));batch.set(eRef,{entryId:e.entryId||eRef.id,type:e.type,amount:amt,note:e.note||"",date:e.date||"",deferred:e.deferred||false,createdAt:e.createdAtMs?fs.Timestamp.fromMillis(e.createdAtMs):fs.serverTimestamp()});if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}for(const p of (Array.isArray(r.pendingPayments)?r.pendingPayments:[])){if(!p||!p.id||!Number.isFinite(Number(p.amount))||Number(p.amount)<=0)continue;const pRef=fs.doc(db,"citizens",r.id,"pendingPayments",String(p.id));batch.set(pRef,{amount:Number(p.amount),date:p.date||"",status:p.status||"pending",createdAt:p.createdAt||fs.serverTimestamp()});if(++ops>=FIRESTORE_BATCH_SIZE)await flush();}if((++done%50)===0&&onProgress)onProgress(2,3);}
      await flush();host.invalidateLedgerCache();markSyncing();if(onProgress)onProgress(3,3);return backup.citizens.length;
    },
    async getImportedPeriods(){ const s=await fs.getDoc(fs.doc(db,"meta","imports")); return s.exists()? (s.data().periods||[]) : []; },
    async recordImportedPeriod(p){ await fs.setDoc(fs.doc(db,"meta","imports"), { periods:fs.arrayUnion(p) }, {merge:true}); markSyncing(); },
    async recalcAll(onProgress){
      // Always rebuild from the complete Firestore ledgers. Do not trust cached
      // citizen totals or a partially populated host.ledgerCache. A repair must
      // read fresh data, so force a scan even if a snapshot is cached.
      const ledgers = await this.getAllLedgers({force:true});
      const citizenIds = Object.keys(ledgers);
      let batch=fs.writeBatch(db), ops=0, done=0;
      // Map current cached citizen docs by id so we can skip unchanged ones.
      // Writing every household unconditionally burned the free write quota and
      // set updatedAt on all of them, which then made refreshChangedLedgers
      // re-read every ledger too.
      const known = new Map();
      for(const c of (host.rawCitizens || [])) known.set(c.id, c);

      const flush=async()=>{
        if(ops===0) return;
        await batch.commit();
        batch=fs.writeBatch(db);
        ops=0;
      };

      for(const id of citizenIds){
        const {totalCharged,totalPaid,balance,deferredTotal}=host.recalcFromLedger(ledgers[id]||[],id);

        // Skip households whose cached totals already match — avoids needless
        // writes (and the updatedAt bump that would trigger ledger re-reads).
        const cur = known.get(id);
        const unchanged = cur &&
          Number(cur.totalCharged||0)===Number(totalCharged||0) &&
          Number(cur.totalPaid||0)===Number(totalPaid||0) &&
          Number(cur.balance||0)===Number(balance||0) &&
          Number(cur.deferredTotal||0)===Number(deferredTotal||0);
        if(unchanged){ if((++done%25)===0&&onProgress) onProgress(done,citizenIds.length); continue; }

        // merge:true makes the repair tolerant of a document whose cached
        // summary fields are missing, while preserving all other citizen data.
        batch.set(fs.doc(db,"citizens",id),{
          totalCharged,
          totalPaid,
          balance,
          deferredTotal,
          updatedAt:fs.serverTimestamp()
        },{merge:true});
        ops++;

        // Keep repair batches comfortably below Firestore's hard limit so a large
        // household set can continue reliably without stalling at a batch boundary.
        if(ops>=300) await flush();
        if((++done%25)===0&&onProgress) onProgress(done,citizenIds.length);
      }

      await flush();
      host.invalidateLedgerCache();

      // The ledger cache was invalidated above; the live snapshot/refresh will
      // provide the repaired totals without an artificial delay.
      if(onProgress) onProgress(citizenIds.length,citizenIds.length);
      return citizenIds.length;
    },
    async getAllLedgers(opts){
      // Reuse a recent full scan. Each scan costs one read per ledger document
      // (~=every entry in the village), which is what exhausts the free
      // Firestore plan's daily quota when exports/backups/period actions each
      // trigger their own scan.
      const force = !!(opts && opts.force);
      const ttlMs = host.fullLedgerTtlMs || 15 * 60 * 1000;
      const age = Date.now() - (host.fullLedgerSnapshotAt || 0);
      if(!force && host.fullLedgerSnapshotCount > 0 && age < ttlMs){
        console.log(`Using cached full ledger snapshot (${Math.round(age/1000)}s old, ${host.fullLedgerSnapshotCount} ledgers) — no Firestore reads.`);
        const out={};
        for(const [id,entries] of host.ledgerCache) out[id]=entries;
        return out;
      }

      // Prefer the fast collectionGroup read. If that query is rejected by
      // Firestore rules/indexing, fall back to the same per-citizen ledger
      // read used by the account detail page. Never silently return empty
      // ledgers, because that makes every household look cleared on Pending.
      //
      // Seed ids from the already-subscribed citizen list (no extra read) and
      // only fall back to reading the citizens collection if we have none.
      const out={};
      const known = host.rawCitizens;
      if(Array.isArray(known) && known.length){
        for(const c of known) out[c.id]=[];
      }else{
        const cSnap = await fs.getDocs(fs.collection(db,"citizens"));
        for(const d of cSnap.docs) out[d.id]=[];
      }

      try{
        const ledgerSnap = await fs.getDocs(fs.collectionGroup(db,"ledger"));
        for(const d of ledgerSnap.docs){
          const citizenRef=d.ref.parent.parent;
          if(!citizenRef) continue;
          const id=citizenRef.id;
          if(!out[id]) out[id]=[];
          out[id].push(d.data());
        }
      }catch(err){
        console.warn("Collection-group ledger read failed; loading ledgers per citizen.", err);
        const ids=Object.keys(out);
        const chunkSize=20;
        for(let i=0;i<ids.length;i+=chunkSize){
          const chunk=ids.slice(i,i+chunkSize);
          const results=await Promise.all(chunk.map(async id=>{
            try{
              return [id, await this.getLedger(id)];
            }catch(e){
              console.error("Failed to load ledger for", id, e);
              throw e;
            }
          }));
          for(const [id,entries] of results) out[id]=entries;
        }
      }

      host.ledgerCache.clear();
      for(const [id,entries] of Object.entries(out)){
        host.ledgerCache.set(id, entries);
      }
      host.periodStatsCache=null;
      host.invalidateStatsMemo();
      // Record the snapshot so later callers skip the scan.
      host.fullLedgerSnapshotAt = Date.now();
      host.fullLedgerSnapshotCount = Object.keys(out).length;
      // Keep the complete ledger snapshot persistent so the next dashboard
      // load can render period-aware balances before Firestore responds.
      host.writeDashboardCache(Object.values(out).map(()=>null), out);
      return out;
    }
  };
}

