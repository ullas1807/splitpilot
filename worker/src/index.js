// Scheduled trigger: POST to the Vercel endpoint with a shared secret.
// Set the secret once with:  npx wrangler secret put CRON_SECRET
async function sweep(env) {
  const res = await fetch(env.SWEEP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Sweep failed: ${res.status} ${body}`);
  console.log('sweep ok', body);
  return body;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
  // Handy for manual testing: open the worker URL in a browser.
  async fetch(request, env) {
    const out = await sweep(env).catch((e) => String(e));
    return new Response(out, { headers: { 'content-type': 'text/plain' } });
  },
};
