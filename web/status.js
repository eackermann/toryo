// The status-line rule, shared by the server (src/protocol.mjs) and the page,
// so the chip the page shows and the status that drives the relay never differ.

export const STATUS_RE = /^\s*(?:[-*]\s+)?[`*_]*\s*(?:TORYO|FOREMAN)\s*:\s*([A-Za-z_]+)\b\s*[:\-–—]?\s*(.*?)\s*[`*_]*\s*$/;

/**
 * The index of the message's status line, or -1. Only the last non-blank line
 * counts, and only outside code blocks and quotes, so a status quoted as an
 * example (or followed by "Actually, fix the bug first") never drives the relay.
 */
export function statusLineIndex(lines) {
  let fence = null;
  let last = -1;
  let lastFenced = false;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()))) {
      fence = fence ? null : f[1];
      last = i;
      lastFenced = true;
      continue;
    }
    if (lines[i].trim()) {
      last = i;
      lastFenced = Boolean(fence);
    }
  }
  if (last < 0 || lastFenced || /^\s*>/.test(lines[last])) return -1;
  return STATUS_RE.test(lines[last]) ? last : -1;
}

export function parseStatus(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const i = statusLineIndex(lines);
  if (i < 0) return { status: null, detail: "" };
  const m = lines[i].match(STATUS_RE);
  return { status: m[1].toUpperCase(), detail: m[2].replace(/[`*_]+$/, "").trim() };
}

/** Remove the status line so the timeline shows it as a chip instead. */
export function stripStatus(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const i = statusLineIndex(lines);
  if (i >= 0) lines.splice(i, 1);
  return lines.join("\n").replace(/\s+$/, "");
}
