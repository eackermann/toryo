import { join } from "node:path";
import { run, which } from "../util.mjs";
import { lockFor, runAgentProcess, tryJson } from "./proc.mjs";
import { readOnlyCommand } from "./readonly.mjs";
import { describeTool } from "./claude.mjs";

/**
 * Cursor CLI (`agent`, formerly `cursor-agent`), headless with -p. Tested on 13 Oct 2026 with Cursor CLI
 * 2026.10.01. A new chat id comes from `agent create-chat`.
 *
 * Read-only turns run under Toryo's read-only mount of the project (a write fails with EROFS), not Cursor's
 * `--mode ask`: a resumed chat keeps its mode, and `--mode` only accepts plan or ask, so after one Ask turn
 * the chat could never edit again (the next write turn replied "Ask mode is on"). `--mode ask` is only the
 * fallback where the mount isn't actually available (not just where Toryo asked for it). A chat that has had
 * an Ask turn reports `askMode`, and Toryo starts Cursor in a new chat before its next turn that writes.
 */
export const cursor = {
  id: "cursor",
  label: "Cursor",
  vendor: "Cursor",
  defaultBin: "agent",
  tested: true,

  /** `agent models` lists what this Cursor account can use; effort is part of each model's name. */
  async listModels(cfg = {}) {
    const bin = cfg.command?.[0] ?? which(cfg.bin ?? this.defaultBin) ?? which("cursor-agent");
    if (!bin) return { models: [] };
    const out = await run(bin, [...(cfg.command?.slice(1) ?? []), "models"], { timeout: 30_000 });
    const models = [];
    for (const line of out.stdout.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
      const m = line.match(/^\s*([\w.:\-\[\]=,]+)\s+-\s+(.+?)\s*$/);
      if (m && m[1] !== "auto") models.push({ id: m[1], label: m[2].replace(/\s*\((current|default)[^)]*\)/gi, "").trim(), efforts: [] });
    }
    return { models, effortInName: true };
  },

  async detect(cfg = {}) {
    const bin = cfg.command?.[0] ?? which(cfg.bin ?? this.defaultBin) ?? which("cursor-agent");
    if (!bin) return { installed: false, hint: "curl https://cursor.com/install -fsS | bash, then agent login" };
    const v = await run(bin, [...(cfg.command?.slice(1) ?? []), "--version"], { timeout: 15_000 });
    return { installed: v.code === 0, path: bin, version: v.stdout.trim().split("\n")[0] };
  },

  async run({ cfg = {}, cwd, prompt, sessionId, access, turnDir, onActivity, onStarted, signal, timeoutMs, readOnlyPaths, protect, mountable = canMount, canLaunch }) {
    const bin = which(cfg.bin ?? this.defaultBin) ?? which("cursor-agent") ?? "agent";
    const command = cfg.command ?? [bin];
    let chat = sessionId;
    if (!chat) {
      const created = await run(command[0], [...command.slice(1), "create-chat"], { cwd, timeout: 60_000 });
      chat = created.stdout.trim().split(/\s+/).pop() || null;
      if (!chat) return { text: "", error: `Cursor could not create a chat: ${created.stderr.trim()}` };
    }
    // Read-only by the mount only where the mount really happens (runAgentProcess wraps the command exactly when this holds).
    const mounted = access !== "write" && mountable(readOnlyPaths);
    const args = cursorArgs({ cfg, cwd, chat, access, mounted, prompt });
    const askMode = access !== "write" && !mounted;

    let text = "";
    let lastAssistant = "";
    let error = null;
    let usage = null;
    let started = false;
    const proc = await runAgentProcess({
      canLaunch,
      command,
      args,
      cwd,
      rawLogPath: join(turnDir, "output.jsonl"),
      signal,
      timeoutMs,
      // In a room's own worktree, the project's main folder is read-only too (`protect`, where possible).
      readOnly: lockFor(access, readOnlyPaths, protect),
      onLine: (line) => {
        const ev = tryJson(line);
        if (!ev) return;
        if (ev.session_id) chat = ev.session_id;
        if (!started) {
          started = true;
          onStarted?.({ sessionId: chat });
        }
        if (ev.type === "assistant") {
          const t = (ev.message?.content ?? []).map((c) => c.text ?? "").join("");
          if (t.trim()) {
            lastAssistant = t;
            onActivity?.({ kind: "say", text: t });
          }
          for (const block of ev.message?.content ?? []) if (block.type === "tool_use") onActivity?.(describeTool(block));
        } else if (ev.type === "tool_call" && ev.subtype === "started") {
          const call = ev.tool_call ?? {};
          const key = Object.keys(call)[0] ?? "tool";
          const a = call[key]?.args ?? {};
          onActivity?.({
            kind: /write|edit/i.test(key) ? "edit" : /shell|command/i.test(key) ? "command" : "read",
            text: `${key.replace(/ToolCall$/, "")} ${a.path ?? a.command ?? ""}`.trim(),
          });
        } else if (ev.type === "result") {
          if (typeof ev.result === "string") text = ev.result;
          usage = cursorUsage(ev.usage) ?? usage;
          if (ev.is_error) error = `Cursor ended with an error: ${String(ev.result ?? "").slice(0, 300)}`;
        }
      },
    });
    if (!text.trim()) text = lastAssistant;
    if (!error && proc.code !== 0 && !proc.aborted)
      error = `Cursor exited with code ${proc.code}: ${proc.stderr.trim().split("\n").slice(-3).join(" ")}`;
    return { text, sessionId: chat, usage, error, askMode: askMode || undefined, aborted: proc.aborted, held: proc.held, timedOut: proc.timedOut };
  },
};

/** Whether a read-only turn will really run under the read-only mount: there are folders to lock, and this machine can. */
const canMount = (paths) => Boolean(paths?.length && readOnlyCommand(paths, "true", []));

/** The arguments for one turn. A write turn gets --force; a read-only one relies on the mount when it's `mounted`, else Ask mode. */
export function cursorArgs({ cfg = {}, cwd, chat, access, mounted, prompt }) {
  const args = ["-p", "--output-format", "stream-json", "--workspace", cwd, "--trust", "--resume", chat];
  if (cfg.model) args.push("--model", cfg.model);
  if (access === "write") args.push("--force");
  else if (!mounted) args.push("--mode", "ask");
  args.push(...(cfg.extraArgs ?? []), prompt);
  return args;
}

/** Cursor's result usage (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) in Toryo's terms. */
export function cursorUsage(u) {
  if (!u || typeof u !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(u.inputTokens) + n(u.cacheWriteTokens), cached: n(u.cacheReadTokens), output: n(u.outputTokens) };
}
