import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isoTime, normalizeWindow, typeForMinutes } from "../usage.mjs";

/**
 * Codex session logs grow to gigabytes, so read them from the end. Calls
 * `test(line)` on whole lines, newest first, and returns the first truthy
 * result with the byte offset where that line starts. Each byte is read once.
 */
export function scanBack(path, test, { maxBytes = 64 * 1024 * 1024, chunk = 4 * 1024 * 1024 } = {}) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const check = (bytes, offset) => {
    if (!bytes.length) return null;
    const value = test(bytes.toString("utf8"));
    return value ? { value, offset } : null;
  };
  try {
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      // Join bytes, not strings, so a character split across chunks survives.
      const data = Buffer.concat([buf, carry]);
      end = start;
      let stop = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const hit = check(data.subarray(i + 1, stop), start + i + 1);
        if (hit) return hit;
        stop = i;
      }
      // What's left may be the end of a line that started in the previous chunk.
      carry = data.subarray(0, stop);
      if (start === 0) return check(carry, 0);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Split bytes appended to a log into whole lines. An unfinished line, and so
 * any character split across reads, waits for the next call.
 */
export function lineReader() {
  let rest = Buffer.alloc(0);
  return (bytes) => {
    const data = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    const lines = [];
    let start = 0;
    for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
      lines.push(data.subarray(start, nl).toString("utf8"));
      start = nl + 1;
    }
    rest = Buffer.from(data.subarray(start));
    return lines;
  };
}

/**
 * Codex's `rate_limits` payload as a usage reading (see src/usage.mjs). `sourceAt` is the log line's own
 * timestamp. A missing or malformed percentage or reset time stays unknown, never 0.
 */
export function parseRateLimits(rl, { sourceAt = null } = {}) {
  if (!rl || typeof rl !== "object") return null;
  const win = (w) => {
    if (!w || typeof w !== "object") return null;
    const minutes = Number.isFinite(w.window_minutes) && w.window_minutes > 0 ? w.window_minutes : null;
    // Without its length, a window can't be told apart from the others: leave it out.
    return normalizeWindow({ type: minutes ? typeForMinutes(minutes) : null, minutes, used: w.used_percent, resetsAt: typeof w.resets_at === "number" ? w.resets_at : null });
  };
  const windows = [win(rl.primary), win(rl.secondary)].filter(Boolean);
  if (!windows.length) return null;
  // Which limit was reached, as Codex says it (kept as is, so nothing is guessed from it).
  const r = rl.rate_limit_reached_type;
  const reached = !r ? null : typeof r === "string" ? r : JSON.stringify(r);
  return { status: reached ? "limited" : "allowed", reached, plan: typeof rl.plan_type === "string" ? rl.plan_type : null, sourceAt: isoTime(sourceAt), windows };
}

/**
 * The newest plan-usage reading in a Codex session log, or null when the log has none. A log that can't be
 * read throws (the error's `code` says why), so a caller can tell a failed read from a log with no reading.
 */
export function latestRateLimits(path) {
  const hit = scanBack(path, (line) => {
    if (!line.includes('"rate_limits"')) return null;
    try {
      const ev = JSON.parse(line);
      return parseRateLimits(ev?.payload?.rate_limits, { sourceAt: ev?.timestamp });
    } catch {
      return null;
    }
  });
  return hit?.value ?? null;
}
