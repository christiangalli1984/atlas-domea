// Atlas Domea — richiesta di prenotazione dalla pagina pubblica
// POST { name, phone, email?, guests, checkin, checkout, note? }
// Rivalida le date sul calendario (mai fidarsi del client) e salva la richiesta.

import { createClient } from "npm:@supabase/supabase-js@2";

const ICS_URL = Deno.env.get("GOOGLE_ICS_URL") ?? "";
const TZ = "Europe/Rome";
const BOOKING_KEYWORDS = (Deno.env.get("BOOKING_KEYWORDS") ?? "stay at,prenotazione,domea")
  .split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function toISODate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

function parseICSDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  const dt = m[7]
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
    : new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return toISODate(dt);
}

async function fetchOccupiedNights(): Promise<Set<string>> {
  const res = await fetch(ICS_URL, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
  const ics = (await res.text()).replace(/\r\n[ \t]/g, "");
  const occupied = new Set<string>();
  let start: string | null = null, end: string | null = null, summary = "", inEvent = false;
  for (const line of ics.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") { inEvent = true; start = end = null; summary = ""; continue; }
    if (line === "END:VEVENT") {
      const isBooking = BOOKING_KEYWORDS.some((k) => summary.toLowerCase().includes(k));
      if (inEvent && start && isBooking) {
        const d = new Date(`${start}T12:00:00`);
        const endD = new Date(`${((end ?? start) >= start ? (end ?? start) : start)}T12:00:00`);
        if (+endD === +d) occupied.add(start);
        while (d < endD) { occupied.add(toISODate(d)); d.setDate(d.getDate() + 1); }
      }
      inEvent = false; continue;
    }
    if (!inEvent) continue;
    if (line.startsWith("SUMMARY:")) { summary = line.slice(8); continue; }
    const m = line.match(/^(DTSTART|DTEND)(?:;[^:]*)?:(.+)$/);
    if (m) {
      const iso = parseICSDate(m[2].trim());
      if (m[1] === "DTSTART") start = iso; else end = iso;
    }
  }
  return occupied;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  const name = String(body.name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim() || null;
  const note = String(body.note ?? "").trim().slice(0, 1000) || null;
  const guests = Math.min(6, Math.max(1, Number(body.guests ?? 2) || 2));
  const checkin = String(body.checkin ?? "");
  const checkout = String(body.checkout ?? "");

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (name.length < 2 || phone.length < 6) return json(400, { error: "missing_contact" });
  if (!dateRe.test(checkin) || !dateRe.test(checkout)) return json(400, { error: "bad_dates" });

  const today = toISODate(new Date());
  const maxDate = toISODate(new Date(Date.now() + 365 * 24 * 3600 * 1000));
  if (checkin < today || checkin >= checkout || checkout > maxDate) {
    return json(400, { error: "bad_range" });
  }

  // Riverifica la disponibilità sul calendario in tempo reale
  let occupied: Set<string>;
  try {
    occupied = await fetchOccupiedNights();
  } catch (e) {
    console.error(e);
    return json(502, { error: "calendar_unreachable" });
  }

  const nights: string[] = [];
  const d = new Date(`${checkin}T12:00:00`);
  const endD = new Date(`${checkout}T12:00:00`);
  while (d < endD) { nights.push(toISODate(d)); d.setDate(d.getDate() + 1); }
  const conflict = nights.filter((n) => occupied.has(n));
  if (conflict.length > 0) return json(409, { error: "not_available", nights: conflict });

  const { data, error } = await supabase.from("booking_requests").insert({
    name, phone, email, guests, checkin, checkout, note,
  }).select("id").single();
  if (error) { console.error(error); return json(500, { error: "db_error" }); }

  return json(200, { ok: true, id: data.id, nights: nights.length });
});
