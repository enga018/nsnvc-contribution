/* =====================================================================
   NSNVC ledger engine — pure, DOM-free, state-injected.
   =====================================================================
   This module holds the money and deferral rules for the contribution
   tracker. It has NO dependency on the DOM or on app state: every
   function that needs to know about deferral state takes it as an
   argument, so the engine can be unit-tested in Node and reasoned about
   in isolation.

   Deferral state is passed as an object:
     { deferredPeriods, deferredPeriodUpdatedAt, deferredPeriodOverrides }
   (all defaulting to empty).

   Design rules that must not change:
     - Payments and waivers are summed regardless of period; payments are
       never matched to a specific charge.
     - A charge/sanitation fee counts as owed unless it is deferred.
     - Deferral resolution is "latest wins" with a strictly-increasing
       timestamp (see defer resolution below).
   ===================================================================== */

/* ---------- deferral state normalisation ---------- */

export function normalizeDeferredPeriodState(raw){
  if(Array.isArray(raw)){
    const updatedAt={};
    raw.forEach(p=>{ if(p) updatedAt[String(p)]=0; });
    return {periods:raw.slice(), updatedAt, migrated:true};
  }
  if(raw && typeof raw==="object"){
    const periods=Array.isArray(raw.periods) ? raw.periods.slice() : [];
    const updatedAt={};
    if(raw.updatedAt && typeof raw.updatedAt==="object"){
      for(const [p,v] of Object.entries(raw.updatedAt)){
        const n=Number(v);
        if(Number.isFinite(n)) updatedAt[p]=n;
      }
    }
    const migrated=!Array.isArray(raw.periods) || !raw.updatedAt || typeof raw.updatedAt!=="object";
    periods.forEach(p=>{ if(p && !Object.prototype.hasOwnProperty.call(updatedAt,p)) updatedAt[p]=0; });
    return {periods, updatedAt, migrated};
  }
  return {periods:[], updatedAt:{}, migrated:true};
}

export function normalizeDeferredPeriodOverrides(raw){
  const out={};
  let migrated=false;
  if(!raw || typeof raw!=="object") return {overrides:out,migrated:Boolean(raw)};
  for(const [citizenId,value] of Object.entries(raw)){
    if(Array.isArray(value)){
      const map={};
      value.forEach(period=>{ if(period) map[String(period)]={value:false,at:0}; });
      if(Object.keys(map).length) out[citizenId]=map;
      migrated=true;
      continue;
    }
    if(!value || typeof value!=="object") { migrated=true; continue; }
    const map={};
    for(const [key,state] of Object.entries(value)){
      if(state && typeof state==="object" && !Array.isArray(state) &&
         Object.prototype.hasOwnProperty.call(state,"value")){
        map[key]={value:Boolean(state.value),at:Number(state.at)||0};
      }else{
        map[key]={value:Boolean(state),at:0};
        migrated=true;
      }
    }
    if(Object.keys(map).length) out[citizenId]=map;
  }
  return {overrides:out,migrated};
}

/* ---------- defer resolution ---------- */
// The engine resolves deferral from injected state. The app keeps a single
// mutable "current state" object updated on login and on every defer action;
// call setDeferralState() to point the engine at it.
let currentDeferralState = { deferredPeriods:[], deferredPeriodUpdatedAt:{}, deferredPeriodOverrides:{} };

export function setDeferralState(state){
  currentDeferralState = state || { deferredPeriods:[], deferredPeriodUpdatedAt:{}, deferredPeriodOverrides:{} };
}

export function getDeferralState(){
  return currentDeferralState;
}

function _deferredPeriods(){ return currentDeferralState.deferredPeriods || []; }
function _deferredPeriodUpdatedAt(){ return currentDeferralState.deferredPeriodUpdatedAt || {}; }
function _deferredPeriodOverrides(){ return currentDeferralState.deferredPeriodOverrides || {}; }

export function getCitizenPeriodOverride(citizenId, period){
  if(!citizenId || !period) return null;
  const raw = _deferredPeriodOverrides()[citizenId];
  if(!raw || typeof raw!=="object") return null;
  const state=raw[period];
  if(state && typeof state==="object" && Object.prototype.hasOwnProperty.call(state,"value")){
    return {value:Boolean(state.value),at:Number(state.at)||0};
  }
  if(typeof state==="boolean") return {value:state,at:0};
  return null;
}

export function getCitizenChargeOverride(citizenId, entry){
  if(!entry || !citizenId) return null;
  const raw = _deferredPeriodOverrides()[citizenId];
  if(raw && typeof raw==="object"){
    if(entry.entryId && Object.prototype.hasOwnProperty.call(raw, entry.entryId)){
      const state=raw[entry.entryId];
      if(state && typeof state==="object" && Object.prototype.hasOwnProperty.call(state,"value")){
        return {value:Boolean(state.value),at:Number(state.at)||0};
      }
      if(typeof state==="boolean") return {value:state,at:0};
    }
  }
  return getCitizenPeriodOverride(citizenId, String(entry.note||"").trim());
}

