/* =====================================================================
   NSNVC application state — Stage 3 Step 3B.
   Shared mutable state, account helpers, cache invalidation, and sync state.
   DOM stays in index.html; data-layer modules import this singleton state.
   ===================================================================== */

import {
  calculateLedgerState,
  isPeriodDeferredForCitizen
} from "./ledger.js";

export let ledgerCache = new Map();
export const ledgerCacheSyncAt = new Map();
export let periodStatsCache = null;
export let deferredPeriods = [];
export let deferredPeriodUpdatedAt = {};
export let deferredPeriodOverrides = {};
export let rawCitizens = [];
export let allCitizens = [];

export const FULL_LEDGER_TTL_MS = 15 * 60 * 1000;
export let fullLedgerSnapshotAt = 0;
export let fullLedgerSnapshotCount = 0;
export let syncPendingWrites = false;

let statsRevision = 0;
const statsMemo = new Map();
let deferClock = 0;
let syncIndicatorRenderer = null;
let exportSnapshotInvalidator = null;

export function setLedgerCache(value){ ledgerCache=value instanceof Map ? value : new Map(); }
export function setPeriodStatsCache(value){ periodStatsCache=value ?? null; }
export function setDeferredPeriods(value){ deferredPeriods=Array.isArray(value) ? value : []; }
export function setDeferredPeriodUpdatedAt(value){ deferredPeriodUpdatedAt=value && typeof value==="object" ? value : {}; }
export function setDeferredPeriodOverrides(value){ deferredPeriodOverrides=value && typeof value==="object" ? value : {}; }
export function setRawCitizens(value){ rawCitizens=Array.isArray(value) ? value : []; }
export function setAllCitizens(value){ allCitizens=Array.isArray(value) ? value : []; }
export function setFullLedgerSnapshotAt(value){ fullLedgerSnapshotAt=Number(value)||0; }
export function setFullLedgerSnapshotCount(value){ fullLedgerSnapshotCount=Number(value)||0; }

export function invalidateFullLedgerSnapshot(){
  fullLedgerSnapshotAt=0;
  fullLedgerSnapshotCount=0;
}

export function invalidateStatsMemo(){
  statsRevision++;
  if(statsMemo.size>5000) statsMemo.clear();
}

function statsMemoEntry(c){
  if(!c || c.id==null) return null;
  const key = Array.isArray(c.ledger)
    ? "L|"+statsRevision+"|"+c.id
    : "B|"+statsRevision+"|"+c.id+"|"+(c.balance!=null?c.balance:0);
  let rec=statsMemo.get(key);
  if(!rec){
    rec={balance:null,deferred:null};
    statsMemo.set(key,rec);
  }
  return rec;
}

export function getEffectiveBalance(c){
  const rec=statsMemoEntry(c);
  if(rec && rec.balance!==null) return rec.balance;
  let value;
  if(c && Array.isArray(c.ledger)){
    value=calculateLedgerState(c.ledger,c.id).balance;
  }else{
    value=Number(c && c.balance!=null ? c.balance : 0);
  }
  if(rec) rec.balance=value;
  return value;
}

export function getDeferredAmount(c){
  const rec=statsMemoEntry(c);
  if(rec && rec.deferred!==null) return rec.deferred;
  let value=0;
  if(c && Array.isArray(c.ledger)){
    value=c.ledger.reduce((sum,e)=>{
      if(!e || (e.type!=="charge" && e.type!=="sanitationFee")) return sum;
      const deferred=isPeriodDeferredForCitizen(e,c.id);
      return sum + (deferred ? Math.max(0,Number(e.amount)||0) : 0);
    },0);
  }
  if(rec) rec.deferred=value;
  return value;
}

export function statusOf(c){
  const bal=getEffectiveBalance(c);
  if(bal<=0) return "paid";
  if((c.totalPaid||0)>0) return "partial";
  return "due";
}

export function nextDeferTimestamp(previous=0){
  deferClock=Math.max(Date.now(),deferClock+1,(Number(previous)||0)+1);
  return deferClock;
}

export function onSyncIndicatorRender(fn){
  syncIndicatorRenderer=typeof fn==="function" ? fn : null;
}

export function setSyncPending(pending){
  const next=Boolean(pending);
  if(next===syncPendingWrites) return;
  syncPendingWrites=next;
  if(syncIndicatorRenderer) syncIndicatorRenderer();
}

export function onExportSnapshotInvalidated(fn){
  exportSnapshotInvalidator=typeof fn==="function" ? fn : null;
}

export function invalidateLedgerCache(id){
  if(id) ledgerCache.delete(id);
  else ledgerCache.clear();
  periodStatsCache=null;
  invalidateStatsMemo();
  invalidateFullLedgerSnapshot();
  if(exportSnapshotInvalidator) exportSnapshotInvalidator();
}
