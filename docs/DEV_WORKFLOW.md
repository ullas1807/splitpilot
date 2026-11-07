# Developer workflow (Antigravity + PayPal tooling)

## Antigravity
Open this folder in Antigravity and let its agent help with changes. Good prompts:
- "Add a `GET /api/health` endpoint that checks Supabase connectivity."
- "Write a test for `buildProposal` when the owner doesn't participate."
Always run `npm test` and `npm run build` after agent edits.

## PayPal MCP server (optional, helps the coding agent talk to PayPal)
PayPal publishes an Agent Toolkit with an MCP server. In Antigravity's MCP settings, add something like the following,
and **verify the exact package name and flags in PayPal's docs**, since they may have changed:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": ["-y", "@paypal/mcp", "--tools=all"],
      "env": {
        "PAYPAL_ACCESS_TOKEN": "<sandbox access token>",
        "PAYPAL_ENVIRONMENT": "SANDBOX"
      }
    }
  }
}
```
Get a sandbox access token with:
```bash
curl -s -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials
```
Tokens expire, so refresh when the MCP server starts failing. **Never commit tokens.**
Sandbox only. Don't point developer tooling at live credentials.

## Mention in your submission
Say you used Antigravity for development and (if you enabled it) the PayPal MCP server for API exploration.
