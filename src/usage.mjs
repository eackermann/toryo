/**
 * Plan usage as the agents report it: each limit window's percentage used and when it resets.
 *
 * A reading is an observation, not a fact Toryo controls. Each window keeps when the agent took the
 * reading (`sourceAt`: the log line's timestamp, or the moment a live stream reported it) apart from
 * when Toryo received it, and anything missing or malformed stays unknown (null), never 0%.
 *
 * Windows are identified by type (`five_hour`, `weekly`, or a model's own, such as `weekly_opus`) and
 * by when they reset. A reading taken before the one Toryo has never replaces it, whatever reset time it
 * reports, and reading the same log line again is the same measurement, not a fresh one.
 *
 * Agents draw on allowances (`groups`). Headless Codex and the Codex app share one ChatGPT plan, so
 * their readings describe the same allowance. They're never added together: the freshest wins.
 */

/** Which allowance each agent draws on. The owner believes headless Codex and the Codex app share one account. */
export const DEFAULT_GROUPS = Object.freeze({ codex: "openai", codexapp: "openai", claude: "anthropic", cursor: "cursor", grok: "grok" });

const ID = /^[a-z][a-z0-9_-]{0,31}$/;

/** A valid agent → allowance mapping, on top of the defaults. With `strict`, a bad entry is an error rather than ignored. */
export function normalizeGroups(mapping, { strict = false } = {}) {
  const out = { ...DEFAULT_GROUPS };
  if (mapping == null) return out;
  if (typeof mapping !== "object" || Array.isArray(mapping)) {
    if (strict) throw new Error("The allowance mapping must be an object of agent → allowance.");
    return out;
  }
  for (const [agent, group] of Object.entries(mapping)) {
    if (ID.test(agent) && typeof group === "string" && ID.test(group)) out[agent] = group;
    else if (strict) throw new Error(`Invalid allowance mapping entry: ${JSON.stringify(agent)} → ${JSON.stringify(group)}.`);
  }
  return out;
}

export const groupOf = (agent, groups = DEFAULT_GROUPS) => groups[agent] ?? agent;

// ---------------------------------------------------------------- windows

const KNOWN = {
  five_hour: { minutes: 300, label: "5-hour" },
  weekly: { minutes: 10080, label: "weekly" },
  weekly_opus: { minutes: 10080, label: "weekly (Opus)" },
  weekly_sonnet: { minutes: 10080, label: "weekly (Sonnet)" },
};

/** The window type for a length in minutes (Codex reports `window_minutes`). */
export function typeForMinutes(minutes) {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "weekly";
  return `${minutes}_minute`;
}

/** A window type in words: "5-hour", "weekly", "weekly (Opus)". */
export const windowLabel = (type, minutes) => labelFor(type, minutes);

function labelFor(type, minutes) {
  if (KNOWN[type]) return KNOWN[type].label;
  if (Number.isFinite(minutes) && minutes > 0) return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return type.replace(/_/g, " ");
}

/** Claude's `unifiedWindows` keys: five_hour, seven_day, and model-specific ones such as seven_day_opus. */
export function claudeWindowType(key) {
  const k = String(key);
  if (k === "five_hour") return "five_hour";
  if (k === "seven_day") return "weekly";
  if (k.startsWith("seven_day_")) return `weekly_${k.slice("seven_day_".length)}`;
  return k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

/** The type of a window known only by its label, as Toryo stored readings before 13 Oct 2026. */
function typeFromLabel(label) {
  const l = String(label ?? "").trim().toLowerCase();
  for (const [type, k] of Object.entries(KNOWN)) if (k.label === l) return type;
  const hours = l.match(/^(\d+)-hour$/);
  if (hours) return typeForMinutes(Number(hours[1]) * 60);
  return l.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || null;
}

/** An ISO time from an ISO string, a Date or epoch seconds; null when it isn't a real time. */
export function isoTime(value) {
  if (value == null || value === "") return null;
  const d = typeof value === "number" ? new Date(value * 1000) : value instanceof Date ? value : new Date(String(value));
  const ms = d.getTime();
  return Number.isFinite(ms) && ms > 0 ? d.toISOString() : null;
}

const percent = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** One window, from an adapter's reading or an old stored one. Null when it says nothing usable. */
export function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  const type = typeof w.type === "string" && w.type ? w.type : typeFromLabel(w.label);
  if (!type) return null;
  const minutes = Number.isFinite(w.minutes) && w.minutes > 0 ? w.minutes : KNOWN[type]?.minutes ?? null;
  const used = percent(w.used);
  const resetsAt = isoTime(w.resetsAt);
  if (used == null && resetsAt == null) return null;
  return { type, label: typeof w.label === "string" && w.label ? w.label : labelFor(type, minutes), minutes, used, resetsAt };
}

