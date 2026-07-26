import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

const runs = new Map();

function runFile(runId) {
  // runId is opaque but may contain characters unsafe for filenames; hash-safe encode.
  const safe = Buffer.from(runId, "utf8").toString("base64url");
  return path.join(DATA_DIR, `run_${safe}.json`);
}

export function loadRun(runId) {
  if (runs.has(runId)) return runs.get(runId);
  const f = runFile(runId);
  if (fs.existsSync(f)) {
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    runs.set(runId, data);
    return data;
  }
  return null;
}

export function saveRun(run) {
  runs.set(run.runId, run);
  fs.writeFileSync(runFile(run.runId), JSON.stringify(run));
}

export function newRunState(runId) {
  return {
    runId,
    requestHash: null,
    publicMarker: null,
    policy: null,
    toolCatalog: null,
    incident: null,
    traceId: null,
    serverSpanId: null,
    agentSpanId: null,
    chatSpanId: null,
    joinSpanId: null,
    approvalGateSpanId: null,
    diagnosis: null,
    status: "waiting",
    chosenEffect: null,
    suppressed: [],
    actionLog: [],
    receiptLog: [],
    pending: { calls: {}, approvals: {} },
    spans: [],
    lastResponse: null,
    receipts: {}, // receiptId -> { hash, response }
  };
}