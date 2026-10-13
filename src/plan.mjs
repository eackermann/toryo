/**
 * Read slices out of a plan document. Recognises headings such as
 * "### Slice 4: Operator artwork", "## Task 2 — API", "### Step 3. Docs",
 * and counts checkboxes inside each slice.
 */
const HEADING = /^(#{1,6})\s+(?:\*\*)?(Slice|Task|Step|Phase|Iteration|Milestone|Stage)\s+([0-9]+[a-z]?)\b\s*[:.)\-–—]?\s*(.*?)(?:\*\*)?\s*$/i;

export function parseSlices(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const slices = [];
  let current = null;
  let level = null;
  for (const line of lines) {
    const m = line.match(HEADING);
    if (m && (level === null || m[1].length <= level)) {
      level = m[1].length;
      current = {
        number: m[3],
        kind: m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(),
        name: m[4].replace(/\*\*/g, "").trim() || `${m[2]} ${m[3]}`,
        checks: 0,
        checked: 0,
        markedDone: /\b(done|complete|completed|shipped)\b|✅/i.test(m[4]),
      };
      slices.push(current);
      continue;
    }
    if (current && /^#{1,6}\s/.test(line) && line.match(/^(#{1,6})/)[1].length <= level) {
      current = null;
      continue;
    }
    if (!current) continue;
    const box = line.match(/^\s*[-*]\s+\[( |x|X)\]/);
    if (box) {
      current.checks++;
      if (box[1] !== " ") current.checked++;
    }
  }
  return slices;
}

/** Does a status-line slice label ("Slice 4: Operator artwork") refer to this slice? */
export function sliceMatches(slice, label) {
  if (!label) return false;
  const l = String(label).toLowerCase();
  const n = l.match(/\b(?:slice|task|step|phase|iteration|milestone|stage)?\s*#?([0-9]+[a-z]?)\b/);
  if (n && n[1] === String(slice.number).toLowerCase()) return true;
  return slice.name && l.includes(slice.name.toLowerCase());
}

/**
 * How long each approved slice took, from a room's events in order. A slice runs from the
 * end of the previous one (or the build's start) to its approval. `active` sums the time
 * agents and checks were working; `wall` is the elapsed time, including pauses and waiting.
 */
export function sliceTimes(events) {
  const done = [];
  let seg = null;
  const open = (at) => (seg ??= { start: at, active: 0, turns: 0 });
  for (const e of events) {
    if (e.type === "system" && /^Build started\b/.test(e.text ?? "")) seg = null;
    if (e.type === "turn" && e.startedAt) {
      open(e.startedAt);
      if (e.endedAt) {
        seg.active += Math.max(0, Date.parse(e.endedAt) - Date.parse(e.startedAt));
        seg.turns++;
      }
    }
    if (e.type === "gate") {
      open(e.at);
      seg.active += (e.results ?? []).reduce((n, r) => n + (r.seconds ?? 0) * 1000, 0);
    }
    const m = e.type === "system" && /^“(.+)” approved after (\d+) rounds?/.exec(e.text ?? "");
    if (m && seg) {
      done.push({ label: m[1], rounds: Number(m[2]), active: seg.active, wall: Math.max(0, Date.parse(e.at) - Date.parse(seg.start)), end: e.at });
      seg = null;
    }
  }
  return { done, current: seg };
}

/** 3h14m, 42m, 1d3h: compact enough to sit next to a slice name. */
export function shortDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}
