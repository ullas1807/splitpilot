import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Circle, Compass, Loader2, PartyPopper, Play, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { SAMPLE_RECEIPT } from '../lib/sample';
import { getDefaultOwnerName, saveOwnerKey } from '../lib/owner';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---------- pop-up messages ---------- */
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return { toasts, push, dismiss };
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            type="button"
            layout
            className={`toast toast-${t.tone}`}
            initial={{ opacity: 0, y: -14, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
            onClick={() => onDismiss(t.id)}
          >
            {t.tone === 'party' ? <PartyPopper size={16} /> : <CheckCircle2 size={16} />}
            <span>{t.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ---------- confetti ---------- */
const COLORS = ['#3b5bff', '#8a4dff', '#17a265', '#f2b84b', '#ff6b6b', '#2ec4f1'];

function Confetti({ burst, count = 40 }) {
  const [pieces, setPieces] = useState(null);
  useEffect(() => {
    if (!burst || reduced()) return undefined;
    setPieces(
      Array.from({ length: count }, (_, i) => ({
        i,
        x: (Math.random() - 0.5) * 640,
        y: 180 + Math.random() * 380,
        r: (Math.random() - 0.5) * 760,
        c: COLORS[i % COLORS.length],
        d: 0.9 + Math.random() * 0.9,
        s: 6 + Math.random() * 7,
      }))
    );
    const t = setTimeout(() => setPieces(null), 2400);
    return () => clearTimeout(t);
  }, [burst, count]);

  if (!pieces) return null;
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p) => (
        <motion.span
          key={p.i}
          className="confetti-piece"
          style={{ background: p.c, width: p.s, height: p.s * 0.6 }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
          animate={{ x: p.x, y: p.y, opacity: 0, rotate: p.r }}
          transition={{ duration: p.d, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}

/* ---------- owner dashboard: celebrate each NEW payment (never on page load) ---------- */
export function LiveEffects({ participants, currency = 'USD', status }) {
  const { toasts, push, dismiss } = useToasts();
  const [burst, setBurst] = useState(0);
  const prevPaid = useRef(null);
  const prevStatus = useRef(status);

  useEffect(() => {
    const paid = new Set((participants || []).filter((p) => p.status === 'paid').map((p) => p.id));
    if (prevPaid.current === null) {
      if ((participants || []).length > 0) prevPaid.current = paid;
      return;
    }
    let fired = false;
    for (const p of participants || []) {
      if (p.status === 'paid' && !prevPaid.current.has(p.id)) {
        push(`${p.name} just paid ${money(p.share, currency)}`);
        fired = true;
      }
    }
    if (fired) setBurst((b) => b + 1);
    prevPaid.current = paid;
  }, [participants, currency, push]);

  useEffect(() => {
    if (prevStatus.current === 'open' && status === 'settled') {
      push('Everyone has paid. Split settled!', 'party');
      setBurst((b) => b + 1);
    }
    prevStatus.current = status;
  }, [status, push]);

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <Confetti burst={burst} />
    </>
  );
}

/* ---------- friend's pay page: confetti when unpaid -> paid ---------- */
export function PaidCelebration({ paid }) {
  const prev = useRef(paid);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!prev.current && paid) setBurst((b) => b + 1);
    prev.current = paid;
  }, [paid]);
  return <Confetti burst={burst} />;
}

/* ---------- green "Guardrails on" banner ---------- */
export function GuardrailBadge() {
  return (
    <div className="guardrail" role="note">
      <ShieldCheck size={18} />
      <div className="guardrail-text">
        <strong>Guardrails on</strong>
        <span>AI can only propose · you approve · amounts calculated by the server</span>
      </div>
      <span className="live"><i className="live-dot" /> Live</span>
    </div>
  );
}

/* ---------- guided demo checklist (only when the URL has ?demo=1) ---------- */
export function DemoGuide({ entries = [], participants = [], status, isOwner }) {
  const [hidden, setHidden] = useState(false);
  const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  if (!enabled || !isOwner || hidden) return null;

  const steps = [
    { done: entries.some((e) => e.action === 'proposal'), title: 'Tell the agent who had what', hint: 'Tap a suggestion chip in the chat, or type your own sentence.' },
    { done: participants.length > 0, title: 'Review and approve the proposal', hint: 'The AI can only propose. Nothing is charged until you approve.' },
    { done: participants.some((p) => p.status === 'paid'), title: 'Pay one share with PayPal Sandbox', hint: 'Click "Pay link" (opens a new tab) and pay with a sandbox Personal account. This page updates live.' },
    { done: status === 'settled', title: 'Settle up', hint: 'Pay the remaining shares and watch the split settle.' },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <motion.section className="card guide" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="guide-head">
        <h2 className="h2"><Compass size={18} /> {current === -1 ? "You've seen the whole flow 🎉" : 'Guided demo'}</h2>
        <button className="icon-btn" aria-label="Hide guide" onClick={() => setHidden(true)}><X size={16} /></button>
      </div>
      <ol className="guide-steps">
        {steps.map((s, i) => (
          <li key={s.title} className={`guide-step ${s.done ? 'done' : ''} ${i === current ? 'current' : ''}`}>
            <span className="guide-icon">{s.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}</span>
            <div>
              <strong>{s.title}</strong>
              {i === current && <p className="muted small">{s.hint}</p>}
            </div>
          </li>
        ))}
      </ol>
    </motion.section>
  );
}

/* ---------- home page: one-click demo ---------- */
export function QuickDemo() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setBusy(true);
    setError('');
    try {
      const r = SAMPLE_RECEIPT;
      const out = await api('create-split', {
        method: 'POST',
        body: {
          owner_name: getDefaultOwnerName() || 'Demo Host',
          venue: r.venue || 'Demo Bistro',
          currency: 'USD',
          tax: r.tax ?? 0,
          tip: r.tip ?? 0,
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          items: (r.items || []).map((i) => ({ name: i.name, quantity: i.quantity || 1, line_total: i.line_total })),
        },
      });
      saveOwnerKey(out.splitId, out.ownerKey);
      window.location.assign(`/?s=${out.splitId}&demo=1`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="quickdemo">
      <button className="btn btn-primary btn-lg" onClick={go} disabled={busy}>
        {busy ? <><Loader2 size={18} className="spin" /> Setting up demo...</> : <><Play size={18} /> Try the 1-click demo</>}
      </button>
      <span className="muted small">Sample receipt · PayPal Sandbox · no sign-up</span>
      {error && <p role="alert" className="alert alert-err">{error}</p>}
    </div>
  );
}