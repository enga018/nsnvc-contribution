/**
 * Optional Cloudflare Worker fetcher for the NSNVC VB-GRAMG importer.
 *
 * Deploy this file as a Worker, then paste its HTTPS URL into the importer's
 * "Optional server-side fetcher endpoint" field.
 *
 * Security: this Worker fetches ONE fixed public report URL. It does not accept
 * arbitrary URLs, forward cookies, or bypass login/access controls. If the
 * upstream returns 401/403, the Worker reports that response.
 */
const REPORT_URL =
  "https://vbgramgrep.dord.gov.in/VBGRAMG/writereaddata/citizen_out/panchregpeople_2207001005_eng2627.html";

const ALLOWED_ORIGINS = new Set([
  "https://enga018.github.io",
]);

function corsHeaders(origin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers });
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response("Origin not allowed", { status: 403, headers });
    }

    try {
      const upstream = await fetch(REPORT_URL, {
        method: "GET",
        redirect: "follow",
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!upstream.ok) {
        return new Response(
          "Official VB-GRAMG server returned HTTP " + upstream.status +
            ". This fetcher cannot bypass upstream authentication or access controls.",
          {
            status: upstream.status,
            headers: {
              ...Object.fromEntries(headers),
              "Content-Type": "text/plain; charset=utf-8",
            },
          },
        );
      }

      const html = await upstream.text();
      if (!/<table\b/i.test(html)) {
        return new Response(
          "The official server response did not contain an HTML table; it may be a login or error page.",
          {
            status: 502,
            headers: {
              ...Object.fromEntries(headers),
              "Content-Type": "text/plain; charset=utf-8",
            },
          },
        );
      }

      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("X-Source-URL", REPORT_URL);
      return new Response(html, { status: 200, headers });
    } catch (error) {
      return new Response(
        "Could not connect to the official VB-GRAMG server: " +
          (error instanceof Error ? error.message : String(error)),
        {
          status: 502,
          headers: {
            ...Object.fromEntries(headers),
            "Content-Type": "text/plain; charset=utf-8",
          },
        },
      );
    }
  },
};
