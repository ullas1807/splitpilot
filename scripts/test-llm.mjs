// Run with: npm run test:llm  (offline: mocks fetch to check request shape, parsing and Grok fallback)
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.GEMINI_API_KEY = 'g-test';
process.env.XAI_API_KEY = 'x-test';
const { chat, geminiJson } = await import('../api/_lib/llm.js');
const { TOOLS } = await import('../api/_lib/agent-tools.js');
const { RECEIPT_SCHEMA } = await import('../api/_lib/receipt.js');

const calls = [];
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const bad = (status) => ({ ok: false, status, json: async () => ({ error: { message: 'boom' } }) });

// 1) Gemini function call: request shape + response parsing
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return ok({ candidates: [{ content: { parts: [{ functionCall: { name: 'propose_split', args: { people: ['A'] } } }] } }] });
};
let r = await chat({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: TOOLS, toolMode: 'auto' });
assert.equal(r.provider, 'gemini');
assert.equal(r.toolCalls[0].name, 'propose_split');
const c = calls[0];
assert.match(c.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
assert.equal(c.init.headers['x-goog-api-key'], 'g-test');
const decl = c.body.tools[0].functionDeclarations[0];
assert.equal(decl.parameters.type, 'OBJECT');
assert.equal(decl.parameters.properties.people.type, 'ARRAY');
assert.equal(decl.parameters.properties.people.items.type, 'STRING');
assert.equal(decl.parameters.properties.tax_tip_mode.enum[0], 'proportional');
assert.equal(c.body.systemInstruction.parts[0].text, 'sys');

// 2) Gemini structured JSON (receipt) incl. code-fenced output and image part
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ body: JSON.parse(init.body) });
  return ok({ candidates: [{ content: { parts: [{ text: '```json\n{"is_receipt":true,"venue":"X","items":[],"subtotal":0,"tax":0,"tip":0,"total":0}\n```' }] } }] });
};
const j = await geminiJson({ system: 's', jsonSchema: RECEIPT_SCHEMA, messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/jpeg', data: 'AAA' }] }] });
assert.equal(j.venue, 'X');
assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
assert.equal(calls[0].body.generationConfig.responseSchema.properties.items.items.properties.name.type, 'STRING');
assert.equal(calls[0].body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');

// 3) Gemini fails (429) -> falls back to Grok (OpenAI-compatible)
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init.body) });
  if (String(url).includes('generativelanguage')) return bad(429);
  return ok({ choices: [{ message: { content: 'hello', tool_calls: [{ function: { name: 'draft_reminders', arguments: '{"reminders":[]}' } }] } }] });
};
r = await chat({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: TOOLS, toolMode: 'required' });
assert.equal(r.provider, 'grok');
assert.equal(r.toolCalls[0].name, 'draft_reminders');
const g = calls.find((x) => x.url.includes('api.x.ai'));
assert.equal(g.url, 'https://api.x.ai/v1/chat/completions');
assert.equal(g.body.tool_choice, 'required');
assert.equal(g.body.tools[0].type, 'function');

// 4) Both fail -> error surfaces (so the API can show a friendly message)
globalThis.fetch = async () => bad(500);
await assert.rejects(() => chat({ messages: [{ role: 'user', text: 'hi' }] }));

console.log('llm layer: all tests passed');
