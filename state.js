/* =====================================================================
   NSNVC application state — Stage 3 Step 3.
   Shared mutable state helpers that are independent of the DOM.
   ===================================================================== */

import {
  calculateLedgerState,
  isPeriodDeferredForCitizen
} from "./ledger.js";

export function createAppState(){
  const state = {
    statsRevision: 0,
    statsMemo: new Map(),
    deferClock: 0
  };

  function invalidateStatsMemo(){
    state.statsRevision++;
    if(state.statsMemo.size>5000) state.statsMemo.clear();
  }

  function statsMemoEntry(c){
    if(!c || c.id==null) return null;
    const key = Array.isArray(c.ledger)
      ? "L|"+state.statsRevision+"|"+c.id
      : "B|"+state.statsRevision+"|"+c.id+"|"+(c.balance!=null?c.balance:0);
    let rec=state.statsMemo.get(key);
    if(!rec){
      rec={balance:null,deferred:null};
      state.statsMemo.set(key,rec);
    }
    return rec;
  }

  function getEffectiveBalance(c){
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

  function getDeferredAmount(c){
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

  function statusOf(c){
    const bal=getEffectiveBalance(c);
    if(bal<=0) return "paid";
    if((c.totalPaid||0)>0) return "partial";
    return "due";
  }

  function nextDeferTimestamp(previous=0){
    state.deferClock=Math.max(Date.now(),state.deferClock+1,(Number(previous)||0)+1);
    return state.deferClock;
  }

  return {
    state,
    invalidateStatsMemo,
    getEffectiveBalance,
    getDeferredAmount,
    statusOf,
    nextDeferTimestamp
  };
}