const ORDER = (w) => [w.minutes ?? Infinity, w.type];
const byWindowOrder = (a, b) => {
  const [am, at] = ORDER(a);
  const [bm, bt] = ORDER(b);
  return am - bm || at.localeCompare(bt);
};

// ---------------------------------------------------------------- the usage book

/** Readings of one window that reset within this many minutes of each other describe the same window. */
const SAME_WINDOW_MS = 15 * 60_000;

/**
 * The latest reading of every window, per agent, and the rules for accepting a new one.
 * Persisted as `{ version: 2, agents: { <agent>: { status, reached, plan, windows: { <type>: … } } } }`.
 */
export class UsageBook {
  constructor({ groups = DEFAULT_GROUPS, now = Date.now } = {}) {
    this.groups = normalizeGroups(groups);
    this.now = now;
    this.agents = {};
    this.errors = {};
    // A file written by a newer Toryo isn't overwritten.
    this.writable = true;
  }

  /** Load what limits.json holds, migrating the format used before 13 Oct 2026 (one reading per agent, windows by label). */
  load(raw) {
    this.agents = {};
    this.writable = true;
    if (!raw || typeof raw !== "object") return this;
    if (raw.version === 2 && raw.agents && typeof raw.agents === "object") {
      for (const [agent, entry] of Object.entries(raw.agents)) {
        if (!ID.test(agent) || !entry || typeof entry !== "object") continue;
        const windows = {};
        for (const w of Object.values(entry.windows ?? {})) {
          const n = normalizeWindow(w);
          if (!n) continue;
          windows[n.type] = { ...n, sourceAt: isoTime(w.sourceAt), receivedAt: isoTime(w.receivedAt), checkedAt: isoTime(w.checkedAt), source: typeof w.source === "string" ? w.source : null };
        }
        if (Object.keys(windows).length) this.agents[agent] = { status: strOrNull(entry.status), reached: strOrNull(entry.reached), plan: strOrNull(entry.plan), windows };
      }
      return this;
    }
    if (typeof raw.version === "number" && raw.version > 2) {
      this.writable = false;
      return this;
    }
    // The old format: { <agent>: { at, status, plan, windows: [{ label, used, resetsAt }] } }. Whether `at` was when the
    // agent took the reading or when Toryo got it depended on the agent, so it's kept as the receipt time only.
    for (const [agent, entry] of Object.entries(raw)) {
      if (!ID.test(agent) || !entry || typeof entry !== "object" || !Array.isArray(entry.windows)) continue;
      const at = isoTime(entry.at);
      const windows = {};
      for (const w of entry.windows) {
        const n = normalizeWindow(w);
        if (n) windows[n.type] = { ...n, sourceAt: null, receivedAt: at, checkedAt: at, source: "migrated" };
      }
      if (Object.keys(windows).length) this.agents[agent] = { status: strOrNull(entry.status), reached: null, plan: strOrNull(entry.plan), windows };
    }
    return this;
  }

  toJSON() {
    return { version: 2, agents: this.agents };
  }

