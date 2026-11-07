// Gemini is the primary model (vision, structured JSON, function calling).
// Grok (xAI, OpenAI-compatible) is a TEXT-ONLY fallback for the agent when Gemini fails.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const XAI_BASE = 'https://api.x.ai/v1';

// Gemini wants UPPERCASE schema types. We author schemas in normal JSON Schema.
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
      else if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      else out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return s;
}

function mergeTurns(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && !m.images?.length && !last.images?.length) last.text += `\n${m.text}`;
    else out.push({ ...m });
  }
  return out;
}

async function callGemini({ system, messages, tools, toolMode, jsonSchema }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  const body = {
    contents: mergeTurns(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...(m.images || []).map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })),
        { text: m.text },
      ],
    })),
    generationConfig: {},
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (jsonSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = toGeminiSchema(jsonSchema);
  }
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
    body.toolConfig = { functionCallingConfig: { mode: toolMode === 'required' ? 'ANY' : 'AUTO' } };
  }

  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Gemini error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const parts = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought);
  if (!parts.length) throw new Error(`Gemini returned no content (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
  return {
    provider: 'gemini',
    text: parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').trim(),
    toolCalls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} })),
  };
}

async function callGrok({ system, messages, tools, toolMode }) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY is not set');
  const body = {
    model: process.env.XAI_MODEL || 'grok-4',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...mergeTurns(messages).map((m) => ({ role: m.role, content: m.text })),
    ],
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = toolMode === 'required' ? 'required' : 'auto';
  }
  const res = await fetch(`${XAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `Grok error ${res.status}`);
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((c) => {
    let args = {};
    try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* ignore bad JSON */ }
    return { name: c.function?.name, args };
  });
  return { provider: 'grok', text: (msg.content || '').trim(), toolCalls };
}

// Agent chat: try Gemini first, then Grok.
export async function chat(opts) {
  try {
    return await callGemini(opts);
  } catch (primaryErr) {
    console.error('Gemini failed:', primaryErr.message);
    if (!process.env.XAI_API_KEY) throw primaryErr;
    return await callGrok(opts);
  }
}

// Receipt vision: Gemini only (Grok fallback is text-only by design).
export async function geminiJson({ system, messages, jsonSchema }) {
  const out = await callGemini({ system, messages, jsonSchema });
  const cleaned = out.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}
