import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Clock, Copy, Check, Link2, KeyRound, Loader2, Receipt, MapPin, Bot, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { captureOwnerKey } from '../lib/owner';
import { useParticipants } from '../hooks/useParticipants';
import { useAgentFeed } from '../hooks/useAgentFeed';
import AgentFeed from './AgentFeed';
import VenueMap from './VenueMap';
import { LiveEffects, GuardrailBadge, DemoGuide } from '../phase4/Extras';

function CopyButton({ text, label, icon }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn btn-ghost btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* blocked */ } }}>
      {ok ? <Check size={14} /> : icon} {ok ? 'Copied' : label}
    </button>
  );
}

export default function SplitView({ splitId }) {
  const [ownerKey] = useState(() => captureOwnerKey(splitId));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const { rows: participants, refetch: refetchParticipants } = useParticipants(splitId);
  const { entries, refetch: refetchFeed } = useAgentFeed(splitId, ownerKey);

  const load = useCallback(async () => {
    try {
      if (ownerKey) {
        setData(await api('split', { method: 'POST', body: { id: splitId, ownerKey } }));
      } else {
        setData(await api('split', { query: { id: splitId } }));
      }
    } catch (e) {
      setError(e.message);
    }
  }, [splitId, ownerKey]);

  useEffect(() => { load(); }, [load]);

  // Reload split metadata when the split flips to settled, etc.
  const paidCount = participants.filter((p) => p.status === 'paid').length;
  useEffect(() => { if (participants.length) load(); }, [paidCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const requested = useMemo(() => participants.reduce((a, p) => a + Number(p.share), 0), [participants]);
  const collected = useMemo(() => participants.filter((p) => p.status === 'paid').reduce((a, p) => a + Number(p.share), 0), [participants]);
  const pct = requested ? Math.round((collected / requested) * 100) : 0;

  if (error) return <section className="card"><p className="alert alert-err">{error}</p><a href="/" className="btn btn-ghost">Back home</a></section>;
  if (!data) return <section className="card center"><Loader2 className="spin" /> Loading...</section>;

  const { split, items, isOwner, receiptUrl } = data;
  const origin = window.location.origin;
  const ownerLink = ownerKey ? `${origin}/?s=${splitId}#key=${ownerKey}` : '';

  return (
    <div className="stack">
      <LiveEffects
         participants={participants}
         currency={split.currency}
         status={split.status}
      />
      <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="head">
          <div>
            <h1 className="h1">{split.title}</h1>
            <p className="muted">Paid by {split.owner_name} · {money(split.total, split.currency)} {isOwner && <span className="chip chip-ok">you're the owner</span>}</p>
          </div>
          <span className={`chip ${split.status === 'settled' ? 'chip-ok' : 'chip-wait'}`}>{split.status === 'settled' ? <CheckCircle2 size={14} /> : <Clock size={14} />} {split.status}</span>
        </div>
        {participants.length > 0 && (
          <>
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <motion.div className="progress-bar" animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
            </div>
            <p className="muted small">{money(collected, split.currency)} of {money(requested, split.currency)} collected · {paidCount}/{participants.length} paid</p>
          </>
        )}
        <div className="actions">
          <CopyButton text={`${origin}/?s=${splitId}`} label="Copy status link" icon={<Link2 size={14} />} />
          {isOwner && ownerLink && <CopyButton text={ownerLink} label="Copy owner link (keep private)" icon={<KeyRound size={14} />} />}
        </div>
      </motion.section>
      <GuardrailBadge />
      <DemoGuide
         entries={entries}
         participants={participants}
         status={split.status}
         isOwner={isOwner}
      />

      <div className="cols">
        <section className="card col-main">
          <h2 className="h2"><Bot size={18} /> Agent</h2>
          <AgentFeed
            splitId={splitId} ownerKey={ownerKey} isOwner={isOwner} hasParticipants={participants.length > 0}
            entries={entries} refetch={refetchFeed}
            onApproved={() => { refetchParticipants(); load(); }}
          />
        </section>

        <div className="col-side stack">
          <section className="card">
            <h2 className="h2"><Wallet size={18} /> Payments</h2>
            {participants.length === 0 ? (
              <p className="muted">No payment requests yet. Ask the agent to split the bill, then approve its proposal.</p>
            ) : (
              <ul className="list">
                <AnimatePresence initial={false}>
                  {participants.map((p) => (
                    <motion.li key={p.id} layout className="row" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                      <div className="row-main">
                        <strong>{p.name}</strong>
                        <span className="muted small">{money(p.share, split.currency)}</span>
                      </div>
                      {p.status === 'paid' ? (
                        <motion.span className="chip chip-ok" initial={{ scale: 0.6 }} animate={{ scale: 1 }}><CheckCircle2 size={14} /> paid</motion.span>
                      ) : (
                        <span className="inline">
                          <span className="chip chip-wait"><Clock size={14} /> {p.status}</span>
                          <CopyButton text={`${origin}/?p=${p.id}`} label="Pay link" icon={<Copy size={14} />} />
                        </span>
                      )}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </section>

          <section className="card">
            <h2 className="h2"><Receipt size={18} /> Receipt</h2>
            {receiptUrl && <img className="preview" src={receiptUrl} alt="Receipt" />}
            <ul className="list">
              {items.map((i) => (
                <li key={i.id} className="row"><span className="row-main">{i.name}</span><span>{money(i.price, split.currency)}</span></li>
              ))}
              <li className="row muted"><span className="row-main">Tax</span><span>{money(split.tax, split.currency)}</span></li>
              <li className="row muted"><span className="row-main">Tip</span><span>{money(split.tip, split.currency)}</span></li>
            </ul>
          </section>

          <section className="card">
            <h2 className="h2"><MapPin size={18} /> Where</h2>
            <VenueMap markers={[{ id: split.id, lat: split.lat, lng: split.lng, status: split.status, label: split.venue || split.title }]} height={200} />
          </section>
        </div>
      </div>
    </div>
  );
}
