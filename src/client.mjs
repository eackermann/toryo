import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toryoHome, truncate } from "./util.mjs";
import { stripStatus } from "./protocol.mjs";

const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor", grok: "Grok", codexapp: "Codex app" };
const name = (a) => NAMES[a] ?? a;
/** One open question as text, with the id that answers it. */
const asked = (q) => `${q.from ? `${name(q.from)} asks: ` : ""}${q.question}${q.recommendation ? ` (recommended: ${q.recommendation})` : ""}${q.id ? ` [id ${q.id}]` : ""}`;

/** Talks to a running Toryo over its local HTTP API (found through server.json). */
export class ToryoClient {
  constructor(home = toryoHome()) {
    this.home = home;
  }

  server() {
    try {
      return JSON.parse(readFileSync(join(this.home, "server.json"), "utf8"));
    } catch {
      return { port: Number(process.env.TORYO_PORT ?? process.env.FOREMAN_PORT ?? 4777) };
    }
  }

  async call(method, path, body) {
    const { port, token } = this.server();
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-toryo": "1", ...(token ? { "x-toryo-token": token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Toryo isn't running on port ${port}. Start it with: toryo`);
    }
    const data = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error ?? String(data));
    return data;
  }

  state() {
    return this.call("GET", "/api/state");
  }

  /** Find a room by id, by part of its title, or default to the most recently active one. */
  async resolveRoom(ref) {
    const { rooms } = await this.state();
    if (!rooms.length) throw new Error("There are no rooms yet.");
    if (!ref) return rooms[0];
    const exact = rooms.find((r) => r.id === ref);
    if (exact) return exact;
    const needle = String(ref).toLowerCase();
    const matches = rooms.filter((r) => r.title.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Several rooms match “${ref}”: ${matches.map((r) => `${r.title} (${r.id})`).join(", ")}`);
    throw new Error(`No room matches “${ref}”.`);
  }

  async statusText() {
    const { rooms, agents } = await this.state();
    const lines = [];
    if (!rooms.length) lines.push("No rooms yet.");
    for (const r of rooms.slice(0, 12)) {
      const who = r.running.length ? ` · ${r.running.map(name).join(" and ")} working` : "";
      lines.push(`• ${r.title} [${r.mode}, ${r.status}${who}] (id ${r.id})`);
      for (const q of r.questions ?? (r.waiting ? [r.waiting] : [])) lines.push(`    waiting for you: ${asked(q)}`);
    }
    lines.push(`Agents: ${Object.entries(agents ?? {}).map(([id, a]) => `${name(id)} ${a.installed ? "✓" : "✗"}`).join("  ")}`);
    return lines.join("\n");
  }

  async roomText(ref, { last = 8, full = false } = {}) {
    const summary = await this.resolveRoom(ref);
    const view = await this.call("GET", `/api/rooms/${summary.id}`);
    const r = view.room;
    const lines = [`${r.title} · ${r.mode} · ${r.status} (id ${r.id})`];
    if (r.mode === "build" && r.build)
      lines.push(`Builder ${name(r.crew.builder)}, reviewer ${name(r.crew.reviewer)}. Plan: ${r.build.planPath || "none"}. Current: ${r.build.slice || "-"}, round ${r.build.round}. Approved: ${r.build.approved.join(", ") || "none yet"}.`);
    if (r.mode === "plan" && r.plan) lines.push(`Planning “${r.plan.topic}”, phase: ${r.plan.phase}. Plan file: ${r.plan.planPath}.`);
    for (const q of view.questions ?? [r.waiting, ...(r.waitingQueue ?? [])].filter(Boolean)) lines.push(`WAITING FOR YOU: ${asked(q)}`);
    for (const l of view.live) lines.push(`Working now: ${name(l.agent)} (${l.kind}), last: ${l.activity.at(-1)?.text ?? "starting"}`);
    lines.push("", "Recent:");
    const events = view.events.filter((e) => ["turn", "owner", "question", "gate"].includes(e.type) || (e.type === "system" && /approved|complete|agree|ended|failed|Stopped/i.test(e.text)));
    for (const e of events.slice(-last)) {
      if (e.type === "turn") {
        const body = stripStatus(e.text ?? "").trim();
        lines.push(`— ${name(e.agent)}${e.role ? ` (${e.role})` : ""}, ${e.kind}${e.status ? `, ${e.status}` : ""}${e.state !== "done" ? `, ${e.state}` : ""}:`);
        lines.push(full ? body : truncate(body.replace(/\n{2,}/g, "\n"), 700));
      } else if (e.type === "owner") lines.push(`— You → ${(e.to ?? []).map(name).join(", ")}: ${truncate(e.text, 400)}`);
      else if (e.type === "question") lines.push(`— Question${e.open ? " (open)" : ""}: ${e.question}${e.answer ? ` → ${e.answer}` : ""}`);
      else if (e.type === "gate") lines.push(`— Checks: ${e.results.map((x) => `${x.name} ${x.ok ? "passed" : "FAILED"}`).join(", ")}`);
      else lines.push(`— ${e.text}`);
    }
    return lines.join("\n");
  }

  async say(ref, text, { to = "auto", now = false, intent } = {}) {
    const r = await this.resolveRoom(ref);
    const res = await this.call("POST", `/api/rooms/${r.id}/messages`, { text, to, delivery: now ? "now" : "next", intent });
    return `Sent to ${res.routed.agents.map(name).join(", ")} in “${r.title}” (${res.routed.why}).`;
  }

  /**
   * Answer one open question: the one named by its id, else the only one open (in the room named, or in any room).
   * With several open, nothing is sent; the reply lists them with their ids. (The desk refuses an id that's no
   * longer open.)
   */
  async answer(ref, text, { accept = false, question } = {}) {
    const rooms = ref ? [await this.resolveRoom(ref)] : (await this.state()).rooms;
    if (!rooms.length) throw new Error("There are no rooms yet.");
    // A desk started before questions had ids (not restarted since this update): it can't take an answer to a
    // particular question, so one named is refused rather than sent somewhere else. Otherwise, as it always did.
    if (!rooms.some((r) => Array.isArray(r.questions))) {
      if (question) throw new Error("Toryo was started before questions had ids, so it can't take an answer to a particular question. Restart it first: toryo quit && toryo");
      await this.call("POST", `/api/rooms/${rooms[0].id}/answer`, { text, accept });
      return `Answered in “${rooms[0].title}”.`;
    }
    const open = rooms.flatMap((r) => (r.questions ?? []).map((q) => ({ ...q, room: r })));
    const where = ref ? ` in “${rooms[0].title}”` : "";
    let q = question ? open.find((x) => x.id === question) : open.length === 1 ? open[0] : null;
    if (question && !q) {
      if (!ref) throw new Error(`No open question has the id “${question}”: it has already been answered, or the id is wrong.`);
      q = { id: question, room: rooms[0] };
    }
    if (!q) {
      if (!open.length) throw new Error(`Nobody${where} is waiting for an answer.`);
      const line = (x) => `  ${ref ? "" : `“${x.room.title}”: `}${asked(x)}`;
      throw new Error([`${open.length} questions are open${where}. Say which one you're answering by its id:`, ...open.map(line)].join("\n"));
    }
    await this.call("POST", `/api/rooms/${q.room.id}/answer`, { text, accept, questionId: q.id });
    return `Answered in “${q.room.title}”${q.question ? `: ${truncate(q.question, 120)}` : ""}.`;
  }

  /**
   * Act on a plan that's ready: `check` asks the other planners (or `checkers`) to check it; `forward` sends your
   * discussion with one planner (`from`) to the author as a change request. The plan is the one whose Ready card is
   * named (`question`), else the only ready one (in the room named, or in any room).
   */
  async plan(ref, action, { question, from, checkers } = {}) {
    if (!["check", "forward"].includes(action)) throw new Error("Usage: toryo plan check|forward [--room R] [--question ID] [--from claude]");
    const rooms = ref ? [await this.resolveRoom(ref)] : (await this.state()).rooms;
    if (!rooms.length) throw new Error("There are no rooms yet.");
    if (!rooms.some((r) => Array.isArray(r.questions))) throw new Error("Toryo was started before this update, so it can't do that yet. Restart it first: toryo quit && toryo");
    const ready = rooms.flatMap((r) => (r.questions ?? []).filter((q) => q.kind === "plan-ready").map((q) => ({ ...q, room: r })));
    const where = ref ? ` in “${rooms[0].title}”` : "";
    const q = question ? ready.find((x) => x.id === question) : ready.length === 1 ? ready[0] : null;
    if (!q) {
      if (question) throw new Error(`No ready plan has the card “${question}”: the plan has moved on, or the id is wrong.`);
      if (!ready.length) throw new Error(`No plan is ready${where}.`);
      throw new Error([`${ready.length} plans are ready${where}. Say which one by its id:`, ...ready.map((x) => `  “${x.room.title}”: ${x.question} [id ${x.id}]`)].join("\n"));
    }
    const { room: r } = await this.call("GET", `/api/rooms/${q.room.id}`);
    const author = r.plan?.synthesizer;
    // A desk started before plans could be checked from here doesn't know these actions.
    const act = (body) =>
      this.call("POST", `/api/rooms/${r.id}/control`, body).catch((error) => {
        throw /^Unknown action/.test(error.message) ? new Error("Toryo was started before this update, so it can't do that yet. Restart it first: toryo quit && toryo") : error;
      });
    if (action === "check") {
      await act({ action: "plan-check", questionId: q.id, checkers });
      const who = checkers?.length ? checkers : (r.plan?.participants ?? []).filter((a) => a !== author);
      return `Asked ${who.map(name).join(" and ")} to check the plan in “${r.title}”.`;
    }
    // Forward: the planner you talked to, or the only other planner.
    const others = (r.plan?.participants ?? []).filter((a) => a !== author);
    const agent = from ?? (others.length === 1 ? others[0] : null);
    if (!agent) throw new Error(`Say whose discussion to forward: --from ${others.join(" or --from ")}.`);
    await act({ action: "forward-discussion", questionId: q.id, agent });
    return `Sent your discussion with ${name(agent)} to ${name(author)} as a change request, in “${r.title}”.`;
  }

  async control(ref, action) {
    const r = await this.resolveRoom(ref);
    await this.call("POST", `/api/rooms/${r.id}/control`, { action });
    return `${action[0].toUpperCase()}${action.slice(1)} “${r.title}”.`;
  }

  async start({ mode, text, project, planPath, title, builder, reviewer, reviewFirst, handoff, slice, appThread }) {
    const { config } = await this.state();
    const p = project ? config.projects.find((x) => x.id === project || x.name === project) : config.projects[0];
    if (!p) throw new Error("No such project.");
    const body = { projectId: p.id, mode, title, appThread };
    if (mode === "chat") Object.assign(body, { text, to: "everyone" });
    if (mode === "plan") Object.assign(body, { topic: text });
    if (mode === "build") {
      Object.assign(body, { task: text, planPath, builder, reviewer, reviewFirst, handoff, slice });
      if (builder || reviewer) body.members = [...new Set([builder ?? "codex", reviewer ?? "claude"])];
    }
    const r = await this.call("POST", "/api/rooms", body);
    return `Started “${r.title}” (${mode}, id ${r.id}) in ${p.name}.`;
  }
}
