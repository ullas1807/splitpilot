// Owner keys + a tiny list of splits created on this device. All storage access is guarded.
const KEY = 'splitpilot.owner.v1';
const NAME = 'splitpilot.name';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export function saveOwnerKey(splitId, key) {
  const all = read();
  all[splitId] = { key, at: Date.now() };
  write(all);
}
export function getOwnerKey(splitId) {
  return read()[splitId]?.key || null;
}
export function knownSplitIds() {
  return Object.entries(read()).sort((a, b) => b[1].at - a[1].at).map(([id]) => id).slice(0, 20);
}
// If the page was opened with #key=..., store it (so the owner can continue on another device).
export function captureOwnerKey(splitId) {
  const m = window.location.hash.match(/key=([a-f0-9]+)/i);
  if (m) {
    saveOwnerKey(splitId, m[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return getOwnerKey(splitId);
}
export function getDefaultOwnerName() {
  try { return localStorage.getItem(NAME) || ''; } catch { return ''; }
}
export function setDefaultOwnerName(n) {
  try { localStorage.setItem(NAME, n); } catch { /* ignore */ }
}
