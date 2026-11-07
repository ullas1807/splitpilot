import { timingSafeEqual } from 'node:crypto';
import { supabase } from './supabase.js';

export const LIMITS = {
  maxPerPerson: Number(process.env.MAX_PER_PERSON || 500),
  maxSplitTotal: Number(process.env.MAX_SPLIT_TOTAL || 2000),
  maxPeople: 12,
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeText(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function allowMethod(req, res, ...methods) {
  if (methods.includes(req.method)) return true;
  res.status(405).json({ error: 'Method not allowed' });
  return false;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The owner proves ownership with a secret key that lives in a table the browser cannot read.
export async function assertOwner(splitId, ownerKey) {
  if (!UUID_RE.test(String(splitId || '')) || !ownerKey) return false;
  const { data } = await supabase
    .from('split_secrets')
    .select('owner_key')
    .eq('split_id', splitId)
    .maybeSingle();
  return !!data && safeEqual(data.owner_key, ownerKey);
}

export async function logEvent(splitId, action, { reasoning = null, payload = null, status = null, approved = null } = {}) {
  const { data, error } = await supabase
    .from('agent_log')
    .insert({ split_id: splitId, action, reasoning, payload, status, approved_by_human: approved })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export function bearerOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers['authorization'] || '';
  return safeEqual(header, `Bearer ${secret}`);
}
