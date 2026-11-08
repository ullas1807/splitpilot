import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import PayButton from './PayButton';
import { PaidCelebration } from '../phase4/Extras';

export default function PayPage({ participantId }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function loadParticipant() {
      if (!participantId) return;
      try {
        const data = await api('participant', { query: { id: participantId } });
        if (!active) return;
        setP(data.participant || data);
      } catch (err) {
        if (!active) return;
        setError(err.message || 'This payment link was not found.');
      }
    }

    loadParticipant();
    const poll = setInterval(loadParticipant, 5000);

    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [participantId]);

  if (error) return <section className="card center"><p>{error}</p></section>;
  if (!p) return <section className="card center"><Loader2 className="spin" /> Loading...</section>;

  const paid = p.status === 'paid';
  return (
    <motion.section className="card pay" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <p className="muted">{p.split.title}{p.split.venue && p.split.venue !== p.split.title ? ` · ${p.split.venue}` : ''}</p>
      <h1 className="h1">Hi {p.name} 👋</h1>
      <p className="muted">{p.split.owner_name} covered the bill. Your share is:</p>
      <p className="amount">{money(p.share, p.split.currency)}</p>
      <PaidCelebration paid={paid} />
      {paid ? (
        <motion.div className="paid" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <CheckCircle2 size={56} color="var(--ok)" />
          <p><strong>Paid. Thank you!</strong></p>
        </motion.div>
      ) : (
        <PayButton
          participantId={p.id}
          currency={p.split.currency}
          onPaid={() => setP((prev) => (prev ? { ...prev, status: 'paid' } : prev))}
        />
      )}
      <p className="muted small"><ShieldCheck size={14} /> Sandbox demo: pay with a PayPal <em>sandbox personal</em> test account. No real money moves.</p>
    </motion.section>
  );
}
