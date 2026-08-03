// Atlas Domea — webhook WhatsApp Cloud API
// GET  = verifica webhook (handshake Meta)
// POST = messaggio in arrivo → salva su DB → risposta di Claude → invio su WhatsApp

import { createClient } from "npm:@supabase/supabase-js@2";
import { ATLAS_SYSTEM_PROMPT } from "./prompt.ts";

const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GRAPH_URL = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

async function sendWhatsApp(to: string, body: string) {
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) console.error("WhatsApp send error:", res.status, await res.text());
}

async function askClaude(history: { role: string; content: string }[]) {
  const messages = history.map((m) => ({
    role: m.role === "guest" ? "user" : "assistant",
    content: m.content,
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: ATLAS_SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    console.error("Anthropic error:", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? null;
}

async function handleIncomingMessage(msg: { from: string; id: string; text: string; profileName: string | null }) {
  // Dedup: Meta ritenta la consegna se non riceve 200 in fretta.
  const { data: existing } = await supabase
    .from("messages").select("id").eq("wa_message_id", msg.id).maybeSingle();
  if (existing) return;

  let { data: guest } = await supabase
    .from("guests").select("*").eq("phone", msg.from).maybeSingle();
  if (!guest) {
    const { data: created, error } = await supabase
      .from("guests").insert({ phone: msg.from, name: msg.profileName }).select().single();
    if (error) { console.error("guest insert:", error); return; }
    guest = created;
  }

  await supabase.from("messages").insert({
    guest_id: guest.id, role: "guest", wa_message_id: msg.id, content: msg.text,
  });

  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("guest_id", guest.id)
    .order("created_at", { ascending: true })
    .limit(30);

  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY mancante: nessuna risposta generata");
    return;
  }

  const reply = await askClaude(history ?? [{ role: "guest", content: msg.text }]);
  if (!reply) return;

  await supabase.from("messages").insert({ guest_id: guest.id, role: "atlas", content: reply });
  await sendWhatsApp(msg.from, reply);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Handshake di verifica del webhook (Meta chiama in GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Estrae i messaggi di testo dal payload WhatsApp (ignora status/ricevute)
  // deno-lint-ignore no-explicit-any
  const value = (payload as any)?.entry?.[0]?.changes?.[0]?.value;
  const waMsg = value?.messages?.[0];
  if (waMsg?.type === "text") {
    const task = handleIncomingMessage({
      from: waMsg.from,
      id: waMsg.id,
      text: waMsg.text.body,
      profileName: value?.contacts?.[0]?.profile?.name ?? null,
    }).catch((e) => console.error("handleIncomingMessage:", e));
    // Rispondi 200 subito a Meta; l'elaborazione continua in background.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(task);
  }

  return new Response("OK", { status: 200 });
});
