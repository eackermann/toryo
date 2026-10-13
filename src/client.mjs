import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toryoHome, truncate } from "./util.mjs";
import { stripStatus } from "./protocol.mjs";

const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor", grok: "Grok", codexapp: "Codex app" };
const name = (a) => NAMES[a] ?? a;

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
      if (r.waiting) lines.push(`    waiting for you: ${r.waiting.from ? `${name(r.waiting.from)} asks: ` : ""}${r.waiting.question}${r.waitingCount > 1 ? ` (and ${r.waitingCount - 1} more)` : ""}`);
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
    if (r.waiting) lines.push(`WAITING FOR YOU: ${r.waiting.from ? `${name(r.waiting.from)} asks: ` : ""}${r.waiting.question}${r.waiting.recommendation ? ` (recommended: ${r.waiting.recommendation})` : ""}`);
    for (const w of r.waitingQueue ?? []) lines.push(`ALSO WAITING (answered after the one above): ${w.from ? `${name(w.from)} asks: ` : ""}${w.question}`);
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

  async answer(ref, text, { accept = false } = {}) {
    const r = await this.resolveRoom(ref);
    await this.call("POST", `/api/rooms/${r.id}/answer`, { text, accept });
    return `Answered in “${r.title}”.`;
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
