/* Pure, DOM-free helpers shared by the NSNVC Contribution Tracker. */

export const fmt = n => "₹" + (Number(n) || 0).toLocaleString("en-IN");

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;",
  "<":"&lt;",
  ">":"&gt;",
  '"':"&quot;",
  "'":"&#39;"
}[c]));

export function todayISO(){
  return new Date().toISOString().slice(0,10);
}

export function entryLabel(e){
  if(!e || !e.type) return "Unknown";
  if(e.type === "payment"){
    const note = String(e.note || "").trim().toLowerCase();
    return note === "bank" ? "Bank" : "Cash";
  }
  if(e.type === "forgive") return "Waived";
  if(e.type === "return" || (e.type === "charge" && String(e.note || "").trim() === "Return")) return "Return";
  if(e.type === "sanitationFee") return "Sanitation Fee";
  return String(e.note || "").trim() || "Contribution";
}

export function suffixOf(s){
  s = String(s || "").trim();
  const i = s.lastIndexOf("/");
  return (i >= 0 ? s.slice(i + 1) : s).trim().toLowerCase();
}

export function fullKey(s){
  return (String(s || "").trim().replace(/\//g,"%2F").replace(/^\.+$/,"_")) || "_";
}

export function seqNum(s){
  const n = parseInt(String(s == null ? "" : s).replace(/[^0-9]/g,""),10);
  return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

export function byCardNo(a,b){
  const d = seqNum(a.cardNo) - seqNum(b.cardNo);
  return d !== 0 ? d : String(a.jobCard || a.id).localeCompare(String(b.jobCard || b.id));
}

export function firestoreTimeMs(value){
  if(!value) return 0;
  if(typeof value === "number") return value;
  if(typeof value.toMillis === "function") return value.toMillis();
  if(typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}
