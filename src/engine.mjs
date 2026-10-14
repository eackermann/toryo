import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ADAPTERS, detectAgents } from "./agents/index.mjs";
import { lastAppMessage } from "./agents/codexapp.mjs";
import { readOnlyPaths, readOnlySupport } from "./agents/readonly.mjs";
import { runGates } from "./gates.mjs";
import { parseSlices, shortDuration, sliceMatches, sliceTimes } from "./plan.mjs";
import { acceptRecommendation, catchUp, parseQuestions, parseStatus, preamble, prompts, rulesKey, rulesUpdate, splitRecommendation, stripStatus } from "./protocol.mjs";
import { UsageBook, groupOf, normalizeGroups, windowLabel } from "./usage.mjs";
import { defaultDesk, holdAgents, holdKey, holdLabel, readDesk } from "./desk.mjs";
import { evaluate as evaluateGuard, excepted, expire as expireGuard, guardWindow as parseGuardWindow, holdKeyOf, holdsFor, offerText, policyFor, setPolicy, when } from "./guard.mjs";
import { noteIntent } from "../web/intent.js";
import { firstLine, nowIso, shortId, slugify, truncate } from "./util.mjs";

export const DEFAULT_SETTINGS = {
  maxRounds: 4,
  autoContinue: true,
  maxNudges: 2,
  turnTimeoutMin: 240,
  snapshots: true,
  gates: true,
  // A new session for the reviewer at each new slice, with a ledger of open findings and your decisions.
  freshReviewer: true,
  // After you ask for changes to a ready plan, the other planners check the revision once.
  recheckAfterChanges: true,
};

const BUILDER_KINDS = new Set(["build", "build-fix", "build-next", "build-nudge", "build-answer", "build-gate", "build-note"]);
const REVIEW_KINDS = new Set(["review", "review-status", "review-answer"]);
const PLAN_PARALLEL = new Set(["plan-proposal", "plan-critique", "plan-check"]);
// Home's Recent keeps this many notable events per room, and this many lines of the desk's journal.
const NOTABLE_KEPT = 300;
const JOURNAL_KEPT = 300;
// Chat replies, discussions and second opinions stand on their own. Everything else belongs to the
// room's current run (`room.flow`: a build or a planning round); when a new run starts, queued work
// from the old one is dropped, and turns from it that are still running no longer drive anything.
const FREE_KINDS = new Set(["chat", "discuss", "opinion"]);

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function defaultConfig() {
  return {
    version: 1,
    notify: { windows: true, ntfyTopic: "", ntfyServer: "" },
    agents: {
      codex: { permissions: "sandboxed" },
      claude: { permissionMode: "auto" },
      cursor: {},
      grok: {},
      codexapp: {},
    },
    projects: [],
  };
}

