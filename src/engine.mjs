import { EventEmitter } from "node:events";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ADAPTERS, detectAgents } from "./agents/index.mjs";
import { lastAppMessage } from "./agents/codexapp.mjs";
import { readOnlyPaths, readOnlySupport } from "./agents/readonly.mjs";
import { runGates } from "./gates.mjs";
import { parseSlices, shortDuration, sliceMatches, sliceTimes } from "./plan.mjs";
import { catchUp, parseQuestions, parseStatus, preamble, prompts, rulesKey, rulesUpdate, stripStatus } from "./protocol.mjs";
import { UsageBook, normalizeGroups } from "./usage.mjs";
import { defaultDesk, holdAgents, holdKey, holdLabel, readDesk } from "./desk.mjs";
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
};

const BUILDER_KINDS = new Set(["build", "build-fix", "build-next", "build-nudge", "build-answer", "build-gate", "build-note"]);
const REVIEW_KINDS = new Set(["review", "review-status", "review-answer"]);
const PLAN_PARALLEL = new Set(["plan-proposal", "plan-critique", "plan-check"]);
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
  constructor({ store, snapshots, notifier, adapters = ADAPTERS, usagePollMs = 5 * 60_000 }) {
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
    // Plan usage, as the agents last reported it (src/usage.mjs). Codex's is re-read from its logs every `usagePollMs`.
    this.usage = new UsageBook();
    this.usagePollMs = usagePollMs;
    this.usageTimer = null;
    // Desk-wide controls (src/desk.mjs), and a problem with them: a file Toryo can't read, or one it couldn't save.
    // While there's a problem, nothing new starts.
    this.desk = defaultDesk();
    this.deskProblem = null;
    this.queueSeq = 0;
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
    this.store.saveConfig(this.config);
    for (const id of this.store.listRoomIds()) {
      const room = this.store.loadRoom(id);
      if (!room || room.archived) continue;
      this.rooms.set(id, room);
      this.events.set(id, this.store.loadEvents(id));
      this.#recover(room);
    }
    if (detect) await this.refreshAgents();
    if (this.usagePollMs > 0 && !this.usageTimer) {
      this.usageTimer = setInterval(() => this.refreshUsage().catch(() => {}), this.usagePollMs);
      this.usageTimer.unref?.();
    }
    // Rooms that weren't paused pick up where they were (for example, following the Codex app's turn).
    this.#pumpAll();
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
  #appTurnFrom(room, followReq) {
    return { marker: followReq.attach.marker, thread: room.sessions.codexapp ?? null, req: followReq, lost: false };
  }

  /** Stop for a restart. Running turns stay marked as running, so the next start offers them again. */
  shutdown() {
    this.shuttingDown = true;
    clearInterval(this.usageTimer);
    this.usageTimer = null;
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
    const { changed, fresh } = this.usage.accept(agent, reading, { receivedAt: nowIso(), source });
    if (changed && this.usage.writable)
      try {
        this.store.writeJson(this.store.path("limits.json"), this.usage.toJSON());
      } catch {
        /* usage is informational */
      }
    return Boolean(fresh);
  }

  // ---------------------------------------------------------------- desk-wide controls

  #loadDesk() {
    const path = this.store.path("desk.json");
    const read = readDesk(path, Object.keys(this.adapters));
    this.desk = read.desk ?? defaultDesk();
    this.deskProblem = read.problem ? { kind: "unreadable", text: read.problem, at: nowIso() } : null;
    if (read.missing)
      try {
        this.store.writeJson(path, this.desk);
      } catch (error) {
        this.deskProblem = { kind: "unsaved", text: `Toryo couldn't save its desk controls (${path}): ${error.code ?? error.message}.`, at: nowIso() };
      }
    this.usage.groups = normalizeGroups(this.desk.groups);
  }

  /** The desk's controls, for the page, the terminal and the phone. */
  deskView() {
    const d = this.desk;
    return {
      paused: d.paused,
      holds: Object.entries(d.holds).map(([key, h]) => ({ key, agents: h.agents, at: h.at, label: holdLabel(key, (a) => this.label(a)) })),
      groups: { ...d.groups },
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
    switch (action) {
      case "pause":
        restrictive = true;
        d.paused ??= { at: nowIso() };
        message = "Everything is paused. Turns and checks running now finish; nothing new starts until you resume.";
        break;
      case "resume": {
        d.paused = null;
        const held = Object.keys(d.holds).map((k) => holdLabel(k, (a) => this.label(a)));
        message = `Everything resumed${held.length ? `, except what you hold: ${held.join(", ")}` : ""}. Rooms you paused yourself stay paused.`;
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
          message = `Holding ${label}: ${names(holdAgents(key))} finish${holdAgents(key).length > 1 ? "" : "es"} the turns they're on, then start${holdAgents(key).length > 1 ? "" : "s"} no new ones until you release ${holdAgents(key).length > 1 ? "them" : "it"}.`;
        } else {
          if (!d.holds[key]) throw new UserError(`${label[0].toUpperCase()}${label.slice(1)} isn't held.`);
          delete d.holds[key];
          const still = Object.entries(d.holds).filter(([, h]) => h.agents.some((a) => holdAgents(key).includes(a)));
          message = `Released ${label}.${still.length ? ` Still held: ${still.map(([k]) => holdLabel(k, (a) => this.label(a))).join(", ")}.` : ""}`;
        }
        break;
      }
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
    this.emit("state");
    this.#pumpAll();
    return { message, desk: this.deskView() };
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
    this.emit("state");
    this.#pumpAll();
    return { message: unreadable ? `Desk controls reset; the old file is at ${aside}.` : "Desk controls reset: nothing paused or held.", desk: this.deskView() };
  }

  /** What, desk-wide, keeps a queued request from starting. Following a turn the Codex app already has is never held up. */
  blockersFor(req) {
    if (req.attach) return [];
    const out = [];
    if (this.deskProblem) out.push(this.deskProblem.kind === "unreadable" ? "Toryo can't read its desk controls" : "Toryo couldn't save your desk controls");
    if (this.desk.paused) out.push("everything is paused");
    // Holds are on agents: Toryo's own checks aren't held, only paused with everything else.
    if (req.agent !== "toryo")
      for (const [key, h] of Object.entries(this.desk.holds)) if (h.agents.includes(req.agent)) out.push(`you hold ${holdLabel(key, (a) => this.label(a))}`);
    return out;
  }

  /**
   * The one scheduler. It starts what can start, in every room, one request at a time: each time, the request that
   * has waited longest among those that can start now, whichever room it's in. Then it looks again, since starting
   * one changes what else can start. Every change (a request queued, a turn ending, a control changed) comes here.
   * A call made while it runs (a turn ending as another starts) makes it look once more; it's never nested.
   */
  #schedule() {
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
    // A desk from the last round kept accepted app work in `following`.
    if (!room.appTurn && room.following?.length) room.appTurn = this.#appTurnFrom(room, room.following[0]);
    if (room.appTurn) room.appTurn.req = bind(room.appTurn.req);
    delete room.following;
    for (const ev of this.events.get(room.id)) {
      if (ev.type === "turn" && ev.state === "running") {
        // The Codex app keeps working while Toryo is down: follow the same turn again rather than sending it twice.
        // (A turn Toryo stopped before handing it to the app is offered again like any other.)
        if (ev.agent === "codexapp" && ev.req && ev.submitted !== false) {
          this.#patch(room, ev, { state: "interrupted", endedAt: nowIso(), error: "Toryo restarted; it follows this turn in the app again below." }, false);
          room.appTurn ??= this.#appTurnFrom(room, this.#followReq(bind(ev.req), ev));
          followed = true;
          continue;
        }
        this.#patch(room, ev, { state: "interrupted", endedAt: nowIso(), error: "Toryo stopped during this turn." }, false);
        if (ev.req && !this.#stale(room, bind(ev.req))) interrupted.push(bind(ev.req));
      }
    }
    // Checks that were running: run them again (they change nothing).
    const gate = room.activeGate && !this.#stale(room, bind(room.activeGate)) ? { ...bind(room.activeGate), id: shortId("q") } : null;
    room.activeGate = null;
    if (followed) this.#system(room, "Toryo restarted while the Codex app was working. It's following that turn again; nothing is sent twice.");
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
      const who = [...new Set(interrupted.map((r) => this.label(r.agent)))].join(" and ");
      this.#system(room, `Toryo restarted while ${who} ${interrupted.length > 1 ? "were" : "was"} working. Resume to run the interrupted turn again.`);
    }
    if (gate) {
      room.queue = [gate, ...room.queue];
      this.#system(room, "Toryo restarted while the checks were running. They run again.");
    }
    // Requests queued before 13 Oct have no time: they keep their order among themselves, after nothing older.
    for (const q of room.queue) q.queuedAt ??= this.#stamp();
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
      // Who is doing what right now, for the room list.
      working: this.#runningIn(room).map((r) => ({ agent: r.agent, kind: r.req.kind })),
      appThread: room.crew.members.includes("codexapp") ? room.sessions?.codexapp ?? null : null,
      // Queued work that desk-wide controls hold up, and why.
      blocked: [...this.#heldUp(room)].map(([q, reasons]) => ({ agent: q.agent, kind: q.kind, reasons })),
      updatedAt: room.updatedAt,
      crew: room.crew,
    };
  }

  roomView(roomId) {
    const room = this.#room(roomId);
    return {
      room: { ...room, status: this.#status(room) },
      events: this.events.get(room.id),
      live: this.#runningIn(room).map((r) => ({
        turnId: r.turnId,
        agent: r.agent,
        kind: r.req.kind,
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
      revisions: 0,
      checks: {},
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

  synthesize(roomId, { synthesizer, planPath, decisions } = {}) {
    const room = this.#room(roomId);
    if (!room.plan) throw new UserError("This room has no planning round.");
    const plan = room.plan;
    plan.synthesizer = room.crew.members.includes(synthesizer) ? synthesizer : room.crew.builder;
    if (planPath?.trim()) plan.planPath = planPath.trim();
    plan.phase = "synthesis";
    const checkpoint = this.#allWaiting(room).find((w) => w.kind === "plan-checkpoint");
    if (checkpoint) {
      this.#takeWaiting(room, checkpoint);
      this.#closeQuestion(room, decisions || "(no extra decisions)", checkpoint);
    }
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

  postMessage(roomId, { text, to = "auto", delivery = "next", discuss = 0, allowWrite = false, intent }) {
    const room = this.#room(roomId);
    text = String(text ?? "").trim();
    if (!text) throw new UserError("Write a message first.");
    const routed = this.route(room, text, to);
    if (!routed.agents.length) throw new UserError("Nobody in this room matches that recipient.");
    if (room.stopped) {
      room.stopped = false;
      room.paused = false;
      this.#system(room, "Resumed by your message.");
    }

    // An answer to an open question?
    const asked = routed.agents.length === 1 ? this.#allWaiting(room).find((w) => w.from && w.from === routed.agents[0]) : null;
    if (asked) {
      const ev = this.#append(room, { type: "owner", text, to: routed.agents, why: routed.why, kind: "answer", deliveredTo: [] });
      this.#resolveWaiting(room, asked, text);
      return { event: ev, routed };
    }

    // Ask (it needs an answer) or Tell (an instruction). Without your choice, a question mark or a question means Ask.
    const ev = this.#append(room, { type: "owner", text, to: routed.agents, why: routed.why, delivery, allowWrite, intent: intent === "ask" || intent === "tell" ? intent : noteIntent(text), deliveredTo: [] });
    // Close open chat questions from these agents: the owner has replied.
    for (const q of this.events.get(room.id))
      if (q.type === "question" && q.open && q.kind === "chat-owner" && routed.agents.includes(q.from)) {
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
      if (q) return this.#answerChat(room, q, { text, accept });
      throw new UserError(questionId ? "That question has already been answered." : "Nobody is waiting for an answer.");
    }
    if (w.kind === "plan-checkpoint") return this.synthesize(roomId, { decisions: text });
    // The plan-ready recommendation is an action: start building with the plan. A written answer asks for changes.
    if (w.kind === "plan-ready" && accept) {
      this.#takeWaiting(room, w);
      this.#closeQuestion(room, "Start building", w);
      return this.startBuild(roomId, { planPath: w.planPath || room.plan?.planPath });
    }
    const body = accept ? `Go with your recommendation${w.recommendation ? `: ${w.recommendation.replace(/[.\s]+$/, "")}` : ""}.` : String(text ?? "").trim();
    if (!body) throw new UserError("Write an answer first.");
    const ev = this.#append(room, { type: "owner", text: body, to: w.from ? [w.from] : room.crew.members, kind: "answer", deliveredTo: [] });
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
        this.#enqueue(room, { agent: room.plan.synthesizer, kind: "plan-revise", access: "write", instruction: prompts.planRevise({ planPath: room.plan.planPath }) });
        room.plan.phase = "revision";
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
    const body = accept ? `Go with your recommendation${q.recommendation ? `: ${q.recommendation.replace(/[.\s]+$/, "")}` : ""}.` : String(text ?? "").trim();
    if (!body) throw new UserError("Write an answer first.");
    this.#append(room, { type: "owner", text: body, to: [q.from], kind: "answer", deliveredTo: [] });
    this.#patch(room, q, { open: false, answer: body });
    room.openChat = room.openChat.filter((id) => id !== q.id);
    if (!room.queue.some((r) => r.agent === q.from))
      this.#enqueue(room, { agent: q.from, kind: "chat", access: "read", parallel: true, whileWaiting: true, instruction: prompts.chat({ canWrite: false, others: [] }) });
    this.#save(room);
    this.#pump(room);
    return this.summary(room);
  }

  /** What the room asks you first: the question it waits on, else the oldest unanswered chat question. */
  #firstAsk(room) {
    if (room.waiting) return { from: room.waiting.from, question: room.waiting.question, kind: room.waiting.kind };
    const id = room.openChat?.[0];
    const q = id && this.events.get(room.id).find((e) => e.id === id);
    return q ? { from: q.from, question: q.question, kind: q.kind } : null;
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
        const w = this.#allWaiting(room).find((x) => x.kind === "error");
        if (w) return this.answer(roomId, { text: "Retry.", accept: false, questionId: w.eventId });
        throw new UserError("Nothing to retry.");
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
      startedAt: nowIso(),
      requeue: false,
    };
    this.running.set(turnId, run);
    this.#executeTurn(room, run).catch((error) => {
      console.error("[toryo] turn crashed:", error);
      this.running.delete(turnId);
      const ev = this.events.get(room.id).find((e) => e.id === turnId);
      if (ev) this.#patch(room, ev, { state: "failed", endedAt: nowIso(), error: String(error?.message ?? error) });
      if (this.shuttingDown) return;
      // A turn the Codex app already has stays kept; following it again waits for you (it's never sent again).
      if (ev?.submitted || (room.appTurn && room.appTurn.marker === (req.attach?.marker ?? `[Toryo ${turnId}]`))) {
        room.appTurn ??= this.#appTurnFrom(room, this.#followReq(req, ev));
        this.#appLost(room, ev ?? { error: String(error?.message ?? error) });
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
    });
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
      onStarted: ({ sessionId } = {}) => {
        if (sessionId) room.sessions[req.agent] = sessionId;
        this.#commitDispatch(room, req.agent, run);
        this.#save(room);
      },
      // The Codex app accepted the message: keep the turn (on disk) until it ends; it's followed, never sent again.
      onSubmitted: () => {
        room.appTurn = this.#appTurnFrom(room, this.#followReq(req, ev));
        this.#patch(room, ev, { submitted: true });
        this.#save(room);
      },
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
      else {
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
    if (state === "done") this.#markReplies(room, req.agent, turnId);
    if (state === "done") this.#noteOutcomes(room, req, run, ev);
    this.#afterTurn(room, ev, run);
    this.#save(room);
    this.#pump(room);
    // Rooms that were waiting for this Codex app thread to be free can go now.
    if (req.agent === "codexapp") for (const other of this.#appThreadRooms(room.sessions.codexapp, room)) this.#pump(other);
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
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
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
    let outcome = { kind: req.kind, final: req.final, status: ev.status, detail: ev.detail, evId: ev.id };
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
    const actual = { ...req, kind: outcome.kind, final: outcome.final };
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
      const q = this.#append(room, { type: "question", kind: "chat-owner", from: req.agent, question: ev.detail || firstLine(ev.text), recommendation: recommendationIn(ev.text), open: true, turnId: ev.id });
      (room.openChat ??= []).push(q.id);
      this.#notify(`${this.label(req.agent)} has a question`, ev.detail || firstLine(ev.text));
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
        return this.#wait(room, { kind: "build-owner", from: req.agent, question: detail || firstLine(ev.text), recommendation: recommendationIn(ev.text) });
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
        return this.#wait(room, { kind: "review-owner", from: req.agent, final: req.final, question: detail || firstLine(ev.text), recommendation: recommendationIn(ev.text) });
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
    const run = { roomId: room.id, agent: "toryo", req, controller: new AbortController(), abandon: new AbortController(), activity: [], startedAt: nowIso(), turnId: shortId("g") };
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
      return this.#wait(room, { kind: "plan-owner", from: req.agent, question: detail || firstLine(ev.text), recommendation: recommendationIn(ev.text), retryReq: { ...req } });
    }
    if (PLAN_PARALLEL.has(req.kind)) {
      plan.pending = plan.pending.filter((a) => a !== req.agent);
      if (req.kind === "plan-check") plan.checks[req.agent] = status;
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
        const wantsChanges = Object.values(plan.checks).some((s) => s === "CHANGES");
        if (wantsChanges && plan.revisions < 1) {
          plan.revisions++;
          plan.phase = "revision";
          return this.#enqueue(room, { agent: plan.synthesizer, kind: "plan-revise", access: "write", instruction: prompts.planRevise({ planPath: plan.planPath }) });
        }
        return this.#planReady(room);
      }
    }
    if (req.kind === "plan-synthesis" || req.kind === "plan-revise") this.#adoptPlanPath(room, detail);
    if (req.kind === "plan-synthesis") {
      const checkers = others(plan.synthesizer);
      if (!checkers.length) return this.#planReady(room);
      plan.phase = "check";
      plan.pending = [...checkers];
      plan.checks = {};
      for (const agent of checkers)
        this.#enqueue(room, { agent, kind: "plan-check", access: "read", parallel: true, instruction: prompts.planCheck({ author: this.label(plan.synthesizer), planPath: plan.planPath }) });
      return;
    }
    if (req.kind === "plan-revise") return this.#planReady(room);
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
    this.#wait(room, {
      kind: "plan-ready",
      from: plan.synthesizer,
      question: `The plan is written at ${plan.planPath}. Start building with it, or tell ${this.label(plan.synthesizer)} what to change.`,
      recommendation: "Start building",
      // Accepting the recommendation starts the build; a written answer asks for changes.
      action: "start-build",
      planPath: plan.planPath,
    });
  }

  #wait(room, w) {
    const q = this.#append(room, { type: "question", kind: w.kind, from: w.from, question: w.question, recommendation: w.recommendation ?? "", questions: w.questions, planPath: w.planPath, open: true });
    // Questions never replace each other (two planners can ask at once): later ones wait their turn.
    if (room.waiting) (room.waitingQueue ??= []).push({ ...w, eventId: q.id });
    else room.waiting = { ...w, eventId: q.id };
    this.#save(room);
    this.#notify(w.from ? `${this.label(w.from)} needs your answer` : "Toryo needs you", w.question);
  }

  // ---------------------------------------------------------------- events & persistence

  #append(room, ev) {
    const event = { id: ev.id ?? shortId("e"), at: nowIso(), ...ev };
    this.events.get(room.id).push(event);
    this.store.appendEvent(room.id, event);
    room.updatedAt = event.at;
    this.emit("event", { roomId: room.id, event });
    return event;
  }

  #patch(room, ev, patch, emit = true) {
    Object.assign(ev, patch);
    this.store.appendEvent(room.id, { id: ev.id, ...patch });
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

function recommendationIn(text) {
  const m = String(text ?? "").match(/\b(?:I\s+)?recommend(?:ed|ation)?\b[:\s-]*(.+)/i);
  return m ? truncate(m[1].replace(/\*\*/g, "").trim(), 300) : "";
}

function sanitizeSettings(s) {
  const out = {};
  if (s.maxRounds != null) out.maxRounds = clamp(Number(s.maxRounds), 1, 20);
  if (s.maxNudges != null) out.maxNudges = clamp(Number(s.maxNudges), 0, 10);
  if (s.turnTimeoutMin != null) out.turnTimeoutMin = clamp(Number(s.turnTimeoutMin), 5, 24 * 60);
  for (const k of ["autoContinue", "snapshots", "gates", "freshReviewer"]) if (k in s) out[k] = Boolean(s[k]);
  return out;
}

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
