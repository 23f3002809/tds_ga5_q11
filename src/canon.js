import crypto from "node:crypto";

// Recursively key-sort an object/array so JSON.stringify is deterministic.
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

export function argumentsDigest(args) {
  return sha256Hex(canonicalJSON(args ?? {}));
}

// Stable hash used to detect "same runId/receiptId, changed content".
export function contentHash(body) {
  return sha256Hex(canonicalJSON(body));
}