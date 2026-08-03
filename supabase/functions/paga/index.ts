// Atlas Domea — redirect al link di pagamento.
// Passare dal nostro dominio evita che il telefono apra l'app Revolut
// (gli universal link scattano solo sul dominio toccato, non dopo un redirect).

const PAYMENT_URL = Deno.env.get("PAYMENT_URL") ?? "https://revolut.me/christian_galli";

Deno.serve(() =>
  new Response(null, {
    status: 302,
    headers: { "Location": PAYMENT_URL, "Cache-Control": "no-store" },
  })
);
