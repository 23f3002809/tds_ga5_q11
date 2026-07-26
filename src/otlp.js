function attrValue(v) {
  if (typeof v === "number" && Number.isInteger(v)) return { intValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: String(v) };
}

function toOtlpSpan(s) {
  const now = s.timeNano || `${Date.now()}000000`;
  const out = {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind, // 1 INTERNAL, 2 SERVER, 3 CLIENT
    startTimeUnixNano: now,
    endTimeUnixNano: now,
    attributes: Object.entries(s.attributes || {}).map(([key, value]) => ({
      key,
      value: attrValue(value),
    })),
    status: s.status || { code: 0 }, // 0 UNSET, 1 OK, 2 ERROR
  };
  if (s.links && s.links.length) {
    out.links = s.links.map((l) => ({ traceId: l.traceId, spanId: l.spanId }));
  }
  return out;
}

export function buildOtlp(run) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "incident-response" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "incident-agent" },
            spans: run.spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  };
}