export function isPeriodDeferredForCitizen(e, citizenId){
  if(!e || (e.type!=="charge" && e.type!=="sanitationFee")) return false;
  const period=String(e.note||"").trim();
  const override=getCitizenChargeOverride(citizenId, e);
  const bulkAt=_deferredPeriodUpdatedAt()[period] || 0;
  const overrideAt=override ? override.at : -1;

  // >= so an explicit per-charge/period override wins on a tie — e.g. legacy
  // overrides stored with at:0, or two actions in the same millisecond.
  if(override && overrideAt >= bulkAt) return override.value;
  if(period && _deferredPeriods().includes(period)) return true;
  if(override) return override.value;
  return Boolean(e.deferred);
}

/* ---------- ledger maths ---------- */

export function calculateLedgerState(entries, citizenId){
  // Simple ledger accounting:
  //   active charges + active sanitation fees - all payments - all waivers
  // Deferred charges are excluded entirely. Payments are never matched to
  // individual periods; timing does not matter and overpayment is allowed.
  let totalCharged=0;
  let totalPaid=0;
  let totalWaived=0;
  let deferredRemaining=0;
  const owed=[];

  for(const e of (entries||[])){
    if(!e) continue;
    const amt=Math.max(0, Number(e.amount)||0);

    if(e.type==="payment"){
      totalPaid += amt;
      continue;
    }

    if(e.type==="forgive"){
      totalWaived += amt;
      continue;
    }

    if(e.type!=="charge" && e.type!=="sanitationFee") continue;

    const deferred=isPeriodDeferredForCitizen(e,citizenId);

    if(deferred){
      // Deferred charges stay recorded but are out of the active balance.
      // Keep their amount separately so the Deferred dashboard total stays live.
      deferredRemaining += amt;
      continue;
    }

    totalCharged += amt;
    owed.push({
      note:e.type==="sanitationFee" ? "" : e.note,
      remaining:amt
    });
  }

  // Waivers reduce the active amount owed, without changing the ledger
  // entries themselves.
  let waiverCredit=Math.min(totalWaived,totalCharged);
  for(const item of owed){
    if(waiverCredit<=0) break;
    const applied=Math.min(waiverCredit,item.remaining);
    item.remaining-=applied;
    waiverCredit-=applied;
  }

  const activeRemaining=owed.reduce((sum,item)=>sum+item.remaining,0);
  const rawBalance=activeRemaining-totalPaid;
  const balance=rawBalance;

  return {
    totalCharged,
    totalPaid,
    totalWaived,
    appliedWaiver:totalWaived-waiverCredit,
    deferredRemaining,
    owed:owed.filter(item=>item.remaining>0),
    activeRemaining,
    unappliedPayment:Math.max(0,-balance),
    balance
  };
}

export function allocateLedgerPayments(entries, citizenId){
  const state=calculateLedgerState(entries,citizenId);
  return {
    owed:state.owed,
    deferredRemaining:state.deferredRemaining,
    unappliedPayment:state.unappliedPayment,
    balance:state.balance
  };
}

// FIFO-allocates payments against all charges first, then exposes only
// active (non-deferred) charges as currently owed. This prevents
// payments that already settled a period from becoming phantom overpayments
// merely because that period was later deferred.
export function getOwedBreakdown(entries, citizenId){
  return allocateLedgerPayments(entries, citizenId).owed;
}

export function recalcFromLedger(entries, citizenId){
  let grossCharges=0, totalPaid=0, totalWaived=0;
  for(const e of entries){
    if(!e || typeof e.amount === 'undefined') continue;
    const amt=Number(e.amount)||0;
    if(e.type==="charge" || e.type==="sanitationFee") grossCharges+=amt;
    else if(e.type==="payment") totalPaid+=amt;
    else if(e.type==="forgive") totalWaived+=amt;
  }
  const allocation=allocateLedgerPayments(entries, citizenId);
  return {
    totalCharged:Math.max(0, grossCharges - Math.min(grossCharges, totalWaived)),
    totalPaid,
    balance:allocation.balance,
    deferredTotal:allocation.deferredRemaining
  };
}

/* ---------- period helpers ---------- */

export function periodKey(note){
  const s=String(note||"").trim().toUpperCase();
  const m=s.match(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*([0-9]*)$/);
  if(!m) return 9999;
  const idx={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[m[1]];
  return idx*10 + (m[2]?parseInt(m[2],10):0);
}
