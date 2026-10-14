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
 * the session starts; `workMs` waits after it has started (a turn at work).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const [kind, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`fake-${kind} 1.0`);
  process.exit(0);
}
const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, "utf8"));
const countsFile = `${process.env.FAKE_SCRIPT}.counts.json`;
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, "utf8")) : {};

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
writeFileSync(countsFile, JSON.stringify(counts));
if (script.log) appendFileSync(script.log, JSON.stringify({ kind, args, prompt, session, rule: rule?.match ?? null, at: Date.now() }) + "\n");

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
const reply = replyNote + (rule?.reply ?? "(fake) no rule matched\nTORYO: REPLY");
if (rule?.hang) {
  start();
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  if (rule?.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  start();
  if (rule?.workMs) await new Promise((r) => setTimeout(r, rule.workMs));
  if (rule?.fail) {
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
    out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: session, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.01 });
  }
}