  /**
   * Take a new reading from `agent`. Returns `{ changed, results }`, with one result per window:
   * new, newer, new-window, same (the reading Toryo already has), older (taken before the one Toryo has),
   * or older-window (a late reading from a window that has since been replaced). `changed` says whether
   * anything worth saving changed, `fresh` whether there's a newer measurement. A reading with nothing
   * usable in it changes nothing.
   */
  accept(agent, reading, { receivedAt = new Date(this.now()).toISOString(), source = null } = {}) {
    if (!ID.test(String(agent)) || !reading || typeof reading !== "object" || !Array.isArray(reading.windows)) return { changed: false, invalid: true, results: [] };
    const sourceAt = isoTime(reading.sourceAt ?? reading.at);
    const incoming = reading.windows.map(normalizeWindow).filter(Boolean);
    if (!incoming.length) return { changed: false, invalid: true, results: [] };
    const entry = (this.agents[agent] ??= { status: null, reached: null, plan: null, windows: {} });
    let changed = false;
    let fresher = false;
    const results = [];
    for (const w of incoming) {
      const next = { ...w, sourceAt, receivedAt, checkedAt: receivedAt, source };
      const prev = entry.windows[w.type];
      const { keep, reason } = choose(prev, next);
      entry.windows[w.type] = keep;
      if (reason !== "older" && reason !== "older-window") changed = true;
      if (reason === "new" || reason === "newer" || reason === "new-window") fresher = true;
      results.push({ type: w.type, reason });
    }
    if (fresher) {
      entry.status = strOrNull(reading.status) ?? entry.status;
      entry.reached = strOrNull(reading.reached);
      entry.plan = strOrNull(reading.plan) ?? entry.plan;
    }
    return { changed, fresh: fresher, results };
  }

  /** A passive read of an agent's usage failed: show it, rather than an old reading that looks current. */
  noteError(agent, error) {
    this.errors[agent] = { at: new Date(this.now()).toISOString(), error: String(error?.message ?? error).slice(0, 300) };
  }

  clearError(agent) {
    delete this.errors[agent];
  }

  /**
   * Per agent, in the shape the page has always used: `{ at, status, plan, windows: [{ label, used, resetsAt, … }] }`.
   * Each window has its own `sourceAt`, since one window can be fresher than another. `at` is the newest of them,
   * kept for older callers. `error` is the last failed attempt to read the agent's usage, if the latest failed.
   */
  agentView(now = this.now()) {
    const out = {};
    for (const agent of new Set([...Object.keys(this.agents), ...Object.keys(this.errors)])) {
      const entry = this.agents[agent] ?? { status: null, reached: null, plan: null, windows: {} };
      const windows = Object.values(entry.windows).map((w) => ({ ...w, expired: expired(w, now) })).sort(byWindowOrder);
      const error = this.errors[agent] ?? null;
      if (!windows.length && !error) continue;
      const at = windows.map((w) => w.sourceAt ?? w.receivedAt).filter(Boolean).sort().at(-1) ?? null;
      out[agent] = { at, status: entry.status, reached: entry.reached, plan: entry.plan, group: groupOf(agent, this.groups), windows, error };
    }
    return out;
  }

  /**
   * Per allowance: each window's best reading across the agents that share it (the one taken last; see
   * `newestFirst`), with the other agents' readings of that window kept for attribution. Never summed.
   */
  groupView(now = this.now()) {
    const groups = {};
    for (const [agent, entry] of Object.entries(this.agents)) {
      const g = (groups[groupOf(agent, this.groups)] ??= { agents: [], byType: {} });
      g.agents.push(agent);
      for (const w of Object.values(entry.windows)) (g.byType[w.type] ??= []).push({ ...w, agent });
    }
    const out = {};
    for (const [group, g] of Object.entries(groups)) {
      const windows = [];
      for (const readings of Object.values(g.byType)) {
        const [best, ...rest] = [...readings].sort(newestFirst);
        const others = rest.map((r) => ({ agent: r.agent, used: r.used, resetsAt: r.resetsAt, sourceAt: r.sourceAt, receivedAt: r.receivedAt, expired: expired(r, now) }));
        windows.push({ ...best, expired: expired(best, now), others });
      }
      out[group] = { agents: g.agents.sort(), windows: windows.sort(byWindowOrder) };
    }
    return { mapping: { ...this.groups }, groups: out, errors: { ...this.errors } };
  }
}

