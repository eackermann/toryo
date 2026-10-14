/**
 * The usage guard. When one of an allowance's limit windows reaches its threshold, Toryo holds that allowance's
 * agents: turns running now finish, and nothing new starts. When the window resets, the hold ends by itself, with
 * or without a new reading. It's kept with the desk's other controls in desk.json (see src/desk.mjs), as `guard`:
 *
 *   { notice: { pending, at },
 *     policies: { <allowance>: { autoRelease, rules: { <window type>: { enabled, at } } } },
 *     holds: { "<allowance>:<window type>": { group, type, used, at, resetsAt, since, agent, state } },
 *     exceptions: { "<allowance>:<window type>": { until, at } } }
 *
 * An allowance with no saved policy uses the default: its 5-hour and weekly windows at 90%, released at reset.
 * A hold is `holding` until its window resets; then it ends, or, with automatic release off, it's `ready` and waits
 * for you to release it. An exception ("pause this guard until reset") lets the allowance run until that window's
 * recorded reset, then ends by itself. Everything here takes the time (`now`, in ms) from its caller.
 */

/** The rules a new desk starts with, and the ones an allowance has until you change them (the owner's choice). */
export const DEFAULT_RULES = Object.freeze({ five_hour: 90, weekly: 90 });

const TYPE = /^[a-z0-9_]{1,40}$/;
const GROUP = /^[a-z][a-z0-9_-]{0,31}$/;
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

export const holdKeyOf = (group, type) => `${group}:${type}`;

export function defaultGuard() {
  return { notice: { pending: true, at: null }, policies: {}, holds: {}, exceptions: {} };
}

/** An allowance's rules: the saved ones over the defaults. */
export function policyFor(guard, group) {
  const saved = guard.policies[group];
  const rules = {};
  for (const [type, at] of Object.entries(DEFAULT_RULES)) rules[type] = { enabled: true, at };
  for (const [type, r] of Object.entries(saved?.rules ?? {})) rules[type] = { ...rules[type], ...r };
  return { autoRelease: saved?.autoRelease ?? true, rules, saved: Boolean(saved) };
}

/** Whether an exception lets the allowance run past this hold now. */
export const excepted = (guard, key, now) => Boolean(guard.exceptions[key]) && ms(guard.exceptions[key].until) > now;

/** The holds that keep an allowance's agents (or, with no allowance named, anyone's) from starting new turns now. */
export function holdsFor(guard, group, now) {
  return Object.entries(guard.holds)
    .filter(([key, h]) => (group == null || h.group === group) && !excepted(guard, key, now))
    .map(([key, h]) => ({ key, ...h }));
}

