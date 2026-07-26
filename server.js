import express from "express";
import { newTraceId, newSpanId, buildTraceparent, parseIncomingTraceContext, newOpaqueId } from "./ids.js";
import { contentHash, argumentsDigest } from "./canon.js";
import { loadRun, saveRun, newRunState } from "./store.js";
import { buildOtlp } from "./otlp.js";
import { planIncident } from "./model.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Render (and any platform) health check — not part of the grader's protocol.
app.get("/healthz", (req, res) => res.status(200).send("ok"));

const MAX_BODY_JSON_BYTES = 768 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_JSON_BYTES) {
    // Should not happen for our own responses, but guard anyway.
    return res.status(500).json({ error: "response too large" });
  }
  res.status(status).type("application/json").send(body);
}

function extractEvidenceIds(transcript) {
  const ids = new Set();
  const re = /\[(ev_[a-zA-Z0-9_]+)\]/g;
  let m;
  while ((m = re.exec(transcript))) ids.add(m[1]);
  return [...ids];
}

function addSpan(run, span) {
  run.spans.push(span);
  return span;
}

function findSpan(run, spanId) {
  return run.spans.find((s) => s.spanId === spanId);
}

// ---------- POST /v2/incidents ----------
app.post("/v2/incidents", async (req, res) => {
  const body = req.body || {};

  if (body.profile !== "ga5-incident-agent/v2") {
    return sendJson(res, 400, { error: "unsupported profile" });
  }
  if (!body.runId || typeof body.runId !== "string" || body.runId.length < 1) {
    return sendJson(res, 400, { error: "missing runId" });
  }
  if (!body.incident || !Array.isArray(body.incident.allowedRootCauses)) {
    return sendJson(res, 400, { error: "missing incident" });
  }
  if (!Array.isArray(body.toolCatalog) || !body.policy) {
    return sendJson(res, 400, { error: "missing toolCatalog/policy" });
  }

  const hash = contentHash(body);
  let run = loadRun(body.runId);

  if (run) {
    if (run.requestHash === hash) {
      // Idempotent replay of the exact same initial request.
      return sendJson(res, 200, run.initialResponse);
    }
    return sendJson(res, 409, { error: "runId exists with different content" });
  }

  // ---- New run ----
  run = newRunState(body.runId);
  run.requestHash = hash;
  run.publicMarker = body.publicMarker ?? null;
  run.policy = body.policy;
  run.toolCatalog = body.toolCatalog;
  run.incident = { ...body.incident, transcript: undefined }; // never persist full transcript
  run.agentName = body.agentName || "incident-response";

  const incoming = parseIncomingTraceContext(req.headers);
  run.traceId = incoming ? incoming.traceId : newTraceId();
  run.serverSpanId = newSpanId();
  run.agentSpanId = newSpanId();
  run.chatSpanId = newSpanId();
  run.incomingParentSpanId = incoming ? incoming.spanId : null;
  run.tracestate = incoming ? incoming.tracestate : undefined;

  const attrs = () => ({
    "ga5.run.id": run.runId,
    "ga5.public.marker": run.publicMarker ?? "",
  });

  addSpan(run, {
    spanId: run.serverSpanId,
    parentSpanId: run.incomingParentSpanId || undefined,
    traceId: run.traceId,
    name: "POST /v2/incidents",
    kind: 2, // SERVER
    attributes: attrs(),
  });
  addSpan(run, {
    spanId: run.agentSpanId,
    parentSpanId: run.serverSpanId,
    traceId: run.traceId,
    name: "invoke_agent incident-response",
    kind: 1, // INTERNAL
    attributes: attrs(),
  });

  let plan;
  try {
    plan = await planIncident({ incident: body.incident, toolCatalog: body.toolCatalog, policy: body.policy });
  } catch (e) {
    return sendJson(res, 502, { error: "planning failed", detail: String(e.message || e) });
  }

  addSpan(run, {
    spanId: run.chatSpanId,
    parentSpanId: run.agentSpanId,
    traceId: run.traceId,
    name: "chat incident-plan",
    kind: 3, // CLIENT
    attributes: {
      ...attrs(),
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": process.env.MODEL_NAME || "claude-haiku-4-5-20251001",
    },
  });

  // ---- Validate / repair root cause + evidence against policy ----
  const allowed = body.incident.allowedRootCauses;
  const evidenceInTranscript = extractEvidenceIds(body.incident.transcript || "");
  let rootCause = allowed.includes(plan.rootCause) ? plan.rootCause : allowed[0];
  let evidence = (plan.evidence || []).filter((e) => evidenceInTranscript.includes(e));
  evidence = [...new Set(evidence)].slice(0, 4);
  if (evidence.length < 2) {
    for (const id of evidenceInTranscript) {
      if (evidence.length >= 2) break;
      if (!evidence.includes(id)) evidence.push(id);
    }
  }
  run.diagnosis = { rootCause, evidence };

  // ---- Build diagnostic dispatches ----
  const maxDiag = body.policy.maximumDiagnostics || 3;
  const catalogNames = new Set(body.toolCatalog.map((t) => t.name));
  const diagPlans = (plan.diagnostics || [])
    .filter((d) => catalogNames.has(d.toolName))
    .slice(0, maxDiag);

  const dispatches = [];
  const diagExecuteSpanIds = [];

  for (const d of diagPlans) {
    const actionId = newOpaqueId("act");
    const callId = newOpaqueId("call");
    const clientSpanId = newSpanId();
    const executeSpanId = newSpanId();

    let ev = (d.evidence || []).filter((e) => evidence.includes(e));
    ev = [...new Set(ev)];
    if (ev.length === 0) ev = [evidence[0]];

    const dispatch = {
      actionId,
      callId,
      phase: "diagnostic",
      toolName: d.toolName,
      arguments: d.arguments || {},
      evidence: ev,
      attempt: 1,
      traceparent: buildTraceparent(run.traceId, clientSpanId),
    };
    dispatches.push(dispatch);
    run.actionLog.push(dispatch);

    addSpan(run, {
      spanId: executeSpanId,
      parentSpanId: run.agentSpanId,
      traceId: run.traceId,
      name: `execute_tool ${d.toolName}`,
      kind: 1,
      attributes: {
        ...attrs(),
        "ga5.action.id": actionId,
        "gen_ai.tool.name": d.toolName,
        "gen_ai.tool.call.id": callId,
        "gen_ai.operation.name": "execute_tool",
      },
    });
    addSpan(run, {
      spanId: clientSpanId,
      parentSpanId: executeSpanId,
      traceId: run.traceId,
      name: `POST tool/${d.toolName}`,
      kind: 3,
      attributes: {
        ...attrs(),
        "ga5.action.id": actionId,
        "ga5.attempt": 1,
        "http.request.method": "POST",
        "http.request.resend_count": 0,
      },
    });

    diagExecuteSpanIds.push(executeSpanId);
    run.pending.calls[callId] = {
      actionId,
      callId,
      phase: "diagnostic",
      toolName: d.toolName,
      arguments: d.arguments || {},
      evidence: ev,
      attempt: 1,
      clientSpanId,
      executeSpanId,
      dispatch,
    };
  }

  if (diagExecuteSpanIds.length > 1) {
    run.joinSpanId = newSpanId();
    addSpan(run, {
      spanId: run.joinSpanId,
      parentSpanId: run.agentSpanId,
      traceId: run.traceId,
      name: "incident.join",
      kind: 1,
      attributes: attrs(),
      links: diagExecuteSpanIds.map((id) => ({ traceId: run.traceId, spanId: id })),
    });
  }

  // Stash the intended effect for later, once diagnostics are confirmed. Not dispatched yet.
  const effectPlan = plan.effect || {};
  run.effectPlan = {
    toolName: body.policy.effectTools?.includes(effectPlan.toolName) ? effectPlan.toolName : body.policy.effectTools?.[0],
    arguments: effectPlan.arguments || {},
  };

  const stepResponse = {
    runId: run.runId,
    status: "waiting",
    diagnosis: run.diagnosis,
    dispatches,
    approvals: [],
  };
  run.initialResponse = stepResponse;
  run.status = "waiting";

  saveRun(run);
  return sendJson(res, 200, stepResponse);
});

