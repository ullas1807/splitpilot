import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin, CheckCircle2, Clock } from 'lucide-react';
import { api } from '../lib/api';
import { knownSplitIds } from '../lib/owner';
import { money, timeAgo } from '../lib/format';
import VenueMap from './VenueMap';

// "Trip ledger": every split created on this device, pinned on an OpenStreetMap.
export default function TripLedger() {
  const [splits, setSplits] = useState([]);

  useEffect(() => {
    let active = true;
    const ids = knownSplitIds();
    if (!ids.length) return undefined;

    async function fetchSplits() {
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const res = await api('split', { query: { id } });
              return res.split || null;
            } catch {
              return null;
            }
          })
        );
        if (!active) return;
        const valid = results
          .filter(Boolean)
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        setSplits(valid);
      } catch (err) {
        console.warn('TripLedger fetch error:', err.message);
      }
    }

    fetchSplits();
    return () => {
      active = false;
    };
  }, []);

  if (!splits.length) return null;
  const markers = splits.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, status: s.status, label: `${s.title} · ${money(s.total, s.currency)}`, href: `/?s=${s.id}` }));

  return (
    <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <h2 className="h2"><MapPin size={18} /> Your trip ledger</h2>
      <VenueMap markers={markers} height={220} />
      <ul className="list">
        {splits.map((s) => (
          <li key={s.id} className="row">
            <a href={`/?s=${s.id}`} className="row-main">
              <strong>{s.title}</strong>
              <span className="muted">{money(s.total, s.currency)} · {timeAgo(s.created_at)}</span>
            </a>
            <span className={`chip ${s.status === 'settled' ? 'chip-ok' : 'chip-wait'}`}>
              {s.status === 'settled' ? <CheckCircle2 size={14} /> : <Clock size={14} />} {s.status}
            </span>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}
