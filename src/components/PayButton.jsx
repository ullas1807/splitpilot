import { useMemo, useState } from 'react';
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function PayButton({ participantId, currency = 'USD', onPaid }) {
  const [error, setError] = useState('');
  const options = useMemo(() => ({ clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID, currency, intent: 'capture' }), [currency]);

  return (
    <PayPalScriptProvider options={options}>
      <PayPalButtons
        style={{ layout: 'vertical', shape: 'pill', label: 'pay' }}
        createOrder={async () => {
          setError('');
          const { id } = await post('/api/create-order', { participantId });
          return id;
        }}
        onApprove={async (data) => {
          try {
            onPaid?.(await post('/api/capture-order', { orderId: data.orderID }));
          } catch (e) {
            setError(e.message);
          }
        }}
        onError={(err) => { console.error(err); setError('Something went wrong with PayPal. Please try again.'); }}
      />
      {error && <p role="alert" className="alert alert-err">{error}</p>}
    </PayPalScriptProvider>
  );
}
