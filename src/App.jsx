import { Receipt, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import NewSplit from './components/NewSplit';
import SplitView from './components/SplitView';
import PayPage from './components/PayPage';
import TripLedger from './components/TripLedger';
import { QuickDemo } from './phase4/Extras';

function Shell({ children }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a href="/" className="brand"><Receipt size={20} /> SplitPilot</a>
        <span className="muted small">PayPal Sandbox · AI-assisted</span>
      </header>
      <main className="container">{children}</main>
      <footer className="footer muted small">Map data © OpenStreetMap contributors · Sandbox demo, no real money</footer>
    </div>
  );
}

function Home() {
  return (
    <div className="stack">
      <section className="hero">
        <h1 className="hero-title">Split the bill. <span className="grad">Let the agent chase it.</span></h1>
        <p className="hero-sub">Snap a receipt, tell the agent who had what, approve the split, and collect through PayPal. The AI proposes, you approve, and money never moves without you.</p>
        <div className="pills">
          <span className="chip"><Sparkles size={14} /> Reads receipts</span>
          <span className="chip"><ShieldCheck size={14} /> Human approval</span>
          <span className="chip"><Wallet size={14} /> Live PayPal status</span>
        </div>
      </section>
      <QuickDemo />
      <NewSplit />
      <TripLedger />
    </div>
  );
}

export default function App() {
  const q = new URLSearchParams(window.location.search);
  const participantId = q.get('p');
  const splitId = q.get('s');
  return <Shell>{participantId ? <PayPage participantId={participantId} /> : splitId ? <SplitView splitId={splitId} /> : <Home />}</Shell>;
}
