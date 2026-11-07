// Preflight: checks every external service BEFORE you try the full flow.
// Run:  npm run preflight        (reads .env in the project root)
// Fill .env by copying .env.example. This script only reads; it never moves money.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'node:fs';

// Minimal .env loader (works on any Node 20+, no flags needed). Real env vars win over the file.
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: rely on real environment variables */ }

const env = process.env;
let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m, fix) => { failures++; console.log(`  \u2717 ${m}${fix ? `\n      fix: ${fix}` : ''}`); };
const warn = (m) => { warnings++; console.log(`  ! ${m}`); };
const section = (t) => console.log(`\n${t}`);

async function step(label, fn) {
  try { await fn(); } catch (e) { bad(`${label}: ${e.message || e}`); }
}

// ---------- 0. Environment ----------
section('1. Environment variables');
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, 'Install Node 20 or newer');

const required = [
  'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'VITE_PAYPAL_CLIENT_ID',
];
for (const k of required) env[k] ? ok(`${k} is set`) : bad(`${k} is missing`, 'Add it to .env (and to Vercel env vars)');
if (env.PAYPAL_WEBHOOK_ID) ok('PAYPAL_WEBHOOK_ID is set');
else warn('PAYPAL_WEBHOOK_ID is empty. That is fine until you create the webhook in the PayPal Dashboard (after the first deploy).');
if (env.CRON_SECRET) ok('CRON_SECRET is set'); else warn('CRON_SECRET is empty. Only needed for the Wrangler reminder worker.');
if (env.PAYPAL_ENV && env.PAYPAL_ENV !== 'sandbox') bad(`PAYPAL_ENV is "${env.PAYPAL_ENV}"`, 'Set PAYPAL_ENV=sandbox. Never use live for this hackathon.');
else ok('PAYPAL_ENV is sandbox');
if (env.VITE_PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_ID && env.VITE_PAYPAL_CLIENT_ID !== env.PAYPAL_CLIENT_ID) {
  bad('VITE_PAYPAL_CLIENT_ID differs from PAYPAL_CLIENT_ID', 'They must be the same sandbox app Client ID');
}
for (const k of Object.keys(env)) {
  if (k.startsWith('VITE_') && /SECRET|SERVICE_ROLE/i.test(k)) bad(`${k} would be exposed in the browser`, 'Never prefix secrets with VITE_');
}

// Vercel Hobby allows at most 12 functions per deployment (every file in api/ except _lib).
try {
  const fns = readdirSync(new URL('../api', import.meta.url)).filter((f) => f.endsWith('.js'));
  if (fns.length > 12) bad(`${fns.length} files in api/ exceeds the Vercel Hobby limit of 12`, 'Merge endpoints or deploy on a Pro team');
  else if (fns.length === 12) warn('api/ has exactly 12 functions, the Vercel Hobby maximum. Do NOT add another api/*.js file.');
  else ok(`${fns.length} API functions (Hobby limit is 12)`);
} catch { /* api folder not found */ }

// ---------- 1. PayPal ----------
section('2. PayPal sandbox');
let ppToken = null;
await step('PayPal auth', async () => {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return bad('Skipped (missing credentials)');
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return bad(`Sandbox auth failed (HTTP ${res.status})`, 'Use the SANDBOX Client ID and Secret from Apps & Credentials (toggle is on "Sandbox", not "Live")');
  ppToken = (await res.json()).access_token;
  ok('Sandbox credentials work');
});
await step('PayPal webhook', async () => {
  if (!ppToken || !env.PAYPAL_WEBHOOK_ID) return;
  const res = await fetch(`https://api-m.sandbox.paypal.com/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`, {
    headers: { Authorization: `Bearer ${ppToken}` },
  });
  if (res.status === 404) return bad('PAYPAL_WEBHOOK_ID not found for this app', 'Copy the Webhook ID (not the URL) from the same sandbox app');
  if (!res.ok) return warn(`Could not look up the webhook (HTTP ${res.status})`);
  const w = await res.json();
  ok(`Webhook found: ${w.url}`);
  const types = (w.event_types || []).map((t) => t.name);
  for (const need of ['PAYMENT.CAPTURE.COMPLETED']) {
    types.includes(need) || types.includes('*') ? ok(`Subscribed to ${need}`) : bad(`Not subscribed to ${need}`, 'Edit the webhook in the PayPal Dashboard and tick it');
  }
  if (!String(w.url).startsWith('https://')) bad('Webhook URL is not https', 'Use your https://....vercel.app/api/paypal-webhook URL');
  if (!String(w.url).endsWith('/api/paypal-webhook')) warn('Webhook URL does not end with /api/paypal-webhook');
});

