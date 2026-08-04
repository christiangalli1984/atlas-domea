// Atlas Domea — pagina pubblica di disponibilità
// Legge il calendario di Christian (link segreto iCal di Google Calendar) più i feed
// iCal delle OTA (Airbnb/Booking) e mostra le notti libere/occupate.
// ?format=json restituisce i dati grezzi.

const ICS_URL = Deno.env.get("GOOGLE_ICS_URL") ?? "";
// Calendario "Domea": il registro prenotazioni di Christian. Contiene sia prenotazioni
// (eventi giorno-intero, titoli liberi tipo "X2 Michela 260€") sia promemoria operativi
// (eventi con orario): contano solo i giorno-intero, senza filtro sui titoli.
const DOMEA_ICS_URL = Deno.env.get("DOMEA_ICS_URL") ?? "";
// Feed iCal delle OTA (Airbnb, Booking...), separati da virgola. Sono calendari
// dedicati all'annuncio: OGNI loro evento conta come notte occupata, senza filtro.
const OTA_ICS_URLS = (Deno.env.get("OTA_ICS_URLS") ?? "")
  .split(",").map((u) => u.trim()).filter(Boolean);
const DAYS_AHEAD = Number(Deno.env.get("DAYS_AHEAD") ?? "180");
const TZ = "Europe/Rome";

// Il calendario Google è quello personale: contano come prenotazioni solo gli eventi
// il cui titolo contiene una di queste parole ("Stay at ..." creati da Gmail o
// eventi manuali tipo "Prenotazione Rossi").
const BOOKING_KEYWORDS = (Deno.env.get("BOOKING_KEYWORDS") ?? "stay at,prenotazione,domea")
  .split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);

type Range = { start: string; end: string }; // date ISO (YYYY-MM-DD), end esclusiva
type IcsEvent = Range & { summary: string; allDay: boolean };

// Regola con cui un feed decide quali eventi contano come prenotazioni.
type FeedMode = "keywords" | "allday" | "all";

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

function parseICS(ics: string): IcsEvent[] {
  // Unfold delle righe (continuazioni iniziano con spazio/tab)
  const lines = ics.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  const events: IcsEvent[] = [];
  let start: string | null = null;
  let end: string | null = null;
  let summary = "";
  let allDay = false;
  let inEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { inEvent = true; start = end = null; summary = ""; allDay = false; continue; }
    if (line === "END:VEVENT") {
      if (inEvent && start) events.push({ start, end: end ?? start, summary, allDay });
      inEvent = false; continue;
    }
    if (!inEvent) continue;
    const s = line.match(/^SUMMARY(?:;[^:]*)?:(.*)$/);
    if (s) { summary = s[1]; continue; }
    const m = line.match(/^(DTSTART|DTEND)(?:;[^:]*)?:(.+)$/);
    if (m) {
      const raw = m[2].trim();
      const iso = parseICSDate(raw);
      if (m[1] === "DTSTART") { start = iso; allDay = !raw.includes("T"); }
      else end = iso;
    }
  }
  return events;
}

function isBooking(ev: IcsEvent, mode: FeedMode): boolean {
  if (mode === "all") return true;
  if (mode === "allday") return ev.allDay;
  return BOOKING_KEYWORDS.some((k) => ev.summary.toLowerCase().includes(k));
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
  const feeds: { url: string; mode: FeedMode }[] = [
    ...(ICS_URL ? [{ url: ICS_URL, mode: "keywords" as const }] : []),
    ...(DOMEA_ICS_URL ? [{ url: DOMEA_ICS_URL, mode: "allday" as const }] : []),
    ...OTA_ICS_URLS.map((url) => ({ url, mode: "all" as const })),
  ];
  if (feeds.length === 0) {
    return new Response("Configurazione in corso: nessun calendario configurato.", { status: 503 });
  }

  // Se anche un solo feed non risponde ci fermiamo: meglio nessuna risposta
  // che mostrare come libera una notte prenotata sul feed mancante.
  let ranges: Range[];
  try {
    const texts = await Promise.all(feeds.map(async (f) => {
      const res = await fetch(f.url, { headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) throw new Error(`ICS fetch ${res.status}: ${f.url.slice(0, 60)}`);
      return res.text();
    }));
    ranges = feeds.flatMap((f, i) => parseICS(texts[i]).filter((ev) => isBooking(ev, f.mode)));
  } catch (e) {
    console.error(e);
    return new Response("Calendario momentaneamente non raggiungibile.", { status: 502 });
  }

  const nights = computeNights(ranges);
  const updatedAt = new Date().toLocaleString("it-IT", { timeZone: TZ });

  if (new URL(req.url).searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ updatedAt, nights }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*", // la pagina di prenotazione legge da qui
      },
    });
  }

  const freeRanges = groupRanges(nights, true);
  const busyRanges = groupRanges(nights, false);

  // Testo semplice: Supabase riscrive il content-type text/html in text/plain
  // sui domini *.supabase.co (anti-phishing), quindi serviamo direttamente
  // testo formattato — leggibile per le persone, perfetto per le AI.
  const text = `DOMEA HOUSE & SPA — Calcata (VT)
DISPONIBILITÀ DELLE NOTTI · prossimi ${DAYS_AHEAD} giorni

Aggiornato in tempo reale al ${updatedAt} (ora italiana).
Il giorno di check-out la casa si libera per nuovi arrivi.

──────────────────────────────────────

✅ PERIODI LIBERI

${freeRanges.map((r) => `  • ${r}`).join("\n") || `  Nessuna notte libera nei prossimi ${DAYS_AHEAD} giorni.`}

❌ PERIODI OCCUPATI

${busyRanges.map((r) => `  • ${r}`).join("\n") || `  Tutte le notti sono libere nei prossimi ${DAYS_AHEAD} giorni.`}

──────────────────────────────────────

Per prenotare scrivici su WhatsApp: la disponibilità mostrata è
indicativa e viene sempre riconfermata da noi al momento della richiesta.`;

  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});
