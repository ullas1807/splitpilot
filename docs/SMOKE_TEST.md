# Smoke test (do this first)

Goal: one sandbox payment goes end to end and the owner dashboard flips to **Paid** on its own (within ~5 seconds).

## 0. Preflight (2 minutes, before deploying)
```bash
cp .env.example .env      # fill in your keys
npm install
npm test                  # offline tests, all five suites must pass
npm run preflight         # checks PayPal, Supabase, Gemini model + JSON output + tool calling
```
Every red line prints a `fix:` hint. Resolve them all before you deploy.
- If `GEMINI_MODEL` is rejected, the script lists the Flash models your key can use. Paste one into `.env` and Vercel.
- Optional lockdown test: add `SUPABASE_ANON_KEY=<anon key>` to your local `.env` only. The script then proves the
  browser key can read and write nothing. The app itself never needs the anon key.

## 1. Deploy
- Push to GitHub, import into Vercel, add every env var from `.env` (not `SUPABASE_ANON_KEY`).
- `VITE_PAYPAL_CLIENT_ID` is baked in at **build** time. If you add or change it, **redeploy**.
- `api/` has exactly 12 functions, the Vercel Hobby maximum. **Do not add another `api/*.js` file.** If you need
  more logic, put it in `api/_lib/`. If a deploy says "No more than 12 Serverless Functions", merge
  `participant.js` into `split.js` or move to a Pro team.

## 2. Webhook
- PayPal Dashboard -> your Sandbox app -> Webhooks -> add `https://YOUR-APP.vercel.app/api/paypal-webhook`.
- Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.
- Copy the **Webhook ID** (not the URL) into `PAYPAL_WEBHOOK_ID` in Vercel and your `.env`, redeploy, and run
  `npm run preflight` again. It confirms the ID exists and is subscribed to the right events.

## 3. The flow
1. Home page -> sample receipt -> create the split.
2. Tell the agent: "Dinner was me, Asha and Ravi. Asha had the garlic bread, Ravi and I shared the paneer tikka, split tax evenly".
3. An approval card appears and nothing is charged yet. Click **Approve**.
4. Open a friend's pay link in a second window and pay with your sandbox **Personal** account.
5. The owner dashboard shows Paid within a few seconds, with no refresh. When everyone has paid, the split is settled.

## 4. Check the webhook really worked
After a payment, open Vercel -> Logs for `/api/paypal-webhook`. You want a 200 and no "signature verification failed".
Also check that the `payment_events` table has a row. Because the browser capture and the webhook both call the same
idempotent `markPaid`, the UI can flip from either, so this step is how you know the webhook itself is healthy.
That matters because judges look for verified webhooks.

## If something fails
| Symptom | Likely cause |
|---|---|
| Agent says "AI brain unavailable" | Wrong `GEMINI_MODEL`. Run `npm run preflight`. |
| PayPal button spins or errors | `VITE_PAYPAL_CLIENT_ID` missing, or you did not redeploy after adding it. |
| Payment works but status is slow to flip | The UI polls every 5 seconds. Wait a moment, or check the function logs. |
| Webhook returns 401 | Wrong `PAYPAL_WEBHOOK_ID`, or you used the Simulator. Use a real sandbox payment. |
| Webhook returns 200 but logs "rejected" | Amount, currency or order did not match the database. The log line says which. |
| `/api` 404 locally | Use `vercel dev`, not `npm run dev`. |

## Honest limits (say them in the pitch)
- Money lands in your sandbox merchant account. Real peer-to-peer payouts are the production path.
- The dashboard updates by 5-second polling, not push. The browser has no direct database access by design.
- Anyone holding a split's link can view it (the id is an unguessable UUID). Only the owner key can talk to the agent or approve.