export class Engine extends EventEmitter {
  constructor({ store, snapshots, notifier, adapters = ADAPTERS, usagePollMs = 5 * 60_000, guardPollMs = 30_000, now = Date.now }) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.snapshots = snapshots;
    this.notifier = notifier;
    this.adapters = adapters;
    this.rooms = new Map();
    this.events = new Map();
    this.running = new Map();
    this.agentStatus = {};
    // The clock the usage guard decides by (tests set their own).
    this.now = now;
    // Plan usage, as the agents last reported it (src/usage.mjs). Codex's is re-read from its logs every `usagePollMs`.
    this.usage = new UsageBook({ now: () => this.now() });
    this.usagePollMs = usagePollMs;
    this.usageTimer = null;
    // The usage guard's resets are looked at every `guardPollMs`, besides before anything starts.
    this.guardPollMs = guardPollMs;
    this.guardTimer = null;
    // Desk-wide controls (src/desk.mjs), and a problem with them: a file Toryo can't read, or one it couldn't save.
    // While there's a problem, nothing new starts.
    this.desk = defaultDesk();
    this.deskProblem = null;
    this.queueSeq = 0;
    // Home's Recent: each room's notable events (finished turns, questions, your answers, failed checks,
    // approvals), kept up to date as events come in, and the desk's own journal (src/guard.mjs, deskControl).
    this.notable = new Map();
    this.deskJournal = [];
    // While acting on a turn's outcome (#actOnOutcome): rooms whose saves wait for one save at the end, and the turn
    // whose outcome it is (questions asked then remember it, so acting on it again after a restart doesn't ask twice).
    this.outcomeRooms = new Set();
    this.outcomeSource = null;
    this.lockPaths = new Map();
  }

  label(agent) {
    return this.adapters[agent]?.label ?? agent;
  }

  /** Each agent's latest usage, in the shape the page shows: `{ at, status, plan, windows: [...] }`. */
  get limits() {
    return this.usage.agentView();
  }

  // ---------------------------------------------------------------- setup

  async init({ detect = true } = {}) {
    this.readOnly = readOnlySupport();
    this.config = this.store.loadConfig() ?? defaultConfig();
    this.#normalizeConfig();
    this.usage.load(this.store.readJson(this.store.path("limits.json"), null));
    // The desk's controls come before any room can start anything.
    this.#loadDesk();
    this.deskJournal = this.store
      .readText(this.store.path("desk-events.jsonl"))
      .split("\n")
      .slice(-JOURNAL_KEPT)
      .flatMap((line, i) => {
        try {
          const e = JSON.parse(line);
          return [{ id: e.id ?? `j${i}-${e.at}`, ...e }];
        } catch {
          return [];
        }
      });
    this.store.saveConfig(this.config);
    for (const id of this.store.listRoomIds()) {
      const room = this.store.loadRoom(id);
      if (!room || room.archived) continue;
      this.rooms.set(id, room);
      this.events.set(id, this.store.loadEvents(id));
      for (const ev of this.events.get(id)) this.#noteNotable(room, ev);
      this.#recover(room);
    }
    // Turns whose end was recorded but whose outcome Toryo hadn't acted on when it stopped: act on them now, once,
    // with every room loaded and before anything starts.
    this.recovering = true;
    try {
      for (const room of this.rooms.values()) if (room.pendingOutcome) this.#reconcile(room);
    } finally {
      this.recovering = false;
    }
    if (detect) await this.refreshAgents();
    if (this.usagePollMs > 0 && !this.usageTimer) {
      this.usageTimer = setInterval(() => this.refreshUsage().catch(() => {}), this.usagePollMs);
      this.usageTimer.unref?.();
    }
    if (this.guardPollMs > 0 && !this.guardTimer) {
      this.guardTimer = setInterval(() => this.checkGuards(), this.guardPollMs);
      this.guardTimer.unref?.();
    }
    // Rooms that weren't paused pick up where they were (for example, following the Codex app's turn).
    this.#pumpAll();
  }

  /**
   * Act, once, on the outcome of a turn whose end was recorded just before Toryo stopped (room.pendingOutcome): what
   * the room would have done next (queue the review, ask you the builder's question, retry…). The turn's own record
   * (its text, status, error) and what the room kept (the Codex app turn it follows, lost or uncertain) say it all.
   */
  #reconcile(room) {
    const turnId = room.pendingOutcome.turnId;
    const ev = this.events.get(room.id).find((e) => e.id === turnId);
    if (!ev?.req) {
      room.pendingOutcome = null;
      return this.#save(room);
    }
    const kept = room.appTurn?.marker === (ev.req.attach?.marker ?? `[Toryo ${ev.id}]`) ? room.appTurn : null;
    const run = { turnId: ev.id, roomId: room.id, agent: ev.agent, req: ev.req, dispatch: ev.dispatch, startedAt: ev.startedAt, activity: [], appLost: Boolean(kept?.lost), uncertain: Boolean(kept?.uncertain) };
    this.#actOnOutcome(room, turnId, () => {
      // Said once, even if Toryo stops again before this is saved.
      if (!this.events.get(room.id).some((e) => e.type === "system" && e.reconciled === turnId))
        this.#append(room, { type: "system", text: `Toryo stopped just as ${this.label(ev.agent)}'s turn ended. It carries on from that turn now.`, forAgents: false, level: "info", reconciled: turnId });
      if (ev.state === "done") {
        this.#commitDispatch(room, ev.agent, run);
        this.#markReplies(room, ev.agent, ev.id);
        this.#noteOutcomes(room, ev.req, run, ev);
      }
      this.#afterTurn(room, ev, run);
    });
  }

  /** A request that follows a Codex app turn already handed to the app, instead of sending it again. */
  #followReq(req, ev) {
    return {
      ...req,
      id: shortId("q"),
      // `since`: when the app was given the turn. Notes you wrote after that are answered when it ends, however
      // many times Toryo reconnects to it.
      attach: { marker: req.attach?.marker ?? `[Toryo ${ev.id}]`, dispatch: req.attach?.dispatch ?? ev.dispatch, since: req.attach?.since ?? ev.startedAt },
    };
  }

  /**
   * The Codex app turn a room has handed to the app (room.appTurn). It's kept, on disk, from the moment the
   * app accepts the message until the turn ends or you let it go, whatever happens to Toryo's following of
   * it (errors, stops, restarts, new runs). While it's kept, the room sends the app nothing else and no other
   * room sends into that thread. `lost` means following it failed and waits for you.
   */
  /** The turn a Codex app marker names: the one the app was first given. */
  #appOrigin(room, marker) {
    const id = String(marker ?? "").match(/^\[(?:Toryo|Foreman) (\S+)\]$/)?.[1];
    return id ? (this.events.get(room.id) ?? []).find((e) => e.id === id) ?? null : null;
  }

  #appTurnFrom(room, followReq) {
    return { marker: followReq.attach.marker, thread: room.sessions.codexapp ?? null, req: followReq, lost: false };
  }

  /** Stop for a restart. Running turns stay marked as running, so the next start offers them again. */
  shutdown() {
    this.shuttingDown = true;
    clearInterval(this.usageTimer);
    this.usageTimer = null;
    clearInterval(this.guardTimer);
    this.guardTimer = null;
    for (const run of this.running.values()) {
      run.controller.abort("shutdown");
      run.abandon?.abort();
    }
  }

  /** The models and effort levels an agent offers, for the Settings dropdowns (cached for ten minutes). */
  async listModels(agent) {
    const adapter = this.adapters[agent];
    if (!adapter) throw new UserError("Unknown agent.", 404);
    this.modelLists ??= new Map();
    const hit = this.modelLists.get(agent);
    if (hit && Date.now() - hit.at < 600_000) return hit.list;
    const list = adapter.listModels ? await Promise.resolve(adapter.listModels(this.config.agents[agent] ?? {})).catch(() => ({ models: [] })) : { models: [] };
    this.modelLists.set(agent, { at: Date.now(), list });
    return list;
  }

  async refreshAgents() {
    this.agentStatus = await detectAgents(this.config.agents, this.adapters);
    await this.refreshUsage({ emit: false });
    this.emit("state");
    return this.agentStatus;
  }

  /**
   * Re-read the usage agents keep on disk (Codex's session logs, the Codex app threads' logs), so it shows
   * before an agent's first turn here and stays current between turns. Nothing is run or sent. Claude
   * reports usage only while it works, so its readings come from its turns.
   */
  async refreshUsage({ emit = true } = {}) {
    let changed = false;
    for (const [id, status] of Object.entries(this.agentStatus ?? {})) {
      const adapter = this.adapters[id];
      if (!status?.installed || !adapter?.currentLimits) continue;
      try {
        const threads = id === "codexapp" ? [...this.rooms.values()].map((r) => r.sessions?.codexapp).filter(Boolean) : [];
        const reading = await adapter.currentLimits(this.config.agents[id] ?? {}, { threads });
        if (this.usage.errors[id]) {
          this.usage.clearError(id);
          changed = true;
        }
        if (reading && this.#setLimits(id, reading, "log")) changed = true;
      } catch (error) {
        this.usage.noteError(id, error);
        changed = true;
      }
    }
    if (changed && emit) this.emit("state");
    return changed;
  }

  /** Take a usage reading from an agent. Returns whether it was news (a newer measurement, not one Toryo already had). */
  #setLimits(agent, reading, source) {
    const { changed, fresh, results } = this.usage.accept(agent, reading, { receivedAt: new Date(this.now()).toISOString(), source });
    if (changed && this.usage.writable)
      try {
        this.store.writeJson(this.store.path("limits.json"), this.usage.toJSON());
      } catch {
        /* usage is informational */
      }
    // A new measurement goes to the guard, for the windows it measured (a reading Toryo already had isn't news).
    const types = results.filter((r) => ["new", "newer", "new-window"].includes(r.reason)).map((r) => r.type);
    if (fresh && types.length) this.#guardReading(groupOf(agent, this.desk.groups), types);
    return Boolean(fresh);
  }

  // ---------------------------------------------------------------- desk-wide controls

  #loadDesk() {
    const path = this.store.path("desk.json");
    const read = readDesk(path, Object.keys(this.adapters));
    this.desk = read.desk ?? defaultDesk();
    this.deskProblem = read.problem ? { kind: "unreadable", text: read.problem, at: nowIso() } : null;
    // A new desk, or one from before the usage guard: saved with the guard on, as the owner chose for both.
    if (read.missing || read.migrated)
      try {
        this.store.writeJson(path, this.desk);
      } catch (error) {
        this.deskProblem = { kind: "unsaved", text: `Toryo couldn't save its desk controls (${path}): ${error.code ?? error.message}.`, at: nowIso() };
      }
    this.usage.groups = normalizeGroups(this.desk.groups);
    // Before any room can start anything: the guard looks at the latest saved readings (on a desk that has just
    // switched it on, and on one whose last hold may not have been saved before Toryo stopped), then at the windows
    // that reset while Toryo was stopped. Your rules and exceptions stay as they are.
    if (!read.problem) {
      this.#guardAllReadings();
      this.#expireGuards();
    }
  }

  /** The desk's controls, for the page, the terminal and the phone. */
  deskView() {
    const d = this.desk;
    return {
      paused: d.paused,
      holds: Object.entries(d.holds).map(([key, h]) => ({ key, agents: h.agents, at: h.at, label: holdLabel(key, (a) => this.label(a)) })),
      groups: { ...d.groups },
      guard: this.#guardView(),
      problem: this.deskProblem,
    };
  }

  /**
   * Change the desk's controls. Each is saved before it's acknowledged. If saving fails, a new restriction (a hold,
   * Pause everything) applies anyway and nothing new starts until it's saved; anything that would release work
   * doesn't happen. Actions: pause, resume, hold / release ({ target, headless }), groups ({ groups }), save
   * (try saving again) and reset (set an unreadable desk.json aside and start with no controls).
   */
  deskControl(action, args = {}) {
    const agents = Object.keys(this.adapters);
    if (this.deskProblem?.kind === "unreadable" && action !== "reset")
      throw new UserError(`${this.deskProblem.text} Nothing new starts until that's fixed: fix the file and restart Toryo, or reset the desk controls.`, 409);
    const before = structuredClone(this.desk);
    const d = this.desk;
    const names = (list) => list.map((a) => this.label(a)).join(" and ");
    let restrictive = false;
    let message;
    let extra = {};
    let guardChanges = [];
    let journalText = null;
    // A refused action leaves the controls exactly as they were.
    try {
      switch (action) {
        case "pause":
          restrictive = true;
          d.paused ??= { at: nowIso() };
          journalText = "You paused everything";
          message = "Everything is paused. Turns and checks running now finish; nothing new starts until you resume.";
          break;
        case "resume": {
          d.paused = null;
          journalText = "You resumed everything";
          const held = Object.keys(d.holds).map((k) => holdLabel(k, (a) => this.label(a)));
          const guarded = holdsFor(d.guard, null, this.now()).map((h) => this.#guardReason(h));
          message = `Everything resumed${held.length ? `, except what you hold: ${held.join(", ")}` : ""}.${guarded.length ? ` The usage guard still holds: ${guarded.join("; ")}.` : ""} Rooms you paused yourself stay paused.`;
          break;
        }
        case "hold":
        case "release": {
          const key = holdKey(args.target ?? args.agent, { headless: Boolean(args.headless) }, agents);
          if (!key) throw new UserError(args.headless ? "Only Codex can be held headless-only." : `There's no agent called “${args.target ?? args.agent ?? ""}”.`);
          const label = holdLabel(key, (a) => this.label(a));
          if (action === "hold") {
            restrictive = true;
            d.holds[key] ??= { agents: holdAgents(key), at: nowIso() };
            journalText = `You held ${label}`;
            message = `Holding ${label}: ${names(holdAgents(key))} finish${holdAgents(key).length > 1 ? "" : "es"} the turns they're on, then start${holdAgents(key).length > 1 ? "" : "s"} no new ones until you release ${holdAgents(key).length > 1 ? "them" : "it"}.`;
          } else {
            const offers = this.#guardOffers(holdAgents(key));
            if (!d.holds[key]) {
              // Not held by you, but perhaps by the guard: say so, with the way past it.
              if (!offers.length) throw new UserError(`${label[0].toUpperCase()}${label.slice(1)} isn't held.`);
              return { message: `You don't hold ${label}. ${offerText(offers)}`, offers, desk: this.deskView() };
            }
            delete d.holds[key];
            journalText = `You released ${label}`;
            const still = Object.entries(d.holds).filter(([, h]) => h.agents.some((a) => holdAgents(key).includes(a)));
            message = `Released ${label}.${still.length ? ` Still held: ${still.map(([k]) => holdLabel(k, (a) => this.label(a))).join(", ")}.` : ""}${offers.length ? ` ${offerText(offers)}` : ""}`;
            extra = { offers };
          }
          break;
        }
        case "guard": {
          // The guard's rules for one allowance (`target`: an agent or an allowance), or for all: thresholds per
          // window (`rules`), automatic release, or all on or off (`enabled`).
          const groups = args.target ? [this.#guardGroup(args.target)] : this.#guardGroups();
          // Every allowance's change is made on a copy first: one refused leaves the guard exactly as it was.
          const next = structuredClone(d.guard);
          const changed = new Map();
          for (const group of groups) {
            const rules = { ...(args.rules ?? {}) };
            if (args.enabled != null) for (const type of Object.keys(policyFor(next, group).rules)) rules[type] = { ...rules[type], enabled: Boolean(args.enabled) };
            try {
              changed.set(group, setPolicy(next, group, { rules, autoRelease: args.autoRelease }));
            } catch (error) {
              throw new UserError(error.message);
            }
          }
          // Only the rules you changed are looked at again: a hold on another window stays as it is.
          const changes = [];
          for (const [group, types] of changed) {
            const windows = this.usage.groupView(this.now()).groups[group]?.windows ?? [];
            if (types.length) changes.push(...evaluateGuard(next, group, windows, this.now(), { types, settings: true }));
          }
          d.guard = next;
          d.guard.notice = { pending: false, at: d.guard.notice.at ?? nowIso() };
          restrictive = !changes.some((c) => c.kind === "end");
          guardChanges = changes;
          message = `${groups.map((g) => this.#policyText(g)).join(" ")}${changes.length ? ` ${changes.map((c) => this.#guardChangeText(c).title).join(". ")}.` : ""}`;
          break;
        }
        case "guard-pause": {
          // Pause one window's guard until that window resets.
          const group = this.#guardGroup(args.target);
          const type = guardWindow(args.window);
          const key = holdKeyOf(group, type);
          const hold = d.guard.holds[key];
          const reading = (this.usage.groupView(this.now()).groups[group]?.windows ?? []).find((w) => w.type === type);
          const until = hold?.resetsAt ?? (reading && !reading.expired ? reading.resetsAt : null);
          const name = `${this.#groupName(group)}'s ${windowLabel(type)} limit`;
          if (!until) throw new UserError(`${name} has no known reset time, so the guard can't be paused until then. To stop it holding, turn that rule off: ${this.#ruleOffCommand(group, type)}`);
          if (hold?.state === "ready") throw new UserError(`${name} has already reset. Release the guard's hold instead: toryo guard ${this.#groupTarget(group)} --window ${type.replace(/_/g, "-")} --release-expired-hold`);
          d.guard.exceptions[key] = { until, at: nowIso() };
          const others = holdsFor(d.guard, group, this.now()).map((h) => this.#guardReason(h));
          message = `The guard lets ${this.#groupName(group)} run until its ${windowLabel(type)} limit resets ${when(until)}; then it guards again.${others.length ? ` Still held: ${others.join("; ")}.` : ""}`;
          guardChanges = [{ kind: "exception", key, until }];
          break;
        }
        case "guard-release": {
          // Release a hold whose window has reset (with automatic release off, it waits for you).
          const group = this.#guardGroup(args.target);
          const type = guardWindow(args.window);
          const key = holdKeyOf(group, type);
          const hold = d.guard.holds[key];
          const name = `${this.#groupName(group)}'s ${windowLabel(type)} limit`;
          if (!hold) throw new UserError(`The guard isn't holding ${this.#groupName(group)} for its ${windowLabel(type)} limit.`);
          if (hold.state !== "ready")
            throw new UserError(`${name} hasn't reset yet${hold.resetsAt ? ` (it resets ${when(hold.resetsAt)})` : ""}, so its hold can't be released as expired.${hold.resetsAt ? ` To let it run anyway until then: toryo guard ${this.#groupTarget(group)} --window ${type.replace(/_/g, "-")} --pause-until-reset` : ""}`);
          delete d.guard.holds[key];
          const others = holdsFor(d.guard, group, this.now()).map((h) => this.#guardReason(h));
          message = `Released the guard's hold on ${this.#groupName(group)} for its ${windowLabel(type)} limit.${others.length ? ` Still held: ${others.join("; ")}.` : ""}`;
          guardChanges = [{ kind: "end", why: "released", key, hold }];
          break;
        }
        case "guard-ok":
          d.guard.notice = { pending: false, at: nowIso() };
          message = "Noted. The usage guard stays as it is; `toryo guard` shows it.";
          break;
        case "groups":
          try {
            d.groups = normalizeGroups(args.groups, { strict: true });
          } catch (error) {
            throw new UserError(error.message);
          }
          message = "Allowances updated.";
          break;
        case "save":
          message = "Desk controls saved.";
          break;
        case "reset":
          return this.#resetDesk();
        default:
          throw new UserError(`Unknown desk action: ${action}`);
      }
    } catch (error) {
      this.desk = before;
      throw error;
    }
    try {
      this.store.writeJson(this.store.path("desk.json"), this.desk);
      if (this.deskProblem?.kind === "unsaved") this.deskProblem = null;
    } catch (error) {
      const why = error.code ?? error.message;
      if (restrictive) this.deskProblem = { kind: "unsaved", text: `Toryo couldn't save your desk controls (${why}).`, at: nowIso() };
      else this.desk = before;
      this.emit("state");
      this.#pumpAll();
      throw new UserError(`Toryo couldn't save that (${why}). ${restrictive ? "It applies anyway, and nothing new starts until Toryo can save it." : "Nothing changed."}`, 500);
    }
    this.usage.groups = normalizeGroups(this.desk.groups);
    // What you changed goes in the desk's journal (no notifications: you did it).
    for (const c of guardChanges) this.#journal({ kind: `guard-${c.kind}`, key: c.key, text: this.#guardChangeText(c).title, by: "you" });
    if (journalText) this.#journal({ kind: `desk-${action}`, text: journalText, by: "you" });
    this.emit("state");
    this.#pumpAll();
    return { message, ...extra, desk: this.deskView() };
  }

  // ---------------------------------------------------------------- usage guard (src/guard.mjs)

  /** Look at the guard's resets now: holds whose window has reset end, and the work they held goes on. */
  checkGuards() {
    this.#expireGuards();
    this.#schedule();
  }

  /** Holds whose window has reset end (or wait for you), and exceptions whose reset has passed end; said once. */
  #expireGuards() {
    if (this.deskProblem?.kind === "unreadable") return;
    const changes = expireGuard(this.desk.guard, this.now());
    if (changes.length) this.#guardChanged(changes);
  }

  /**
   * The guard looks at every allowance's latest readings: when Toryo starts, and when the controls are reset. A hold
   * a reading called for is there, saved or not; one that ended (a reset, a lower reading, a rule you changed) isn't
   * brought back, since the same readings and rules end it again.
   */
  #guardAllReadings() {
    const changes = [];
    const groups = this.usage.groupView(this.now()).groups;
    for (const group of this.#guardGroups()) changes.push(...evaluateGuard(this.desk.guard, group, groups[group]?.windows ?? [], this.now()));
    if (changes.length) this.#guardChanged(changes);
  }

  /** A fresh reading of some of an allowance's windows (`types`): the guard looks at its best reading of each. */
  #guardReading(group, types) {
    if (this.deskProblem?.kind === "unreadable") return;
    const windows = this.usage.groupView(this.now()).groups[group]?.windows ?? [];
    const changes = evaluateGuard(this.desk.guard, group, windows, this.now(), { types });
    if (!changes.length) return;
    this.#guardChanged(changes);
    this.#schedule();
  }

  /**
   * The guard changed by itself (a reading, a reset): saved, written in the desk's journal, and notified once per
   * change, not once per room it holds up. If it can't be saved, it applies anyway, and nothing new starts until it
   * can be (a hold isn't lost, and a release doesn't let work through unsaved).
   */
  #guardChanged(changes) {
    try {
      this.store.writeJson(this.store.path("desk.json"), this.desk);
      if (this.deskProblem?.kind === "unsaved") this.deskProblem = null;
    } catch (error) {
      this.deskProblem = { kind: "unsaved", text: `Toryo couldn't save the usage guard's state (${error.code ?? error.message}).`, at: nowIso() };
    }
    for (const c of changes) {
      const t = this.#guardChangeText(c);
      if (!t) continue;
      this.#journal({ kind: `guard-${c.kind}`, key: c.key, text: t.title });
      if (t.notify) this.#notify(t.title, t.body);
    }
    this.emit("state");
  }

  /** A change in words: a title (also the journal's line), what it means, and whether it's worth a notification. */
  #guardChangeText(c) {
    const h = c.hold ?? this.desk.guard.holds[c.key];
    const [group, type] = c.key.split(":");
    const name = this.#groupName(h?.group ?? group);
    const win = windowLabel(h?.type ?? type);
    const target = this.#groupTarget(h?.group ?? group);
    const flag = (h?.type ?? type).replace(/_/g, "-");
    switch (c.kind) {
      case "hold":
        return { notify: true, title: `Holding ${name}: its ${win} limit is at ${h.used}%`, body: `The usage guard holds ${name} at ${h.at}% of its ${win} limit. Turns running now finish; nothing new starts ${h.resetsAt ? `until it resets ${when(h.resetsAt)}` : "until a new reading shows it under that (its reset time isn't known)"}.` };
      case "update":
        return { notify: false, title: `${name}'s ${win} limit is at ${h.used}%; still held` };
      case "ready":
        return { notify: true, title: `${name}'s ${win} limit has reset`, body: `Automatic release is off, so ${name} stays held until you release it: toryo guard ${target} --window ${flag} --release-expired-hold` };
      case "end": {
        const why = { reset: `its ${win} limit has reset`, fell: `its ${win} limit is back under ${h.at}%`, released: "you released it", off: `you turned the ${win} rule off`, raised: `its ${win} limit is under the new threshold` }[c.why] ?? "it ended";
        return { notify: c.why === "reset" || c.why === "fell", title: `The guard released ${name}: ${why}`, body: `${name}'s work carries on, unless something else holds it.` };
      }
      case "exception":
        return { notify: false, title: `The guard lets ${name} run until its ${win} limit resets ${when(c.until)}` };
      case "exception-end":
        return { notify: false, title: `${name}'s ${win} limit has reset: the guard watches it again` };
      default:
        return null;
    }
  }

  /** Why the guard keeps an agent's turn from starting, in the room's words. */
  #guardReason(h) {
    const name = this.#groupName(h.group);
    const win = windowLabel(h.type);
    if (h.state === "ready") return `${name}'s ${win} limit has reset, and the usage guard waits for you to release it (automatic release is off)`;
    return `${name}'s ${win} limit is at ${h.used}% (the usage guard holds at ${h.at}%) ${h.resetsAt ? `until it resets ${when(h.resetsAt)}` : "until a new reading shows it under that"}`;
  }

  /** The ways past the guard's holds on these agents: pause a window's guard until it resets, or release one that has. */
  #guardOffers(agents) {
    const groups = new Set(agents.map((a) => groupOf(a, this.desk.groups)));
    const out = [];
    for (const h of holdsFor(this.desk.guard, null, this.now())) {
      if (!groups.has(h.group)) continue;
      const target = this.#groupTarget(h.group);
      const window = h.type.replace(/_/g, "-");
      const name = this.#groupName(h.group);
      const win = windowLabel(h.type);
      const offer = (action, text) => ({ key: h.key, action, text, command: `toryo guard ${target} --window ${window} --${action}`, mcp: { tool: "toryo_guard", arguments: { target, window, action } } });
      if (h.state === "ready") out.push(offer("release-expired-hold", `${name}'s ${win} limit has reset; the guard waits for you to release it`));
      else if (h.resetsAt) out.push(offer("pause-until-reset", `The usage guard still holds ${name}: its ${win} limit is at ${h.used}% (guard at ${h.at}%) until it resets ${when(h.resetsAt)}. To let it run anyway until then`));
      else out.push({ key: h.key, action: null, text: `The usage guard still holds ${name}: its ${win} limit is at ${h.used}%, and its reset time isn't known, so it can't be paused until then. To stop it holding, turn that rule off`, command: this.#ruleOffCommand(h.group, h.type), mcp: { tool: "toryo_guard", arguments: { target, rules: { [window]: { enabled: false } } } } });
    }
    return out;
  }

  #guardView() {
    const g = this.desk.guard;
    const now = this.now();
    return {
      notice: g.notice,
      policies: this.#guardGroups().map((group) => {
        const p = policyFor(g, group);
        const agents = this.#groupAgents(group);
        // Its name with the agents drawing on it, when there are several: "Codex (headless and the Codex app)".
        const label = agents.length > 1 ? (agents.includes("codex") && agents.includes("codexapp") && agents.length === 2 ? "Codex (headless and the Codex app)" : `${this.#groupName(group)} (${agents.map((a) => this.label(a)).join(" and ")})`) : this.#groupName(group);
        return { group, name: this.#groupName(group), label, target: this.#groupTarget(group), agents, autoRelease: p.autoRelease, saved: p.saved, rules: Object.entries(p.rules).map(([type, r]) => ({ type, label: windowLabel(type), enabled: r.enabled, at: r.at })) };
      }),
      holds: Object.entries(g.holds).map(([key, h]) => ({ key, ...h, name: this.#groupName(h.group), label: windowLabel(h.type), excepted: excepted(g, key, now), exceptionUntil: g.exceptions[key]?.until ?? null, reason: this.#guardReason(h) })),
      exceptions: Object.entries(g.exceptions).map(([key, e]) => ({ key, ...e })),
    };
  }

  /** One allowance's rules in a sentence. */
  #policyText(group) {
    const p = policyFor(this.desk.guard, group);
    const on = Object.entries(p.rules).filter(([, r]) => r.enabled);
    if (!on.length) return `The usage guard is off for ${this.#groupName(group)}.`;
    return `The usage guard holds ${this.#groupName(group)} at ${on.map(([type, r]) => `${r.at}% of its ${windowLabel(type)} limit`).join(" or ")}, and ${p.autoRelease ? "releases it at reset" : "waits for you to release it after the reset"}.`;
  }

  /** The allowances the desk's agents draw on. */
  #guardGroups() {
    return [...new Set(Object.keys(this.adapters).map((a) => groupOf(a, this.desk.groups)))];
  }

  #groupAgents(group) {
    return Object.keys(this.adapters).filter((a) => groupOf(a, this.desk.groups) === group);
  }

  /** An allowance by name: Codex's (headless and the Codex app share it), Claude's… */
  #groupName(group) {
    const agents = this.#groupAgents(group);
    if (agents.includes("codex")) return "Codex";
    return agents.length ? agents.map((a) => this.label(a)).join(" and ") : group;
  }

  /** The command that turns one window's rule off, in a form `toryo guard` takes for any window. */
  #ruleOffCommand(group, type) {
    const flag = { five_hour: "--five-hour off", weekly: "--weekly off" }[type] ?? `--window ${type.replace(/_/g, "-")} --at off`;
    return `toryo guard ${this.#groupTarget(group)} ${flag}`;
  }

  /** The name to give `toryo guard` for an allowance. */
  #groupTarget(group) {
    const agents = this.#groupAgents(group);
    return agents.includes("codex") ? "codex" : (agents[0] ?? group);
  }

  /** The allowance a request names: an agent ("codex", "codex app") or an allowance ("openai"). */
  #guardGroup(target) {
    const t = String(target ?? "").trim().toLowerCase().replace(/^codex app$/, "codexapp");
    if (this.adapters[t]) return groupOf(t, this.desk.groups);
    if (this.#guardGroups().includes(t)) return t;
    throw new UserError(`There's no agent or allowance called “${target ?? ""}”.`);
  }

  /** The desk's journal: what the guard and the controls did, for Home's Recent later. Best effort. */
  #journal(entry) {
    const line = { id: shortId("j"), at: new Date(this.now()).toISOString(), ...entry };
    this.deskJournal.push(line);
    if (this.deskJournal.length > JOURNAL_KEPT) this.deskJournal.shift();
    try {
      this.store.appendLine("desk-events.jsonl", line);
    } catch {
      /* the journal explains; it doesn't decide anything */
    }
  }

  /**
   * Start again with no controls: nothing paused or held. An unreadable file is first copied aside, then replaced
   * in one step by the new controls, so desk.json is never missing: a reset that fails at any point leaves the old
   * file, and its problem, exactly where they were, before and after a restart.
   */
  #resetDesk() {
    const path = this.store.path("desk.json");
    const fresh = defaultDesk();
    const aside = `${path}.unreadable-${Date.now()}`;
    const unreadable = this.deskProblem?.kind === "unreadable" && existsSync(path);
    let copied = false;
    try {
      if (unreadable) {
        this.store.copyFile(path, aside);
        copied = true;
      }
      this.store.writeJson(path, fresh);
    } catch (error) {
      if (copied)
        try {
          rmSync(aside, { force: true });
        } catch {
          /* a spare copy of the old file; harmless */
        }
      throw new UserError(`Toryo couldn't reset the desk controls (${error.code ?? error.message}). Nothing changed, and nothing new starts until the controls are fixed or reset.`, 500);
    }
    this.desk = fresh;
    this.deskProblem = null;
    this.usage.groups = normalizeGroups(this.desk.groups);
    this.#guardAllReadings();
    this.emit("state");
    this.#pumpAll();
    return { message: `${unreadable ? `Desk controls reset; the old file is at ${aside}.` : "Desk controls reset: nothing paused or held."} The usage guard is on at its defaults.`, desk: this.deskView() };
  }

  /** What, desk-wide, keeps a queued request from starting. Following a turn the Codex app already has is never held up. */
  blockersFor(req) {
    if (req.attach) return [];
    const out = [];
    if (this.deskProblem) out.push(this.deskProblem.kind === "unreadable" ? "Toryo can't read its desk controls" : "Toryo couldn't save your desk controls");
    if (this.desk.paused) out.push("everything is paused");
    // Holds are on agents: Toryo's own checks aren't held, only paused with everything else.
    if (req.agent !== "toryo") {
      for (const [key, h] of Object.entries(this.desk.holds)) if (h.agents.includes(req.agent)) out.push(`you hold ${holdLabel(key, (a) => this.label(a))}`);
      // The usage guard holds an allowance: every agent drawing on it.
      for (const h of holdsFor(this.desk.guard, groupOf(req.agent, this.desk.groups), this.now())) out.push(this.#guardReason(h));
    }
    return out;
  }

  /**
   * The one scheduler. It starts what can start, in every room, one request at a time: each time, the request that
   * has waited longest among those that can start now, whichever room it's in. Then it looks again, since starting
   * one changes what else can start. Every change (a request queued, a turn ending, a control changed) comes here.
   * A call made while it runs (a turn ending as another starts) makes it look once more; it's never nested.
   */
  #schedule() {
    // Nothing starts while Toryo is still bringing its rooms back after a restart (see init), or before a turn's
    // outcome is saved (#actOnOutcome, which looks again once it is).
    if (this.recovering || this.outcomeRooms.size) return;
    if (this.scheduling) {
      this.scheduleAgain = true;
      return;
    }
    this.scheduling = true;
    const touched = new Set();
    try {
      do {
        this.scheduleAgain = false;
        if (this.shuttingDown) break;
        // A window that has reset since the last look (a desk that slept through it, say) is decided before anything starts.
        this.#expireGuards();
        for (const room of this.rooms.values()) {
          if (room.archived) continue;
          // A turn the Codex app has accepted is followed even in a paused or stopped room: it runs in the app anyway.
          const app = room.appTurn;
          if (app && !app.lost && !this.#runningIn(room).some((r) => r.agent === "codexapp")) {
            this.#startTurn(room, { ...app.req, id: shortId("q") });
            touched.add(room);
          }
        }
        for (;;) {
          let best = null;
          for (const room of this.rooms.values()) {
            const req = this.#nextStartable(room);
            if (req && (!best || queueOrder(req, room) < queueOrder(best.req, best.room))) best = { room, req };
          }
          if (!best) break;
          best.room.queue.splice(best.room.queue.indexOf(best.req), 1);
          if (best.req.kind === "gates") this.#startChecks(best.room, best.req);
          else this.#startTurn(best.room, best.req);
          touched.add(best.room);
        }
        // A room says, once, when desk-wide controls start holding its work up (or the reason changes). Inside the
        // loop: whoever hears it may change something (release a hold, queue a note), and that's looked at at once.
        for (const room of this.rooms.values()) {
          if (room.archived) continue;
          const reasons = [...new Set(room.queue.flatMap((q) => this.blockersFor(q)))].join("; ");
          if (reasons === (room.deskNotice ?? "")) continue;
          room.deskNotice = reasons || undefined;
          touched.add(room);
          if (reasons) this.#system(room, `Waiting: ${reasons}. It goes on when that ends.`);
        }
      } while (this.scheduleAgain);
    } finally {
      this.scheduling = false;
    }
    for (const room of touched) this.#save(room);
  }

  /** Kept for the many places that used to start a room's work: everything goes through the one scheduler now. */
  #pumpAll() {
    this.#schedule();
  }

  /**
   * What, desk-wide, keeps each queued request in a room from starting: its own reasons (Pause everything, a hold),
   * or waiting behind an earlier step of the room's work that's held up. A step not running beside the work holds
   * the steps after it, so the work keeps its order. One calculation for starting, the room's status and its reasons.
   */
  #heldUp(room) {
    const out = new Map();
    let first = null;
    for (const req of room.queue) {
      const own = this.blockersFor(req);
      if (own.length) {
        out.set(req, own);
        if (!req.parallel) first ??= req;
      } else if (first && !req.parallel) {
        const who = first.agent === "toryo" ? "the checks" : `${this.label(first.agent)}'s turn`;
        out.set(req, [`it comes after ${who}, which waits (${out.get(first).join("; ")})`]);
      }
    }
    return out;
  }

  /** The first request in a room's queue that can start now, or null. */
  #nextStartable(room) {
    if (room.archived || room.paused || room.stopped || !room.queue.length) return null;
    const heldUp = this.#heldUp(room);
    const running = this.#runningIn(room);
    for (const req of room.queue) {
      if (room.waiting && !req.whileWaiting) continue;
      if (heldUp.has(req)) continue;
      if (running.some((r) => r.agent === req.agent)) continue;
      // Nothing new goes to the app while it has a turn of this room's, or another room's turn in this thread.
      if (req.agent === "codexapp" && (room.appTurn || this.#appThreadWorking(room))) continue;
      const exclusive = !req.parallel;
      if (exclusive && running.some((r) => !r.req.parallel)) continue;
      if (exclusive && running.length && room.mode === "build") continue;
      return req;
    }
    return null;
  }

  #normalizeConfig() {
    const base = defaultConfig();
    this.config = { ...base, ...this.config };
    this.config.notify = { ...base.notify, ...this.config.notify };
    this.config.agents = { ...base.agents, ...this.config.agents };
    for (const id of Object.keys(base.agents))
      this.config.agents[id] = { ...base.agents[id], ...this.config.agents[id] };
    this.config.projects = (this.config.projects ?? []).map((p) => ({ gates: [], agents: {}, rules: "", decisions: "", ...p }));
  }

  #recover(room) {
    room.queue ??= [];
    room.seen ??= {};
    room.sessions ??= {};
    room.waitingQueue ??= [];
    // Which session each agent got Toryo's introduction (house rules, decisions) in. Older rooms: a
    // headless agent that has already had a turn here got it with its first one. The Codex app may not have
    // (the previous version skipped it in rooms that chose their thread up front), so it gets it again on
    // its next turn; a repeat is harmless, a missing one isn't.
    if (!room.introduced) {
      room.introduced = {};
      for (const [agent, session] of Object.entries(room.sessions))
        if (agent !== "codexapp" && this.events.get(room.id).some((e) => e.type === "turn" && e.agent === agent && !e.imported)) room.introduced[agent] = session;
    }
    // Questions agents asked in chat that you haven't answered yet: the room is waiting for you.
    room.openChat = this.events.get(room.id).filter((e) => e.type === "question" && e.kind === "chat-owner" && e.open).map((e) => e.id);
    // Rooms from before threads belonged to rooms: pin the thread they were using, so Settings can't move them.
    if (room.crew.members.includes("codexapp") && !room.sessions.codexapp) {
      const project = this.project(room.projectId);
      const thread = project?.agents?.codexapp?.thread || this.config.agents.codexapp?.thread;
      if (thread) room.sessions.codexapp = thread;
    }
    // Rooms saved before runs were tracked: what they have queued belongs to their current run.
    room.flow ??= shortId("f");
    // Older versions kept final-review intent only in room.build.final; reviews, checks and the reviewer's
    // questions carry it themselves now. Fill it in from there for anything saved before that.
    const legacyFinal = Boolean(room.build?.final);
    const withFinal = (req) => (req && req.final === undefined && (REVIEW_KINDS.has(req.kind) || req.kind === "gates") ? { ...req, final: legacyFinal } : req);
    const bind = (req) => withFinal(FREE_KINDS.has(req.kind) || req.flow ? req : { ...req, flow: room.flow });
    room.queue = room.queue.map(bind);
    for (const w of [room.waiting, ...room.waitingQueue].filter(Boolean)) {
      if ((w.kind === "review-owner" || w.kind === "gates") && w.final === undefined) w.final = legacyFinal;
      if (w.retryReq) w.retryReq = withFinal(w.retryReq);
    }
    const interrupted = [];
    let followed = false;
    let uncertain = false;
    // A desk from the last round kept accepted app work in `following`.
    if (!room.appTurn && room.following?.length) room.appTurn = this.#appTurnFrom(room, room.following[0]);
    if (room.appTurn) room.appTurn.req = bind(room.appTurn.req);
    delete room.following;
    // A turn whose end was recorded but whose outcome Toryo hadn't acted on yet when it stopped: acted on once all
    // rooms are loaded (#reconcile, from init). Still running means it hadn't ended: it's handled below.
    const pending = room.pendingOutcome && this.events.get(room.id).find((e) => e.id === room.pendingOutcome.turnId && e.type === "turn" && e.state !== "running");
    room.pendingOutcome = pending ? room.pendingOutcome : null;
    // First what the room keeps (the app turn it follows, the turns it offers again), on disk; only then the end of
    // the turns that were running. A stop in between then can't lose a kept turn: its event is still "running".
    const ended = [];
    for (const ev of this.events.get(room.id)) {
      if (ev.type === "turn" && ev.state === "running") {
        // The Codex app keeps working while Toryo is down: follow the same turn again rather than sending it twice.
        // (A turn Toryo stopped before handing it to the app is offered again like any other.)
        if (ev.agent === "codexapp" && ev.req && (ev.submitted !== false || ev.submitting)) {
          ended.push([ev, "Toryo restarted; it follows this turn in the app again below."]);
          room.appTurn ??= this.#appTurnFrom(room, this.#followReq(bind(ev.req), ev));
          // Toryo stopped while handing it over: the app may or may not have it. Watch for it; never send it twice.
          if (!ev.submitted && ev.submitting) {
            room.appTurn.uncertain = true;
            uncertain = true;
          } else followed = true;
          continue;
        }
        ended.push([ev, "Toryo stopped during this turn."]);
        // Offered again once: a stop during an earlier recovery may already have queued it (`replaces`).
        if (ev.req && !this.#stale(room, bind(ev.req)) && !room.queue.some((q) => q.replaces === ev.id)) interrupted.push({ ...bind(ev.req), replaces: ev.id });
      }
    }
    // Checks that were running: run them again (they change nothing).
    const gate = room.activeGate && !this.#stale(room, bind(room.activeGate)) ? { ...bind(room.activeGate), id: shortId("q") } : null;
    room.activeGate = null;
    if (interrupted.length) {
      room.queue = [
        ...interrupted.map((req) => ({
          ...req,
          id: shortId("q"),
          instruction:
            "Toryo restarted while you were working on this. Check for partial work from your previous attempt, then continue.\n\n" +
            (req.baseInstruction ?? req.instruction),
        })),
        ...room.queue,
      ];
      room.paused = true;
    }
    if (gate) room.queue = [gate, ...room.queue];
    // Requests queued before 13 Oct have no time: they keep their order among themselves, after nothing older.
    for (const q of room.queue) q.queuedAt ??= this.#stamp();
    this.store.saveRoom(room);
    for (const [ev, error] of ended) this.#patch(room, ev, { state: "interrupted", endedAt: nowIso(), error }, false);
    if (followed) this.#system(room, "Toryo restarted while the Codex app was working. It's following that turn again; nothing is sent twice.");
    if (uncertain) {
      const text =
        "Toryo stopped while it was handing a message to the Codex app, so it can't tell whether the app has it. It's watching the thread for it and sends nothing else there meanwhile: if the app sends it, Toryo follows that turn as usual. If you know it never arrived, choose “Stop waiting for it” (or press Stop twice) and send it again.";
      this.#system(room, text, { level: "warn" });
      this.#notify("The Codex app may not have Toryo's message", `“${room.title}”: Toryo is watching the thread for it.`);
    }
    if (interrupted.length) {
      const who = [...new Set(interrupted.map((r) => this.label(r.agent)))].join(" and ");
      this.#system(room, `Toryo restarted while ${who} ${interrupted.length > 1 ? "were" : "was"} working. Resume to run the interrupted turn again.`);
    }
    if (gate) this.#system(room, "Toryo restarted while the checks were running. They run again.");
    this.#save(room);
  }

  // ---------------------------------------------------------------- projects & config

  project(id) {
    return this.config.projects.find((p) => p.id === id) ?? null;
  }

  addProject({ path, name, rules = "", decisions = "", gates = [] }) {
    if (!path || !isAbsolute(path)) throw new UserError("Give the project's absolute path.");
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new UserError(`No folder at ${path}.`);
    const real = realpathSync(path);
    const existing = this.config.projects.find((p) => p.path === real);
    if (existing) return existing;
    let id = slugify(name || real.split("/").pop(), 32);
    while (this.project(id)) id += "-2";
    const project = { id, name: name || real.split("/").pop(), path: real, rules, decisions, gates, agents: {} };
    this.config.projects.push(project);
    this.store.saveConfig(this.config);
    this.emit("state");
    return project;
  }

  updateProject(id, patch) {
    const project = this.project(id);
    if (!project) throw new UserError("Unknown project.", 404);
    for (const key of ["name", "rules", "decisions", "gates", "agents"]) if (key in patch) project[key] = patch[key];
    this.store.saveConfig(this.config);
    this.emit("state");
    return project;
  }

  updateConfig(patch) {
    if (patch.notify) this.config.notify = { ...this.config.notify, ...patch.notify };
    if (patch.agents)
      for (const [id, value] of Object.entries(patch.agents)) {
        const merged = { ...this.config.agents[id], ...value };
        // null clears a setting (JSON can't carry undefined).
        for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
        this.config.agents[id] = merged;
      }
    this.store.saveConfig(this.config);
    this.emit("state");
    // A different app thread changes what the sidebar shows for the Codex app.
    if (patch.agents?.codexapp) this.refreshAgents().catch(() => {});
    return this.config;
  }

  agentConfig(project, agent) {
    return { ...(this.config.agents[agent] ?? {}), ...(project?.agents?.[agent] ?? {}) };
  }

  // ---------------------------------------------------------------- views

  summary(room) {
    const running = this.#runningIn(room).map((r) => r.agent);
    return {
      id: room.id,
      projectId: room.projectId,
      title: room.title,
      mode: room.mode,
      status: this.#status(room),
      running,
      waiting: this.#firstAsk(room),
      waitingCount: this.#allWaiting(room).length + (room.openChat?.length ?? 0),
      // Every open question, by id, so a client answers the one it means.
      questions: this.#openQuestions(room),
      // Who is doing what right now, for the room list.
      working: this.#runningIn(room).map((r) => ({ agent: r.agent, kind: r.req.kind })),
      appThread: room.crew.members.includes("codexapp") ? room.sessions?.codexapp ?? null : null,
      // Queued work that desk-wide controls hold up, and why.
      blocked: [...this.#heldUp(room)].map(([q, reasons]) => ({ agent: q.agent, kind: q.kind, reasons })),
      // Paused (or stopped) and held, apart from the status: a question waiting makes the status "waiting", and the
      // page still shows the pause or the hold under it.
      paused: Boolean(room.paused || room.stopped),
      held: room.queue.length > 0 && room.queue.every((q) => this.#heldUp(room).has(q)),
      updatedAt: room.updatedAt,
      crew: room.crew,
    };
  }

  roomView(roomId) {
    const room = this.#room(roomId);
    return {
      room: { ...room, status: this.#status(room) },
      questions: this.#openQuestions(room),
      events: this.events.get(room.id),
      live: this.#runningIn(room).map((r) => ({
        turnId: r.turnId,
        agent: r.agent,
        kind: r.req.kind,
        phase: r.phase,
        startedAt: r.startedAt,
        activity: r.activity,
      })),
    };
  }

  state() {
    return {
      config: this.config,
      agents: this.agentStatus,
      limits: this.limits,
      // The same readings per allowance: Codex and the Codex app share one, and are never added together.
      usage: this.usage.groupView(),
      desk: this.deskView(),
      // Whether read-only turns are enforced by a read-only mount of the project (Claude, Cursor, Grok).
      readOnly: this.readOnly ?? null,
      rooms: [...this.rooms.values()].map((r) => this.summary(r)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    };
  }

  // ---------------------------------------------------------------- Home

  /**
   * Home: every room at a glance, from what the desk keeps in memory, never a whole transcript. The questions waiting
   * for you (oldest first), the work running now (with how long it prepared, waited in the Codex app's queue and has
   * worked, and when it last said something), the other rooms and what keeps them, usage per allowance, what each
   * agent is doing, and the first page of Recent.
   */
  home({ recent = 40 } = {}) {
    const now = this.now();
    const rooms = [...this.rooms.values()].filter((r) => !r.archived);
    const project = (r) => this.config.projects.find((p) => p.id === r.projectId) ?? null;
    // Rooms working in the same folder: a builder there can change what the others read.
    const byFolder = new Map();
    for (const r of rooms) {
      const f = project(r)?.path;
      if (f) byFolder.set(f, [...(byFolder.get(f) ?? []), r]);
    }
    const where = (r) => ({
      project: project(r)?.name ?? null,
      folder: project(r)?.path ?? null,
      shared: (byFolder.get(project(r)?.path) ?? []).filter((x) => x !== r).map((x) => ({ id: x.id, title: x.title })),
    });
    const questions = rooms
      .flatMap((r) => this.#openQuestions(r).map((q) => ({ ...q, room: r.id, roomTitle: r.title })))
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
    const working = [...this.running.values()]
      .filter((run) => this.rooms.get(run.roomId) && !this.rooms.get(run.roomId).archived)
      .map((run) => {
        const room = this.rooms.get(run.roomId);
        const last = run.activity.at(-1);
        return {
          room: room.id,
          title: room.title,
          mode: room.mode,
          ...where(room),
          turn: run.turnId,
          agent: run.agent,
          role: run.role ?? null,
          kind: run.req.kind,
          slice: room.mode === "build" ? this.#currentSlice(room) : null,
          // The round going on now: the first is 1 (build.round counts the change requests before it).
          round: room.mode === "build" && room.build ? (room.build.round ?? 0) + 1 : null,
          task: room.mode === "build" ? room.build?.task || null : room.mode === "plan" ? room.plan?.topic ?? null : null,
          // Preparing (from startedAt), in the Codex app's queue (from submittedAt), working (from workingAt).
          phase: run.phase ?? "working",
          startedAt: run.startedAt,
          submittedAt: run.submittedAt ?? null,
          workingAt: run.workingAt ?? null,
          lastOutputAt: last?.at ?? run.workingAt ?? null,
          activity: last?.text ?? null,
          questions: this.#allWaiting(room).length + (room.openChat?.length ?? 0),
        };
      })
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const busy = new Set(working.map((w) => w.room));
    const others = rooms
      .filter((r) => !busy.has(r.id))
      .map((r) => {
        const sum = this.summary(r);
        return { id: r.id, title: r.title, mode: r.mode, status: sum.status, paused: sum.paused, held: sum.held, done: Boolean(r.done), blocked: sum.blocked, questions: sum.waitingCount, updatedAt: r.updatedAt ?? null, ...where(r) };
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    // What each agent is doing, and what keeps it from starting more. The two Codex interfaces each have a row.
    // The agents found on this machine (or, before Toryo has looked, the ones configured), and any at work.
    const detected = Object.keys(this.agentStatus ?? {}).length > 0;
    const agents = Object.keys(this.adapters)
      .filter((a) => (detected ? this.agentStatus[a]?.installed : this.config.agents?.[a]?.command) || this.usage.agents[a] || working.some((w) => w.agent === a))
      .map((agent) => ({
        agent,
        label: this.label(agent),
        group: groupOf(agent, this.desk.groups),
        working: working.filter((w) => w.agent === agent).map((w) => ({ room: w.room, title: w.title, kind: w.kind })),
        blockers: this.blockersFor({ agent, kind: "chat" }),
      }));
    return {
      at: new Date(now).toISOString(),
      desk: this.deskView(),
      questions: questions.slice(0, 50),
      questionCount: questions.length,
      working,
      rooms: others,
      usage: this.usage.groupView(now),
      agents,
      // Recent's first `recent` items (up to 100): a page that shows more asks for more, so nothing falls in a gap.
      recent: this.feed({ limit: recent }),
    };
  }

  /**
   * The slice a build is on, as the room shows it: the one it names, unless that's approved (a build moving to the
   * next slice); then the plan's first slice not yet approved, or, without a plan to say, "the next slice".
   */
  #currentSlice(room) {
    const b = room.build;
    if (!b || room.done) return null;
    if (b.slice && !(b.approved ?? []).includes(b.slice)) return b.slice;
    if (b.planPath)
      try {
        const next = parseSlices(this.readProjectFile(room.projectId, b.planPath).content).find(
          (s) => !(b.approved ?? []).some((a) => sliceMatches(s, a)) && !s.markedDone && !(s.checks > 0 && s.checks === s.checked),
        );
        if (next) return `${next.kind ?? "Slice"} ${next.number}: ${next.name}`;
      } catch {
        /* no plan file to read: say what's known */
      }
    return b.slice ? "the next slice" : null;
  }

  /**
   * Recent, newest first: each room's notable events and the desk's journal, merged. Each item has a stable id
   * (`<room>:<event>`, or `desk:<journal id>`) and the time it happened (a turn: when it ended). `before` is the
   * cursor of the last item already shown (`next` from the page before): the next page carries on from there.
   */
  feed({ limit = 40, before = null } = {}) {
    const items = [];
    for (const [roomId, list] of this.notable) {
      const room = this.rooms.get(roomId);
      if (!room || room.archived) continue;
      for (const ev of list.values()) {
        const item = this.#feedItem(room, ev);
        if (item) items.push(item);
      }
    }
    for (const j of this.deskJournal) items.push({ id: `desk:${j.id}`, at: j.at, kind: "desk", room: null, what: j.kind, text: j.text, by: j.by ?? null });
    // Things that happen in the same millisecond keep their order: a turn ends, then its checks, an approval, a
    // question, your answer. The key (also the cursor) is the same after a restart.
    const RANK = { turn: 0, checks: 1, approved: 2, question: 3, answer: 4, desk: 5 };
    const key = (x) => `${x.at}|${RANK[x.kind] ?? 9}|${x.id}`;
    // Plain string order, the same the cursor is compared with (localeCompare can ignore punctuation).
    items.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    const from = before ? items.findIndex((x) => key(x) < before) : 0;
    const page = from < 0 ? [] : items.slice(from, from + Math.max(1, Math.min(100, limit)));
    const more = from >= 0 && from + page.length < items.length;
    return { items: page, next: more && page.length ? key(page.at(-1)) : null };
  }

  /**
   * Whether an event belongs in Recent, and as what. Running turns, notes and routine messages don't, and nothing
   * is said twice: a turn that asked you something is its question, and a failed turn's retry question is the failure.
   */
  #notableKind(ev) {
    if (ev.type === "turn") return ev.state === "failed" || (ev.state === "done" && ev.status !== "OWNER") ? "turn" : null;
    if (ev.type === "question") return ev.kind === "error" ? null : "question";
    if (ev.type === "owner") return ev.kind === "answer" || ev.kind === "change-request" ? "answer" : null;
    if (ev.type === "gate") return (ev.results ?? []).some((r) => !r.ok) ? "checks" : null;
    if (ev.type === "system") return / approved after \d+ rounds?|approved the final review/.test(ev.text ?? "") ? "approved" : null;
    return null;
  }

  /** Keep an event in its room's Recent once it's notable (a turn, when it ends); the oldest go past NOTABLE_KEPT. */
  #noteNotable(room, ev) {
    if (!this.#notableKind(ev)) return;
    let list = this.notable.get(room.id);
    if (!list) this.notable.set(room.id, (list = new Map()));
    list.delete(ev.id);
    list.set(ev.id, ev);
    if (list.size > NOTABLE_KEPT) list.delete(list.keys().next().value);
  }

  #feedItem(room, ev) {
    const kind = this.#notableKind(ev);
    if (!kind) return null;
    const base = { id: `${room.id}:${ev.id}`, room: room.id, roomTitle: room.title, event: ev.id, kind };
    if (kind === "turn")
      return { ...base, at: ev.endedAt ?? ev.at, agent: ev.agent, role: ev.role ?? null, turnKind: ev.kind, state: ev.state, status: ev.status ?? null, detail: truncate(ev.detail ?? "", 160), slice: ev.slice ?? null, error: ev.state === "failed" ? truncate(ev.error ?? "", 160) : null };
    if (kind === "question") return { ...base, at: ev.at, from: ev.from ?? null, question: truncate(ev.question ?? "", 200), open: Boolean(ev.open) };
    if (kind === "answer") return { ...base, at: ev.at, text: truncate(firstLine(ev.text ?? "", 200), 200), to: ev.to ?? [], answered: ev.answers?.[0]?.question ? truncate(ev.answers[0].question, 120) : null, change: ev.kind === "change-request" };
    if (kind === "checks") return { ...base, at: ev.at, failed: (ev.results ?? []).filter((r) => !r.ok).map((r) => r.name) };
    return { ...base, at: ev.at, text: truncate(ev.text ?? "", 200) };
  }

  // ---------------------------------------------------------------- rooms

  createRoom({ projectId, title, mode = "chat", members, builder, reviewer, settings, task, planPath, topic, text, to, discuss, allowWrite, reviewFirst, handoff, slice, appThread }) {
    const project = this.project(projectId);
    if (!project) throw new UserError("Choose a project first.");
    const order = Object.keys(this.adapters);
    members = [...new Set((members?.length ? members : ["codex", "claude"]).filter((a) => this.adapters[a]))].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    if (!members.length) throw new UserError("Pick at least one agent.");
    // Default crew: Codex builds and Claude reviews when both are present.
    builder = members.includes(builder) ? builder : ["codex", "codexapp"].find((a) => members.includes(a)) ?? members[0];
    reviewer =
      members.includes(reviewer) && reviewer !== builder
        ? reviewer
        : members.includes("claude") && builder !== "claude"
          ? "claude"
          : members.find((m) => m !== builder) ?? builder;
    // Resolve the app thread and the handoff before the room exists, so a failed start leaves nothing behind.
    const thread = members.includes("codexapp") ? this.#appThreadFor(project, appThread) : null;
    if (mode === "build" && reviewFirst) handoff = this.#handoffFor(project, builder, handoff, thread);
    const room = {
      id: shortId("r"),
      projectId,
      title: title?.trim() || defaultTitle(mode, topic || task || text),
      mode: "chat",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      crew: { members, builder, reviewer },
      // The Codex app's thread belongs to the room from the start; Settings only holds defaults for new rooms.
      sessions: thread ? { codexapp: thread } : {},
      seen: {},
      queue: [],
      flow: shortId("f"),
      paused: false,
      stopped: false,
      done: false,
      waiting: null,
      waitingQueue: [],
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      build: null,
      plan: null,
      discuss: null,
      stats: { turns: 0, agents: {} },
    };
    this.rooms.set(room.id, room);
    this.events.set(room.id, []);
    this.#system(room, `Room opened in ${project.name} (${project.path}) with ${members.map((m) => this.label(m)).join(" and ")}.`);
    if (thread) this.#warnSharedThread(room);
    this.#save(room);
    if (mode === "build") this.startBuild(room.id, { task: task ?? text, planPath, reviewFirst, handoff, slice });
    else if (mode === "plan") this.startPlan(room.id, { topic: topic ?? text });
    else if (text?.trim()) this.postMessage(room.id, { text, to: to ?? "everyone", discuss, allowWrite });
    this.emit("state");
    return this.summary(room);
  }

  deleteRoom(roomId) {
    const room = this.#room(roomId);
    for (const run of this.#runningIn(room)) {
      run.controller.abort("delete");
      run.abandon?.abort();
    }
    room.archived = true;
    this.rooms.delete(room.id);
    this.notable.delete(room.id);
    this.store.saveRoom(room);
    this.emit("state");
  }

  startBuild(roomId, { task, planPath, builder, reviewer, reviewFirst, handoff, slice } = {}) {
    const room = this.#room(roomId);
    // Check the handoff before changing anything, so a failed start leaves the room as it was.
    const nextBuilder = builder && room.crew.members.includes(builder) ? builder : room.swapPending ? room.crew.reviewer : room.crew.builder;
    if (reviewFirst) handoff = this.#handoffFor(this.project(room.projectId), nextBuilder, handoff, room.sessions.codexapp);
    if (room.swapPending) this.#swapRoles(room);
    if (builder && room.crew.members.includes(builder)) room.crew.builder = builder;
    if (reviewer && room.crew.members.includes(reviewer)) room.crew.reviewer = reviewer;
    if (room.crew.builder === room.crew.reviewer && room.crew.members.length > 1)
      room.crew.reviewer = room.crew.members.find((m) => m !== room.crew.builder);
    room.mode = "build";
    room.done = false;
    room.stopped = false;
    this.#clearWaiting(room, "(superseded: building started)");
    room.discuss = null;
    this.#newFlow(room);
    room.build = {
      task: task?.trim() || "",
      planPath: planPath?.trim() || "",
      round: 0,
      nudges: 0,
      gateRetries: 0,
      slice: "",
      handoff: "",
      approved: [],
      final: false,
      startedAt: nowIso(),
    };
    const b = this.label(room.crew.builder);
    const r = this.label(room.crew.reviewer);
    if (reviewFirst) {
      const named = parseStatus(handoff);
      const [namedSlice, namedHandoff] = named.status === "REVIEW" ? named.detail.split("|").map((x) => x.trim()) : [];
      room.build.slice = slice?.trim() || namedSlice || "Handed-over work";
      room.build.handoff = namedHandoff || "";
      // The builder hasn't had Toryo's briefing yet; its first turn here starts with it.
      room.build.briefed = false;
      this.#system(room, `Build started from ${b}'s finished round: ${r} reviews it first, then ${b} carries on through the plan.${room.build.planPath ? ` Plan: ${room.build.planPath}.` : ""}`, { forAgents: true });
      const now = nowIso();
      const ev = this.#append(room, { type: "turn", agent: room.crew.builder, role: "builder", kind: "build", state: "done", imported: true, text: handoff.trim(), status: named.status ?? "REVIEW", detail: named.detail || room.build.slice, slice: room.build.slice, startedAt: now, endedAt: now });
      room.seen[room.crew.builder] = [...new Set([...(room.seen[room.crew.builder] ?? []), ev.id])];
      this.#checksThenReview(room, false);
      return this.summary(room);
    }
    this.#system(room, `Build started: ${b} builds, ${r} reviews.${room.build.planPath ? ` Plan: ${room.build.planPath}.` : ""}`, { forAgents: true });
    this.#enqueue(room, {
      agent: room.crew.builder,
      kind: "build",
      access: "write",
      instruction: prompts.buildKickoff({ reviewer: r, task: room.build.task, planPath: room.build.planPath }),
    });
    return this.summary(room);
  }

  /** The builder finished a round outside Toryo: its handoff comes from the owner, or from the room's Codex app thread. */
  #handoffFor(project, builder, handoff, thread) {
    if (handoff?.trim()) return handoff;
    if (builder === "codexapp") {
      const last = thread ? lastAppMessage({ ...this.agentConfig(project, "codexapp"), thread }) : "";
      if (last.trim()) return last;
      throw new UserError("Couldn't find a finished reply in your Codex app thread. Paste the handoff message instead.");
    }
    throw new UserError(
      this.agentStatus?.codexapp?.installed
        ? `Paste ${builder ? this.label(builder) : "the builder"}'s handoff message, or choose Codex app as the builder to use your app thread's last reply.`
        : `Paste ${builder ? this.label(builder) : "the builder"}'s handoff message, so the reviewer knows what to review.`,
    );
  }

  /** The thread for a room's Codex app: the one asked for, else the project's default, else the global one. */
  #appThreadFor(project, requested, room = null) {
    const thread = String(requested ?? "").trim() || project?.agents?.codexapp?.thread || this.config.agents.codexapp?.thread || "";
    if (!thread) throw new UserError("Choose the Codex app thread for this room. Settings can hold a default.");
    const busy = this.#appThreadRooms(thread, room).find((r) => this.#appBusy(r));
    if (busy) throw new UserError(`The Codex app is working in that thread for “${busy.title}”. Choose another thread, or wait until it has finished.`);
    return thread;
  }

  /** Other open rooms whose Codex app uses `thread`. */
  #appThreadRooms(thread, except) {
    return [...this.rooms.values()].filter((r) => r !== except && !r.archived && r.crew.members.includes("codexapp") && r.sessions?.codexapp === thread);
  }

  /** Whether the Codex app has work running, queued or being followed in this room. */
  #appBusy(room) {
    return Boolean(room.appTurn) || this.#runningIn(room).some((r) => r.agent === "codexapp") || room.queue.some((q) => q.agent === "codexapp");
  }

  #warnSharedThread(room) {
    const others = this.#appThreadRooms(room.sessions.codexapp, room);
    if (others.length)
      this.#system(room, `${others.map((r) => `“${r.title}”`).join(" and ")} also ${others.length > 1 ? "use" : "uses"} this Codex app thread. Only one room's turn runs in it at a time; the others wait.`, { level: "warn" });
  }

  startPlan(roomId, { topic, participants } = {}) {
    const room = this.#room(roomId);
    if (!topic?.trim()) throw new UserError("Say what you want to plan.");
    participants = (participants?.length ? participants : room.crew.members).filter((a) => room.crew.members.includes(a));
    room.mode = "plan";
    room.done = false;
    room.stopped = false;
    this.#clearWaiting(room, "(superseded: a new planning round started)");
    room.discuss = null;
    this.#newFlow(room);
    room.plan = {
      topic: topic.trim(),
      phase: "proposals",
      participants,
      pending: [...participants],
      synthesizer: null,
      planPath: `docs/plans/${slugify(topic, 40)}.md`,
      checks: {},
      // Each time the author finishes writing or revising the plan; a Ready card is for one revision.
      revision: 0,
      // The check cycle in progress (see #startPlanChecks), and how the plan was last checked (see #reviewSentence).
      cycle: null,
      review: null,
      startedAt: nowIso(),
    };
    this.#append(room, { type: "owner", text: topic.trim(), to: participants, kind: "topic", deliveredTo: [] });
    for (const agent of participants)
      this.#enqueue(room, {
        agent,
        kind: "plan-proposal",
        access: "read",
        parallel: true,
        hideKinds: ["plan-proposal"],
        instruction: prompts.planProposal({ topic: room.plan.topic, others: participants.filter((p) => p !== agent).map((p) => this.label(p)) }),
      });
    return this.summary(room);
  }

  /**
   * Your call on a planning round: who writes the plan, and your decisions. Only while the round waits for it (its
   * checkpoint question is open; `questionId` names it), so a second submission can't start a second plan.
   */
  synthesize(roomId, { synthesizer, planPath, decisions, questionId } = {}) {
    const room = this.#room(roomId);
    if (!room.plan) throw new UserError("This room has no planning round.");
    const plan = room.plan;
    const checkpoint = this.#allWaiting(room).find((w) => w.kind === "plan-checkpoint" && (!questionId || w.eventId === questionId));
    if (!checkpoint)
      throw new UserError(questionId ? "That planning question has already been answered: the plan is being written, or the round has moved on." : "The planning round isn't waiting for your call.", 409);
    if (synthesizer && !(plan.participants ?? room.crew.members).includes(synthesizer))
      throw new UserError(`${this.label(synthesizer)} isn't one of this round's planners, so it can't write the plan.`);
    plan.synthesizer = synthesizer || (plan.participants?.includes(room.crew.builder) ? room.crew.builder : plan.participants?.[0] ?? room.crew.builder);
    if (planPath?.trim()) plan.planPath = planPath.trim();
    plan.phase = "synthesis";
    this.#takeWaiting(room, checkpoint);
    this.#closeQuestion(room, decisions || "(no extra decisions)", checkpoint);
    if (decisions?.trim())
      this.#append(room, { type: "owner", text: `Decisions for the plan:\n${decisions.trim()}`, to: plan.participants, kind: "decisions", deliveredTo: [] });
    this.#system(room, `${this.label(plan.synthesizer)} is writing the plan to ${plan.planPath}.`, { forAgents: true });
    this.#enqueue(room, {
      agent: plan.synthesizer,
      kind: "plan-synthesis",
      access: "write",
      instruction: prompts.planSynthesis({ planPath: plan.planPath }),
    });
    return this.summary(room);
  }

  /**
   * Accept every recommendation at a planning checkpoint, as shown with it (its questions and recommendations), with
   * the default author or the one named. A question without a recommendation can't be accepted this way: open the form.
   */
  acceptCheckpoint(roomId, { questionId, synthesizer, planPath } = {}) {
    const room = this.#room(roomId);
    const w = this.#allWaiting(room).find((x) => x.kind === "plan-checkpoint" && (!questionId || x.eventId === questionId));
    if (!w) throw new UserError("That planning question has already been answered: the plan is being written, or the round has moved on.", 409);
    const missing = (w.questions ?? []).filter((q) => !String(q.recommendation ?? "").trim());
    if (missing.length)
      throw new UserError(`Some questions have no recommendation to accept: ${missing.map((q) => `“${q.question}”`).join(", ")}. Answer them in the planning form.`);
    const decisions = (w.questions ?? []).map((q) => `- ${q.question} → ${q.recommendation} (${this.label(q.from)}'s recommendation)`).join("\n");
    return this.synthesize(roomId, { questionId: w.eventId, synthesizer, planPath, decisions });
  }

  // ---------------------------------------------------------------- owner input

  route(room, text, to = "auto") {
    const members = room.crew.members;
    if (Array.isArray(to)) return { agents: to.filter((a) => members.includes(a)), why: "you chose" };
    if (to === "everyone") return { agents: [...members], why: "to everyone" };
    if (to && to !== "auto") return { agents: members.includes(to) ? [to] : [], why: "you chose" };
    if (/@(all|everyone)\b/i.test(text)) return { agents: [...members], why: "you mentioned everyone" };
    const mentioned = members.filter((a) => new RegExp(`@${a}\\b`, "i").test(text) || new RegExp(`@${this.label(a)}\\b`, "i").test(text));
    if (mentioned.length) return { agents: mentioned, why: `you mentioned ${mentioned.map((a) => "@" + a).join(" ")}` };
    const asking = this.#firstAsk(room)?.from;
    if (asking) return { agents: [asking], why: "it is waiting for your answer" };
    if (room.mode === "build") {
      if (/\b(review|check|verify|confirm|audit|test|tests)\b/i.test(text)) return { agents: [room.crew.reviewer], why: "it mentions checking" };
      if (/\b(fix|build|implement|add|change|rename|refactor|update|write|remove|make)\b/i.test(text))
        return { agents: [room.crew.builder], why: "it mentions building or fixing" };
      const busy = this.#runningIn(room)[0]?.agent ?? room.queue[0]?.agent;
      return { agents: [busy ?? room.crew.builder], why: busy ? "it is working now" : "it acts next" };
    }
    if (room.mode === "plan" && room.plan) return { agents: [...room.plan.participants], why: "the planners" };
    const last = [...this.events.get(room.id)].reverse().find((e) => e.type === "turn");
    if (last) return { agents: [last.agent], why: `continuing with ${this.label(last.agent)}` };
    return { agents: [...members], why: "to everyone" };
  }

  postMessage(roomId, { text, to = "auto", delivery = "next", discuss = 0, allowWrite = false, intent, answering }) {
    const room = this.#room(roomId);
    text = String(text ?? "").trim();
    if (!text) throw new UserError("Write a message first.");
    const routed = this.route(room, text, to);
    if (!routed.agents.length) throw new UserError("Nobody in this room matches that recipient.");
    // What the note answers, as you saw it when you began writing it (the page says): one question (`answering: id`;
    // the note goes to whoever asked it), questions agents asked in chat when it goes to several (`[ids]`), or nothing
    // (`false`). If one of them has been answered since, nothing is sent, so a note never lands on a newer question.
    // Left out (`toryo say`, an older page), a note to an agent that has exactly one question open answers it.
    const find = (id) => this.#allWaiting(room).find((w) => w.eventId === id) ?? this.#openChatQuestions(room).find((q) => q.id === id);
    const stale = () => new UserError("That question has already been answered, so this wasn't sent.", 409);
    let target = null;
    let closes = [];
    if (typeof answering === "string") {
      target = find(answering);
      if (!target) throw stale();
      if (target.kind === "plan-checkpoint" || target.kind === "app-lost") throw new UserError("Answer that one with its own buttons.");
    } else if (Array.isArray(answering)) {
      closes = answering.map(find);
      if (closes.some((q) => !q)) throw stale();
      if (closes.some((q) => q.eventId || !routed.agents.includes(q.from))) throw new UserError("A note to several agents can only answer questions they asked in chat. Answer the others from their cards.");
    } else if (answering == null) {
      const open = (agent) => [...this.#allWaiting(room).filter((w) => w.from === agent && w.kind !== "app-lost"), ...this.#openChatQuestions(room).filter((q) => q.from === agent)];
      for (const agent of routed.agents) {
        const mine = open(agent);
        if (mine.length !== 1) continue;
        // The questions the room waits on are answered by a note to that agent alone; a chat question by any note.
        if (!mine[0].eventId) closes.push(mine[0]);
        else if (routed.agents.length === 1) target = mine[0];
      }
    } else if (answering !== false) throw new UserError("`answering` is a question's id, a list of ids, or false.");
    if (room.stopped) {
      room.stopped = false;
      room.paused = false;
      this.#system(room, "Resumed by your message.");
    }
    if (target && !target.eventId) return { event: this.#answerChat(room, target, { text }), routed: { agents: [target.from], why: "your answer to its question" } };
    if (target) {
      const answered = typeof answering === "string" ? { agents: target.from ? [target.from] : [...room.crew.members], why: "your answer to its question" } : routed;
      const ev = this.#append(room, { type: "owner", text, to: answered.agents, why: answered.why, kind: "answer", answers: [answerOf(target)], deliveredTo: [] });
      this.#resolveWaiting(room, target, text);
      return { event: ev, routed: answered };
    }

    // Ask (it needs an answer) or Tell (an instruction). Without your choice, a question mark or a question means Ask.
    const ev = this.#append(room, { type: "owner", text, to: routed.agents, why: routed.why, delivery, allowWrite, intent: intent === "ask" || intent === "tell" ? intent : noteIntent(text), answers: closes.length ? closes.map(answerOf) : undefined, deliveredTo: [] });
    for (const q of closes) {
      this.#patch(room, q, { open: false, answer: text });
      room.openChat = (room.openChat ?? []).filter((id) => id !== q.id);
    }

    const flowBusy = room.mode !== "chat" && (room.queue.length > 0 || this.#runningIn(room).length > 0) && !room.stopped;
    for (const agent of routed.agents) {
      const run = this.#runningIn(room).find((r) => r.agent === agent);
      const uncancellable = this.adapters[agent]?.cancellable === false;
      if (delivery === "now" && run && !uncancellable) {
        this.#interrupt(room, run);
        continue;
      }
      if (delivery === "now" && run) this.#system(room, `${this.label(agent)} can't be interrupted from Toryo, so your note goes with its next turn.`);
      // Already queued for this agent, whatever the room is doing: the note rides along with that turn, and stays tied
      // to it, so withdrawing another note doesn't drop the turn this one needs (see editNote). (A note to an agent
      // that is working is handled when its turn ends; see #queueNotesTurn.)
      const queuedTurn = room.queue.find((q) => q.agent === agent);
      if (queuedTurn && (!run || room.mode === "chat")) {
        tieNote(queuedTurn, ev.id);
        if (room.mode !== "chat") this.#system(room, `Your note goes to ${this.label(agent)} with its next turn.`);
        continue;
      }
      if (room.mode === "chat" || !flowBusy) {
        if (room.mode === "build" && agent === room.crew.builder && !room.waiting && room.build) {
          const reopened = room.done || undefined;
          if (room.done) {
            room.done = false;
            room.build.final = false;
          }
          this.#enqueue(room, { agent, kind: "build-note", access: "write", forNotes: true, notes: [ev.id], reopened, instruction: "The owner wrote to you (above). Act on it, then end with TORYO: REVIEW, OWNER or DONE." });
        } else {
          this.#enqueue(room, {
            agent,
            kind: "chat",
            access: allowWrite ? "write" : "read",
            parallel: !allowWrite,
            whileWaiting: true,
            forNotes: true,
            notes: [ev.id],
            instruction: prompts.chat({ canWrite: allowWrite, others: routed.agents.filter((a) => a !== agent).map((a) => this.label(a)) }),
          });
        }
      } else if (!run && ev.intent === "ask" && !(room.mode === "build" && agent === room.crew.builder)) {
        // A question for an agent that isn't building: it answers now, in a short read-only turn beside the work.
        this.#queueAnswer(room, agent, [ev.id]);
      } else if (!run) {
        this.#system(room, `Your note goes to ${this.label(agent)} with its next turn.`);
      } else if (uncancellable) {
        if (delivery !== "now") this.#system(room, `Your note goes to ${this.label(agent)} when its current turn ends.`);
      } else {
        this.#system(room, `Your note goes to ${this.label(agent)} when its current turn ends. Choose “Now” to interrupt instead.`);
      }
    }
    if (room.mode === "chat" && discuss > 0 && routed.agents.length > 1)
      room.discuss = { rounds: Math.min(Number(discuss) || 1, 6), round: 0, participants: routed.agents, pending: [...routed.agents], statuses: {}, note: ev.id };
    this.#save(room);
    return { event: ev, routed };
  }

  /**
   * Change or withdraw a note while it's still queued: no agent has it yet, and no turn that's starting carries
   * it. Once it has gone to an agent, it stays as sent.
   */
  editNote(roomId, eventId, { text, cancel = false } = {}) {
    const room = this.#room(roomId);
    const ev = this.events.get(room.id).find((e) => e.id === eventId);
    if (!ev || ev.type !== "owner" || ev.kind) throw new UserError("That isn't a note you can change.", 404);
    if (ev.cancelled) throw new UserError("You've already withdrawn that note.", 409);
    // It closed questions as their answer: changing it, or taking it back, would leave them answered with something else.
    if (ev.answers?.length) throw new UserError("That note answered a question, so it stays as sent. If something has changed, write another note.", 409);
    const carried = this.#runningIn(room).some((r) => r.dispatch?.ids?.includes(ev.id) || r.dispatch?.ownerIds?.includes(ev.id));
    if (ev.deliveredTo?.length || Object.keys(ev.readBy ?? {}).length || carried)
      throw new UserError("That note has already gone to the crew, so it can't be changed now.", 409);
    if (cancel) {
      this.#patch(room, ev, { cancelled: true, cancelledAt: nowIso() });
      // A turn queued only for notes goes once none of its notes is left; turns that were queued anyway stay.
      const dropped = [];
      for (const q of room.queue) {
        if (!noteIds(q).includes(ev.id)) continue;
        tieNote(q);
        q.notes = q.notes.filter((id) => id !== ev.id);
        if (q.forNotes && !q.notes.length) dropped.push(q);
      }
      room.queue = room.queue.filter((q) => !dropped.includes(q));
      if (dropped.some((q) => q.reopened) && room.build) room.done = true;
      // A turn for your notes that was holding the relay (it carries `after`): skip it, and carry on as it would have.
      for (const q of dropped) if (q.after && !this.#stale(room, q)) this.#carryOn(room, q, q.after);
      if (room.discuss?.note === ev.id && room.discuss.round === 0) room.discuss = null;
      this.#system(room, `You withdrew your note to ${(ev.to ?? []).map((a) => this.label(a)).join(" and ")}.`);
    } else {
      const body = String(text ?? "").trim();
      if (!body) throw new UserError("Write the note, or withdraw it.");
      this.#patch(room, ev, { text: body, editedAt: nowIso() });
    }
    this.#save(room);
    this.#pump(room);
    return { event: ev };
  }

  answer(roomId, { text, accept, questionId }) {
    const room = this.#room(roomId);
    const w = this.#allWaiting(room).find((x) => !questionId || x.eventId === questionId);
    if (!w) {
      // A question an agent asked in chat: the room waits for it too, after the questions above.
      const q = this.#openChatQuestions(room).find((x) => !questionId || x.id === questionId);
      if (q) {
        this.#answerChat(room, q, { text, accept });
        return this.summary(room);
      }
      throw new UserError(questionId ? "That question has already been answered." : "Nobody is waiting for an answer.", questionId ? 409 : 400);
    }
    if (w.kind === "plan-checkpoint") return accept ? this.acceptCheckpoint(roomId, { questionId: w.eventId }) : this.synthesize(roomId, { questionId: w.eventId, decisions: text });
    // The plan-ready recommendation is an action: start building with the plan. A written answer asks for changes.
    if (w.kind === "plan-ready" && accept) {
      this.#takeWaiting(room, w);
      this.#closeQuestion(room, "Start building", w);
      return this.startBuild(roomId, { planPath: w.planPath || room.plan?.planPath });
    }
    const body = accept ? acceptRecommendation(w.recommendation) : String(text ?? "").trim();
    if (!body) throw new UserError("Write an answer first.");
    const ev = this.#append(room, { type: "owner", text: body, to: w.from ? [w.from] : room.crew.members, kind: "answer", answers: [answerOf(w)], deliveredTo: [] });
    this.#resolveWaiting(room, w, body);
    return this.summary(room);
  }

  #resolveWaiting(room, w, text) {
    this.#takeWaiting(room, w);
    this.#closeQuestion(room, text, w);
    // Your answers in a build go into the ledger, so a reviewer started fresh knows what you decided.
    if (room.mode === "build" && room.build && ["build-owner", "review-owner", "max-rounds", "nudges", "gates", "slice-approved"].includes(w.kind))
      this.#ledgerAdd(room, { kind: "decision", slice: room.build.slice, from: w.from, question: w.question, answer: text });
    switch (w.kind) {
      case "build-owner":
      case "max-rounds":
      case "nudges":
        if (w.kind === "max-rounds") room.build.round = 0;
        room.build.nudges = 0;
        this.#enqueueBuilder(room, "build-answer", prompts.buildAnswer());
        break;
      case "review-owner":
        // The answer goes back to the reviewer who asked, which finishes its review with a verdict.
        this.#enqueue(room, { agent: w.from, kind: "review-answer", access: "read", final: w.final, instruction: prompts.reviewAnswer({ builder: this.label(room.crew.builder), final: w.final }) });
        break;
      case "slice-approved":
        this.#enqueueBuilder(room, "build-next", prompts.buildNext({ reviewer: this.label(room.crew.reviewer), slice: room.build.slice }));
        break;
      case "gates":
        this.#enqueueBuilder(room, "build-answer", prompts.buildAnswer(), { final: w.final });
        break;
      case "error":
        if (w.retryReq) this.#enqueue(room, { ...w.retryReq, tries: 0, id: undefined });
        break;
      case "app-lost":
        // Follow the same turn again (never send it again). Letting it go is Stop pressed twice, or "Stop waiting for it".
        if (room.appTurn) room.appTurn.lost = false;
        this.#pump(room);
        break;
      case "plan-ready":
        this.#planChange(room, "owner");
        break;
      case "plan-owner":
        // A planner working in parallel may carry on while another planner's question waits.
        this.#enqueue(room, { ...w.retryReq, id: undefined, whileWaiting: w.retryReq.parallel || undefined });
        break;
      default:
        if (w.from) this.#enqueue(room, { agent: w.from, kind: "chat", access: "read", parallel: true, whileWaiting: true, instruction: prompts.chat({ canWrite: false, others: [] }) });
    }
    this.#save(room);
  }

  #openChatQuestions(room) {
    const events = this.events.get(room.id);
    return (room.openChat ?? []).map((id) => events.find((e) => e.id === id)).filter((q) => q?.open);
  }

  /** Answer one question an agent asked in chat: the answer goes to that agent, and it replies. */
  #answerChat(room, q, { text, accept }) {
    const body = accept ? acceptRecommendation(q.recommendation) : String(text ?? "").trim();
    if (!body) throw new UserError("Write an answer first.");
    const ev = this.#append(room, { type: "owner", text: body, to: [q.from], kind: "answer", answers: [answerOf(q)], deliveredTo: [] });
    this.#patch(room, q, { open: false, answer: body });
    room.openChat = room.openChat.filter((id) => id !== q.id);
    if (!room.queue.some((r) => r.agent === q.from))
      this.#enqueue(room, { agent: q.from, kind: "chat", access: "read", parallel: true, whileWaiting: true, instruction: prompts.chat({ canWrite: false, others: [] }) });
    this.#save(room);
    this.#pump(room);
    return ev;
  }

  /** What the room asks you first: the question it waits on, else the oldest unanswered chat question. */
  #firstAsk(room) {
    if (room.waiting) return { id: room.waiting.eventId, from: room.waiting.from, question: room.waiting.question, kind: room.waiting.kind };
    const id = room.openChat?.[0];
    const q = id && this.events.get(room.id).find((e) => e.id === id);
    return q ? { id: q.id, from: q.from, question: q.question, kind: q.kind } : null;
  }

  /** Every open question with its id and when it was asked: the ones the room waits on, in order, then chat questions. */
  #openQuestions(room) {
    const events = this.events.get(room.id) ?? [];
    const askedAt = (id) => {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].id === id) return events[i].at ?? null;
      return null;
    };
    const one = (id, x) => ({ id, kind: x.kind, from: x.from ?? null, question: x.question, recommendation: x.recommendation ?? "", at: askedAt(id), ...(x.questions ? { questions: x.questions } : {}) });
    return [...this.#allWaiting(room).map((w) => one(w.eventId, w)), ...this.#openChatQuestions(room).map((q) => one(q.id, q))];
  }

  /** Every question the room is waiting on: the current one first, then any that arrived while it was open. */
  #allWaiting(room) {
    return [room.waiting, ...(room.waitingQueue ?? [])].filter(Boolean);
  }

  /** Take a question off the waiting list; the next one, if any, becomes current. */
  #takeWaiting(room, w) {
    room.waitingQueue ??= [];
    if (room.waiting?.eventId === w.eventId) room.waiting = room.waitingQueue.shift() ?? null;
    else room.waitingQueue = room.waitingQueue.filter((x) => x.eventId !== w.eventId);
  }

  /** Clear every open question because something else superseded them (a new mode, a stop). */
  #clearWaiting(room, reason) {
    // A question about the Codex app's turn stays: it belongs to the turn the app still has, not to the run.
    const keep = this.#allWaiting(room).filter((w) => w.kind === "app-lost");
    for (const w of this.#allWaiting(room)) if (w.kind !== "app-lost") this.#closeQuestion(room, reason, w);
    room.waiting = keep[0] ?? null;
    room.waitingQueue = keep.slice(1);
  }

  /** Stop keeping the app's turn: the room (and its thread) may send the app new work. */
  #releaseAppTurn(room) {
    room.appTurn = null;
    for (const w of this.#allWaiting(room).filter((x) => x.kind === "app-lost")) {
      this.#takeWaiting(room, w);
      this.#closeQuestion(room, "(stopped waiting for it)", w);
    }
    this.#system(room, "Toryo stopped waiting for the Codex app's turn. It may still be working in the app.", { level: "warn" });
    for (const other of this.#appThreadRooms(room.sessions.codexapp, room)) this.#pump(other);
  }

  #closeQuestion(room, answer, w = room.waiting) {
    if (!w?.eventId) return;
    const q = this.events.get(room.id).find((e) => e.id === w.eventId);
    if (q) this.#patch(room, q, { open: false, answer });
  }

  control(roomId, action, args = {}) {
    const room = this.#room(roomId);
    switch (action) {
      case "pause":
        room.paused = true;
        this.#system(room, this.#runningIn(room).length ? "Pausing: the current turn finishes, nothing new starts." : "Paused.");
        break;
      case "resume": {
        const wasStopped = room.stopped;
        room.paused = false;
        room.stopped = false;
        this.#system(room, "Resumed.");
        if (wasStopped && room.mode === "build" && room.build && !room.done && !room.queue.length && !this.#allWaiting(room).length)
          this.#enqueueBuilder(room, "build-note", "The owner resumed the run. Continue where you left off, and end with TORYO: REVIEW, OWNER or DONE.");
        // A plan's check cycle you stopped: the plan is ready again, saying the cycle didn't finish.
        if (wasStopped && room.mode === "plan" && room.plan?.cycle && !room.queue.length && !this.#allWaiting(room).length) {
          room.plan.review = { revision: room.plan.revision, by: [], verdict: "stopped", stage: room.plan.cycle.stage };
          room.plan.cycle = null;
          this.#planReady(room);
        }
        break;
      }
      case "stop": {
        const running = this.#runningIn(room);
        const again = room.stopped;
        room.stopped = true;
        room.queue = [];
        this.#clearWaiting(room, "(room stopped)");
        room.discuss = null;
        // Whatever is still finishing after the stop belongs to the stopped run and drives nothing.
        this.#newFlow(room, { note: false });
        this.#system(room, "Stopped. Nothing runs until you resume or start something new.");
        for (const run of running) this.#stopRun(room, run);
        // Stop pressed again with the app's turn kept but not being followed (Toryo lost track of it): let it go.
        if (again && room.appTurn && !running.some((r) => r.agent === "codexapp")) this.#releaseAppTurn(room);
        break;
      }
      case "app-release": {
        const run = this.#runningIn(room).find((r) => r.agent === "codexapp");
        if (run) {
          run.controller.abort("stop");
          run.abandon.abort();
          this.#system(room, "Toryo stopped waiting for the Codex app's turn. It may still be working in the app.", { level: "warn" });
        } else if (room.appTurn) this.#releaseAppTurn(room);
        else throw new UserError("Toryo isn't waiting for a Codex app turn here.");
        break;
      }
      case "swap": {
        // Roles change before the next building turn. A round in progress (building, checks, review, a question
        // to you) finishes with the roles it started with, so nobody reviews their own work.
        if (this.#roundOpen(room)) {
          room.swapPending = !room.swapPending;
          this.#system(
            room,
            room.swapPending
              ? `Roles swap before the next building turn, once the work in progress has been checked and reviewed with the current roles: then ${this.label(room.crew.reviewer)} builds and ${this.label(room.crew.builder)} reviews. Swap again to cancel.`
              : "Swap cancelled.",
          );
        } else this.#swapRoles(room);
        break;
      }
      case "fresh": {
        const agent = args.agent;
        if (!room.crew.members.includes(agent)) throw new UserError("That agent isn't in this room.");
        if (!canStartFresh(agent)) throw new UserError("The Codex app's session is its thread. To start it fresh, choose another thread for this room.");
        (room.fresh ??= {})[agent] = "you";
        const working = this.#runningIn(room).some((r) => r.agent === agent);
        this.#system(room, `${this.label(agent)} starts fresh in this room ${working ? "after its current turn" : "on its next turn"}: a new session, with the briefing, the plan and the latest handoff.`);
        break;
      }
      case "rename":
        room.title = String(args.title ?? "").trim() || room.title;
        break;
      case "settings":
        room.settings = { ...room.settings, ...sanitizeSettings(args) };
        this.#system(room, "Room settings updated.");
        break;
      case "roles": {
        // Any member can build or review. Like a swap, a change during a round waits for the round to finish,
        // so the work in progress is reviewed by whoever started reviewing it.
        const builder = args.builder;
        const reviewer = args.reviewer;
        if (!room.crew.members.includes(builder) || !room.crew.members.includes(reviewer)) throw new UserError("Both roles need agents from this room.");
        if (builder === reviewer) throw new UserError("Choose different agents to build and to review.");
        if (builder === room.crew.builder && reviewer === room.crew.reviewer) {
          room.rolesPending = null;
          room.swapPending = false;
          break;
        }
        room.swapPending = false;
        if (this.#roundOpen(room)) {
          room.rolesPending = { builder, reviewer };
          this.#system(room, `Roles change before the next building turn, once the work in progress has been checked and reviewed: then ${this.label(builder)} builds and ${this.label(reviewer)} reviews.`);
        } else this.#setRoles(room, builder, reviewer);
        break;
      }
      case "members": {
        const members = (args.members ?? []).filter((a) => this.adapters[a]);
        if (!members.length) throw new UserError("Keep at least one agent.");
        const leaving = room.crew.members.filter((a) => !members.includes(a));
        const busy = leaving.filter((a) => this.#runningIn(room).some((r) => r.agent === a));
        if (busy.length) throw new UserError(`${busy.map((a) => this.label(a)).join(" and ")} is working; remove it when its turn has finished.`);
        if (room.mode === "build" && leaving.some((a) => a === room.crew.builder || a === room.crew.reviewer))
          throw new UserError("Give the builder's or reviewer's role to someone else before removing them.");
        if (leaving.length) room.queue = room.queue.filter((q) => !leaving.includes(q.agent));
        const joining = members.includes("codexapp") && !room.crew.members.includes("codexapp");
        if (joining) room.sessions.codexapp = this.#appThreadFor(this.project(room.projectId), args.appThread ?? room.sessions.codexapp, room);
        room.crew.members = [...new Set(members)];
        if (joining) this.#warnSharedThread(room);
        if (!members.includes(room.crew.builder)) room.crew.builder = members[0];
        if (!members.includes(room.crew.reviewer)) room.crew.reviewer = members.find((m) => m !== room.crew.builder) ?? members[0];
        this.#system(room, `Crew: ${members.map((m) => this.label(m)).join(", ")}.`);
        break;
      }
      case "app-thread": {
        if (!room.crew.members.includes("codexapp")) throw new UserError("The Codex app isn't in this room.");
        if (!String(args.thread ?? "").trim()) throw new UserError("Choose a thread.");
        if (this.#appBusy(room)) throw new UserError("The Codex app is working in this room. Change its thread once it has finished.");
        const next = this.#appThreadFor(this.project(room.projectId), args.thread, room);
        if (next !== room.sessions.codexapp) {
          room.sessions.codexapp = next;
          // The new thread has seen nothing: its next turn gets the introduction, the room's history and, for a builder, the briefing.
          room.seen.codexapp = [];
          delete room.introduced?.codexapp;
          if (room.mode === "build" && room.build && room.crew.builder === "codexapp") room.build.briefed = false;
        }
        this.#system(room, "The Codex app works in a different thread from now on. Its next turn there starts with the room's history.");
        this.#warnSharedThread(room);
        break;
      }
      case "start-build":
        return this.startBuild(roomId, { task: args.task, planPath: args.planPath ?? room.plan?.planPath, builder: args.builder, reviewer: args.reviewer, reviewFirst: args.reviewFirst, handoff: args.handoff, slice: args.slice });
      case "start-plan":
        return this.startPlan(roomId, { topic: args.topic, participants: args.participants });
      case "synthesize":
        return this.synthesize(roomId, args);
      case "plan-check": {
        // Ask the other planners (or some of them) to check the ready plan.
        const w = this.#readyQuestion(room, args.questionId);
        const all = this.#checkers(room);
        if (!all.length) throw new UserError("There's no other planner in this round to check the plan.");
        const checkers = args.checkers?.length ? [...new Set(args.checkers)] : all;
        if (!checkers.every((a) => all.includes(a))) throw new UserError("Only the other planners can check the plan: not its author, and not an agent outside the round.");
        this.#takeWaiting(room, w);
        this.#closeQuestion(room, `You asked ${this.#names(checkers)} to check the plan.`, w);
        this.#startPlanChecks(room, "check", checkers);
        break;
      }
      case "forward-discussion": {
        // Your discussion of the ready plan with another planner, to the author as a change request.
        const w = this.#readyQuestion(room, args.questionId);
        const picked = this.#discussion(room, w, args);
        const author = room.plan.synthesizer;
        const with_ = [...new Set(picked.filter((e) => e.type === "turn").map((e) => e.agent))];
        // Who said it: your notes, your answers to a planner's questions (and which question), and the planners' replies.
        const speaker = (e) => {
          if (e.type === "turn") return this.label(e.agent);
          const answered = (e.answers ?? []).map((a) => `${this.label(a.from)}: “${a.question}”`);
          return answered.length ? `The owner (answering ${answered.join("; ")})` : `The owner (to ${this.#names(e.to ?? [])})`;
        };
        // A planner's message without its status line, but with the question it asked you, if it asked one.
        const said = (e) => (e.type === "turn" ? [stripStatus(e.text).trim(), e.status === "OWNER" && e.detail ? `(Question for the owner: ${e.detail})` : ""].filter(Boolean).join("\n\n") : e.text);
        const quote = (t) => String(t).trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
        const text = [
          `A change request: the owner forwards ${with_.length ? `a discussion with ${this.#names(with_)}` : "these notes"} about the plan, for you to act on.${with_.length ? ` What the owner says there is the owner's; ${this.#names(with_)}'s replies are a planner's suggestions, which count as decisions only where the owner agreed with them.` : ""}`,
          ...picked.map((e) => `**${speaker(e)}** [${e.id}]:\n${quote(said(e))}`),
        ].join("\n\n");
        this.#takeWaiting(room, w);
        this.#closeQuestion(room, `You sent ${with_.length ? `your discussion with ${this.#names(with_)}` : "your notes"} to ${this.label(author)} as a change request.`, w);
        this.#append(room, { type: "owner", kind: "change-request", text, to: [author], forwarded: picked.map((e) => ({ id: e.id, from: e.type === "owner" ? "owner" : e.agent })), deliveredTo: [] });
        this.#planChange(room, "forwarded");
        break;
      }
      case "accept-checkpoint":
        return this.acceptCheckpoint(roomId, args);
      case "chat-mode":
        room.mode = "chat";
        this.#clearWaiting(room, "(switched to chat)");
        room.queue = [];
        this.#newFlow(room);
        this.#system(room, "Switched to chat. Sessions are kept, so everyone remembers the work so far.");
        break;
      case "opinion": {
        const target = this.events.get(room.id).find((e) => e.id === args.eventId);
        const agent = args.agent;
        if (!target || target.type !== "turn") throw new UserError("Pick an agent message to get a second opinion on.");
        if (!this.adapters[agent]) throw new UserError("Unknown agent.");
        if (agent === "codexapp" && !room.crew.members.includes(agent))
          room.sessions.codexapp = this.#appThreadFor(this.project(room.projectId), args.appThread ?? room.sessions.codexapp, room);
        if (!room.crew.members.includes(agent)) room.crew.members.push(agent);
        this.#system(room, `Asked ${this.label(agent)} for a second opinion on ${this.label(target.agent)}'s message.`);
        this.#enqueue(room, { agent, kind: "opinion", access: "read", parallel: true, whileWaiting: true, instruction: prompts.opinion({ author: this.label(target.agent) }), focus: target.id });
        break;
      }
      case "retry": {
        const w = this.#allWaiting(room).find((x) => x.kind === "error" && (!args.questionId || x.eventId === args.questionId));
        if (w) return this.answer(roomId, { text: "Retry.", accept: false, questionId: w.eventId });
        throw new UserError(args.questionId ? "That has already been retried or answered." : "Nothing to retry.", args.questionId ? 409 : 400);
      }
      default:
        throw new UserError(`Unknown action: ${action}`);
    }
    this.#save(room);
    this.#pump(room);
    return this.summary(room);
  }

  // ---------------------------------------------------------------- files & plans

  readProjectFile(projectId, path) {
    const project = this.project(projectId);
    if (!project) throw new UserError("Unknown project.", 404);
    let root;
    try {
      root = realpathSync(project.path);
    } catch {
      throw new UserError(`The project folder ${project.path} is missing.`, 404);
    }
    const asked = resolve(root, String(path ?? ""));
    const rel = relative(root, asked);
    if (outside(rel)) throw new UserError("That file is outside the project.", 403);
    let full;
    try {
      full = realpathSync(asked);
    } catch {
      throw new UserError(`No file at ${rel}.`, 404);
    }
    // A link inside the project can point anywhere: only files that really live in it are shown.
    if (outside(relative(root, full))) throw new UserError("That file is outside the project.", 403);
    const st = statSync(full);
    if (!st.isFile()) throw new UserError(`${rel} is not a file.`);
    const max = 1_500_000;
    const fd = openSync(full, "r");
    let content;
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== st.ino || opened.dev !== st.dev) throw new UserError(`${rel} changed while Toryo was reading it. Try again.`, 409);
      const buf = Buffer.alloc(Math.min(st.size, max));
      const n = readSync(fd, buf, 0, buf.length, 0);
      // Streaming decode holds back a character cut off at the limit instead of mangling it.
      content = new TextDecoder().decode(buf.subarray(0, n), { stream: st.size > max });
    } finally {
      closeSync(fd);
    }
    return { path: rel, size: st.size, truncated: st.size > max, content };
  }

  planView(roomId) {
    const room = this.#room(roomId);
    const path = room.build?.planPath || room.plan?.planPath;
    // Rooms without a plan file still show how long each approved slice took.
    if (!path) return { path: null, slices: [], times: sliceTimes(this.events.get(room.id) ?? []).done };
    let slices = [];
    try {
      const file = this.readProjectFile(room.projectId, path);
      slices = parseSlices(file.content);
    } catch {
      return { path, slices: [], missing: true };
    }
    const approved = room.build?.approved ?? [];
    const { done } = sliceTimes(this.events.get(room.id) ?? []);
    return {
      path,
      slices: slices.map((s) => {
        const took = [...done].reverse().find((t) => sliceMatches(s, t.label));
        return {
          ...s,
          approved: approved.some((a) => sliceMatches(s, a)) || s.markedDone || (s.checks > 0 && s.checks === s.checked),
          current: !room.done && sliceMatches(s, room.build?.slice),
          took: took ? { active: took.active, wall: took.wall, rounds: took.rounds } : null,
        };
      }),
      times: done,
    };
  }

  async turnDiff(roomId, turnId, path) {
    const room = this.#room(roomId);
    const ev = this.events.get(room.id).find((e) => e.id === turnId);
    if (!ev?.snapBefore || !ev?.snapAfter) throw new UserError("No snapshot for that turn.", 404);
    const project = this.project(room.projectId);
    return {
      files: await this.snapshots.changes(project, ev.snapBefore, ev.snapAfter),
      diff: await this.snapshots.diff(project, ev.snapBefore, ev.snapAfter, path),
    };
  }

  turnPrompt(roomId, turnId) {
    const room = this.#room(roomId);
    if (!/^[\w-]+$/.test(turnId)) throw new UserError("Bad turn id.");
    const file = join(this.store.roomDir(room.id), "turns", turnId, "prompt.md");
    if (!existsSync(file)) throw new UserError("No prompt recorded for that turn.", 404);
    return readFileSync(file, "utf8");
  }

  // ---------------------------------------------------------------- scheduling

  #enqueue(room, req) {
    const flow = FREE_KINDS.has(req.kind) ? undefined : (req.flow ?? room.flow);
    room.queue.push({ ...req, id: shortId("q"), flow, queuedAt: req.queuedAt ?? this.#stamp(), baseInstruction: req.baseInstruction ?? req.instruction });
    this.#save(room);
    this.#pump(room);
  }

  /** When a request was queued, in an order that's stable within one millisecond. */
  #stamp() {
    return `${nowIso()}#${String(++this.queueSeq).padStart(6, "0")}`;
  }

  /** Queue a building turn. A swap or role change the owner asked for during a round takes effect here. */
  #enqueueBuilder(room, kind, instruction, extra = {}) {
    const before = { builder: room.crew.builder, reviewer: room.crew.reviewer };
    if (room.swapPending) this.#swapRoles(room);
    if (room.rolesPending) this.#setRoles(room, room.rolesPending.builder, room.rolesPending.reviewer);
    // The instruction was written for the old crew. Tell a new builder whose work it continues, and, if it
    // reviewed that work itself, that the review to address is its own last message.
    if (room.crew.builder !== before.builder) {
      const B = this.label(before.builder);
      const R = this.label(before.reviewer);
      const own = room.crew.builder === before.reviewer;
      instruction =
        `Roles changed: you build from now on, and ${this.label(room.crew.reviewer)} reviews. ${B} built the work so far` +
        (own ? `, and you reviewed it: where the instruction below says “${R}”, it means you, and the review to address is the one you wrote in your last message.` : `, and ${R} reviewed it (above).`) +
        ` Treat it as your work to continue: read the code and ${B}'s handoff before changing anything.\n\n${instruction}`;
    }
    this.#enqueue(room, { ...extra, agent: room.crew.builder, kind, access: "write", instruction });
  }

  /** Whether a building round is under way: anything of the current run running or queued (other than the next building turn), or a question waiting. */
  #roundOpen(room) {
    if (room.mode !== "build" || !room.build || room.done) return false;
    const current = (req) => Boolean(req.flow) && req.flow === room.flow;
    return (
      this.#runningIn(room).some((r) => current(r.req)) ||
      room.queue.some((q) => current(q) && !BUILDER_KINDS.has(q.kind)) ||
      this.#allWaiting(room).length > 0
    );
  }

  #setRoles(room, builder, reviewer) {
    room.rolesPending = null;
    if (!room.crew.members.includes(builder) || !room.crew.members.includes(reviewer) || builder === reviewer) return;
    const newBuilder = builder !== room.crew.builder;
    room.crew.builder = builder;
    room.crew.reviewer = reviewer;
    for (const q of room.queue) if (BUILDER_KINDS.has(q.kind)) q.agent = builder;
    // A builder that hasn't built in this room gets the builder's briefing with its first turn.
    if (newBuilder && room.build && !this.events.get(room.id).some((e) => e.type === "turn" && e.agent === builder && BUILDER_KINDS.has(e.kind)))
      room.build.briefed = false;
    this.#system(room, `Roles: ${this.label(builder)} builds and ${this.label(reviewer)} reviews from the next turn.`, { forAgents: true });
  }

  #swapRoles(room) {
    const { builder, reviewer } = room.crew;
    room.crew.builder = reviewer;
    room.crew.reviewer = builder;
    room.swapPending = false;
    // A queued building turn goes to the new builder. (Reviews are never queued here: a swap waits for them.)
    for (const q of room.queue) if (BUILDER_KINDS.has(q.kind)) q.agent = room.crew.builder;
    this.#system(room, `Roles swapped: ${this.label(room.crew.builder)} builds and ${this.label(room.crew.reviewer)} reviews from the next turn.`, { forAgents: true });
  }

  /** A new run (build, planning round, chat, stop): queued work from the old one won't happen. */
  #newFlow(room, { note = true } = {}) {
    room.flow = shortId("f");
    room.queue = room.queue.filter((q) => !q.flow);
    room.swapPending = false;
    room.rolesPending = null;
    const still = [...new Set(this.#runningIn(room).filter((r) => r.req.flow).map((r) => this.label(r.agent)))];
    if (note && still.length)
      this.#system(room, `${still.join(" and ")} ${still.length > 1 ? "are" : "is"} still finishing a turn from before. It runs to the end, but it no longer drives anything here.`);
  }

  /** Work from a run that has since been replaced. */
  #stale(room, req) {
    return Boolean(req.flow) && req.flow !== room.flow;
  }

  #stopRun(room, run) {
    if (this.adapters[run.agent]?.cancellable !== false) return run.controller.abort("stop");
    // The Codex app can't be stopped from here: keep following its turn so nothing else starts over it.
    if (!run.controller.signal.aborted) {
      run.controller.abort("stop");
      this.#system(room, `${this.label(run.agent)} can't be stopped from Toryo: its turn carries on in the app, and nothing else starts here until it finishes. Stop it in the app, or press Stop again to stop waiting for it.`, { level: "warn" });
    } else {
      run.abandon.abort();
      this.#system(room, `Toryo stopped waiting for ${this.label(run.agent)}'s turn. It may still be working in the app.`, { level: "warn" });
    }
  }

  /** Start what can start (in every room; see #schedule), and save this room. */
  #pump(room) {
    this.#schedule();
    if (!room.archived) this.#save(room);
  }

  #runningIn(room) {
    return [...this.running.values()].filter((r) => r.roomId === room.id);
  }

  /** Another room has a Codex app turn in this room's thread: running, or handed to the app and not yet over. */
  #appThreadWorking(room) {
    const thread = room.sessions?.codexapp;
    if (!thread) return false;
    if ([...this.rooms.values()].some((r) => r !== room && !r.archived && r.appTurn?.thread === thread)) return true;
    return [...this.running.values()].some((r) => r.agent === "codexapp" && r.roomId !== room.id && this.rooms.get(r.roomId)?.sessions?.codexapp === thread);
  }

  #status(room) {
    if (room.done) return "done";
    // A turn that can't be cancelled (the Codex app) keeps a stopped room "stopping" until it ends.
    if (room.stopped) return this.#runningIn(room).length ? "stopping" : "stopped";
    // Anything that needs you comes before anyone working: a question the room waits on, or one asked in chat.
    if (room.waiting || room.openChat?.length) return "waiting";
    if (this.#runningIn(room).length) return room.paused ? "pausing" : "running";
    if (room.paused) return "paused";
    if (room.queue.length) {
      const heldUp = this.#heldUp(room);
      if (room.queue.every((q) => heldUp.has(q))) return "held";
    }
    if (room.queue.length) return "queued";
    return "idle";
  }

  #roleOf(room, agent) {
    if (room.mode === "build") return agent === room.crew.builder ? "builder" : agent === room.crew.reviewer ? "reviewer" : "advisor";
    if (room.mode === "plan") return room.plan?.synthesizer === agent ? "plan author" : "planner";
    return "";
  }

  #interrupt(room, run) {
    run.requeue = true;
    run.controller.abort("interrupt");
    this.#system(room, `Interrupted ${this.label(run.agent)} to deliver your note now.`);
  }

  #startTurn(room, req) {
    const turnId = shortId("t");
    const run = {
      turnId,
      roomId: room.id,
      agent: req.agent,
      req,
      controller: new AbortController(),
      // Only for agents whose turns can't be cancelled (the Codex app): stop following the turn.
      abandon: new AbortController(),
      activity: [],
      // Following a Codex app turn again after a restart: it started when the app was given it, not now.
      startedAt: req.attach?.since ?? nowIso(),
      // preparing (snapshot, prompt) → sending (handing it to the Codex app) → in-app (the app has it, not yet
      // started) → working. Headless agents go from preparing to working when they start.
      phase: req.attach ? "in-app" : "preparing",
      requeue: false,
    };
    this.running.set(turnId, run);
    this.#executeTurn(room, run).catch((error) => {
      console.error("[toryo] turn crashed:", error);
      this.running.delete(turnId);
      const ev = this.events.get(room.id).find((e) => e.id === turnId);
      // A turn the Codex app already has stays kept; following it again waits for you (it's never sent again). One that
      // was being handed over may have reached the app: kept too, and watched for (#appUncertain). The room keeps it on
      // disk before the turn's end is recorded, so a stop in between can't lose it.
      if (room.pendingOutcome?.turnId === turnId) room.pendingOutcome = null;
      const keep = Boolean(ev?.submitted || ev?.submitting || (room.appTurn && room.appTurn.marker === (req.attach?.marker ?? `[Toryo ${turnId}]`)));
      const unsure = keep && !ev?.submitted && Boolean(ev?.submitting) && !req.attach;
      if (keep) {
        room.appTurn ??= this.#appTurnFrom(room, this.#followReq(req, ev));
        if (unsure) room.appTurn.uncertain = true;
        this.store.saveRoom(room);
      }
      if (ev) this.#patch(room, ev, { state: "failed", endedAt: nowIso(), error: String(error?.message ?? error) });
      if (this.shuttingDown) return;
      if (keep) {
        if (unsure) this.#appUncertain(room);
        else this.#appLost(room, ev ?? { error: String(error?.message ?? error) });
      } else if (!this.#stale(room, req))
        this.#wait(room, { kind: "error", from: req.agent, question: `${this.label(req.agent)}'s turn crashed in Toryo: ${firstLine(error?.message ?? error)}`, recommendation: "Retry", retryReq: { ...req } });
      this.#save(room);
      this.#pump(room);
    });
    return run;
  }

  async #executeTurn(room, run) {
    const { req, turnId } = run;
    const project = this.project(room.projectId);
    const adapter = this.adapters[req.agent];
    if (!adapter) throw new Error(`No adapter for ${req.agent}`);
    const cfg = this.agentConfig(project, req.agent);
    const role = this.#roleOf(room, req.agent);
    run.role = role;
    const others = room.crew.members.filter((a) => a !== req.agent).map((a) => this.label(a));
    const pre = preamble({ agentLabel: this.label(req.agent), others, project });

    // A session that hasn't had Toryo's introduction yet (the agent's first turn here, or a different Codex app
    // thread) gets it, and gets the agent's own earlier messages in this room along with everyone else's.
    // Started fresh (by you, or as a new slice's reviewer): the session is forgotten, and the turn starts a new one
    // with what the agent needs instead of what it remembered. Following a Codex app turn is never a fresh start.
    if (req.access === "write" && room.askMode?.[req.agent] && room.askMode[req.agent] === room.sessions[req.agent]) (room.fresh ??= {})[req.agent] ??= "ask-mode";
    const startFresh = !req.attach && canStartFresh(req.agent) ? room.fresh?.[req.agent] ?? null : null;
    if (startFresh) {
      delete room.sessions[req.agent];
      if (room.introduced) delete room.introduced[req.agent];
    }
    const session = room.sessions[req.agent] ?? null;
    run.sessionBefore = session;
    const known = room.introduced?.[req.agent];
    const fresh = known == null || (session != null && known !== session);
    const { items, ids, ownerIds, notes } = this.#catchUpItems(room, req.agent, req.hideKinds ?? [], req.focus, { own: fresh });
    const usesSystemPrompt = req.agent === "claude";
    let prompt = "";
    if (!usesSystemPrompt && fresh) prompt += `${pre}\n\n---\n\n`;
    // House rules changed since this agent last got them (or it got them before Toryo kept track): say so, once.
    const rules = rulesKey(project);
    const rulesChanged = !fresh && !startFresh && (room.rulesSent ?? {})[req.agent] !== rules;
    if (rulesChanged) prompt += `${rulesUpdate(project, { inInstructions: usesSystemPrompt })}\n\n---\n\n`;
    if (startFresh) prompt += `${this.#freshBrief(room, req.agent, startFresh, new Set(ids))}\n\n---\n\n`;
    const backlog = catchUp(items);
    if (backlog) prompt += `${backlog}\n`;
    // The one-time briefing for a builder whose build started with a review of its earlier work.
    const briefing = room.mode === "build" && room.build?.briefed === false && req.agent === room.crew.builder && BUILDER_KINDS.has(req.kind);
    if (briefing) prompt += `${prompts.buildKickoff({ reviewer: this.label(room.crew.reviewer), task: room.build.task, planPath: room.build.planPath })}\n\n---\n\n`;
    // A building turn that carries your notes opens its message with one line per note (done, scheduled, declined).
    const building = room.mode === "build" && (BUILDER_KINDS.has(req.kind) || req.kind === "build-notes");
    if (building && notes.length) prompt += `${prompts.noteAcks(notes)}\n`;
    prompt += req.instruction;
    // What this turn hands the agent. It counts as delivered only once the agent has started the turn, so a
    // launch that fails, or a restart before the agent began, sends the same messages and briefing again.
    run.dispatch = req.attach?.dispatch ?? { flow: room.flow, ids, ownerIds, briefing, intro: fresh, fresh: startFresh || undefined, notes: notes.length ? notes : undefined, acks: building || undefined, rules, rulesBefore: (room.rulesSent ?? {})[req.agent] ?? null, rulesUpdate: rulesChanged || undefined };

    const round = room.mode === "build" ? (room.build?.round ?? 0) + 1 : undefined;
    // Following a Codex app turn again (after a restart): when the app was given it, and when it took it up, are
    // the first turn's, not now.
    const origin = req.attach ? this.#appOrigin(room, req.attach.marker) : null;
    const ev = this.#append(room, {
      id: turnId,
      type: "turn",
      agent: req.agent,
      role,
      kind: req.kind,
      access: req.access,
      state: "running",
      startedAt: run.startedAt,
      slice: room.mode === "build" ? room.build?.slice || undefined : undefined,
      round,
      req: { ...req },
      dispatch: run.dispatch,
      // For agents whose turns can't be cancelled: whether the agent has the message (then a restart follows it).
      submitted: this.adapters[req.agent]?.cancellable === false ? Boolean(req.attach) : undefined,
      ...(req.attach ? { submittedAt: origin?.submittedAt ?? req.attach.since, pickedUpAt: origin?.pickedUpAt } : {}),
    });
    if (req.attach) {
      run.submittedAt = ev.submittedAt;
      if (ev.pickedUpAt) {
        run.phase = "working";
        run.workingAt = ev.pickedUpAt;
      }
    }
    this.#save(room);

    const dir = this.store.turnDir(room.id, turnId);
    const snapOn = room.settings.snapshots !== false && this.snapshots;
    const before = snapOn ? await this.snapshots.take(project, `before ${turnId} ${req.agent} ${req.kind}`) : null;
    if (before) this.#patch(room, ev, { snapBefore: before.commit });
    if (req.kind === "review" && before && this.snapshots) {
      // Tell the reviewer exactly which tree it is reviewing, and how to diff it against its last review.
      const prev = [...this.events.get(room.id)].reverse().find((e) => e.type === "turn" && e.kind === "review" && e.id !== turnId && e.snapBefore);
      const git = this.snapshots.hint(project);
      const lines = [`Toryo snapshot of the tree as handed over: ${before.commit.slice(0, 12)} (read-only: \`${git} show --stat ${before.commit.slice(0, 12)}\`).`];
      if (prev) lines.push(`Changes since your last review: \`${git} diff --stat ${prev.snapBefore.slice(0, 12)} ${before.commit.slice(0, 12)}\`.`);
      prompt = prompt.replace("{{SNAPSHOT}}", lines.join("\n"));
    } else prompt = prompt.replace("{{SNAPSHOT}}", "");
    writeFileSync(join(dir, "prompt.md"), (usesSystemPrompt ? `<!-- system prompt (appended) -->\n${pre}\n\n<!-- prompt -->\n` : "") + prompt);

    // Held while it was being prepared (Pause everything, a hold): it was never sent, so it goes back to the front of
    // the queue as it was, with its messages still unread, and goes when the restriction lifts. (A room's own Pause
    // lets the turn it's on finish, preparing included.) Following a turn the Codex app already has is never held.
    const heldBy = req.attach || run.abandon.signal.aborted || run.controller.signal.aborted ? [] : this.blockersFor(req);
    if (heldBy.length) return this.#deferTurn(room, run, ev, heldBy);

    // Stopped while the snapshot was taken: an unsent turn isn't handed over at all. Following a turn the
    // Codex app already has carries on after a first stop; only letting it go (abandon) ends it.
    const skip = run.abandon.signal.aborted || (run.controller.signal.aborted && !req.attach);
    const result = skip ? { text: "", aborted: true } : await adapter.run({
      cfg,
      cwd: project.path,
      prompt,
      sessionId: room.sessions[req.agent] ?? null,
      access: req.access,
      // `"readOnlyMount": false` in an agent's config turns the read-only mount off for that agent.
      readOnlyPaths: req.access === "write" || cfg.readOnlyMount === false ? null : this.#readOnlyPaths(project),
      systemPrompt: usesSystemPrompt ? pre : undefined,
      turnDir: dir,
      signal: run.controller.signal,
      abandon: run.abandon.signal,
      timeoutMs: (room.settings.turnTimeoutMin ?? 240) * 60_000,
      attach: req.attach && { marker: req.attach.marker },
      // The agent has the turn: keep its session at once (a restart resumes it) and mark the messages delivered.
      onStarted: ({ sessionId, at } = {}) => {
        if (sessionId) room.sessions[req.agent] = sessionId;
        if (run.phase !== "working") {
          run.phase = "working";
          // When it started: the time the agent says (the Codex app's log, which can be from while Toryo was
          // stopped), if it's a real time and not ahead of now; else now.
          const said = Date.parse(at ?? "");
          run.workingAt = Number.isFinite(said) && said <= Date.now() + 60_000 ? new Date(Math.min(said, Date.now())).toISOString() : nowIso();
          // For the Codex app: when it took the message up, as opposed to when it was given it. Kept on the first
          // turn too, so following it again after another restart still knows.
          if (req.agent === "codexapp" && !ev.pickedUpAt) {
            this.#patch(room, ev, { pickedUpAt: run.workingAt });
            if (origin && origin !== ev && !origin.pickedUpAt) this.#patch(room, origin, { pickedUpAt: run.workingAt });
          }
        }
        this.#commitDispatch(room, req.agent, run);
        this.#save(room);
      },
      // About to hand the message to the Codex app: from here until it says it has it, a crash leaves it uncertain
      // whether the app got it, and a restart mustn't send it again (see #recover).
      onSubmitting: () => {
        run.phase = "sending";
        this.#patch(room, ev, { submitting: true });
        this.#save(room);
      },
      // The Codex app accepted the message: keep the turn (on disk) until it ends; it's followed, never sent again.
      onSubmitted: () => {
        if (run.phase === "preparing" || run.phase === "sending") run.phase = "in-app";
        run.submittedAt ??= nowIso();
        if (room.appTurn?.marker !== `[Toryo ${turnId}]`) room.appTurn = this.#appTurnFrom(room, this.#followReq(req, ev));
        if (!ev.submitted) this.#patch(room, ev, { submitted: true, submittedAt: nowIso() });
        this.#save(room);
      },
      // The Codex app opens a thread to make it send a queued message, but not while it's held or everything is paused.
      canOpen: () => !this.blockersFor({ agent: req.agent }).length,
      // Asked right before the agent is actually launched (or the message handed to the app), after anything the
      // adapter awaited first (Cursor's create-chat): held since the turn began means it goes back unsent.
      canLaunch: () => !this.blockersFor(req).length,
      onActivity: (item) => {
        if (item.kind === "limits") {
          if (this.#setLimits(req.agent, item.limits, "stream")) this.emit("state");
          return;
        }
        const entry = { ...item, text: truncate(String(item.text ?? "").replace(/\s+/g, " "), 300), at: nowIso() };
        if (item.notify) this.#notify(`${this.label(req.agent)} needs attention`, entry.text);
        run.activity.push(entry);
        if (run.activity.length > 60) run.activity.shift();
        this.emit("activity", { roomId: room.id, turnId, agent: req.agent, item: entry });
      },
    });

    // Held right before launch: nothing reached the agent. Back to the queue, as at the start of the turn.
    if (result.held && !this.shuttingDown) return this.#deferTurn(room, run, ev, this.blockersFor(req));

    if (this.shuttingDown) {
      // Leave the turn marked as running; the next start re-queues it.
      this.running.delete(turnId);
      if (result.sessionId) room.sessions[req.agent] = result.sessionId;
      this.store.saveRoom(room);
      return;
    }
    const after = snapOn ? await this.snapshots.take(project, `after ${turnId} ${req.agent} ${req.kind}`) : null;
    const files = before && after ? await this.snapshots.changes(project, before.commit, after.commit) : [];
    this.running.delete(turnId);
    if (result.sessionId) room.sessions[req.agent] = result.sessionId;
    // Handing the message to the Codex app ended without an answer (it ran out of time, or was stopped): the app may
    // have it. Keep the thread, and follow the turn by its marker if the app sends it; never send it again by itself.
    if (result.uncertain && !room.appTurn) {
      room.appTurn = this.#appTurnFrom(room, this.#followReq(req, ev));
      room.appTurn.uncertain = true;
      run.uncertain = true;
    }
    // A Cursor chat that had an Ask-mode turn keeps Ask mode: remember it, so its next turn that writes starts a new chat.
    if (result.askMode && result.sessionId) (room.askMode ??= {})[req.agent] = result.sessionId;
    // Usually the reading the turn already streamed; that one isn't news.
    if (result.limits && this.#setLimits(req.agent, result.limits, "turn")) this.emit("state");
    const { status, detail } = parseStatus(result.text);
    // A timeout is a failure that needs the owner; a stop or an interrupt is deliberate.
    const interrupted = run.requeue || Boolean(result.aborted && (run.controller.signal.aborted || !result.timedOut));
    const timedOut = Boolean(result.timedOut) && !interrupted;
    // A turn that ended without a word (or whose prompt a hook dropped before the agent saw it) is an error, never
    // an answer: in particular, never a reviewer's verdict.
    // Whether or not the agent reported an error with it (Claude: "ran no turns"), a turn with nothing to show was never
    // really had: what it carried is sent again, whole, with the next try, in the session the agent had before.
    const silent = !interrupted && !timedOut && !String(result.text ?? "").trim();
    const empty = silent && !result.error;
    const state = interrupted ? "interrupted" : timedOut || result.error || empty ? "failed" : "done";
    if (state === "done") this.#commitDispatch(room, req.agent, run);
    if (result.dropped || silent) this.#uncommitDispatch(room, req.agent, run);
    // The app's turn is over when it finished or you let it go. Anything else (an error while following it)
    // keeps it, and following it again waits for you.
    if (room.appTurn && room.appTurn.marker === (req.attach?.marker ?? `[Toryo ${turnId}]`)) {
      if (state === "done" || run.abandon.signal.aborted) room.appTurn = null;
      else if (!run.uncertain) {
        room.appTurn.lost = true;
        run.appLost = true;
      }
    }
    writeFileSync(join(dir, "message.md"), result.text ?? "");
    const stats = (room.stats.agents[req.agent] ??= { turns: 0, input: 0, cached: 0, output: 0, cost: 0 });
    stats.turns++;
    room.stats.turns++;
    if (result.usage) {
      stats.input += result.usage.input ?? 0;
      stats.cached += result.usage.cached ?? 0;
      stats.output += result.usage.output ?? 0;
    }
    if (result.cost) stats.cost += result.cost;
    // Before the turn's end is recorded: the room notes that this turn has ended and its outcome is being acted on,
    // with what it keeps (the Codex app turn it follows, or lets go). If Toryo stops before that outcome's effects are
    // saved (below), the next start acts on it, once (#reconcile). If it stops before this, the turn is still running.
    room.pendingOutcome = { turnId };
    this.store.saveRoom(room);
    this.#patch(room, ev, {
      state,
      endedAt: nowIso(),
      text: result.text ?? "",
      status,
      detail,
      usage: result.usage ?? null,
      cost: result.cost ?? null,
      error: result.error ?? (timedOut ? `Timed out after ${room.settings.turnTimeoutMin ?? 240} min.` : empty ? `${this.label(req.agent)} returned an empty message: no text and no status line.` : null),
      timedOut: timedOut || undefined,
      dropped: result.dropped || undefined,
      empty: empty || undefined,
      snapAfter: after?.commit ?? null,
      files,
      activityCount: run.activity.length,
    });
    if (req.access !== "write" && files.length && state === "done")
      this.#system(room, `Files changed during ${this.label(req.agent)}'s read-only turn (by it or someone else): ${files.slice(0, 8).map((f) => f.path).join(", ")}${files.length > 8 ? "…" : ""}`, { level: "warn" });
    this.#actOnOutcome(room, turnId, () => {
      if (state === "done") this.#markReplies(room, req.agent, turnId);
      if (state === "done") this.#noteOutcomes(room, req, run, ev);
      this.#afterTurn(room, ev, run);
    });
  }

  /**
   * Act on a turn's outcome (`fn`) as one step: the room's "outcome pending" marker is cleared first, its saves wait,
   * and nothing new starts until the room is saved once, with the outcome's effects and the cleared marker together.
   * A stop before that save leaves the marker, and the next start acts on the outcome again (#reconcile); what it
   * already wrote to the timeline (a question to you) is found and reused rather than written twice.
   */
  #actOnOutcome(room, turnId, fn) {
    if (room.pendingOutcome?.turnId === turnId) room.pendingOutcome = null;
    const before = this.outcomeSource;
    this.outcomeRooms.add(room);
    this.outcomeSource = turnId;
    try {
      fn();
    } finally {
      this.outcomeSource = before;
      this.outcomeRooms.delete(room);
    }
    this.#save(room);
    this.#schedule();
  }

  /** Mark what a turn handed its agent as delivered (once). */
  #commitDispatch(room, agent, run) {
    if (run.committed || !run.dispatch) return;
    run.committed = true;
    const d = run.dispatch;
    room.seen[agent] = [...new Set([...(room.seen[agent] ?? []), ...(d.ids ?? [])])];
    for (const id of d.ownerIds ?? []) {
      const o = this.events.get(room.id).find((e) => e.id === id);
      if (o) this.#patch(room, o, { deliveredTo: [...new Set([...(o.deliveredTo ?? []), agent])], readBy: { ...o.readBy, [agent]: run.turnId } });
    }
    if (d.intro) (room.introduced ??= {})[agent] = room.sessions[agent] ?? true;
    if (d.briefing && room.build && d.flow === room.flow) room.build.briefed = true;
    if (d.fresh && room.fresh?.[agent] === d.fresh) delete room.fresh[agent];
    if (d.rules) (room.rulesSent ??= {})[agent] = d.rules;
    if (d.rulesUpdate) this.#system(room, `${this.label(agent)} has the updated house rules from this turn on.`);
  }

  /**
   * Undo `#commitDispatch` for a turn the agent never really had (its prompt was dropped, or it returned nothing):
   * the messages count as unread again, so the next try carries them, and a session started by this turn is forgotten.
   */
  #uncommitDispatch(room, agent, run) {
    if (run.sessionBefore === null) delete room.sessions[agent];
    else if (run.sessionBefore !== undefined) room.sessions[agent] = run.sessionBefore;
    if (!run.committed || !run.dispatch) return;
    run.committed = false;
    const d = run.dispatch;
    const ids = new Set(d.ids ?? []);
    room.seen[agent] = (room.seen[agent] ?? []).filter((id) => !ids.has(id));
    for (const id of d.ownerIds ?? []) {
      const o = this.events.get(room.id).find((e) => e.id === id);
      if (!o) continue;
      const { [agent]: _read, ...readBy } = o.readBy ?? {};
      this.#patch(room, o, { deliveredTo: (o.deliveredTo ?? []).filter((a) => a !== agent), readBy });
    }
    if (d.intro && room.introduced) delete room.introduced[agent];
    if (d.briefing && room.build && d.flow === room.flow) room.build.briefed = false;
    if (d.fresh) (room.fresh ??= {})[agent] = d.fresh;
    if (d.rules) {
      room.rulesSent ??= {};
      if (d.rulesBefore == null) delete room.rulesSent[agent];
      else room.rulesSent[agent] = d.rulesBefore;
    }
  }

  /**
   * What an agent started fresh in this room needs instead of its memory: its role and the task, the plan and
   * where it stands, the latest handoff and, for a reviewer, the ledger of open findings and the owner's
   * decisions. Messages it hasn't seen yet follow in "Since your last turn" as usual (`shown`).
   */
  #freshBrief(room, agent, why, shown) {
    const L = (a) => this.label(a);
    const out = [
      "## A fresh session",
      why === "final"
        ? "Toryo starts a fresh session for the final review, so the whole change gets an independent look."
        : why === "new-slice"
          ? "Toryo starts the reviewer fresh for each new slice, so each slice gets an independent review and the session stays small."
          : why === "ask-mode"
            ? "Your last chat here was read-only in Ask mode, which it would keep, and this turn changes files, so Toryo started you in a new chat."
            : "The owner started you fresh in this room.",
      "You don't remember earlier turns here. This is what you need; read the files it names for the rest.",
    ];
    const events = this.events.get(room.id);
    const latest = (test) => [...events].reverse().find((e) => e.type === "turn" && e.state === "done" && e.text?.trim() && test(e));
    const quote = (e, heading) => (e && !shown.has(e.id) ? `### ${heading}\n${stripStatus(e.text).trim()}\n\nIts status line: TORYO: ${e.status ?? "(none)"}${e.detail ? ` ${e.detail}` : ""}` : "");
    if (room.mode === "build" && room.build) {
      const b = room.build;
      const role = agent === room.crew.builder ? "builder" : agent === room.crew.reviewer ? "reviewer" : "advisor";
      out.push(`Your role: ${role}. ${L(room.crew.builder)} builds; ${L(room.crew.reviewer)} reviews.${b.task ? ` Task: ${b.task}` : ""}`);
      const plan = this.planView(room.id);
      if (plan.path) {
        const done = plan.slices.filter((x) => x.approved).map((x) => `${x.kind} ${x.number}`);
        const current = plan.slices.find((x) => x.current);
        out.push(`The plan: ${plan.path}.${done.length ? ` Approved so far: ${done.join(", ")}.` : ""}${current ? ` In progress: ${current.kind} ${current.number}: ${current.name}.` : b.slice ? ` In progress: ${b.slice}.` : ""}`);
      } else if (b.slice) out.push(`In progress: ${b.slice}.`);
      const handoff = latest((e) => e.role === "builder" && (e.status === "REVIEW" || e.status === "DONE"));
      const parts = [quote(handoff, `The latest handoff (${L(handoff?.agent)}${handoff?.slice ? `, ${handoff.slice}` : ""})`)];
      if (role === "builder" && handoff) parts.push(quote(latest((e) => e.role === "reviewer" && e.at >= handoff.at && e.status), `The review of it (${L(room.crew.reviewer)})`));
      if (role === "reviewer") parts.push(this.#ledgerText(room));
      out.push(...parts.filter(Boolean));
    } else {
      // Chat or planning: the last few messages, for context.
      const recent = events.filter((e) => !shown.has(e.id) && ((e.type === "turn" && e.state === "done" && e.text?.trim()) || (e.type === "owner" && !e.cancelled))).slice(-6);
      if (recent.length)
        out.push(`### The last messages in this room\n${recent.map((e) => `**${e.type === "owner" ? "The owner" : L(e.agent)}:** ${truncate(stripStatus(e.text).trim(), 1_500)}`).join("\n\n")}`);
    }
    return out.join("\n\n");
  }

  // ---------------------------------------------------------------- the ledger

  /**
   * The room's ledger: the reviews' findings and how each was resolved, and the owner's decisions in builds.
   * A reviewer started fresh gets the open findings and the decisions (see `#ledgerText`).
   */
  #ledgerAdd(room, entry) {
    const ledger = (room.ledger ??= []);
    const prefix = entry.kind === "decision" ? "D" : "L";
    const id = `${prefix}${ledger.filter((e) => (e.kind === "decision") === (prefix === "D")).length + 1}`;
    ledger.push({ id, at: nowIso(), ...entry });
    return id;
  }

  /** After a review: findings it asks for, findings it leaves open for later, and ledger findings it says are resolved. */
  #ledgerFromReview(room, ev, req, status) {
    const b = room.build;
    const R = this.label(req.agent);
    // A status given on its own (review-status) belongs to the review just before it.
    if (req.kind === "review-status")
      ev = [...this.events.get(room.id)].reverse().find((e) => e.type === "turn" && e.agent === req.agent && e.state === "done" && (e.kind === "review" || e.kind === "review-answer") && e.at <= ev.at) ?? ev;
    const text = String(ev.text ?? "");
    for (const m of text.matchAll(/^\s*(?:[-*]\s*)?\**Resolved\**\s*:\s*((?:[LD]\d+[,\s]*)+)/gim))
      for (const id of m[1].match(/L\d+/g) ?? []) {
        const f = room.ledger?.find((e) => e.id === id && e.state === "open");
        if (f) Object.assign(f, { state: "resolved", resolution: `resolved, per ${R}'s review of ${b.slice || "the work"}`, resolvedAt: nowIso() });
      }
    if (status === "APPROVED") {
      const round = b.round + 1;
      for (const f of room.ledger ?? [])
        if (f.kind === "changes" && f.state === "open" && f.slice === b.slice) Object.assign(f, { state: "resolved", resolution: `${b.slice || "the slice"} approved in round ${round}`, resolvedAt: nowIso() });
      for (const m of text.matchAll(/^\s*(?:[-*]\s*)?\**Open\**\s*:\s*(.+)$/gim))
        this.#ledgerAdd(room, { kind: "open", slice: b.slice, round, by: req.agent, text: truncate(m[1].trim(), 1_000), state: "open", turnId: ev.id });
    } else if (status === "CHANGES" || !status) {
      this.#ledgerAdd(room, { kind: "changes", slice: b.slice, round: b.round + 1, by: req.agent, text: truncate(stripStatus(text).trim(), 3_000), state: "open", turnId: ev.id });
    }
  }

  /** The ledger as a fresh reviewer gets it: open findings, then the owner's decisions. Empty when there's nothing. */
  #ledgerText(room) {
    const ledger = room.ledger ?? [];
    const open = ledger.filter((e) => e.kind !== "decision" && e.state === "open");
    const decisions = ledger.filter((e) => e.kind === "decision").slice(-20);
    if (!open.length && !decisions.length) return "";
    const lines = ["### The ledger: open findings and the owner's decisions", "From earlier reviews in this room, which you don't remember. Check whether the open findings still apply."];
    for (const f of open) lines.push(`- ${f.id} (${f.slice || "no slice"}, ${f.kind === "open" ? "left open on approval" : `round ${f.round} changes`}, ${this.label(f.by)}): ${truncate(f.text, 1_200)}`);
    if (decisions.length) {
      lines.push("", "The owner's decisions:");
      for (const d of decisions) lines.push(`- ${d.id} (${d.slice || "no slice"}${d.from ? `, ${this.label(d.from)} asked` : ""}): ${truncate(d.question, 400)} → ${truncate(d.answer, 600)}`);
    }
    lines.push("", "If an open finding is now resolved, add a line “Resolved: L<n>” to your review.");
    return lines.join("\n");
  }

  /** The folders a read-only turn can't write to (see agents/readonly.mjs). */
  #readOnlyPaths(project) {
    if (!this.lockPaths.has(project.path)) this.lockPaths.set(project.path, readOnlyPaths(project.path));
    return this.lockPaths.get(project.path);
  }

  #catchUpItems(room, agent, hideKinds, focus, { own = false } = {}) {
    const events = this.events.get(room.id);
    const seen = new Set(room.seen[agent] ?? []);
    const items = [];
    const ids = [];
    const ownerIds = [];
    // The owner's notes to this agent, numbered N1, N2… so a building turn can say what became of each.
    const notes = [];
    const members = room.crew.members;
    // A discussion the owner forwarded to this agent as a change request: it reads it there, not twice.
    const forwarded = new Set(events.filter((e) => e.type === "owner" && e.kind === "change-request" && (e.to ?? []).includes(agent)).flatMap((e) => (e.forwarded ?? []).map((f) => f.id)));
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      if (forwarded.has(ev.id)) {
        ids.push(ev.id);
        continue;
      }
      if (ev.type === "owner" && ev.cancelled) {
        ids.push(ev.id);
        continue;
      }
      if (ev.type === "owner") {
        const to = ev.to ?? [];
        const toAll = members.every((m) => to.includes(m));
        const toMe = to.includes(agent);
        const others = to.filter((a) => a !== agent).map((a) => this.label(a));
        let heading = toAll
          ? "The owner (to everyone)"
          : toMe
            ? `The owner (to you${others.length ? ` and ${others.join(", ")}` : ""})`
            : `The owner (to ${others.join(", ")}; for your information)`;
        if (toMe && !ev.kind) {
          const note = { n: `N${notes.length + 1}`, id: ev.id, intent: ev.intent ?? noteIntent(ev.text), preview: truncate(firstLine(ev.text, 120), 120) };
          notes.push(note);
          heading += ` · note ${note.n}, ${note.intent}`;
        }
        // An answer to a question this agent asked: the question goes with it, so “Yes” says what it's yes to.
        for (const a of ev.answers ?? []) if (a.from === agent) heading += ` · answering your question “${truncate(a.question, 200)}”`;
        items.push({ heading, body: ev.text });
        ids.push(ev.id);
        if (toMe) ownerIds.push(ev.id);
      } else if (ev.type === "turn") {
        if (ev.agent === agent) {
          if (ev.state === "running") continue;
          // A new session doesn't know what this agent said here before: show it its own messages too.
          if (own && ev.state === "done" && ev.text?.trim()) items.push({ heading: `You (${this.label(agent)}), earlier in this room`, body: ev.text });
          ids.push(ev.id);
          continue;
        }
        if (ev.state === "running") continue;
        if (ev.state !== "done" || !ev.text?.trim()) {
          ids.push(ev.id);
          continue;
        }
        if (hideKinds.includes(ev.kind)) continue;
        const role = ev.role ? ` (${ev.role})` : "";
        const tag = focus === ev.id ? " ← the message you were asked about" : "";
        items.push({ heading: `${this.label(ev.agent)}${role}${tag}`, body: ev.text });
        ids.push(ev.id);
      } else if (ev.type === "system" && ev.forAgents) {
        items.push({ heading: "Toryo", body: ev.text });
        ids.push(ev.id);
      } else if (ev.type === "gate") {
        items.push({ heading: "Toryo checks", body: ev.results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.seconds}s)${r.ok ? "" : `\n${r.output}`}`).join("\n") });
        ids.push(ev.id);
      } else ids.push(ev.id);
    }
    return { items, ids, ownerIds, notes };
  }

  // ---------------------------------------------------------------- flow after each turn

  #afterTurn(room, ev, run) {
    const { req } = run;
    if (run.appLost) return this.#appLost(room, ev);
    if (run.uncertain) return this.#appUncertain(room);
    if (this.#stale(room, req)) {
      if (ev.state === "done") this.#system(room, `${this.label(req.agent)}'s turn from before has finished. It doesn't change what's running now.`);
      return;
    }
    if (run.requeue) {
      room.queue.unshift({ ...req, id: shortId("q"), instruction: `${prompts.interrupted()}\n\n${req.baseInstruction ?? req.instruction}` });
      return;
    }
    if (ev.state === "interrupted" || room.stopped) return;
    if (ev.state === "failed") {
      const tries = (req.tries ?? 0) + 1;
      // A hook that dropped the prompt will drop it again: that goes straight to the owner.
      if (tries < 2 && !ev.timedOut && !ev.dropped) {
        this.#system(room, `${this.label(req.agent)}'s turn failed (${firstLine(ev.error, 200)}). Retrying once.`, { level: "warn" });
        room.queue.unshift({ ...req, id: shortId("q"), tries });
        return;
      }
      const why = ev.timedOut ? `ran out of time (${room.settings.turnTimeoutMin ?? 240} min)` : `failed: ${firstLine(ev.error, 300)}`;
      this.#wait(room, { kind: "error", from: req.agent, question: `${this.label(req.agent)}'s turn ${why}`, recommendation: "Retry", retryReq: { ...req } });
      return;
    }
    // What the relay acts on: the turn's own status, or, for a reply to the owner's note that keeps its
    // earlier status (TORYO: REPLY), the turn that reply was for.
    // (A plan check asked for its verdict alone stays so, also when an answer to your note carries it on.)
    let outcome = { kind: req.kind, final: req.final, verdictOnly: req.verdictOnly || undefined, status: ev.status, detail: ev.detail, evId: ev.id };
    // A building turn for your notes carries on from the turn before it, unless it resubmitted (REVIEW, DONE, OWNER).
    // (note-reply: the same, for turns queued before 13 Oct.) An answer to your question always carries on as before.
    if (req.kind === "build-notes" || req.kind === "note-reply") outcome = ev.status && ev.status !== "REPLY" ? { ...req.after, status: ev.status, detail: ev.detail, evId: ev.id } : req.after;
    if (req.kind === "note-answer") {
      // A question answered beside the work: nothing to carry on, except more questions that came meanwhile.
      if (!req.after) {
        const asks = this.#notesDuring(room, req.agent, run).filter((n) => (n.intent ?? noteIntent(n.text)) === "ask");
        if (asks.length) this.#queueAnswer(room, req.agent, asks.map((n) => n.id));
        return;
      }
      outcome = req.after;
    }
    // The owner wrote to this agent while it worked.
    const notes = room.mode === "chat" ? [] : this.#notesDuring(room, req.agent, run);
    if (notes.length && this.#queueNotesTurn(room, req, outcome, notes)) return;
    return this.#carryOn(room, req, outcome, ev);
  }

  /** Move the relay on from a turn's outcome (its own, or, after a turn for your notes, the one it carried). */
  #carryOn(room, req, outcome, ev = null) {
    const actual = { ...req, kind: outcome.kind, final: outcome.final, verdictOnly: outcome.verdictOnly };
    const source = (ev && outcome.evId === ev.id ? ev : this.events.get(room.id).find((e) => e.id === outcome.evId)) ?? ev ?? {};
    if (FREE_KINDS.has(actual.kind)) return this.#afterChat(room, { ...source, status: outcome.status, detail: outcome.detail }, actual);
    if (room.mode === "build" && room.build) return this.#afterBuild(room, source, actual, outcome.status, outcome.detail ?? "");
    if (room.mode === "plan" && room.plan) return this.#afterPlan(room, source, actual, outcome.status, outcome.detail ?? "");
  }

  /** Notes the owner wrote to `agent` during this turn that the turn didn't carry. */
  #notesDuring(room, agent, run) {
    const carried = new Set(run.dispatch?.ids ?? []);
    // A followed Codex app turn started when the app was given it, not when Toryo reconnected.
    const marker = run.req.attach?.marker?.match(/^\[(?:Toryo|Foreman) (\S+)\]$/)?.[1];
    const since = run.req.attach?.since ?? (marker && this.events.get(room.id).find((e) => e.id === marker)?.startedAt) ?? run.startedAt;
    return this.events
      .get(room.id)
      .filter((e) => e.type === "owner" && !e.kind && !e.cancelled && (e.to ?? []).includes(agent) && !(e.deliveredTo ?? []).includes(agent) && !carried.has(e.id) && e.at >= since);
  }

  /**
   * Notes the owner sent while an agent worked. A builder gets a building turn for them ("Building: your notes"),
   * then the relay carries on as it would have. Anyone else answers only questions (Ask), in a short read-only turn
   * ("Answering your question"), after which the room goes back to exactly what it was doing; instructions (Tell)
   * go with its next turn. Returns whether a turn was queued.
   */
  #queueNotesTurn(room, req, outcome, notes) {
    const building = room.mode === "build" && room.build && (BUILDER_KINDS.has(outcome.kind) || outcome.kind === "build-notes");
    if (building) {
      const next = outcome.status === "REVIEW" ? "checks, then review" : outcome.status === "DONE" ? "checks, then the final review" : outcome.status === "OWNER" ? "its question waits for the owner" : "";
      room.queue.unshift({ id: shortId("q"), agent: req.agent, kind: "build-notes", access: "write", flow: req.flow, final: outcome.final, after: outcome, queuedAt: this.#stamp(), forNotes: true, notes: notes.map((n) => n.id), instruction: prompts.buildNotes({ status: outcome.status, detail: outcome.detail, next }) });
      this.#system(room, `${this.label(req.agent)} builds your note${notes.length > 1 ? "s" : ""} in before the relay moves on.`);
      return true;
    }
    const asks = notes.filter((n) => (n.intent ?? noteIntent(n.text)) === "ask");
    if (!asks.length) return false;
    room.queue.unshift({ id: shortId("q"), agent: req.agent, kind: "note-answer", access: "read", parallel: req.parallel, hideKinds: req.hideKinds, flow: req.flow, after: outcome, queuedAt: this.#stamp(), forNotes: true, notes: asks.map((n) => n.id), instruction: prompts.noteAnswer() });
    this.#system(room, `${this.label(req.agent)} answers your question before the relay moves on.`);
    return true;
  }

  /** A short read-only turn, beside the work, in which `agent` answers the owner's questions (`noteIds`). */
  #queueAnswer(room, agent, ids) {
    this.#enqueue(room, { agent, kind: "note-answer", access: "read", parallel: true, whileWaiting: true, forNotes: true, notes: ids, instruction: prompts.noteAnswer() });
  }

  /**
   * What became of each note a turn carried: a building turn's own lines ("N1: done — …", "scheduled for …",
   * "declined — …"), and a question answered in a short turn. Shown on each note.
   */
  #noteOutcomes(room, req, run, ev) {
    const notes = run.dispatch?.notes ?? [];
    if (!notes.length) return;
    const events = this.events.get(room.id);
    const text = String(ev.text ?? "");
    for (const n of notes) {
      const o = events.find((e) => e.id === n.id);
      if (!o) continue;
      let outcome = null;
      if (run.dispatch.acks) {
        const m = text.match(new RegExp(`^\\s*(?:[-*]\\s*)?\\**${n.n}\\**\\s*[:.)\\-–—]\\s*\\**(done|scheduled|declined|answered)\\**\\b[\\s:,.\\-–—]*(.*)$`, "im"));
        if (m) outcome = { status: m[1].toLowerCase(), detail: truncate(m[2].trim(), 200) };
      } else if (n.intent === "ask" && (req.kind === "note-answer" || FREE_KINDS.has(req.kind))) outcome = { status: "answered", detail: "" };
      if (outcome) this.#patch(room, o, { outcomes: { ...o.outcomes, [req.agent]: { ...outcome, turnId: ev.id } } });
    }
  }

  /**
   * (Turns queued before 13 Oct: a short turn to answer the owner's note before the relay moves on.)
   */
  #queueNoteReply(room, req, outcome, notes) {
    const role = BUILDER_KINDS.has(outcome.kind) ? "builder" : REVIEW_KINDS.has(outcome.kind) ? "reviewer" : "other";
    room.queue.unshift({
      id: shortId("q"),
      queuedAt: this.#stamp(),
      agent: req.agent,
      kind: "note-reply",
      access: req.access,
      parallel: req.parallel,
      hideKinds: req.hideKinds,
      flow: req.flow,
      after: outcome,
      instruction: prompts.noteReply({ role, canWrite: req.access === "write", status: outcome.status, detail: outcome.detail }),
    });
    this.#system(room, `${this.label(req.agent)} answers your note${notes.length > 1 ? "s" : ""} before the relay moves on.`);
  }

  /** Mark notes this agent has read as answered by this turn. */
  #markReplies(room, agent, turnId) {
    for (const o of this.events.get(room.id))
      if (o.type === "owner" && o.readBy?.[agent] && !o.repliedBy?.[agent]) this.#patch(room, o, { repliedBy: { ...o.repliedBy, [agent]: turnId } });
  }

  /**
   * A turn held since it began (a hold, Pause everything) that never reached its agent: back to the front of the
   * queue as it was (same id, same place in the order), its messages still unread, and on when the hold lifts.
   */
  #deferTurn(room, run, ev, reasons) {
    this.running.delete(run.turnId);
    if (run.sessionBefore === null) delete room.sessions[run.agent];
    else if (run.sessionBefore !== undefined) room.sessions[run.agent] = run.sessionBefore;
    room.queue.unshift(run.req);
    this.#patch(room, ev, { state: "deferred", endedAt: nowIso(), error: `Not sent: ${reasons.join("; ") || "held"}. It goes when that ends.` });
    this.#save(room);
    this.#schedule();
  }

  /** Toryo can't tell whether the Codex app got a message: it's watched for (the thread kept), never sent again by itself. */
  #appUncertain(room) {
    this.#system(
      room,
      "Toryo couldn't tell whether the Codex app got its message. It's watching the thread for it and sends nothing else there meanwhile: if the app sends it, Toryo follows that turn as usual. If you know it never arrived, choose “Stop waiting for it” (or press Stop twice) and send it again.",
      { level: "warn" },
    );
    this.#notify("The Codex app may not have Toryo's message", `“${room.title}”: Toryo is watching the thread for it.`);
  }

  /** Following the Codex app's turn failed. The turn stays kept (nothing new goes to the app); you choose what happens. */
  #appLost(room, ev) {
    if (room.appTurn) room.appTurn.lost = true;
    if (this.#allWaiting(room).some((w) => w.kind === "app-lost")) return;
    this.#wait(room, {
      kind: "app-lost",
      from: "codexapp",
      question: `Toryo lost track of the Codex app's turn (${firstLine(ev?.error ?? "unknown error", 200)}). It may still be working in the app, so Toryo sends it nothing else until you decide.`,
      recommendation: "Follow it again",
    });
  }

  #afterChat(room, ev, req) {
    if (ev.status === "OWNER") {
      // Asked once, even if this outcome is acted on again after a restart.
      const asked = this.events.get(room.id).find((e) => e.type === "question" && e.kind === "chat-owner" && e.turnId === ev.id);
      const q = asked ?? this.#append(room, { type: "question", kind: "chat-owner", from: req.agent, question: questionIn(ev.detail, ev.text), recommendation: recommendationIn(ev.text, ev.detail), open: true, turnId: ev.id });
      if (q.open && !(room.openChat ??= []).includes(q.id)) room.openChat.push(q.id);
      if (!asked) this.#notify(`${this.label(req.agent)} has a question`, ev.detail || firstLine(ev.text));
    }
    const d = room.discuss;
    if (!d || !d.pending.includes(req.agent)) return;
    d.pending = d.pending.filter((a) => a !== req.agent);
    d.statuses[req.agent] = { status: ev.status, detail: ev.detail };
    if (d.pending.length) return;
    const agreed = d.round > 0 && d.participants.every((a) => d.statuses[a]?.status === "AGREE");
    if (agreed) {
      this.#system(room, `${d.participants.map((a) => this.label(a)).join(" and ")} agree after ${d.round} discussion round${d.round > 1 ? "s" : ""}.`);
      room.discuss = null;
      this.#notify("Discussion settled", "The agents agree. Have a look.");
      return;
    }
    if (d.round >= d.rounds) {
      const open = d.participants.map((a) => d.statuses[a]).filter((s) => s?.status === "DISAGREE" && s.detail).map((s) => s.detail);
      this.#system(room, `Discussion ended after ${d.round} round${d.round === 1 ? "" : "s"}.${open.length ? ` Still open: ${open.join("; ")}` : ""}`);
      room.discuss = null;
      this.#notify("Discussion ended", open.length ? `Still open: ${open[0]}` : "Have a look.");
      return;
    }
    d.round++;
    d.pending = [...d.participants];
    d.statuses = {};
    for (const agent of d.participants)
      this.#enqueue(room, {
        agent,
        kind: "discuss",
        access: "read",
        parallel: true,
        whileWaiting: true,
        instruction: prompts.discuss({ round: d.round, rounds: d.rounds, others: d.participants.filter((a) => a !== agent).map((a) => this.label(a)) }),
      });
  }

  #afterBuild(room, ev, req, status, detail) {
    const b = room.build;
    // A turn is handled by the role it was queued for, whatever the crew is now.
    if (BUILDER_KINDS.has(req.kind)) {
      const B = this.label(req.agent);
      if (status === "REVIEW") {
        const [slice, handoff] = detail.split("|").map((s) => s.trim());
        if (slice && slice !== b.slice) {
          if (b.slice && !b.approved.includes(b.slice)) b.round = 0;
          b.slice = slice;
        }
        if (handoff) b.handoff = handoff;
        b.nudges = 0;
        // Fixing the checks that ran before a final review (or answering you about them) leads back to that final review.
        b.final = Boolean(req.final);
        return this.#checksThenReview(room, b.final);
      }
      if (status === "DONE") {
        b.nudges = 0;
        b.final = true;
        this.#system(room, `${B} reports the plan is done. ${this.label(room.crew.reviewer)} does a final review.`);
        return this.#checksThenReview(room, true);
      }
      if (status === "OWNER")
        return this.#wait(room, { kind: "build-owner", from: req.agent, question: questionIn(detail, ev.text), recommendation: recommendationIn(ev.text, detail) });
      if (b.nudges < room.settings.maxNudges) {
        b.nudges++;
        this.#system(room, `${B} stopped without a status line. Nudge ${b.nudges} of ${room.settings.maxNudges}: keep going through the plan.`);
        return this.#enqueueBuilder(room, "build-nudge", prompts.buildNudge({ count: b.nudges, max: room.settings.maxNudges }));
      }
      return this.#wait(room, { kind: "nudges", from: req.agent, question: `${B} stopped ${b.nudges + 1} times without saying it was ready for review. What should it do?`, recommendation: "Continue with the plan" });
    }
    if (REVIEW_KINDS.has(req.kind)) {
      const R = this.label(req.agent);
      // A review that will ask again for its status (below) counts once, when it has one.
      if (status || !(req.kind === "review" || req.kind === "review-answer")) this.#ledgerFromReview(room, ev, req, status);
      if (status === "APPROVED") {
        // Only an approval of the final review itself completes the plan.
        if (req.final) {
          room.done = true;
          this.#system(room, `${R} approved the final review. The plan is complete.`, { forAgents: true });
          this.#notify("Plan complete", `${R} approved the final review in “${room.title}”.`);
          return;
        }
        const rounds = b.round + 1;
        if (b.slice) b.approved.push(b.slice);
        const work = sliceTimes(this.events.get(room.id) ?? []).current;
        this.#system(room, `${b.slice ? `“${b.slice}”` : "This round"} approved after ${rounds} round${rounds === 1 ? "" : "s"}${work ? ` (${shortDuration(work.active)} of work)` : ""}.`, { forAgents: true });
        b.round = 0;
        if (room.settings.autoContinue) {
          if (!room.swapPending) this.#system(room, `${this.label(room.crew.builder)} continues with the next slice.`);
          return this.#enqueueBuilder(room, "build-next", prompts.buildNext({ reviewer: R, slice: b.slice }));
        }
        return this.#wait(room, { kind: "slice-approved", from: room.crew.builder, question: `${b.slice || "The slice"} is approved. Continue to the next slice?`, recommendation: "Continue" });
      }
      if (status === "CHANGES") return this.#changesRequested(room, R);
      if (status === "OWNER")
        return this.#wait(room, { kind: "review-owner", from: req.agent, final: req.final, question: questionIn(detail, ev.text), recommendation: recommendationIn(ev.text, detail) });
      if (req.kind === "review" || req.kind === "review-answer")
        return this.#enqueue(room, { agent: req.agent, kind: "review-status", access: "read", final: req.final, instruction: prompts.statusOnly({ allowed: ["TORYO: APPROVED", "TORYO: CHANGES", "TORYO: OWNER <question>"] }) });
      this.#system(room, `${R} gave no status; treating its review as changes requested.`, { level: "warn" });
      return this.#changesRequested(room, R);
    }
  }

  /** The reviewer asked for changes: another round, within the room's limit. */
  #changesRequested(room, R) {
    const b = room.build;
    b.round++;
    b.final = false;
    if (b.round >= room.settings.maxRounds) {
      const B = this.label(room.crew.builder);
      return this.#wait(room, { kind: "max-rounds", from: room.crew.builder, question: `${B} and ${R} have gone ${b.round} rounds on ${b.slice || "this slice"}. How should ${B} proceed?`, recommendation: `Address ${R}'s latest findings and resubmit` });
    }
    return this.#enqueueBuilder(room, "build-fix", prompts.buildFix({ reviewer: R, round: b.round, maxRounds: room.settings.maxRounds }));
  }

  #queueReview(room, final) {
    const b = room.build;
    const reviewer = room.crew.reviewer;
    // A fresh reviewer for each new slice (a room setting, on unless you turn it off), and always for the final review.
    if (canStartFresh(reviewer)) {
      if (final) (room.fresh ??= {})[reviewer] = "final";
      else if (room.settings.freshReviewer !== false && b.reviewedSlice !== b.slice && room.sessions[reviewer]) (room.fresh ??= {})[reviewer] = "new-slice";
    }
    b.reviewedSlice = b.slice;
    this.#enqueue(room, {
      agent: room.crew.reviewer,
      kind: "review",
      access: "read",
      final,
      instruction: prompts.review({ builder: this.label(room.crew.builder), snapshot: "{{SNAPSHOT}}", round: b.round + 1, final }),
    });
  }

  /** Review next, after the project's checks if it has any. The checks are queued work, so a restart runs them again. */
  #checksThenReview(room, final) {
    const project = this.project(room.projectId);
    if (room.settings.gates !== false && project.gates?.some((g) => g.command?.trim())) return this.#enqueue(room, { agent: "toryo", kind: "gates", access: "read", final });
    return this.#queueReview(room, final);
  }

  #startChecks(room, req) {
    const project = this.project(room.projectId);
    const run = { roomId: room.id, agent: "toryo", req, controller: new AbortController(), abandon: new AbortController(), activity: [], startedAt: nowIso(), turnId: shortId("g"), phase: "checks" };
    run.workingAt = run.startedAt;
    this.running.set(run.turnId, run);
    // Kept in the room until the checks finish, so a restart in between runs them again.
    room.activeGate = { ...req };
    // Checks switched off since this was queued: none run, and the work goes straight to review.
    const gates = room.settings.gates === false ? [] : (project.gates ?? []).filter((g) => g.command?.trim());
    if (gates.length) this.#system(room, `Running checks before ${req.final ? "the final review" : "review"}: ${gates.map((g) => g.name || g.command).join(", ")}.`);
    this.#afterChecks(room, run, { ...project, gates }).catch((error) => {
      console.error("[toryo] checks crashed:", error);
      this.running.delete(run.turnId);
      room.activeGate = null;
      if (!this.shuttingDown && !this.#stale(room, req))
        this.#wait(room, { kind: "error", from: null, question: `Toryo's checks crashed: ${firstLine(error?.message ?? error)}`, recommendation: "Retry", retryReq: { ...req } });
      this.#save(room);
      this.#pump(room);
    });
    return run;
  }

  async #afterChecks(room, run, project) {
    const { req } = run;
    let results = [];
    try {
      results = await runGates(project, {
        signal: run.controller.signal,
        onActivity: (item) => this.emit("activity", { roomId: room.id, turnId: run.turnId, agent: "toryo", item: { ...item, at: nowIso() } }),
      });
    } finally {
      this.running.delete(run.turnId);
    }
    if (this.shuttingDown) return; // still recorded as running: the next start runs the checks again
    room.activeGate = null;
    const b = room.build;
    if (results.cancelled || room.stopped || this.#stale(room, req) || !b) {
      this.#save(room);
      return this.#pump(room);
    }
    if (results.length) this.#append(room, { type: "gate", results });
    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      b.gateRetries = 0;
      this.#queueReview(room, Boolean(req.final));
    } else if (b.gateRetries < 2) {
      b.gateRetries++;
      this.#enqueueBuilder(room, "build-gate", prompts.buildGate({ failures: failed.map((f) => `### ${f.name} (${f.timedOut ? "timed out" : `exit ${f.code}`})\n\`\`\`\n${f.output}\n\`\`\``).join("\n\n") }), { final: req.final });
    } else {
      b.gateRetries = 0;
      this.#wait(room, { kind: "gates", from: room.crew.builder, final: req.final, question: `Checks still fail after two fixes: ${failed.map((f) => f.name).join(", ")}. What should happen?`, recommendation: "Send it to review anyway and note the failing checks" });
    }
    this.#save(room);
    this.#pump(room);
  }

  #afterPlan(room, ev, req, status, detail) {
    const plan = room.plan;
    const others = (a) => plan.participants.filter((p) => p !== a);
    if (status === "OWNER") {
      return this.#wait(room, { kind: "plan-owner", from: req.agent, question: questionIn(detail, ev.text), recommendation: recommendationIn(ev.text, detail), retryReq: { ...req } });
    }
    // A check that ends without a verdict (no status line, or another one) is asked once for it alone, and stays open.
    const verdict = status === "APPROVED" || status === "CHANGES";
    if (req.kind === "plan-check" && !verdict && !req.verdictOnly)
      return this.#enqueue(room, { agent: req.agent, kind: "plan-check", access: "read", parallel: true, verdictOnly: true, instruction: prompts.planVerdict() });
    if (PLAN_PARALLEL.has(req.kind)) {
      plan.pending = plan.pending.filter((a) => a !== req.agent);
      // Still none after that: the check is recorded as having no verdict, never as an approval.
      if (req.kind === "plan-check") plan.checks[req.agent] = verdict ? status : "NONE";
      if (plan.pending.length) return;
      if (req.kind === "plan-proposal") {
        if (plan.participants.length < 2) return this.#checkpoint(room);
        plan.phase = "critiques";
        plan.pending = [...plan.participants];
        this.#system(room, "Proposals are in. Each planner now critiques the others.");
        for (const agent of plan.participants)
          this.#enqueue(room, { agent, kind: "plan-critique", access: "read", parallel: true, instruction: prompts.planCritique() });
        return;
      }
      if (req.kind === "plan-critique") return this.#checkpoint(room);
      if (req.kind === "plan-check") {
        // Every check is in. Findings go to the author, who addresses them once; otherwise the plan is ready again.
        const cycle = plan.cycle ?? { why: "written", checkers: Object.keys(plan.checks) };
        const changed = cycle.hash != null && this.#planHash(room) !== cycle.hash;
        if (changed) this.#system(room, `The plan file changed while ${this.#names(cycle.checkers)} checked it, so the check is about an earlier version.`);
        const asking = cycle.checkers.filter((a) => plan.checks[a] === "CHANGES");
        const silent = cycle.checkers.filter((a) => plan.checks[a] !== "CHANGES" && plan.checks[a] !== "APPROVED");
        if (asking.length) {
          plan.phase = "revision";
          plan.cycle = { ...cycle, stage: "address", asking, silent, stale: changed || undefined };
          return this.#enqueue(room, { agent: plan.synthesizer, kind: "plan-revise", access: "write", instruction: prompts.planAddress({ planPath: plan.planPath, checkers: this.#names(asking) }) });
        }
        // Approved only when every checker said so.
        const approved = cycle.checkers.filter((a) => plan.checks[a] === "APPROVED");
        plan.review = { revision: plan.revision, by: cycle.checkers, approved, silent, verdict: silent.length ? "incomplete" : "approved", stale: changed || undefined };
        plan.cycle = null;
        return this.#planReady(room);
      }
    }
    if (req.kind === "plan-synthesis" || req.kind === "plan-revise") {
      this.#adoptPlanPath(room, detail);
      plan.revision = (plan.revision ?? 0) + 1;
    }
    if (req.kind === "plan-synthesis") {
      plan.review = null;
      const checkers = others(plan.synthesizer);
      if (checkers.length) return this.#startPlanChecks(room, "written", checkers);
      plan.review = { revision: plan.revision, by: [], verdict: "none" };
      return this.#planReady(room);
    }
    if (req.kind === "plan-revise") {
      const cycle = plan.cycle;
      if (cycle?.stage === "revise") {
        // After your change: the other planners check the revision once, if the room says so.
        if (room.settings.recheckAfterChanges !== false && cycle.checkers.length) return this.#startPlanChecks(room, cycle.why, cycle.checkers);
        plan.review = { revision: plan.revision, by: [], verdict: cycle.checkers.length ? "off" : "none" };
      } else if (cycle?.stage === "address") {
        // The author answered the check: ready again, with no further check (the cycle is bounded).
        plan.review = { revision: plan.revision, by: cycle.checkers, asking: cycle.asking, silent: cycle.silent, verdict: "addressed", stale: cycle.stale };
      } else plan.review = { revision: plan.revision, by: [], verdict: "unchecked" };
      plan.cycle = null;
      return this.#planReady(room);
    }
  }

  /** Agents' names, in words: "Claude", "Claude and Cursor". */
  #names(agents) {
    return (agents ?? []).map((a) => this.label(a)).join(" and ");
  }

  /** The planners who can check the plan: all but its author. */
  #checkers(room) {
    const plan = room.plan;
    return plan.participants.filter((p) => p !== plan.synthesizer);
  }

  /** A fingerprint of the plan file, to tell whether it changed while it was being checked. */
  #planHash(room) {
    try {
      return createHash("sha256").update(this.readProjectFile(room.projectId, room.plan.planPath).content).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  }

  /**
   * The other planners check the plan, read-only, all at once. Their findings go to the author, who addresses them once
   * (no check of that), and the plan is ready again. `why`: it was just written; you asked for changes, or forwarded
   * a discussion (a re-check of the revision); or you asked for a check.
   */
  #startPlanChecks(room, why, checkers) {
    const plan = room.plan;
    plan.phase = "check";
    plan.cycle = { why, stage: "check", checkers, hash: this.#planHash(room) };
    plan.pending = [...checkers];
    plan.checks = {};
    const author = this.label(plan.synthesizer);
    const instruction = why === "owner" || why === "forwarded" ? prompts.planRecheck({ author, planPath: plan.planPath }) : prompts.planCheck({ author, planPath: plan.planPath });
    for (const agent of checkers) this.#enqueue(room, { agent, kind: "plan-check", access: "read", parallel: true, instruction });
  }

  /** You asked for changes to a ready plan (or forwarded a discussion as a change request): the author revises first. */
  #planChange(room, why) {
    const plan = room.plan;
    plan.phase = "revision";
    plan.cycle = { why, stage: "revise", checkers: this.#checkers(room) };
    this.#enqueue(room, { agent: plan.synthesizer, kind: "plan-revise", access: "write", instruction: prompts.planChange({ planPath: plan.planPath }) });
  }

  /** The Ready card's question, if it's the one named: actions on an older card are refused. */
  #readyQuestion(room, questionId) {
    if (room.mode !== "plan" || !room.plan) throw new UserError("This room has no planning round.");
    const w = this.#allWaiting(room).find((x) => x.kind === "plan-ready" && (!questionId || x.eventId === questionId));
    if (!w) throw new UserError(questionId ? "That plan has moved on: it's being revised or checked, or a newer version is ready." : "The plan isn't ready.", 409);
    return w;
  }

  /**
   * The discussion you forward to the author: the messages named (your notes and answers, and other planners'
   * replies), or else your exchange with one planner since the plan was ready, your answers to its questions included.
   */
  #discussion(room, w, { agent, eventIds }) {
    const events = this.events.get(room.id);
    const author = room.plan.synthesizer;
    // Your notes and your answers (to a planner's question), and the other planners' finished replies.
    const forwardable = (e) => (e.type === "owner" && (!e.kind || e.kind === "answer") && !e.cancelled) || (e.type === "turn" && e.state === "done" && e.agent !== author && Boolean(e.text?.trim()));
    let picked;
    if (eventIds?.length) {
      picked = [...new Set(eventIds)].map((id) => events.find((e) => e.id === id));
      if (picked.some((e) => !e)) throw new UserError("Some of those messages aren't in this room.");
      if (!picked.every(forwardable)) throw new UserError("Only your notes and answers, and the other planners' replies, can be forwarded to the author.");
      picked.sort((a, b) => events.indexOf(a) - events.indexOf(b));
    } else {
      if (!agent || agent === author || !room.plan.participants.includes(agent)) throw new UserError("Say which planner's discussion to forward: one of the planners other than the author.");
      const since = events.findIndex((e) => e.id === w.eventId);
      picked = events.filter((e, i) => i > since && forwardable(e) && (e.type === "turn" ? e.agent === agent : (e.to ?? []).includes(agent)));
    }
    if (!picked.length) throw new UserError(`There's nothing to forward: no discussion with ${this.label(agent)} since the plan was ready.`);
    return picked;
  }

  /** How the plan was last checked, in a sentence for the Ready card: who checked which version, and what came of it. */
  #reviewSentence(room) {
    const r = room.plan.review;
    const earlier = r?.stale ? " That check was of an earlier version: the plan file changed while it ran." : "";
    // Checkers who gave no verdict, even when asked for it alone: said as it is, never counted as approving.
    const silent = r?.silent?.length ? ` ${this.#names(r.silent)} checked it but didn't say whether ${r.silent.length > 1 ? "they approve" : "it approves"}.` : "";
    switch (r?.verdict) {
      case "approved":
        return `${this.#names(r.by)} checked it and approved.${earlier}`;
      case "incomplete":
        return `${r.approved?.length ? `${this.#names(r.approved)} checked it and approved.` : ""}${silent}${earlier}`.trim();
      case "addressed":
        return `${this.#names(r.asking ?? r.by)} asked for changes, and ${this.label(room.plan.synthesizer)} addressed them.${silent}${earlier}`;
      case "off":
        return "Nobody has checked it since your change: Re-check after changes is off in this room.";
      case "none":
        return "There's no other planner here to check it.";
      case "stopped":
        return `The ${r.stage === "check" ? "check" : "revision"} was stopped before it finished.`;
      default:
        return "Nobody has checked it since it last changed.";
    }
  }

  /** If the author wrote the plan somewhere else and says so in its status line, follow it. */
  #adoptPlanPath(room, detail) {
    const plan = room.plan;
    const named = String(detail ?? "").split(/\s+/).find((w) => /\.(md|mdx|markdown|txt)$/i.test(w));
    if (!named || named === plan.planPath) return;
    try {
      this.readProjectFile(room.projectId, plan.planPath);
      return; // the agreed path exists; keep it
    } catch {
      /* missing: try the path the agent named */
    }
    try {
      this.readProjectFile(room.projectId, named);
      this.#system(room, `${this.label(plan.synthesizer)} wrote the plan to ${named}; using that path.`);
      plan.planPath = named.replace(/^\.\//, "");
    } catch {
      /* neither exists; the check step will notice */
    }
  }

  #checkpoint(room) {
    const plan = room.plan;
    plan.phase = "checkpoint";
    const texts = this.events.get(room.id).filter((e) => e.type === "turn" && (e.kind === "plan-proposal" || e.kind === "plan-critique") && e.state === "done" && e.startedAt >= plan.startedAt);
    const questions = [];
    for (const t of texts) for (const q of parseQuestions(t.text)) questions.push({ ...q, from: t.agent });
    this.#wait(room, {
      kind: "plan-checkpoint",
      from: null,
      question: "Proposals and critiques are in. Settle the open questions and choose who writes the plan.",
      questions,
      recommendation: "",
    });
  }

  #planReady(room) {
    const plan = room.plan;
    plan.phase = "ready";
    const checkers = this.#checkers(room);
    this.#wait(room, {
      kind: "plan-ready",
      from: plan.synthesizer,
      question: `The plan is written at ${plan.planPath}. ${this.#reviewSentence(room)} Start building with it, ${checkers.length ? `ask ${this.#names(checkers)} to check it, ` : ""}or tell ${this.label(plan.synthesizer)} what to change.`,
      recommendation: "Start building",
      // Accepting the recommendation starts the build; a written answer asks for changes.
      action: "start-build",
      planPath: plan.planPath,
      checkers,
      revision: plan.revision,
    });
  }

  #wait(room, w) {
    // Acting on a turn's outcome again after a restart: the question it asked may already be in the timeline. Ask once.
    const source = this.outcomeSource;
    const asked = source && this.events.get(room.id).find((e) => e.type === "question" && e.open && e.source === source && e.kind === w.kind);
    const q = asked ?? this.#append(room, { type: "question", kind: w.kind, from: w.from, question: w.question, recommendation: w.recommendation ?? "", questions: w.questions, planPath: w.planPath, checkers: w.checkers, revision: w.revision, open: true, source: source ?? undefined });
    // Questions never replace each other (two planners can ask at once): later ones wait their turn.
    if (![room.waiting, ...(room.waitingQueue ?? [])].some((x) => x?.eventId === q.id)) {
      if (room.waiting) (room.waitingQueue ??= []).push({ ...w, eventId: q.id });
      else room.waiting = { ...w, eventId: q.id };
    }
    this.#save(room);
    if (!asked) this.#notify(w.from ? `${this.label(w.from)} needs your answer` : "Toryo needs you", w.question);
  }

  // ---------------------------------------------------------------- events & persistence

  #append(room, ev) {
    const event = { id: ev.id ?? shortId("e"), at: nowIso(), ...ev };
    this.events.get(room.id).push(event);
    this.store.appendEvent(room.id, event);
    this.#noteNotable(room, event);
    room.updatedAt = event.at;
    this.emit("event", { roomId: room.id, event });
    return event;
  }

  #patch(room, ev, patch, emit = true) {
    Object.assign(ev, patch);
    this.store.appendEvent(room.id, { id: ev.id, ...patch });
    this.#noteNotable(room, ev);
    room.updatedAt = nowIso();
    if (emit) this.emit("event", { roomId: room.id, event: ev });
  }

  #system(room, text, { forAgents = false, level = "info" } = {}) {
    return this.#append(room, { type: "system", text, forAgents, level });
  }

  #notify(title, body) {
    try {
      this.notifier?.send(title, truncate(body, 240));
    } catch {
      /* best effort */
    }
    this.emit("notify", { title, body });
  }

  #save(room) {
    // Acting on a turn's outcome: one save at the end (#actOnOutcome).
    if (this.outcomeRooms.has(room)) return;
    room.updatedAt ??= nowIso();
    this.store.saveRoom(room);
    this.emit("room", this.summary(room));
  }

  #room(id) {
    const room = this.rooms.get(id);
    if (!room) throw new UserError("Unknown room.", 404);
    return room;
  }
}

