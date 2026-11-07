import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Sparkles, Loader2, Plus, Trash2, MapPin, Search, ArrowRight, Receipt, LocateFixed } from 'lucide-react';
import { api } from '../lib/api';
import { fileToResizedBase64 } from '../lib/image';
import { SAMPLE_RECEIPT } from '../lib/sample';
import { money } from '../lib/format';
import { saveOwnerKey, getDefaultOwnerName, setDefaultOwnerName } from '../lib/owner';
import MapPicker from './MapPicker';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const num = (v) => Math.max(0, Number(v) || 0);

export default function NewSplit() {
  const fileRef = useRef(null);
  const [step, setStep] = useState('upload'); // upload | parsing | review | creating
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [preview, setPreview] = useState('');
  const [receiptPath, setReceiptPath] = useState(null);
  const [form, setForm] = useState(null);
  const [geoBusy, setGeoBusy] = useState(false);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function startReview(receipt, path, extra = {}) {
    setReceiptPath(path || null);
    setWarning(receipt.total_matches === false ? 'The total printed on the receipt does not match the sum of the items. Please double-check the numbers.' : '');
    setForm({
      owner_name: getDefaultOwnerName(),
      venue: receipt.venue || '',
      currency: 'USD',
      tax: String(receipt.tax ?? 0),
      tip: String(receipt.tip ?? 0),
      lat: extra.lat ?? null,
      lng: extra.lng ?? null,
      items: receipt.items.map((i) => ({ name: i.name, quantity: String(i.quantity), line_total: String(i.line_total) })),
    });
    setStep('review');
  }

  async function onFile(file) {
    if (!file) return;
    setError('');
    setStep('parsing');
    try {
      const img = await fileToResizedBase64(file);
      setPreview(img.previewUrl);
      const out = await api('parse-receipt', { method: 'POST', body: { imageBase64: img.data, mimeType: img.mimeType } });
      startReview(out.receipt, out.receipt_path);
    } catch (e) {
      setError(e.message);
      setStep('upload');
    }
  }

  async function findOnMap() {
    setError('');
    try {
      const g = await api('geocode', { query: { q: form.venue } });
      setForm((f) => ({ ...f, lat: g.lat, lng: g.lng }));
    } catch (e) {
      setError(e.message);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setForm((f) => ({ ...f, lat: p.coords.latitude, lng: p.coords.longitude })); setGeoBusy(false); },
      () => { setGeoBusy(false); setError('Could not get your location. Click the map to drop a pin instead.'); },
      { timeout: 8000 }
    );
  }

  const items = form?.items || [];
  const subtotal = items.reduce((a, i) => a + num(i.line_total), 0);
  const total = subtotal + num(form?.tax) + num(form?.tip);

  async function create() {
    setError('');
    if (!form.owner_name.trim()) return setError('Please enter your name.');
    if (!items.some((i) => i.name.trim() && num(i.line_total) > 0)) return setError('Add at least one item with a price.');
    setStep('creating');
    try {
      setDefaultOwnerName(form.owner_name.trim());
      const out = await api('create-split', {
        method: 'POST',
        body: {
          owner_name: form.owner_name,
          venue: form.venue,
          currency: form.currency,
          tax: num(form.tax),
          tip: num(form.tip),
          lat: form.lat,
          lng: form.lng,
          receipt_path: receiptPath,
          items: items.map((i) => ({ name: i.name, quantity: Number(i.quantity) || 1, line_total: num(i.line_total) })),
        },
      });
      saveOwnerKey(out.splitId, out.ownerKey);
      window.location.assign(`/?s=${out.splitId}`);
    } catch (e) {
      setError(e.message);
      setStep('review');
    }
  }

  return (
    <section className="card">
      <AnimatePresence mode="wait">
        {(step === 'upload' || step === 'parsing') && (
          <motion.div key="upload" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <h2 className="h2"><Receipt size={18} /> Start with a receipt</h2>
            <p className="muted">Snap or upload the bill. AI reads the items, tax and tip for you.</p>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            <div className="actions">
              <button className="btn btn-primary" disabled={step === 'parsing'} onClick={() => fileRef.current?.click()}>
                {step === 'parsing' ? <><Loader2 size={18} className="spin" /> Reading receipt...</> : <><Camera size={18} /> Upload receipt photo</>}
              </button>
              <button className="btn btn-ghost" disabled={step === 'parsing'} onClick={() => startReview(SAMPLE_RECEIPT, null, { lat: SAMPLE_RECEIPT.lat, lng: SAMPLE_RECEIPT.lng })}>
                <Sparkles size={18} /> Use sample receipt
              </button>
            </div>
            {step === 'parsing' && preview && <img className="preview" src={preview} alt="Your receipt" />}
          </motion.div>
        )}

        {(step === 'review' || step === 'creating') && form && (
          <motion.div key="review" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <h2 className="h2"><Receipt size={18} /> Check the details</h2>
            {warning && <p className="alert alert-warn">{warning}</p>}

            <div className="grid2">
              <label className="field">Your name (you paid the bill)
                <input className="input" value={form.owner_name} onChange={(e) => setField('owner_name', e.target.value)} maxLength={40} placeholder="e.g. Sam" />
              </label>
              <label className="field">Currency to charge (PayPal)
                <select className="input" value={form.currency} onChange={(e) => setField('currency', e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            </div>

            <div className="items">
              {items.map((it, idx) => (
                <div className="item-row" key={idx}>
                  <input className="input" aria-label="Item name" value={it.name} placeholder="Item" onChange={(e) => setField('items', items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} />
                  <input className="input narrow" aria-label="Line total" inputMode="decimal" value={it.line_total} onChange={(e) => setField('items', items.map((x, i) => (i === idx ? { ...x, line_total: e.target.value } : x)))} />
                  <button className="icon-btn" aria-label="Remove item" onClick={() => setField('items', items.filter((_, i) => i !== idx))}><Trash2 size={16} /></button>
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={() => setField('items', [...items, { name: '', quantity: '1', line_total: '' }])}><Plus size={16} /> Add item</button>
            </div>

            <div className="grid2">
              <label className="field">Tax
                <input className="input" inputMode="decimal" value={form.tax} onChange={(e) => setField('tax', e.target.value)} />
              </label>
              <label className="field">Tip
                <input className="input" inputMode="decimal" value={form.tip} onChange={(e) => setField('tip', e.target.value)} />
              </label>
            </div>
            <p className="total">Total: <strong>{money(total, form.currency)}</strong></p>

            <label className="field">Venue
              <div className="inline">
                <input className="input" value={form.venue} placeholder="Restaurant name or address" onChange={(e) => setField('venue', e.target.value)} />
                <button className="btn btn-ghost btn-sm" onClick={findOnMap} disabled={form.venue.trim().length < 3}><Search size={16} /> Find</button>
                <button className="btn btn-ghost btn-sm" onClick={useMyLocation} disabled={geoBusy}><LocateFixed size={16} /> Here</button>
              </div>
            </label>
            <p className="muted small"><MapPin size={14} /> Click the map to place or move the pin (optional).</p>
            <MapPicker position={form.lat != null ? { lat: form.lat, lng: form.lng } : null} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />

            <div className="actions">
              <button className="btn btn-primary" onClick={create} disabled={step === 'creating'}>
                {step === 'creating' ? <><Loader2 size={18} className="spin" /> Creating...</> : <>Create split <ArrowRight size={18} /></>}
              </button>
              <button className="btn btn-ghost" onClick={() => { setStep('upload'); setForm(null); }}>Start over</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p role="alert" className="alert alert-err">{error}</p>}
    </section>
  );
}
