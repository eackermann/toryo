#!/usr/bin/env node
/**
 * A stand-in for the codex / claude CLIs that speaks their headless output
 * formats. Behaviour comes from a JSON script (FAKE_SCRIPT):
 *   { "rules": [{ "agent": "codex", "match": "regex", "reply": "...", "times": 1,
 *                 "write": { "path": "a.txt", "content": "x" }, "hang": false, "fail": false,
 *                 "failEarly": false, "silent": false }],
 *     "log": "/path/calls.jsonl" }
 * Rules are tried in order; each may be used `times` times (default unlimited).
 * `fail` fails after starting the session; `failEarly` fails before printing
 * anything (a launch that never started); `silent` exits 0 with no output.
 * `hang` starts the session, then waits to be stopped. A write that the
 * system refuses is reported in the reply instead of crashing. For Claude,
 * `rateLimit` replaces the usual usage event: an object, a list of them, or
 * null for none. `empty` ends the turn with no message; for Claude,
 * `zeroTurns` does too, reporting num_turns 0, and `hookDrop: "<text>"`
 * reports "Prompt dropped by a hook: <text>" first. `resultText` puts text
 * in that last result event (diagnostics after a drop). `delayMs` waits before
 * the session starts; `workMs` waits after it has started (a turn at work). Usage is reported before a turn
 * fails too (`fail` with `rateLimit`), as a real turn can report it and then fail. For Codex, `codexUsage`
 * ({ primary, secondary }, as Codex logs them) is written to the session log under CODEX_HOME, where Toryo
 * reads Codex's usage. `sh` (a command or a list) runs shell commands in the working folder, each one's outcome
 * noted in the reply. The log records each call's working folder (`cwd`). For Claude, `followUp` adds a later answer
 * in the same run (a second result, after a background command's notice).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`fake-${kind} 1.0`);
  process.exit(0);
}
const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, "utf8"));
const countsFile = `${process.env.FAKE_SCRIPT}.counts.json`;
// Shared by fakes running at once (rooms side by side): read again if caught half-written, and written whole, by
// renaming a finished copy into place, so no fake ever reads it half-written.
const counts = (() => {
  if (!existsSync(countsFile)) return {};
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      return JSON.parse(readFileSync(countsFile, "utf8"));
    } catch (error) {
      last = error; // being replaced: once more
    }
  }
  // Still unreadable: a broken file, said, never taken for "no rule has answered yet".
  throw last;
})();

// Codex and Claude take the prompt on stdin; Cursor takes it as its last argument (and speaks Claude's format).
const prompt =
  kind === "cursor"
    ? args.at(-1)
    : await new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (d) => (data += d));
        process.stdin.on("end", () => resolve(data));
      });

let session;
if (kind === "codex") {
  const i = args.indexOf("resume");
  session = i >= 0 ? args[args.length - 2] : randomUUID();
} else {
  const s = args.indexOf("--session-id");
  const r = args.indexOf("--resume");
  session = s >= 0 ? args[s + 1] : r >= 0 ? args[r + 1] : randomUUID();
}

let rule = null;
let replyNote = "";
for (let i = 0; i < script.rules.length; i++) {
  const r = script.rules[i];
  if (r.agent && r.agent !== kind) continue;
  if (r.match && !new RegExp(r.match, "s").test(prompt)) continue;
  if (r.times != null && (counts[i] ?? 0) >= r.times) continue;
  counts[i] = (counts[i] ?? 0) + 1;
  rule = r;
  break;
}
writeFileSync(`${countsFile}.${process.pid}`, JSON.stringify(counts));
renameSync(`${countsFile}.${process.pid}`, countsFile);
if (script.log) appendFileSync(script.log, JSON.stringify({ kind, args, prompt, session, rule: rule?.match ?? null, cwd: process.cwd(), at: Date.now() }) + "\n");

if (rule?.failEarly) {
  process.stderr.write("fake launch failure\n");
  process.exit(1);
}
if (rule?.silent) process.exit(0);
if (rule?.write) {
  // Relative to the working folder, as an agent's own edits are.
  try {
    mkdirSync(dirname(rule.write.path), { recursive: true });
    writeFileSync(rule.write.path, rule.write.content ?? "");
  } catch (error) {
    replyNote = `(write refused: ${error.code})\n`;
  }
}
// `sh`: shell commands run in the working folder, as an agent's would; each one's outcome goes in the reply.
for (const command of [rule?.sh ?? []].flat()) {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  replyNote += `(sh ${r.status === 0 ? "ok" : `failed ${r.status}`}: ${command})\n`;
}
const reply = replyNote + (rule?.reply ?? "(fake) no rule matched\nTORYO: REPLY");
if (rule?.hang) {
  start();
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  if (rule?.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  start();
  // `progress`: a line of activity as the turn gets to work (a command it runs), before `workMs`.
  if (rule?.progress) progressLine(rule.progress);
  if (rule?.workMs) await new Promise((r) => setTimeout(r, rule.workMs));
  if (kind === "codex" && rule?.codexUsage) logCodexUsage(rule.codexUsage);
  if (rule?.fail) {
    // Usage reported, then an ordinary failure.
    if (kind !== "codex" && rule.rateLimit) for (const info of [rule.rateLimit].flat().filter(Boolean)) out({ type: "rate_limit_event", rate_limit_info: info });
    process.stderr.write("fake failure\n");
    process.exit(1);
  }
  if (rule?.hookDrop || rule?.empty || rule?.zeroTurns) emitNothing();
  else emit();
}

/** A turn that ends with no message: empty, or (Claude) its prompt dropped by a hook first. */
function emitNothing() {
  if (kind === "codex") {
    out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 } });
    const o = args.indexOf("-o");
    if (o >= 0) writeFileSync(args[o + 1], "");
    return;
  }
  if (rule.hookDrop) out({ type: "system", subtype: "informational", message: `Prompt dropped by a hook: ${rule.hookDrop}` });
  out({ type: "result", subtype: "success", is_error: false, result: rule.resultText ?? "", num_turns: rule.hookDrop || rule.zeroTurns ? 0 : 1, session_id: session });
}