const outside = (rel) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** The order requests start in across rooms: the one queued first, then by room and place in its queue, so ties are stable. */
const queueOrder = (req, room) => `${req.queuedAt ?? ""}|${room.id}|${String(room.queue.indexOf(req)).padStart(4, "0")}`;

/** The notes a queued turn was queued for, or carries along (`note` is how turns queued before 13 Oct said it). */
const noteIds = (q) => q.notes ?? (q.note ? [q.note] : []);

/** Tie a note to a queued turn (or just bring the turn to the current form): a turn queued with an old `note` was queued for it. */
function tieNote(q, id) {
  if (q.note) {
    q.forNotes = true;
    q.notes = noteIds(q);
    delete q.note;
  }
  q.notes = [...noteIds(q), ...(id ? [id] : [])];
}

/** The Codex app's session is its thread, which the owner chooses; it can't be started fresh by Toryo. */
const canStartFresh = (agent) => agent !== "codexapp";

function defaultTitle(mode, text) {
  const t = firstLine(text ?? "", 60);
  if (t) return t;
  return mode === "build" ? "Build" : mode === "plan" ? "Planning" : "Conversation";
}

/** Which question an answer of yours answers, kept with it, so the agent reads your answer next to its question. */
function answerOf(q) {
  return { id: q.eventId ?? q.id, from: q.from ?? null, question: q.question };
}

