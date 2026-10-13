import { join } from "node:path";
import { run, uuid, which } from "../util.mjs";
import { runAgentProcess, tryJson } from "./proc.mjs";
import { claudeWindowType, normalizeWindow } from "../usage.mjs";

/**
 * Claude Code, headless: `claude -p --output-format stream-json`.
 * Toryo picks the session id up front (--session-id), then resumes it.
 * Read-only turns run with the project folder mounted read-only (readonly.mjs),
 * which covers shell commands and every other tool. Where that isn't available
 * only Claude Code's own rules apply: Edit/Write/NotebookEdit are denied inside
 * the repository (verified 13 Oct 2026), but shell commands could still write.
 */
export const claude = {
  id: "claude",
  label: "Claude",
  vendor: "Anthropic",
  defaultBin: "claude",
  tested: true,

  /** Claude Code's model aliases (always the latest of each) and its effort levels (`claude --help`). */
  listModels() {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const models = [
      ["opus", "Opus (latest)"],
      ["sonnet", "Sonnet (latest)"],
      ["haiku", "Haiku (latest)"],
      ["fable", "Fable (latest)"],
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
      ["claude-haiku-5-5", "Claude Haiku 5.5"],
      ["claude-fable-5-1", "Claude Fable 5.1"],
    ];
    return { models: models.map(([id, label]) => ({ id, label, efforts })) };
  },

  async detect(cfg = {}) {
    const bin = cfg.command?.[0] ?? which(cfg.bin ?? this.defaultBin);
    if (!bin) return { installed: false, hint: "curl -fsSL https://claude.ai/install.sh | bash, then claude /login" };
    const v = await run(bin, [...(cfg.command?.slice(1) ?? []), "--version"], {
      timeout: 15_000,
      env: { ...process.env, CLAUDECODE: "" },
    });
    return { installed: v.code === 0, path: bin, version: v.stdout.trim().split("\n")[0] };
  },

  async run({ cfg = {}, cwd, prompt, sessionId, access, systemPrompt, turnDir, onActivity, onStarted, signal, timeoutMs, readOnlyPaths, canLaunch }) {
    const command = cfg.command ?? [which(cfg.bin ?? this.defaultBin) ?? "claude"];
    const fresh = !sessionId;
    const session = sessionId ?? uuid();
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"];
    args.push(fresh ? "--session-id" : "--resume", session);
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.effort) args.push("--effort", cfg.effort);
    args.push("--permission-mode", cfg.permissionMode ?? "auto");
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    args.push(...(cfg.extraArgs ?? []));
    // Variadic option: keep it last so nothing after it is swallowed.
    if (access !== "write") {
      const root = cwd.startsWith("/") ? `/${cwd}` : cwd;
      args.push("--disallowedTools", `Edit(${root}/**)`, `Write(${root}/**)`, `NotebookEdit(${root}/**)`);
    }

    let text = "";
    let lastAssistant = "";
    let usage = null;
    let cost = null;
    let error = null;
    // A new session only exists once Claude has started it; until then there's nothing to resume.
    let resultSession = fresh ? null : session;
    let started = false;
    let limits = null;
    // A Claude Code hook (a plugin's, say) can drop the prompt before Claude sees it. The stream then says
    // "Prompt dropped by a hook: …" and the turn ends with nothing; that's an error, not an answer.
    let dropped = null;
    let turns = null;
    const proc = await runAgentProcess({
      canLaunch,
      command,
      args,
      cwd,
      stdin: prompt,
      env: { CLAUDECODE: undefined },
      rawLogPath: join(turnDir, "output.jsonl"),
      signal,
      timeoutMs,
      readOnly: access !== "write" ? readOnlyPaths : null,
      onLine: (line) => {
        const ev = tryJson(line);
        if (!ev) return;
        // Only Claude Code's own notices count: not the model's words, a tool's output or the final message, which may quote this text.
        if (!dropped && !["assistant", "user", "result"].includes(ev.type) && /dropped by a hook/i.test(line)) dropped = findText(ev, DROPPED);
        if (ev.session_id && !started) {
          started = true;
          resultSession = ev.session_id;
          onStarted?.({ sessionId: ev.session_id });
        }
        if (ev.type === "rate_limit_event") {
          const fresh = claudeLimits(ev.rate_limit_info);
          if (fresh) {
            limits = fresh;
            onActivity?.({ kind: "limits", limits: fresh });
          }
        }
        if (ev.type === "system" && ev.subtype === "init" && ev.session_id) resultSession = ev.session_id;
        else if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastAssistant = block.text;
              onActivity?.({ kind: "say", text: block.text });
            } else if (block.type === "tool_use") onActivity?.(describeTool(block));
          }
        } else if (ev.type === "user") {
          for (const block of ev.message?.content ?? [])
            if (block.type === "tool_result" && block.is_error)
              onActivity?.({ kind: "warn", text: String(flatten(block.content)).slice(0, 200) });
        } else if (ev.type === "result") {
          text = typeof ev.result === "string" ? ev.result : text;
          resultSession = ev.session_id ?? resultSession;
          usage = ev.usage
            ? {
                input: (ev.usage.input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0),
                cached: ev.usage.cache_read_input_tokens ?? 0,
                output: ev.usage.output_tokens ?? 0,
              }
            : null;
          cost = ev.total_cost_usd ?? null;
          if (typeof ev.num_turns === "number") turns = ev.num_turns;
          if (ev.is_error || (ev.subtype && ev.subtype !== "success"))
            error = `Claude ended with ${ev.subtype ?? "an error"}${typeof ev.result === "string" ? `: ${ev.result.slice(0, 300)}` : ""}`;
        }
      },
    });
    if (!text.trim()) text = lastAssistant;
    // A dropped prompt is an error whatever text came with it: Claude never saw the prompt, so that text isn't an answer.
    if (dropped) error = `Claude never saw the prompt. ${firstSentence(dropped)} (a Claude Code hook stopped it; check the plugins and hooks in Claude Code's settings)`;
    else if (!error && !proc.aborted && !text.trim() && turns === 0) error = "Claude ran no turns and returned nothing.";
    if (!error && proc.code !== 0 && !proc.aborted)
      error = `Claude exited with code ${proc.code}: ${proc.stderr.trim().split("\n").slice(-3).join(" ")}`;
    return { text, sessionId: resultSession, usage, cost, limits, error, dropped: Boolean(dropped), aborted: proc.aborted, held: proc.held, timedOut: proc.timedOut };
  },
};

