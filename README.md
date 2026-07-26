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

Any host that gives you a public HTTPS URL with no required auth/query/fragment works. Below
is a ready-to-use Docker setup targeted at Render.

### Docker

```bash
docker build -t incident-agent .
docker run -p 3000:3000 \
  -e GEMINI_API_KEY=AIza... \
  -e DATA_DIR=/data \
  -v incident-data:/data \
  incident-agent
```

The image is `node:22-alpine`, installs only production deps, and runs `node src/server.js`.
`DATA_DIR` defaults to `/data` inside the container — mount a volume there or state resets
every time the container restarts.

### Render

Two ways to deploy:

**1. Blueprint (`render.yaml`, included).** Push this repo to GitHub, then in Render:
New → Blueprint → point at the repo. It provisions a Docker web service with a 1 GB persistent
disk mounted at `/data`, wires up `/healthz` as the health check, and reads `GEMINI_API_KEY`
from an environment variable you set manually in the dashboard (never commit it).

**2. Manual.** New → Web Service → your repo → Runtime: `Docker`. Then in the service settings:
- **Environment variables:** `GEMINI_API_KEY` (required), optionally `MODEL_NAME`.
- **Disk:** add one, mount path `/data`, and set `DATA_DIR=/data` — otherwise state doesn't
  survive restarts/redeploys.
- **Health check path:** `/healthz`.
- **Plan:** avoid the free tier for the actual grading run — it spins down after ~15 minutes
  idle, and the cold start on the next request can blow the grader's 18-second-per-request
  budget. A paid "Starter" instance stays warm.

Either way, double-check the URL Render gives you:
- Is plain `https://your-service.onrender.com` with no query string or fragment.
- Doesn't redirect.
- Doesn't require an API key/auth header from the grader (Render's default services don't
  add auth, but confirm nothing else in front of it does).

## Known simplifications / things to double check against your actual grader responses

- The effect's arguments and each diagnostic call's arguments come straight from the model's
  JSON output, lightly validated against `toolCatalog`/`policy` but not against each tool's
  `inputSchema`. If your graded incidents have strict schemas, add a JSON-schema validation
  pass in `server.js` before dispatching (reject/repair otherwise).
- Denied approvals and doubly-failed effects are marked `status: "failed"` with a `suppressed`
  entry — adjust if your grading rubric expects different terminal semantics.
- `contentHash` hashes the entire incoming JSON body (including `sensitive`) only to detect
  changed-content resubmission; it is never persisted or exported, only compared in memory.