// ---------- 2. Supabase ----------
section('3. Supabase');
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  for (const t of ['splits', 'items', 'participants', 'agent_log', 'split_secrets', 'payment_events']) {
    await step(`table ${t}`, async () => {
      const { error } = await admin.from(t).select('*', { count: 'exact', head: true });
      error ? bad(`Table "${t}": ${error.message}`, 'Run supabase/schema.sql in the SQL Editor (and check SUPABASE_URL / service role key)') : ok(`Table "${t}" is reachable`);
    });
  }
  await step('storage bucket', async () => {
    const { data, error } = await admin.storage.getBucket('receipts');
    if (error || !data) return bad('Storage bucket "receipts" not found', 'Re-run schema.sql (its last statement creates the bucket)');
    data.public ? bad('Bucket "receipts" is PUBLIC', 'Make it private in Storage settings') : ok('Bucket "receipts" exists and is private');
  });
  // Lockdown check: the browser key must not be able to read OR write anything directly.
  // The app never talks to Supabase from the browser, so the anon key is optional here.
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (anonKey) {
    const anon = createClient(env.SUPABASE_URL, anonKey, { auth: { persistSession: false } });
    for (const t of ['split_secrets', 'splits', 'participants', 'agent_log', 'items', 'payment_events']) {
      await step(`lockdown ${t}`, async () => {
        const { data } = await anon.from(t).select('*').limit(1);
        data && data.length ? bad(`Anon key CAN read "${t}"`, 'Re-run supabase/schema.sql (it revokes all anon/authenticated privileges)') : ok(`Anon key cannot read "${t}"`);
      });
    }
    await step('lockdown write', async () => {
      const { error } = await anon.from('participants').insert({ split_id: '00000000-0000-0000-0000-000000000000', name: 'x', share: 1 });
      error ? ok('Anon key cannot write to participants') : bad('Anon key CAN write to participants!', 'Re-run supabase/schema.sql');
    });
  } else {
    console.log('  - Lockdown test skipped. To run it, add SUPABASE_ANON_KEY=<your anon key> to .env (local only, never needed in Vercel).');
  }
} else {
  bad('Supabase checks skipped (missing URL or service role key)');
}

// ---------- 3. Gemini ----------
section('4. Gemini');
await step('Gemini', async () => {
  if (!env.GEMINI_API_KEY) return bad('Skipped (GEMINI_API_KEY missing)');
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const headers = { 'x-goog-api-key': env.GEMINI_API_KEY };
  const list = await fetch(`${base}/models?pageSize=200`, { headers });
  if (!list.ok) return bad(`Could not list models (HTTP ${list.status})`, 'Check GEMINI_API_KEY from Google AI Studio');
  const models = (await list.json()).models || [];
  const usable = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/i.test(n) && !/(image|tts|embedding|live|audio|robotics|computer)/i.test(n));
  ok(`Your key can use ${usable.length} Gemini text models`);
  const model = env.GEMINI_MODEL;
  if (!model) return bad('GEMINI_MODEL is not set');
  if (!usable.includes(model)) {
    const flash = usable.filter((n) => /flash/i.test(n)).slice(0, 8);
    return bad(`GEMINI_MODEL "${model}" is not available to your key`, `Set GEMINI_MODEL to one of: ${flash.join(', ') || usable.slice(0, 8).join(', ')}`);
  }
  ok(`GEMINI_MODEL "${model}" is available`);

  // Real call using the same request shape the app uses (system prompt + JSON schema).
  const body = {
    systemInstruction: { parts: [{ text: 'Reply with JSON only.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Return {"ok": true}' }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
    },
  };
  const res = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return bad(`Test call failed: ${data?.error?.message || res.status}`, 'Pick another model or check quota in AI Studio');
  const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  try { JSON.parse(text); ok('Structured JSON output works (used for receipt parsing)'); } catch { bad(`Model did not return valid JSON: ${text.slice(0, 80)}`); }

  // Function calling test (used by the agent).
  const fc = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Call the ping tool with note "hi".' }] }],
      tools: [{ functionDeclarations: [{ name: 'ping', description: 'Ping', parameters: { type: 'OBJECT', properties: { note: { type: 'STRING' } }, required: ['note'] } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    }),
  });
  const fcData = await fc.json().catch(() => ({}));
  const called = (fcData.candidates?.[0]?.content?.parts || []).some((p) => p.functionCall?.name === 'ping');
  called ? ok('Function calling works (used by the agent)') : bad(`Function calling test failed: ${fcData?.error?.message || 'no tool call returned'}`, 'Try a different Flash model in GEMINI_MODEL');
});

// ---------- 4. Grok (optional) ----------
section('5. Grok fallback (optional)');
await step('Grok', async () => {
  if (!env.XAI_API_KEY) return ok('No XAI_API_KEY set. Fallback is disabled, which is fine.');
  const res = await fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${env.XAI_API_KEY}` } });
  if (!res.ok) return bad(`xAI key rejected (HTTP ${res.status})`, 'Check XAI_API_KEY, or clear it to disable the fallback');
  const ids = ((await res.json()).data || []).map((m) => m.id);
  const want = env.XAI_MODEL || 'grok-4';
  ids.includes(want) ? ok(`XAI_MODEL "${want}" is available`) : bad(`XAI_MODEL "${want}" not found`, `Set XAI_MODEL to one of: ${ids.slice(0, 8).join(', ')}`);
});

// ---------- Summary ----------
console.log(`\n${failures ? `\u2717 ${failures} problem${failures > 1 ? 's' : ''}` : '\u2713 All checks passed'}${warnings ? `, ${warnings} note${warnings > 1 ? 's' : ''}` : ''}.`);
if (!failures) console.log('Next: deploy, set the webhook, then run the smoke test in docs/SMOKE_TEST.md.');
process.exit(failures ? 1 : 0);