const strOrNull = (v) => (typeof v === "string" && v ? v : null);

/** A window whose reset time has passed: its percentage describes a window that's over. */
export const expired = (w, now) => Boolean(w.resetsAt) && ms(w.resetsAt) <= now;

const fingerprint = (w) => `${w.used}|${w.resetsAt}`;

/**
 * Which of two readings of one window type, from one agent, to keep, and why. When each was taken comes
 * first: a reading taken earlier never replaces one taken later, whatever reset time it reports, and an
 * undated reading never replaces a dated one. A reading taken later still loses when it describes an
 * earlier window that was already over when it was taken: it's about an obsolete window. When the
 * reading Toryo has is undated (a migrated one), the window decides: a reading of a window that ended
 * before the one Toryo has is late, and one of a later window is the new window.
 */
function choose(prev, next) {
  if (!prev) return { keep: next, reason: "new" };
  const ps = ms(prev.sourceAt);
  const ns = ms(next.sourceAt);
  const pr = ms(prev.resetsAt);
  const nr = ms(next.resetsAt);
  const window = Number.isFinite(pr) && Number.isFinite(nr) && Math.abs(nr - pr) >= SAME_WINDOW_MS ? (nr > pr ? "later" : "earlier") : "same";
  const same = () => ({ keep: { ...prev, checkedAt: laterOf(prev.checkedAt, next.receivedAt) }, reason: "same" });
  const older = () => ({ keep: prev, reason: window === "earlier" ? "older-window" : "older" });
  if (Number.isFinite(ps)) {
    if (!Number.isFinite(ns) || ns < ps) return older();
    if (ns === ps) return same();
    if (window === "earlier" && overAt(next)) return { keep: prev, reason: "older-window" };
    return { keep: next, reason: window === "later" ? "new-window" : "newer" };
  }
  if (window === "earlier") return { keep: prev, reason: "older-window" };
  if (window === "later") return { keep: next, reason: "new-window" };
  // Neither is dated (old stored readings, or an agent that doesn't say): the same numbers are the same reading.
  if (!Number.isFinite(ns) && fingerprint(prev) === fingerprint(next)) return same();
  return { keep: next, reason: "newer" };
}

/**
 * The reading to trust among several agents' readings of one shared window, whatever order they come in:
 * one about a window still running when it was taken before one about a window already over, a dated
 * reading before an undated one, then the one taken last, then the later window, then the one received last.
 */
function newestFirst(a, b) {
  const da = Number.isFinite(ms(a.sourceAt));
  const db = Number.isFinite(ms(b.sourceAt));
  const n = (iso) => (Number.isFinite(ms(iso)) ? ms(iso) : -Infinity);
  return (
    Number(overAt(a)) - Number(overAt(b)) ||
    Number(db) - Number(da) ||
    n(b.sourceAt) - n(a.sourceAt) ||
    n(b.resetsAt) - n(a.resetsAt) ||
    n(b.receivedAt) - n(a.receivedAt) ||
    a.agent.localeCompare(b.agent)
  );
}

/** A reading of a window that had already reset when the reading was taken. */
const overAt = (w) => Number.isFinite(ms(w.resetsAt)) && Number.isFinite(ms(w.sourceAt)) && ms(w.resetsAt) <= ms(w.sourceAt);

function laterOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return ms(b) > ms(a) ? b : a;
}
