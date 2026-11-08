import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, User, Send, Loader2, ShieldCheck, Check, X, BellRing, Copy, Share2, Wallet, CheckCircle2, PartyPopper } from 'lucide-react';
import { api } from '../lib/api';
import { centsToMoney, money, timeAgo } from '../lib/format';

function Bubble({ role, children }) {
  const mine = role === 'user';
  return (
    <div className={`bubble-row ${mine ? 'mine' : ''}`}>
      <span className="avatar">{mine ? <User size={14} /> : <Bot size={14} />}</span>
      <div className={`bubble ${mine ? 'bubble-user' : 'bubble-bot'}`}>{children}</div>
    </div>
  );
}

function ProposalCard({ entry, isOwner, busy, onDecide }) {
  const p = entry.payload || {};
  const pending = entry.status === 'pending';
  return (
    <motion.div className="proposal" layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
      <div className="proposal-head">
        <ShieldCheck size={18} />
        <strong>Proposed split · needs your approval</strong>
        <span className={`chip ${entry.status === 'approved' ? 'chip-ok' : pending ? 'chip-wait' : 'chip-muted'}`}>{entry.status}</span>
      </div>
      {entry.reasoning && <p className="muted">{entry.reasoning}</p>}
      {p.assumptions && <p className="muted small"><strong>Assumptions:</strong> {p.assumptions}</p>}
      <ul className="list">
        {(p.requests || []).map((r) => (
          <li key={r.name} className="row">
            <div className="row-main">
              <strong>{r.name}</strong>
              <span className="muted small">{(r.lines || []).map((l) => l.name).join(', ') || 'shared items'} · tax/tip {centsToMoney(r.tax_tip_cents, p.currency)}</span>
            </div>
            <strong>{centsToMoney(r.amount_cents, p.currency)}</strong>
          </li>
        ))}
        <li className="row">
          <div className="row-main"><span className="muted">Your own share ({p.owner_name})</span></div>
          <span className="muted">{centsToMoney(p.owner_share_cents, p.currency)}</span>
        </li>
      </ul>
      <p className="muted small">
        Tax split {p.tax_mode === 'equal' || p.mode === 'equal' ? 'evenly' : 'proportionally'}.{' '}
        Tip {p.tip_mode === 'owner_covers' ? `covered by ${p.owner_name}` : p.tip_mode === 'even' ? 'split evenly' : 'split proportionally'}.{' '}
        Amounts are calculated exactly by the server, not by the AI.
      </p>
      {(p.unmatched || []).length > 0 && <p className="alert alert-warn">I couldn't match: {p.unmatched.join(', ')}. Those items were shared equally.</p>}
      {pending && isOwner && (
        <div className="actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => onDecide(entry.id, 'approve')}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Approve & create payment requests
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => onDecide(entry.id, 'reject')}><X size={16} /> Reject</button>
        </div>
      )}
    </motion.div>
  );
}

function ReminderCard({ entry }) {
  const p = entry.payload || {};
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/?p=${p.participant_id}`;
  const text = `${p.message} ${link}`;
  return (
    <motion.div className="reminder" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="proposal-head">
        <BellRing size={16} /> <strong>Reminder draft for {p.name}</strong>
        <span className="chip chip-muted">{p.source === 'scheduler' ? 'auto' : 'agent'}</span>
      </div>
      <p>{p.message}</p>
      <div className="actions">
        <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(text)}`}><Share2 size={14} /> WhatsApp</a>
        <button className="btn btn-ghost btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </motion.div>
  );
}

function EventLine({ icon, children, time }) {
  return (
    <div className="event"><span className="event-icon">{icon}</span><span>{children}</span><span className="muted small">{time}</span></div>
  );
}

export default function AgentFeed({ splitId, ownerKey, isOwner, hasParticipants, entries, refetch, onApproved }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [entries.length, sending]);

  async function send(message) {
    const msg = (message ?? text).trim();
    if (!msg || sending) return;
    setError(''); setSending(true); setText('');
    try {
      await api('agent', { method: 'POST', body: { splitId, ownerKey, message: msg } });
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
      refetch();
    }
  }

  async function decide(logId, decision) {
    setError(''); setBusyId(logId);
    try {
      await api('approve', { method: 'POST', body: { splitId, ownerKey, logId, decision } });
      onApproved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
      refetch();
    }
  }

  const suggestions = hasParticipants
    ? ['Remind everyone who hasn\'t paid', 'Who still owes me?']
    : ['Split everything equally between me, Asha, Ravi and Meera', 'Asha and Ravi shared the pizza, I had the paneer, Meera had the pasta. Garlic bread and lemonades are shared by all four of us'];

  return (
    <div className="feed">
      <div className="feed-scroll">
        <AnimatePresence initial={false}>
          {entries.map((e) => {
            const p = e.payload || {};
            switch (e.action) {
              case 'user_message': return <Bubble key={e.id} role="user">{p.text}</Bubble>;
              case 'agent_message': return <Bubble key={e.id} role="bot">{p.text}</Bubble>;
              case 'proposal': return <ProposalCard key={e.id} entry={e} isOwner={isOwner} busy={busyId === e.id} onDecide={decide} />;
              case 'reminder_draft': return <ReminderCard key={e.id} entry={e} />;
              case 'approved': return <EventLine key={e.id} icon={<CheckCircle2 size={14} />} time={timeAgo(e.created_at)}>{e.reasoning}</EventLine>;
              case 'payment_received': return <EventLine key={e.id} icon={<Wallet size={14} />} time={timeAgo(e.created_at)}>{p.name} paid {money(p.amount)}</EventLine>;
              case 'settled': return <EventLine key={e.id} icon={<PartyPopper size={14} />} time={timeAgo(e.created_at)}>{e.reasoning}</EventLine>;
              default: return null;
            }
          })}
        </AnimatePresence>
        {sending && <Bubble role="bot"><Loader2 size={16} className="spin" /> thinking...</Bubble>}
        <div ref={endRef} />
      </div>

      {error && <p role="alert" className="alert alert-err">{error}</p>}

      {isOwner ? (
        <>
          <div className="chips">
            {suggestions.map((s) => <button key={s} className="chip chip-btn" disabled={sending} onClick={() => send(s)}>{s.length > 46 ? `${s.slice(0, 44)}…` : s}</button>)}
          </div>
          <div className="composer">
            <input className="input" value={text} placeholder="Tell the agent who had what..." onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} maxLength={1000} />
            <button className="btn btn-primary" onClick={() => send()} disabled={sending || !text.trim()} aria-label="Send"><Send size={16} /></button>
          </div>
        </>
      ) : (
        <p className="muted small">You're viewing this split read-only.</p>
      )}
    </div>
  );
}
