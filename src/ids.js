import crypto from "node:crypto";

// lowercase hex, nonzero
export function hex(bytes) {
  let s = crypto.randomBytes(bytes).toString("hex");
  // guard against the astronomically unlikely all-zero id
  if (/^0+$/.test(s)) s = s.slice(0, -1) + "1";
  return s;
}

export const newTraceId = () => hex(16); // 32 hex chars
export const newSpanId = () => hex(8);   // 16 hex chars

export function buildTraceparent(traceId, spanId) {
  return `00-${traceId}-${spanId}-01`;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// Returns {traceId, spanId, tracestate} or null if absent/invalid.
export function parseIncomingTraceContext(headers) {
  const tp = headers["traceparent"];
  if (!tp || typeof tp !== "string") return null;
  const m = TRACEPARENT_RE.exec(tp.trim());
  if (!m) return null;
  const [, traceId, spanId] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  const tracestate = typeof headers["tracestate"] === "string" ? headers["tracestate"] : undefined;
  return { traceId, spanId, tracestate };
}

export function newOpaqueId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`; // 18 hex chars, well over 8
}