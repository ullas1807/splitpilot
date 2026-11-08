// Scheduled trigger: POST to the Vercel endpoint with a shared secret.
// Set the secret once with:  npx wrangler secret put CRON_SECRET
async function sweep(env) {
  const res = await fetch(env.SWEEP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
  });
  console.log('sweep status', res.status);
  if (!res.ok) throw new Error(`Sweep failed: ${res.status}`);
}

export default {
  async scheduled(event, env, ctx) {
    await sweep(env);
  },
};
