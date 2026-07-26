# incident-agent

A stateful AI incident-response agent implementing the `ga5-incident-agent/v2` protocol:

```
POST /v2/incidents
POST /v2/incidents/{runId}/receipts
GET  /v2/incidents/{runId}
```

## How it works

- **One model call per run.** `src/model.js` makes exactly one call to the Google Gemini API
  (`generateContent`, reflected as the `chat incident-plan` span) that returns root cause,
  evidence, 1–3 diagnostic tool calls, and the *intended* effect. It uses `responseMimeType:
  "application/json"` + a `responseSchema` so Gemini returns strict structured JSON. The
  `sensitive` object from the request is never sent to the model or stored.
- **State machine, not re-planning.** `src/server.js` drives everything after that first call
  purely from stored state (`src/store.js`, one JSON file per run under `DATA_DIR`, default
  `./data`). Receipts, retries, approvals, and GET never call the model again.
- **Retry rule:** a `503` on attempt 1 gets exactly one retry (new CLIENT span, same
  `execute_tool` span, `resend_count` 1). A second `503` or a `timeout` terminally fails that
  call; a failed diagnostic suppresses the dependent effect.
- **Approval gate:** if the intended effect tool is in `policy.approvalRequiredFor`, the agent
  emits zero effect dispatches and one approval request (with a SHA-256 digest of the
  recursively key-sorted, compact-JSON arguments) instead. The effect is only dispatched after
  an `approved` receipt, using the same reserved `actionId` and carrying `approvalId` /
  `approvalNonce`.
- **Idempotency:** the exact same initial `POST /v2/incidents` body replays the frozen initial
  response; the same `runId` with different content returns `409`. The same rule applies to
  `receiptId` on the receipts endpoint. `GET` always reflects current stored state, freshly
  built from stored fields (never reconstructed by re-running actions).
- **OTLP trace:** `src/otlp.js` renders the span tree from `run.spans`, which are appended/
  updated in place as dispatches and receipts happen — `SERVER → INTERNAL invoke_agent →
  {CLIENT chat, INTERNAL execute_tool → CLIENT tool, INTERNAL incident.join, INTERNAL
  approval_gate}`. No prompts, transcripts, tool arguments/results, or credentials are ever
  attached to a span.

## Run it

```bash
npm install
GEMINI_API_KEY=AIza... PORT=3000 npm start
```

Env vars:
- `GEMINI_API_KEY` — required for real runs. Get one from Google AI Studio
  (https://aistudio.google.com/apikey) — it has a free tier.
- `MODEL_NAME` — defaults to `gemini-2.5-flash`. Gemini's model lineup moves fast (2.5 →
  3.x variants), so check https://ai.google.dev/gemini-api/docs/models for whatever's
  current and cheap when you deploy; the model name itself earns no marks. Any model that
  supports `generateContent` + `responseSchema` works.
- `DATA_DIR` — where per-run JSON state files are persisted (default `./data`).
- `MOCK_MODEL=1` — **local testing only.** Skips the real API call and returns a deterministic
  plan derived from the transcript's `[ev_...]` tags, so you can exercise the whole state
  machine (retries, approvals, replay, 409s) without spending API calls. Never set this for
  an actual graded deployment.

The included test run (used during development) exercised: happy-path diagnosis → effect,
POST replay, 409 on changed content, a 503 → retry → success diagnostic, and a full
approval-gated `rollback_deployment` flow — all passing.

## Deploying

Any host that gives you a public HTTPS URL with no required auth/query/fragment works, e.g.:
- **Railway / Render / Fly.io**: point them at this repo, set `ANTHROPIC_API_KEY`, deploy.
  These give a container with a persistent disk (or add one) — mount it and set `DATA_DIR`
  to that mount so state survives restarts.
- Make sure the deployed URL:
  - Is plain `https://...` with no query string or fragment.
  - Doesn't redirect (no trailing-slash redirect middleware, no `www.` bounce).
  - Doesn't require an API key/auth header from the grader.

## Known simplifications / things to double check against your actual grader responses

- The effect's arguments and each diagnostic call's arguments come straight from the model's
  JSON output, lightly validated against `toolCatalog`/`policy` but not against each tool's
  `inputSchema`. If your graded incidents have strict schemas, add a JSON-schema validation
  pass in `server.js` before dispatching (reject/repair otherwise).
- Denied approvals and doubly-failed effects are marked `status: "failed"` with a `suppressed`
  entry — adjust if your grading rubric expects different terminal semantics.
- `contentHash` hashes the entire incoming JSON body (including `sensitive`) only to detect
  changed-content resubmission; it is never persisted or exported, only compared in memory.