/** One line of activity: a command started, as each CLI reports it. */
function progressLine(text) {
  if (kind === "codex") out({ type: "item.started", item: { id: "p1", type: "command_execution", command: text, status: "in_progress" } });
  else out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: text } }] } });
}

/** Codex's usage, as Codex writes it in the session's log (Toryo reads it from there after the turn). */
function logCodexUsage(rateLimits) {
  const d = new Date();
  const dir = join(process.env.CODEX_HOME, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `rollout-fake-${session}.jsonl`), JSON.stringify({ timestamp: d.toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } }) + "\n");
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** What the real CLIs print as soon as they have the prompt and a session. */
function start() {
  if (kind === "codex") {
    out({ type: "thread.started", thread_id: session });
    out({ type: "turn.started" });
  } else out({ type: "system", subtype: "init", session_id: session });
}

function emit() {
  if (kind === "codex") {
    const o = args.indexOf("-o");
    out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "/bin/bash -lc 'ls'", status: "in_progress" } });
    out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "/bin/bash -lc 'ls'", exit_code: 0, status: "completed" } });
    if (rule?.write) out({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: rule.write.path, kind: "add" }] } });
    out({ type: "item.completed", item: { id: "i3", type: "agent_message", text: reply } });
    out({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } });
    if (o >= 0) writeFileSync(args[o + 1], reply);
  } else {
    const soon = Math.round(Date.now() / 1000);
    const usual = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: soon + 3 * 3600 }, seven_day: { utilization: 0.77, resetsAt: soon + 4 * 86400 } } };
    // `rateLimit`: the usage events to report instead (one or a list); null reports none.
    const events = rule && "rateLimit" in rule ? [rule.rateLimit].flat().filter((e) => e != null) : [usual];
    for (const info of events) out({ type: "rate_limit_event", rate_limit_info: info });
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: session, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.01, num_turns: 3 });
    // `followUp`: a later answer in the same run, as when a background command's notice wakes Claude after its answer.
    // (Claude's cost is the run's so far; its tokens are the answer's own.)
    if (rule?.followUp != null) {
      out({ type: "system", subtype: "task_updated", task_id: "T1", patch: { status: "killed" } });
      out({ type: "system", subtype: "task_notification", task_id: "T1", status: "stopped", summary: "A background command stopped." });
      out({ type: "system", subtype: "init", session_id: session });
      out({ type: "assistant", message: { content: [{ type: "text", text: rule.followUp }] } });
      out({ type: "result", subtype: "success", is_error: false, result: rule.followUp, session_id: session, usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, total_cost_usd: 0.015, num_turns: 1 });
    }
  }
}