// ---------- POST /v2/incidents/:runId/receipts ----------
app.post("/v2/incidents/:runId/receipts", async (req, res) => {
  const { runId } = req.params;
  const run = loadRun(runId);
  if (!run) return sendJson(res, 404, { error: "run not found" });

  const body = req.body || {};
  if (!body.receiptId) return sendJson(res, 422, { error: "missing receiptId" });
  const hasOutcomes = Array.isArray(body.outcomes);
  const hasApprovals = Array.isArray(body.approvals);
  if (!hasOutcomes && !hasApprovals) {
    return sendJson(res, 422, { error: "receipt must include outcomes or approvals" });
  }

  const hash = contentHash(body);
  const existing = run.receipts[body.receiptId];
  if (existing) {
    if (existing.hash === hash) return sendJson(res, 200, existing.response);
    return sendJson(res, 409, { error: "receiptId exists with different content" });
  }
  if (run.status === "completed" || run.status === "failed") {
    return sendJson(res, 422, { error: "run already terminal" });
  }

  const attrs = () => ({
    "ga5.run.id": run.runId,
    "ga5.public.marker": run.publicMarker ?? "",
  });

  const newDispatches = [];
  let diagnosticsJustFailed = false;

  if (hasOutcomes) {
    for (const o of body.outcomes) {
      const pc = run.pending.calls[o.callId];
      if (!pc || pc.actionId !== o.actionId || pc.attempt !== o.attempt) continue; // only accept pending calls

      const span = findSpan(run, pc.clientSpanId);
      run.receiptLog.push({
        receiptId: body.receiptId,
        actionId: o.actionId,
        callId: o.callId,
        attempt: o.attempt,
        status: o.status,
        resultClass: o.resultClass,
        nonce: o.nonce,
      });
      if (span) {
        span.attributes["ga5.receipt.id"] = body.receiptId;
        span.attributes["ga5.receipt.nonce"] = o.nonce;
      }

      const isTimeout = o.status === 0 && o.errorType === "timeout";
      const is503 = o.status === 503;

      if (o.status === 200) {
        if (span) span.status = { code: 0 };
        delete run.pending.calls[o.callId];
      } else if (is503 && pc.attempt === 1) {
        if (span) {
          span.status = { code: 2 };
          span.attributes["error.type"] = "503";
          span.attributes["http.request.resend_count"] = 0;
        }
        // exactly one retry
        const newClientSpanId = newSpanId();
        addSpan(run, {
          spanId: newClientSpanId,
          parentSpanId: pc.executeSpanId,
          traceId: run.traceId,
          name: `POST tool/${pc.toolName}`,
          kind: 3,
          attributes: {
            ...attrs(),
            "ga5.action.id": pc.actionId,
            "ga5.attempt": 2,
            "http.request.method": "POST",
            "http.request.resend_count": 1,
          },
        });
        const retryDispatch = {
          actionId: pc.actionId,
          callId: pc.callId,
          phase: pc.phase,
          toolName: pc.toolName,
          arguments: pc.arguments,
          evidence: pc.evidence,
          attempt: 2,
          traceparent: buildTraceparent(run.traceId, newClientSpanId),
        };
        run.actionLog.push(retryDispatch);
        newDispatches.push(retryDispatch);
        run.pending.calls[o.callId] = { ...pc, attempt: 2, clientSpanId: newClientSpanId, dispatch: retryDispatch };
      } else {
        // second 503, timeout, or other failure: terminal failure for this call
        if (span) {
          span.status = { code: 2 };
          span.attributes["error.type"] = isTimeout ? "timeout" : String(o.status);
        }
        delete run.pending.calls[o.callId];
        if (pc.phase === "diagnostic") diagnosticsJustFailed = true;
        else run.suppressed.push({ actionId: pc.actionId, toolName: pc.toolName, reason: "effect_execution_failed" });
      }
    }
  }

  if (hasApprovals) {
    for (const a of body.approvals) {
      const pending = run.pending.approvals[a.approvalId];
      if (!pending) continue;
      run.receiptLog.push({ receiptId: body.receiptId, approvalId: a.approvalId, decision: a.decision, nonce: a.nonce });

      const gateSpan = findSpan(run, run.approvalGateSpanId);
      if (gateSpan) {
        gateSpan.attributes["ga5.approval.id"] = a.approvalId;
        gateSpan.attributes["ga5.approval.nonce"] = a.nonce;
        gateSpan.status = { code: a.decision === "approved" ? 1 : 2 };
      }
      delete run.pending.approvals[a.approvalId];

      if (a.decision === "approved") {
        const callId = newOpaqueId("call");
        const clientSpanId = newSpanId();
        const executeSpanId = newSpanId();
        const dispatch = {
          actionId: pending.actionId,
          callId,
          phase: "effect",
          toolName: pending.toolName,
          arguments: pending.arguments,
          attempt: 1,
          traceparent: buildTraceparent(run.traceId, clientSpanId),
          approvalId: a.approvalId,
          approvalNonce: a.nonce,
        };
        run.actionLog.push(dispatch);
        newDispatches.push(dispatch);

        addSpan(run, {
          spanId: executeSpanId,
          parentSpanId: run.agentSpanId,
          traceId: run.traceId,
          name: `execute_tool ${pending.toolName}`,
          kind: 1,
          attributes: {
            ...attrs(),
            "ga5.action.id": pending.actionId,
            "gen_ai.tool.name": pending.toolName,
            "gen_ai.tool.call.id": callId,
            "gen_ai.operation.name": "execute_tool",
          },
        });
        addSpan(run, {
          spanId: clientSpanId,
          parentSpanId: executeSpanId,
          traceId: run.traceId,
          name: `POST tool/${pending.toolName}`,
          kind: 3,
          attributes: {
            ...attrs(),
            "ga5.action.id": pending.actionId,
            "ga5.attempt": 1,
            "http.request.method": "POST",
            "http.request.resend_count": 0,
          },
        });

        run.pending.calls[callId] = {
          actionId: pending.actionId,
          callId,
          phase: "effect",
          toolName: pending.toolName,
          arguments: pending.arguments,
          attempt: 1,
          clientSpanId,
          executeSpanId,
          dispatch,
        };
        run.chosenEffect = pending.toolName;
      } else {
        run.suppressed.push({ actionId: pending.actionId, toolName: pending.toolName, reason: "approval_denied" });
      }
    }
  }

  // ---- Decide next step ----
  const stillPendingDiagnostics = Object.values(run.pending.calls).some((c) => c.phase === "diagnostic");
  const stillPendingEffect = Object.values(run.pending.calls).some((c) => c.phase === "effect");
  const stillPendingApprovals = Object.keys(run.pending.approvals).length > 0;

  let stepResponse;

  if (stillPendingDiagnostics || stillPendingEffect || stillPendingApprovals || newDispatches.length > 0) {
    if (!stillPendingDiagnostics && !stillPendingEffect && !newDispatches.length && diagnosticsJustFailed) {
      // fallthrough to finalize below
    } else {
      stepResponse = {
        runId: run.runId,
        status: "waiting",
        diagnosis: run.diagnosis,
        dispatches: newDispatches,
        approvals: [],
      };
    }
  }

  if (!stepResponse) {
    // No pending diagnostics/effects/approvals and nothing new dispatched this step -> decide terminal or advance to effect.
    if (diagnosticsJustFailed && !run.chosenEffect) {
      run.suppressed.push({ toolName: run.effectPlan?.toolName, reason: "diagnostic_failed" });
      run.status = "failed";
      stepResponse = finalResponse(run);
    } else if (!stillPendingDiagnostics && !run.chosenEffect && !stillPendingApprovals && Object.keys(run.pending.calls).length === 0) {
      // Diagnostics all confirmed successfully; time to propose the effect.
      const effect = run.effectPlan;
      if (run.policy.approvalRequiredFor?.includes(effect.toolName)) {
        const approvalId = newOpaqueId("appr");
        const actionId = newOpaqueId("act");
        run.approvalGateSpanId = newSpanId();
        addSpan(run, {
          spanId: run.approvalGateSpanId,
          parentSpanId: run.agentSpanId,
          traceId: run.traceId,
          name: "approval_gate",
          kind: 1,
          attributes: attrs(),
        });
        run.pending.approvals[approvalId] = {
          approvalId,
          actionId,
          toolName: effect.toolName,
          arguments: effect.arguments,
        };
        stepResponse = {
          runId: run.runId,
          status: "waiting",
          diagnosis: run.diagnosis,
          dispatches: [],
          approvals: [
            {
              approvalId,
              actionId,
              toolName: effect.toolName,
              argumentsDigest: argumentsDigest(effect.arguments),
            },
          ],
        };
      } else {
        const actionId = newOpaqueId("act");
        const callId = newOpaqueId("call");
        const clientSpanId = newSpanId();
        const executeSpanId = newSpanId();
        const dispatch = {
          actionId,
          callId,
          phase: "effect",
          toolName: effect.toolName,
          arguments: effect.arguments,
          attempt: 1,
          traceparent: buildTraceparent(run.traceId, clientSpanId),
        };
        run.actionLog.push(dispatch);
        addSpan(run, {
          spanId: executeSpanId,
          parentSpanId: run.agentSpanId,
          traceId: run.traceId,
          name: `execute_tool ${effect.toolName}`,
          kind: 1,
          attributes: {
            ...attrs(),
            "ga5.action.id": actionId,
            "gen_ai.tool.name": effect.toolName,
            "gen_ai.tool.call.id": callId,
            "gen_ai.operation.name": "execute_tool",
          },
        });
        addSpan(run, {
          spanId: clientSpanId,
          parentSpanId: executeSpanId,
          traceId: run.traceId,
          name: `POST tool/${effect.toolName}`,
          kind: 3,
          attributes: {
            ...attrs(),
            "ga5.action.id": actionId,
            "ga5.attempt": 1,
            "http.request.method": "POST",
            "http.request.resend_count": 0,
          },
        });
        run.pending.calls[callId] = {
          actionId,
          callId,
          phase: "effect",
          toolName: effect.toolName,
          arguments: effect.arguments,
          attempt: 1,
          clientSpanId,
          executeSpanId,
          dispatch,
        };
        run.chosenEffect = effect.toolName;
        stepResponse = {
          runId: run.runId,
          status: "waiting",
          diagnosis: run.diagnosis,
          dispatches: [dispatch],
          approvals: [],
        };
      }
    } else {
      // effect resolved (success or failure) and nothing else pending -> terminal
      const effectFailed = run.suppressed.some((s) => s.reason === "effect_execution_failed" || s.reason === "approval_denied");
      run.status = effectFailed ? "failed" : "completed";
      stepResponse = finalResponse(run);
    }
  }

  run.receipts[body.receiptId] = { hash, response: stepResponse };
  saveRun(run);
  return sendJson(res, 200, stepResponse);
});

function finalResponse(run) {
  return {
    runId: run.runId,
    status: run.status,
    diagnosis: run.diagnosis,
    chosenEffect: run.chosenEffect || null,
    suppressed: run.suppressed,
    actionLog: run.actionLog,
    receiptLog: run.receiptLog,
    otlp: buildOtlp(run),
  };
}

// ---------- GET /v2/incidents/:runId ----------
app.get("/v2/incidents/:runId", (req, res) => {
  const run = loadRun(req.params.runId);
  if (!run) return sendJson(res, 404, { error: "run not found" });

  if (run.status === "completed" || run.status === "failed") {
    return sendJson(res, 200, finalResponse(run));
  }

  const dispatches = Object.values(run.pending.calls).map((c) => c.dispatch);
  const approvals = Object.values(run.pending.approvals).map((a) => ({
    approvalId: a.approvalId,
    actionId: a.actionId,
    toolName: a.toolName,
    argumentsDigest: argumentsDigest(a.arguments),
  }));

  return sendJson(res, 200, {
    runId: run.runId,
    status: run.status,
    diagnosis: run.diagnosis,
    dispatches,
    approvals,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`incident-agent listening on :${PORT}`));