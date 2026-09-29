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

/* ---------- per-period allocation (reporting only) */
// Splits one household's ledger across periods for the by-period export.
// Active (non-deferred) charges are ordered by upload time, oldest first —
// the same order the live ledger uses — and waivers, then payments, are
// applied to them in that order. Period labels are NOT used for ordering,
// so a year rollover (JAN after DEC) cannot misallocate anything.
// Accepts createdAt (live ledger) or createdAtMs (export/backup shape).
// Ties keep the order the entries were given in.
// This is a reporting view only — the real balance never depends on it.
// Returns { [period]: {charged, deferred, waived, paid, still} }.
export function allocateByPeriod(entries, citizenId){
  const out={};
  const row=p=>out[p]||(out[p]={charged:0,deferred:0,waived:0,paid:0,still:0});
  const timeOf=e=>e.createdAt!=null ? entryTimeMs(e) : (Number(e.createdAtMs)||0);
  const active=[];
  let waivedLeft=0, paidLeft=0;
  (entries||[]).forEach((e,i)=>{
    if(!e) return;
    const amt=Math.max(0, Number(e.amount)||0);
    if(e.type==="payment"){ paidLeft+=amt; return; }
    if(e.type==="forgive"){ waivedLeft+=amt; return; }
    if(e.type!=="charge" && e.type!=="sanitationFee") return;
    const period=String(e.note||"").trim();
    row(period).charged+=amt;
    if(isPeriodDeferredForCitizen(e,citizenId)){ row(period).deferred+=amt; return; }
    active.push({period, left:amt, t:timeOf(e), i});
  });
  active.sort((a,b)=>a.t-b.t||a.i-b.i);
  for(const it of active){
    const w=Math.min(waivedLeft,it.left);
    waivedLeft-=w; it.left-=w; row(it.period).waived+=w;
  }
  for(const it of active){
    const p=Math.min(paidLeft,it.left);
    paidLeft-=p; it.left-=p; row(it.period).paid+=p;
  }
  for(const it of active) row(it.period).still+=it.left;
  return out;
}

/* ---------- period display order */
// Periods are ordered by the day they were first uploaded, so a label that
// repeats across a year rollover (JAN after DEC) still sorts after the
// earlier months. Within the same upload day — e.g. a historical register
// imported in one go — periodKey (month, then batch number) breaks the tie.
// Display order only; no balance ever depends on it.
function _uploadDay(ms){
  if(!ms) return 0;
  const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime();
}
// ledgers: iterable of entry arrays (live ledgers or export ledgers).
export function buildPeriodOrder(ledgers){
  const first=new Map();
  for(const entries of ledgers){
    for(const e of (entries||[])){
      if(!e || (e.type!=="charge" && e.type!=="sanitationFee")) continue;
      const p=String(e.note||"").trim();
      if(!p) continue;
      const ms=e.createdAt!=null ? entryTimeMs(e) : (Number(e.createdAtMs)||0);
      const day=_uploadDay(ms);
      if(!first.has(p) || day<first.get(p)) first.set(p,day);
    }
  }
  return first;
}
export function comparePeriods(order){
  return (a,b)=>((order.get(a)||0)-(order.get(b)||0)) || periodKey(a)-periodKey(b) || String(a).localeCompare(String(b));
}

/* ---------- entry sorting ---------- */
// createdAt may be a number (Date.now()), a Firestore serverTimestamp read
// back as a Timestamp-like object ({seconds, nanoseconds}), or missing on
// old imported entries. Plain `a-b` subtraction on Timestamps is NaN, which
// silently disables the sort. These helpers normalise all three shapes so
// the ledger always renders newest-first consistently.
export function entryTimeMs(e){
  const c = e && e.createdAt;
  if(c && typeof c === "object" && !Array.isArray(c) && typeof c.seconds === "number"){
    return c.seconds * 1000 + (typeof c.nanoseconds === "number" ? c.nanoseconds / 1e6 : 0);
  }
  return Number(c) || 0;
}
export function sortLedgerEntries(entries, newestFirst = true){
  return [...entries].sort((a,b)=>{
    const diff = entryTimeMs(b) - entryTimeMs(a);
    return newestFirst ? diff : -diff;
  });
}
