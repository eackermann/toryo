import { existsSync, readFileSync } from "node:fs";
import { defaultGuard, parseGuard } from "./guard.mjs";
import { normalizeGroups } from "./usage.mjs";

/**
 * Desk-wide controls, kept in `desk.json` under Toryo's home: Pause everything, holds on agents, and which
 * allowance each agent draws on. They sit apart from each room's own Pause and Stop, so resuming the desk never
 * resumes a room you paused yourself. All of them let current turns finish; they only stop new ones starting.
 *
 *   { version: 2, paused: null | { at }, holds: { <key>: { agents: [...], at } }, groups: { <agent>: <allowance> },
 *     guard: { … } }   (the usage guard: src/guard.mjs)
 *
 * Version 1 had no guard: read, it gets the guard as the owner chose it for existing desks (on, at 90% of the 5-hour
 * and weekly windows, released at reset), with its one-time notice. A file Toryo can't read, or one from a newer
 * Toryo, is never overwritten: nothing new starts until it's fixed or you reset the controls (see Engine.deskControl).
 */

export const DESK_VERSION = 2;

/** "Hold Codex" covers both headless Codex and the Codex app; each can also be held on its own. */
const FAMILIES = { codex: ["codex", "codexapp"] };

export function defaultDesk() {
  return { version: DESK_VERSION, paused: null, holds: {}, groups: normalizeGroups(null), guard: defaultGuard() };
}

/**
 * The hold a request names: `codex` (both Codex interfaces), `codex` with `headless` (headless Codex only),
 * `codexapp` (the Codex app only), or any other agent. Null when it names nothing Toryo knows.
 */
export function holdKey(target, { headless = false } = {}, agents = []) {
  const t = String(target ?? "").trim().toLowerCase().replace(/^codex app$/, "codexapp");
  if (headless) return t === "codex" ? "codex:headless" : null;
  if (t === "codex:headless") return t;
  if (FAMILIES[t] || agents.includes(t)) return t;
  return null;
}

/** The agents a hold covers. */
export function holdAgents(key) {
  if (key === "codex:headless") return ["codex"];
  return FAMILIES[key] ?? [key];
}

/** How a hold reads in a sentence. */
export function holdLabel(key, label = (a) => a) {
  if (key === "codex") return "Codex (headless and the Codex app)";
  if (key === "codex:headless") return "headless Codex";
  if (key === "codexapp") return "the Codex app";
  return label(key);
}

/** Read desk.json: `{ missing: true }`, `{ desk }`, or `{ problem }` (unreadable or unsupported; never overwrite it). */
export function readDesk(path, agents) {
  if (!existsSync(path)) return { missing: true };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problem: `Toryo can't read ${path}: ${error.code ?? error.message}.` };
  }
  return parseDesk(raw, path, agents);
}

export function parseDesk(raw, path, agents) {
  const bad = (why) => ({ problem: `Toryo can't use ${path}: ${why}.` });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("it isn't a JSON object");
  if (typeof raw.version === "number" && raw.version > DESK_VERSION) return bad(`a newer Toryo wrote it (version ${raw.version})`);
  if (raw.version !== DESK_VERSION && raw.version !== 1) return bad("it has no version Toryo knows");
  const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (raw.paused != null && !(typeof raw.paused === "object" && iso(raw.paused.at))) return bad("“paused” isn't valid");
  const holds = {};
  if (raw.holds != null && (typeof raw.holds !== "object" || Array.isArray(raw.holds))) return bad("“holds” isn't valid");
  for (const [key, h] of Object.entries(raw.holds ?? {})) {
    // A hold Toryo can't make sense of isn't dropped quietly: you'd lose a restriction you set.
    if (holdKey(key, {}, agents) !== key || !h || typeof h !== "object" || !iso(h.at)) return bad(`the hold “${key}” isn't valid`);
    holds[key] = { agents: holdAgents(key), at: h.at };
  }
  let groups;
  try {
    groups = normalizeGroups(raw.groups ?? null, { strict: true });
  } catch (error) {
    return bad(error.message.replace(/\.$/, ""));
  }
  // Version 1 had no guard: it starts with the default one, and its notice (`migrated` says to save it so).
  let guard;
  try {
    guard = raw.version === 1 ? defaultGuard() : parseGuard(raw.guard);
  } catch (error) {
    return bad(error.message);
  }
  return { desk: { version: DESK_VERSION, paused: raw.paused ? { at: raw.paused.at } : null, holds, groups, guard }, migrated: raw.version === 1 };
}
