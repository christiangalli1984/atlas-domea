// Atlas Domea — pagina pubblica di disponibilità
// Legge il calendario prenotazioni di Christian (link segreto iCal di Google Calendar)
// e mostra le notti libere/occupate dei prossimi 90 giorni.
// ?format=json restituisce i dati grezzi.

const ICS_URL = Deno.env.get("GOOGLE_ICS_URL") ?? "";
const DAYS_AHEAD = 90;
const TZ = "Europe/Rome";

// Solo gli eventi il cui titolo contiene una di queste parole contano come prenotazioni:
// "Stay at ..." (sync Airbnb/Booking) o eventi manuali tipo "Prenotazione Rossi".
const BOOKING_KEYWORDS = (Deno.env.get("BOOKING_KEYWORDS") ?? "stay at,prenotazione,domea")
  .split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);

type Range = { start: string; end: string }; // date ISO (YYYY-MM-DD), end esclusiva

function toISODate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

function parseICSDate(raw: string): string | null {
  // Formati: 20260810 | 20260810T140000Z | 20260810T140000
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`; // all-day
  const dt = m[7]
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
    : new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return toISODate(dt);
}

function parseICS(ics: string): Range[] {
  // Unfold delle righe (continuazioni iniziano con spazio/tab)
  const lines = ics.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  const ranges: Range[] = [];
  let start: string | null = null;
  let end: string | null = null;
  let summary = "";
  let inEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { inEvent = true; start = end = null; summary = ""; continue; }
    if (line === "END:VEVENT") {
      const isBooking = BOOKING_KEYWORDS.some((k) => summary.toLowerCase().includes(k));
      if (inEvent && start && isBooking) ranges.push({ start, end: end ?? start });
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
  return ranges;
}

function computeNights(ranges: Range[]): { date: string; free: boolean }[] {
  const occupied = new Set<string>();
  for (const r of ranges) {
    const d = new Date(`${r.start}T12:00:00`);
    const endD = new Date(`${(r.end >= r.start ? r.end : r.start)}T12:00:00`);
    // DTEND esclusiva: l'ultima notte occupata è end-1 (il giorno di check-out si libera)
    if (+endD === +d) occupied.add(r.start); // evento di un solo giorno
    while (d < endD) { occupied.add(toISODate(d)); d.setDate(d.getDate() + 1); }
  }
  const out: { date: string; free: boolean }[] = [];
  const today = new Date();
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    const iso = toISODate(d);
    out.push({ date: iso, free: !occupied.has(iso) });
  }
  return out;
}

function groupRanges(nights: { date: string; free: boolean }[], free: boolean): string[] {
  const out: string[] = [];
  let runStart: string | null = null;
  let prev: string | null = null;
  for (const n of nights) {
    if (n.free === free) {
      if (!runStart) runStart = n.date;
      prev = n.date;
    } else if (runStart && prev) {
      out.push(runStart === prev ? fmt(runStart) : `dal ${fmt(runStart)} al ${fmt(prev)}`);
      runStart = prev = null;
    }
  }
  if (runStart && prev) out.push(runStart === prev ? fmt(runStart) : `dal ${fmt(runStart)} al ${fmt(prev)}`);
  return out;
}

function fmt(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("it-IT", {
    day: "numeric", month: "long", year: "numeric", timeZone: TZ,
  });
}

Deno.serve(async (req) => {
  if (!ICS_URL) {
    return new Response("Configurazione in corso: manca GOOGLE_ICS_URL.", { status: 503 });
  }

  let ics: string;
  try {
    const res = await fetch(ICS_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
    ics = await res.text();
  } catch (e) {
    console.error(e);
    return new Response("Calendario momentaneamente non raggiungibile.", { status: 502 });
  }

  const nights = computeNights(parseICS(ics));
  const updatedAt = new Date().toLocaleString("it-IT", { timeZone: TZ });

  if (new URL(req.url).searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ updatedAt, nights }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const freeRanges = groupRanges(nights, true);
  const busyRanges = groupRanges(nights, false);

  const cells = nights.map((n) =>
    `<div class="day ${n.free ? "free" : "busy"}" title="${fmt(n.date)}">` +
    `<span>${n.date.slice(8)}</span><small>${new Date(`${n.date}T12:00:00`).toLocaleDateString("it-IT", { month: "short", timeZone: TZ })}</small></div>`
  ).join("");

  const html = `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Disponibilità — Domea House &amp; Spa</title>
<style>
  body{font-family:Georgia,serif;background:#faf7f2;color:#3a3430;max-width:720px;margin:0 auto;padding:24px}
  h1{font-size:1.5rem;font-weight:normal} .sub{color:#8a7f74;font-size:.9rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:6px;margin:20px 0}
  .day{border-radius:8px;padding:6px 2px;text-align:center;font-size:.95rem}
  .day small{display:block;font-size:.6rem;text-transform:uppercase;letter-spacing:.05em}
  .free{background:#e6efe2;color:#3e5c38} .busy{background:#efe2e2;color:#7c4a44;text-decoration:line-through}
  .legend{font-size:.85rem;color:#8a7f74} .legend b{font-weight:normal;padding:2px 8px;border-radius:6px}
  section{margin-top:28px} h2{font-size:1.05rem} li{margin:4px 0}
</style></head><body>
<h1>Domea House &amp; Spa — Disponibilità</h1>
<p class="sub">Notti disponibili dei prossimi ${DAYS_AHEAD} giorni · aggiornato in tempo reale al ${updatedAt} (ora italiana)</p>
<p class="legend"><b class="free">verde = notte libera</b> &nbsp; <b class="busy">rosso = notte occupata</b> · il giorno di check-out la casa si libera per nuovi arrivi</p>
<div class="grid">${cells}</div>
<section>
<h2>Periodi liberi</h2>
<ul>${freeRanges.map((r) => `<li>${r}</li>`).join("") || "<li>Nessuna notte libera nei prossimi 90 giorni.</li>"}</ul>
<h2>Periodi occupati</h2>
<ul>${busyRanges.map((r) => `<li>${r}</li>`).join("") || "<li>Tutte le notti sono libere nei prossimi 90 giorni.</li>"}</ul>
</section>
<p class="sub">Per prenotare scrivici su WhatsApp: la disponibilità mostrata è indicativa e viene sempre riconfermata da noi al momento della richiesta.</p>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});