/** The recommendation that comes with a question: in its status line first, else in the message. */
function recommendationIn(text, detail = "") {
  const rec = splitRecommendation(detail).recommendation || splitRecommendation(text).recommendation;
  return truncate(rec, 300);
}

/** A question as the agent asked it, without the recommendation wrapped into it ("Do X (Recommended: Y)?" → "Do X?"). */
function questionIn(detail, text) {
  return (detail ? splitRecommendation(detail).question : "") || firstLine(text);
}

/** A window named in a request ("weekly", "5-hour"), or a refusal saying how to name one. */
function guardWindow(name) {
  try {
    return parseGuardWindow(name);
  } catch (error) {
    throw new UserError(error.message);
  }
}

function sanitizeSettings(s) {
  const out = {};
  if (s.maxRounds != null) out.maxRounds = clamp(Number(s.maxRounds), 1, 20);
  if (s.maxNudges != null) out.maxNudges = clamp(Number(s.maxNudges), 0, 10);
  if (s.turnTimeoutMin != null) out.turnTimeoutMin = clamp(Number(s.turnTimeoutMin), 5, 24 * 60);
  for (const k of ["autoContinue", "snapshots", "gates", "freshReviewer", "recheckAfterChanges"]) if (k in s) out[k] = Boolean(s[k]);
  return out;
}

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
