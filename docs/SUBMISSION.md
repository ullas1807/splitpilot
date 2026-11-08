# Devpost submission kit

## Checklist (tick everything before you submit)
- [ ] Repo is **public** on GitHub; `LICENSE` (MIT) visible in the About section
- [ ] README has setup + run steps (done) and the hosted demo URL filled in at the top
- [ ] Hosted demo works on a fresh browser with the sample receipt and a sandbox Personal account
- [ ] Webhook configured on the **deployed** URL and `PAYPAL_WEBHOOK_ID` set; redeployed
- [ ] No secrets in git history (`git log -p | grep -i secret` returns nothing); `.env` is ignored
- [ ] Demo video < 3:00, **public on YouTube**, no copyrighted music or third-party logos
- [ ] Tools section filled in (copy from below)
- [ ] Submitted at least 12 hours before the deadline (deadline: Nov 12, 2026, 3:00 PM EST; check the Devpost page for the exact time)

## Project name
SplitPilot

## Tagline
An AI agent that turns a receipt photo into settled PayPal payments, and can never spend money without you.

## Description (paste into Devpost)
**The problem.** Splitting a group bill is a small but universal pain: someone pays, then spends days chasing friends, doing awkward math about tax and tip, and tracking who has paid.

**What SplitPilot does.** Snap a photo of the receipt. Gemini reads the items, tax and tip. Tell the agent in plain language who had what ("Dinner was me, Asha, Ravi and Meera. Asha had the paneer tikka, Ravi and I shared the garlic bread..."). The agent drafts a split proposal. You approve it, and each friend gets a PayPal checkout link. As friends pay, PayPal webhooks settle payments securely on the server and update the live dashboard via API polling. A scheduled agent drafts friendly reminders for anyone who hasn't paid, and every outing is pinned on an OpenStreetMap trip ledger.

**Why it's different: agents with guardrails.** The AI never moves money and never does arithmetic. It only proposes who had what. The server computes every share exactly in integer cents (tax and tip allocated proportionally with largest-remainder rounding, so shares always sum to the bill, verified with property-style tests), enforces per-person and per-bill caps, and creates payment requests only after the owner clicks Approve. Amounts used at checkout always come from the database; webhooks are signature-verified, correlated by PayPal order ID, and idempotent.

**How we built it.** React + Vite + Framer Motion on Vercel; Vercel Node functions call Gemini (vision, structured output, function calling) with Grok as a text-only fallback; PayPal Orders v2 + webhooks; Supabase Postgres with strict Row Level Security (all client access revoked) and private Storage; a Cloudflare Worker (Wrangler) triggers scheduled reminder sweeps because Vercel's free plan only allows daily crons; OpenStreetMap/Leaflet for maps.

**Challenges.** Making an LLM useful in a money flow without trusting it: we moved all math and validation to the server, treated receipt text as untrusted input, and built an approval gate with atomic claiming to prevent double-creation. Keeping payment state consistent between the capture response and the webhook required integer-cent amount and currency checks with idempotent settlement.

**What's next.** True peer-to-peer settlement with PayPal Payouts, per-owner auth, group trips with running balances, and multi-currency receipts.

## Tools (for the "Tools" field)
- **PayPal Sandbox**: Orders v2 (create/capture), JS SDK Checkout buttons, webhooks with signature verification.
- **Google Gemini**: receipt vision to structured JSON; function calling for the split agent and reminder drafting.
- **Grok (xAI)**: text-only fallback model for the agent.
- **Supabase**: Postgres with Row Level Security (all client access revoked), private Storage.
- **Vercel**: hosting and serverless API (Node.js).
- **Cloudflare Workers (Wrangler)**: scheduled reminder trigger.
- **React, JavaScript, CSS, Framer Motion, Lucide React**: frontend.
- **OpenStreetMap (Leaflet, Nominatim)**: maps and geocoding.
- **Antigravity**: AI-assisted development environment.

## Demo video script (target 2:40)
| Time | Show | Say |
|---|---|---|
| 0:00-0:20 | Title card, then a messy receipt | "Splitting a bill means math, chasing, and awkward texts. SplitPilot is an AI agent that does it for you, but can't spend a cent without your approval." |
| 0:20-0:45 | Upload receipt → items appear | "Gemini reads the receipt into structured items, tax and tip. I check it and drop the venue on the map." |
| 0:45-1:20 | Type the who-had-what message → proposal card | "I just tell the agent who had what. It returns a proposal. Note: the AI only says who had what; the server calculates every share to the cent." |
| 1:20-1:40 | Click Approve | "Nothing exists until I approve. That's the guardrail." |
| 1:40-2:15 | Open a pay link, pay with sandbox account; split to the dashboard tab flips to Paid live | "Each friend pays with PayPal Checkout. The webhook is signature-verified and updates the dashboard live." |
| 2:15-2:30 | Reminder card + WhatsApp share, trip-ledger map | "A scheduled Cloudflare Worker wakes the agent to draft reminders, and every outing lands on the OpenStreetMap ledger." |
| 2:30-2:45 | Architecture diagram | "Gemini for vision and tools, Grok as fallback, PayPal for money, Supabase for database and storage. Open source, MIT." |

Recording tips: use a 1080p screen recording, two browser windows side by side for the live "Paid" flip, silent or royalty-free music only, hide any secrets/dashboards.

## Likely judge questions (have answers ready)
- *Why not let the LLM compute amounts?* LLMs make arithmetic mistakes; money needs exactness and auditability.
- *What stops the agent from over-charging?* No money-moving tool exists; proposals need approval; server caps; server-side amounts.
- *What if Gemini is down?* Grok fallback for the agent; receipt upload falls back to manual entry / sample.
- *What's production-ready next?* Auth + per-owner RLS, rate limits, PayPal Payouts for true P2P.
