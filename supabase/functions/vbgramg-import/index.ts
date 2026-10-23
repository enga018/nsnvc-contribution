import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const PROJECT_ID = "nsnvc-contribution";
const EXPECTED_SOURCE = "https://vbgramgrep.dord.gov.in/VBGRAMG/writereaddata/citizen_out/panchregpeople_2207001005_eng2627.html";
const ALLOWED_ORIGINS = new Set(["https://enga018.github.io"]);
const FIREBASE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://enga018.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function authenticate(req: Request, db: ReturnType<typeof createClient>) {
  const header = req.headers.get("Authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error("Sign in to the NSNVC tracker before using the importer.");
  const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const uid = typeof payload.sub === "string" ? payload.sub : "";
  if (!uid || !email || payload.email_verified !== true) throw new Error("A verified Firebase account is required.");
  const { data: admin, error } = await db.from("vbgramg_admins").select("email").eq("email", email).maybeSingle();
  if (error) throw new Error("Could not verify NSNVC importer permissions.");
  if (!admin) throw new Error("This Firebase account is not on the authorized NSNVC importer list.");
  return { uid, email };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin || "https://enga018.github.io" } });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed." }, 403);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server storage is not configured." }, 500);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const actor = await authenticate(req, db);
    const body = await req.json();
    if (!body || typeof body.action !== "string") return json({ error: "Invalid request." }, 400);

    if (body.action === "active") {
      const { data: state, error: stateError } = await db.from("vbgramg_import_state").select("*").eq("singleton", true).maybeSingle();
      if (stateError) throw new Error("Could not read active import state.");
      if (!state?.active_import_id) return json({ state: state ?? null, records: [] });
      const records: Record<string, unknown>[] = [];
      const pageSize = 500;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await db.from("vbgramg_records")
          .select("serial,job_card,jc_no,household,applicant,applicant_no,unique_id,status")
          .eq("import_id", state.active_import_id)
          .order("serial", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw new Error("Could not load saved import records.");
        records.push(...(data || []));
        if (!data || data.length < pageSize) break;
      }
      if (records.length !== state.record_count) throw new Error("Saved record count does not match the active import metadata. No data was changed.");
      return json({ state, records });
    }

    if (body.action === "save") {
      if (body.sourceUrl !== EXPECTED_SOURCE) return json({ error: "Unexpected report source URL." }, 400);
      if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 20000) {
        return json({ error: "Record list is empty or exceeds the 20,000-record safety limit." }, 400);
      }
      const rows = body.records.map((r: Record<string, unknown>, i: number) => {
        const serial = Number(r.serial);
        const jobCard = String(r.jobCard ?? "").trim();
        const jcNo = String(r.jcNo ?? "").trim();
        const uniqueId = String(r.uniqueId ?? "").trim();
        const applicantNo = Number(r.applicantNo ?? 1);
        if (!Number.isInteger(serial) || serial < 1 || !jobCard || !jcNo || !uniqueId || !Number.isInteger(applicantNo) || applicantNo < 1) {
          throw new Error(`Invalid imported record at position ${i + 1}.`);
        }
        return {
          record_key: String(serial).padStart(6, "0"),
          serial, job_card: jobCard, jc_no: jcNo,
          household: String(r.household ?? ""),
          applicant: String(r.applicant ?? ""),
          applicant_no: applicantNo, unique_id: uniqueId,
          status: String(r.status ?? "Active"),
        };
      });
      const serials = new Set(rows.map((r: { serial: number }) => r.serial));
      if (serials.size !== rows.length) return json({ error: "Imported records contain duplicate serial numbers." }, 400);

      const { data: priorState, error: priorError } = await db.from("vbgramg_import_state").select("active_import_id").eq("singleton", true).single();
      if (priorError) throw new Error("Could not read previous active import.");
      const previousId = priorState.active_import_id as string | null;
      const { data: staged, error: stageError } = await db.from("vbgramg_imports").insert({
        source_url: body.sourceUrl, imported_by_uid: actor.uid, imported_by_email: actor.email,
        record_count: rows.length, deleted_skipped: Math.max(0, Number(body.deletedSkipped) || 0), status: "staging",
      }).select("id").single();
      if (stageError || !staged) throw new Error("Could not create the staging import.");
      const importId = staged.id as string;
      try {
        for (let i = 0; i < rows.length; i += 200) {
          const batch = rows.slice(i, i + 200).map((row: Record<string, unknown>) => ({ ...row, import_id: importId }));
          const { error } = await db.from("vbgramg_records").insert(batch);
          if (error) throw new Error("Failed to save import batch " + (Math.floor(i / 200) + 1) + ".");
        }
        const { count, error: countError } = await db.from("vbgramg_records").select("record_key", { count: "exact", head: true }).eq("import_id", importId);
        if (countError || count !== rows.length) throw new Error("Staged record count verification failed.");
        const { error: completeError } = await db.from("vbgramg_imports").update({ status: "complete", completed_at: new Date().toISOString() }).eq("id", importId);
        if (completeError) throw new Error("Could not finalize staged import metadata.");
        const { error: pointerError } = await db.from("vbgramg_import_state").update({
          active_import_id: importId, source_url: body.sourceUrl, record_count: rows.length,
          deleted_skipped: Math.max(0, Number(body.deletedSkipped) || 0), updated_at: new Date().toISOString(),
        }).eq("singleton", true);
        if (pointerError) throw new Error("Could not activate the verified import; the previous snapshot remains active.");
      } catch (error) {
        // A timed-out pointer update may have committed. Never delete a snapshot
        // until we have checked whether it became active.
        const { data: currentState } = await db.from("vbgramg_import_state")
          .select("active_import_id").eq("singleton", true).maybeSingle();
        if (currentState?.active_import_id === importId) {
          return json({
            ok: true, importId, recordCount: rows.length,
            deletedSkipped: Math.max(0, Number(body.deletedSkipped) || 0),
            cleanupWarning: true,
            warning: "The new snapshot is active, but the activation response was interrupted."
          });
        }
        await db.from("vbgramg_imports").delete().eq("id", importId);
        throw error;
      }
      let cleanupWarning = false;
      if (previousId && previousId !== importId) {
        const { error } = await db.from("vbgramg_imports").delete().eq("id", previousId);
        cleanupWarning = Boolean(error);
      }
      return json({ ok: true, importId, recordCount: rows.length, deletedSkipped: Math.max(0, Number(body.deletedSkipped) || 0), cleanupWarning });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    const status = /Sign in|verified Firebase|not on the authorized/i.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
});