/** A reset time in words, in the desk's own time zone: "Mon 14 Oct, 09:00". */
export function when(iso) {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A window as you'd type it ("weekly", "5-hour", "five-hour", "weekly-opus") as its type ("five_hour"…). */
export function guardWindow(name) {
  const t = String(name ?? "").trim().toLowerCase().replace(/-/g, "_");
  const aliases = { "5_hour": "five_hour", "5h": "five_hour", five_hours: "five_hour", week: "weekly", "7_day": "weekly", seven_day: "weekly" };
  const type = aliases[t] ?? t;
  if (!/^[a-z0-9_]{1,40}$/.test(type)) throw new Error(`There's no window called “${name ?? ""}”: say 5-hour or weekly.`);
  return type;
}

/** The ways past the guard (see Engine#guardOffers), as text for a reply: each with its command and MCP arguments. */
export function offerText(offers) {
  return offers.map((o) => `${o.text}: ${o.command}${o.mcp ? ` (MCP: ${o.mcp.tool} ${JSON.stringify(o.mcp.arguments)})` : ""}.`).join(" ");
}

/**
 * Apply an allowance's latest readings to its rules: after a fresh reading, or a change to its rules. `windows` are
 * its best reading of each window type (UsageBook.groupView), `types` the window types to look at. At or over the
 * threshold, the allowance is held until that window resets. A late reading of a window that has already reset
 * holds nothing. Under the threshold, a fresh reading (a new window, or a higher threshold) ends a hold, unless
 * automatic release is off: then it's ready for you to release. With `settings` (you changed the rule), a rule
 * that's off or now above the reading ends its hold at once. Returns the changes: { kind, key, hold }.
 */
export function evaluate(guard, group, windows, now, { types = null, settings = false } = {}) {
  const policy = policyFor(guard, group);
  const changes = [];
  const byType = new Map(windows.map((w) => [w.type, w]));
  const looked = types ?? [...byType.keys()];
  for (const type of looked) {
    const key = holdKeyOf(group, type);
    const rule = policy.rules[type];
    const hold = guard.holds[key];
    const w = byType.get(type);
    if (!rule?.enabled) {
      if (hold && settings) changes.push(end(guard, key, "off"));
      continue;
    }
    if (!w || w.used == null || !Number.isFinite(w.used)) continue;
    if (w.resetsAt && ms(w.resetsAt) <= now) continue;
    if (w.used >= rule.at) {
      const next = { group, type, used: w.used, at: rule.at, resetsAt: w.resetsAt ?? null, since: hold?.since ?? new Date(now).toISOString(), agent: w.agent ?? hold?.agent ?? null, state: "holding" };
      if (!hold) {
        guard.holds[key] = next;
        changes.push({ kind: "hold", key, hold: next });
      } else if (hold.used !== next.used || hold.resetsAt !== next.resetsAt || hold.at !== next.at || hold.state !== "holding") {
        // A new window over the threshold after a reset you haven't released yet is held from now.
        if (hold.resetsAt !== next.resetsAt) next.since = new Date(now).toISOString();
        guard.holds[key] = next;
        changes.push({ kind: "update", key, hold: next });
      }
    } else if (hold) {
      if (settings || policy.autoRelease) changes.push(end(guard, key, settings ? "raised" : "fell"));
      else if (hold.state !== "ready") {
        hold.state = "ready";
        changes.push({ kind: "ready", key, hold });
      }
    }
  }
  return changes;
}

function end(guard, key, why) {
  const hold = guard.holds[key];
  delete guard.holds[key];
  delete guard.exceptions[key];
  return { kind: "end", why, key, hold };
}

/**
 * Holds whose window has reset end (or wait for you, with automatic release off), and exceptions whose reset has
 * passed end. Called before anything starts, on a timer, and when Toryo starts: a desk waking up after a reset
 * decides as one that kept running.
 */
export function expire(guard, now) {
  const changes = [];
  for (const [key, h] of Object.entries(guard.holds)) {
    const reset = h.resetsAt != null && ms(h.resetsAt) <= now;
    const auto = policyFor(guard, h.group).autoRelease;
    if (reset && auto) changes.push(end(guard, key, "reset"));
    // Ready to release, and automatic release turned on since: it goes now.
    else if (h.state === "ready" && auto) changes.push(end(guard, key, "reset"));
    else if (reset && h.state !== "ready") {
      h.state = "ready";
      changes.push({ kind: "ready", key, hold: h });
    }
  }
  for (const [key, e] of Object.entries(guard.exceptions))
    if (ms(e.until) <= now) {
      delete guard.exceptions[key];
      changes.push({ kind: "exception-end", key, exception: e });
    }
  return changes;
}

/**
 * Change an allowance's rules (`rules`: { <window>: { enabled?, at? } }, windows named as you'd type them: "5-hour",
 * "weekly") or its automatic release. Saved as yours. Everything is checked before anything changes: a refused
 * change leaves the guard as it was. Returns the window types whose rules actually changed (on or off, or the
 * threshold), counting a rule for a window that had none: a rule given again as it was changes nothing.
 */
export function setPolicy(guard, group, { rules = {}, autoRelease } = {}) {
  const current = policyFor(guard, group);
  const next = {};
  for (const [name, r] of Object.entries(rules)) {
    const type = guardWindow(name);
    const rule = { ...(current.rules[type] ?? { enabled: true, at: 90 }), ...next[type], ...r };
    if (!Number.isFinite(rule.at) || rule.at < 1 || rule.at > 100) throw new Error("A threshold is a percentage from 1 to 100.");
    next[type] = { enabled: Boolean(rule.enabled), at: Math.round(rule.at * 10) / 10 };
  }
  const saved = (guard.policies[group] ??= { autoRelease: current.autoRelease, rules: {} });
  Object.assign(saved.rules, next);
  if (autoRelease != null) saved.autoRelease = Boolean(autoRelease);
  const was = (type) => current.rules[type];
  return Object.keys(next).filter((type) => !was(type) || was(type).enabled !== next[type].enabled || was(type).at !== next[type].at);
}

/** Read the `guard` part of desk.json. Throws (with a plain reason) if anything in it isn't valid: never drop a hold. */
export function parseGuard(raw) {
  if (raw == null) return defaultGuard();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("“guard” isn't valid");
  const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const out = defaultGuard();
  if (raw.notice != null) {
    if (!obj(raw.notice) || typeof raw.notice.pending !== "boolean" || (raw.notice.at != null && !iso(raw.notice.at))) throw new Error("the guard's notice isn't valid");
    out.notice = { pending: raw.notice.pending, at: raw.notice.at ?? null };
  }
  for (const [group, p] of Object.entries(raw.policies ?? {})) {
    if (!GROUP.test(group) || !obj(p) || typeof p.autoRelease !== "boolean" || !obj(p.rules)) throw new Error(`the guard's settings for “${group}” aren't valid`);
    const rules = {};
    for (const [type, r] of Object.entries(p.rules)) {
      if (!TYPE.test(type) || !obj(r) || typeof r.enabled !== "boolean" || !Number.isFinite(r.at) || r.at < 1 || r.at > 100) throw new Error(`the guard's “${type}” rule for “${group}” isn't valid`);
      rules[type] = { enabled: r.enabled, at: r.at };
    }
    out.policies[group] = { autoRelease: p.autoRelease, rules };
  }
  for (const [key, h] of Object.entries(raw.holds ?? {})) {
    const ok =
      obj(h) &&
      GROUP.test(h.group) &&
      TYPE.test(h.type) &&
      key === holdKeyOf(h.group, h.type) &&
      Number.isFinite(h.used) &&
      Number.isFinite(h.at) &&
      (h.resetsAt === null || iso(h.resetsAt)) &&
      iso(h.since) &&
      ["holding", "ready"].includes(h.state);
    if (!ok) throw new Error(`the guard's hold “${key}” isn't valid`);
    out.holds[key] = { group: h.group, type: h.type, used: h.used, at: h.at, resetsAt: h.resetsAt, since: h.since, agent: typeof h.agent === "string" ? h.agent : null, state: h.state };
  }
  for (const [key, e] of Object.entries(raw.exceptions ?? {})) {
    if (!obj(e) || !/^[a-z][a-z0-9_-]{0,31}:[a-z0-9_]{1,40}$/.test(key) || !iso(e.until) || !iso(e.at)) throw new Error(`the guard's exception “${key}” isn't valid`);
    out.exceptions[key] = { until: e.until, at: e.at };
  }
  return out;
}