/**
 * Claude's `rate_limit_info` as a usage reading (see src/usage.mjs). The stream is live, so the reading was
 * taken when it arrived. Model-specific windows (seven_day_opus) keep their own identity; a missing or
 * malformed utilization or reset time stays unknown, never 0.
 */
export function claudeLimits(info, { sourceAt = new Date().toISOString() } = {}) {
  const windows = info?.unifiedWindows;
  if (!windows || typeof windows !== "object") return null;
  const parsed = Object.entries(windows)
    .map(([key, w]) =>
      w && typeof w === "object"
        ? normalizeWindow({
            type: claudeWindowType(key),
            used: typeof w.utilization === "number" && Number.isFinite(w.utilization) ? Math.round(w.utilization * 1000) / 10 : null,
            resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
          })
        : null,
    )
    .filter(Boolean);
  if (!parsed.length) return null;
  return { status: typeof info.status === "string" ? info.status : null, sourceAt, windows: parsed };
}

/** Claude Code's message when a hook drops the prompt before Claude sees it. */
const DROPPED = /^\s*Prompt dropped by a hook\b/i;

/** The first string anywhere in a stream event that matches `re`. */
function findText(value, re, depth = 0) {
  if (typeof value === "string") return re.test(value) ? value : null;
  if (!value || typeof value !== "object" || depth > 6) return null;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findText(v, re, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const firstSentence = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim().slice(0, 400);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

function flatten(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join(" ");
  return JSON.stringify(content ?? "");
}

export function describeTool(block) {
  const input = block.input ?? {};
  const name = block.name ?? "tool";
  if (name === "Bash") return { kind: "command", text: String(input.command ?? "").replace(/\s+/g, " ") };
  if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(name))
    return { kind: "edit", text: `${name.toLowerCase()} ${input.file_path ?? input.notebook_path ?? ""}` };
  if (name === "Read") return { kind: "read", text: `read ${input.file_path ?? ""}` };
  if (name === "Grep" || name === "Glob") return { kind: "read", text: `${name.toLowerCase()} ${input.pattern ?? ""}` };
  if (name === "WebSearch" || name === "WebFetch")
    return { kind: "tool", text: `${name} ${input.query ?? input.url ?? ""}` };
  return { kind: "tool", text: name };
}
