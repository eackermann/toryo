import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, which } from "../util.mjs";
import { latestRateLimits } from "./logtail.mjs";
import { runAgentProcess, tryJson } from "./proc.mjs";

/**
 * Codex CLI, headless: `codex exec --json` for a new thread and
 * `codex exec resume <id>` afterwards. Resumed turns do not keep the model,
 * effort or sandbox, so every turn passes them again (verified 13 Oct 2026).
 */
export const codex = {
  id: "codex",
  label: "Codex",
  vendor: "OpenAI",
  defaultBin: "codex",
  tested: true,

  /** The models Codex offers, with the effort levels each supports, from Codex's own model list. */
  listModels() {
    try {
      const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      const models = (Array.isArray(data) ? data : data.models ?? []).filter((m) => m.slug && m.visibility !== "hide");
      return {
        models: models.map((m) => ({
          id: m.slug,
          label: m.display_name || m.slug,
          efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
          defaultEffort: m.default_reasoning_level ?? null,
        })),
      };
    } catch {
      return { models: [] };
    }
  },

  /** Plan usage before any turn in Toryo: the latest reading from recent Codex sessions. */
  currentLimits() {
    return codexCurrentLimits();
  },

  async detect(cfg = {}) {
    const bin = cfg.command?.[0] ?? which(cfg.bin ?? this.defaultBin);
    if (!bin) return { installed: false, hint: "npm install -g @openai/codex, then codex login" };
    const v = await run(bin, [...(cfg.command?.slice(1) ?? []), "--version"], { timeout: 15_000 });
    return { installed: v.code === 0, path: bin, version: v.stdout.trim().split("\n")[0] };
  },

  accessArgs({ access, permissions, resume, writableRoots = [] }) {
    if (access !== "write") return resume ? ["-c", 'sandbox_mode="read-only"'] : ["-s", "read-only"];
    if (permissions === "full") return ["--dangerously-bypass-approvals-and-sandbox"];
    const net = ["-c", "sandbox_workspace_write.network_access=true"];
    const roots = writableRoots.map((r) => String(r).trim()).filter(Boolean).map((r) => r.replace(/^~(?=\/|$)/, homedir()));
    if (roots.length) net.push("-c", `sandbox_workspace_write.writable_roots=[${roots.map((r) => JSON.stringify(r)).join(",")}]`);
    if (permissions === "auto-review") {
      // Matches the Codex app's "on-request + automatic review". Not verified headless.
      return resume
        ? ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"', ...net]
        : ["--approve-for-me", ...net];
    }
    return resume ? ["-c", 'sandbox_mode="workspace-write"', ...net] : ["-s", "workspace-write", ...net];
  },

  async run({ cfg = {}, cwd, prompt, sessionId, access, turnDir, onActivity, onStarted, signal, timeoutMs, protect, canLaunch }) {
    const command = cfg.command ?? [which(cfg.bin ?? this.defaultBin) ?? "codex"];
    const last = join(turnDir, "last-message.txt");
    const common = ["--json", "--skip-git-repo-check", "-o", last];
    if (cfg.model) common.push("-m", cfg.model);
    if (cfg.effort) common.push("-c", `model_reasoning_effort="${cfg.effort}"`);
    const resume = Boolean(sessionId);
    // Its sandbox writes only in the room's folder: in a room's own worktree, also the Git folders that worktree's
    // index and branch are in (`protect.writable`), never the project's main folder.
    const accessArgs = this.accessArgs({ access, permissions: cfg.permissions, resume, writableRoots: [...(cfg.writableRoots ?? []), ...(protect?.writable ?? [])] });
    const args = resume
      ? ["exec", "resume", ...common, ...accessArgs, ...(cfg.extraArgs ?? []), sessionId, "-"]
      : ["exec", ...common, "-C", cwd, ...accessArgs, ...(cfg.extraArgs ?? []), "-"];

    let thread = sessionId ?? null;
    let started = false;
    let lastMessage = "";
    let usage = null;
    let error = null;
    const proc = await runAgentProcess({
      canLaunch,
      command,
      args,
      cwd,
      stdin: prompt,
      rawLogPath: join(turnDir, "output.jsonl"),
      signal,
      timeoutMs,
      onLine: (line) => {
        const ev = tryJson(line);
        if (!ev) return;
        if (ev.type === "thread.started") thread = ev.thread_id ?? thread;
        // Codex has the prompt once it starts the thread (or resumes it): from then on there's a session to resume.
        if ((ev.type === "thread.started" || ev.type === "turn.started") && !started) {
          started = true;
          onStarted?.({ sessionId: thread });
        }
        if (ev.type === "turn.completed") usage = ev.usage ?? usage;
        else if (ev.type === "turn.failed") error = ev.error?.message ?? "Codex turn failed";
        else if (ev.type === "error") error = ev.message ?? "Codex error";
        else if (ev.type === "item.started" || ev.type === "item.completed") {
          const item = ev.item ?? {};
          if (item.type === "command_execution") {
            if (ev.type === "item.started") onActivity?.({ kind: "command", text: cleanCommand(item.command) });
            else if (item.exit_code && item.exit_code !== 0)
              onActivity?.({ kind: "warn", text: `exit ${item.exit_code}: ${cleanCommand(item.command)}` });
          } else if (item.type === "file_change" && ev.type === "item.completed") {
            for (const change of item.changes ?? [])
              onActivity?.({ kind: "edit", text: `${change.kind ?? "edit"} ${change.path}` });
          } else if (item.type === "agent_message" && ev.type === "item.completed") {
            lastMessage = item.text ?? lastMessage;
            onActivity?.({ kind: "say", text: item.text ?? "" });
          } else if (item.type === "mcp_tool_call" && ev.type === "item.started") {
            onActivity?.({ kind: "tool", text: `${item.server ?? "mcp"}.${item.tool ?? "tool"}` });
          } else if (item.type === "web_search" && ev.type === "item.started") {
            onActivity?.({ kind: "tool", text: `search ${item.query ?? ""}` });
          } else if (item.type === "error" && ev.type === "item.completed") {
            onActivity?.({ kind: "warn", text: item.message ?? "error" });
          }
        }
      },
    });

    let text = "";
    try {
      text = readFileSync(last, "utf8");
    } catch {
      text = lastMessage;
    }
    if (!text.trim()) text = lastMessage;
    if (!error && proc.code !== 0 && !proc.aborted)
      error = `Codex exited with code ${proc.code}: ${proc.stderr.trim().split("\n").slice(-3).join(" ")}`;
    return {
      text,
      limits: codexLimits(thread),
      sessionId: thread,
      usage: usage
        ? { input: usage.input_tokens, cached: usage.cached_input_tokens, output: usage.output_tokens }
        : null,
      error,
      aborted: proc.aborted,
      held: proc.held,
      timedOut: proc.timedOut,
    };
  },
};

/** Recent session logs in Codex's home, newest day first. None yet is an empty list; a folder that can't be read throws. */
function recentLogs() {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const files = [];
  let years;
  try {
    years = readdirSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  for (const y of years.sort().reverse().slice(0, 2))
    for (const m of readdirSync(join(root, y)).sort().reverse().slice(0, 2))
      for (const d of readdirSync(join(root, y, m)).sort().reverse().slice(0, 4))
        for (const f of readdirSync(join(root, y, m, d))) if (f.endsWith(".jsonl")) files.push(join(root, y, m, d, f));
  return files;
}

/** Codex records its plan limits in the session log; read the latest reading for a thread. */
export function codexLimits(threadId) {
  if (!threadId) return null;
  try {
    const path = recentLogs().find((f) => f.includes(threadId));
    return path ? latestRateLimits(path) : null;
  } catch {
    return null;
  }
}

/**
 * The latest plan usage from any recent Codex session, so the meters show before Toryo's first turn and stay
 * current between turns. Null when no recent log has a reading; throws when a log can't be read, so the
 * failure shows instead of the old reading passing for the latest. A log deleted meanwhile is skipped.
 */
export function codexCurrentLimits() {
  const newest = recentLogs()
    .map((f) => ({ f, t: mtime(f) }))
    .filter((x) => x.t != null)
    .sort((a, b) => b.t - a.t)
    .slice(0, 5);
  for (const { f } of newest) {
    let l = null;
    try {
      l = latestRateLimits(f);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (l) return l;
  }
  return null;
}

function mtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function cleanCommand(cmd = "") {
  const m = String(cmd).match(/^\/bin\/(?:ba)?sh -lc (.*)$/s);
  let c = m ? m[1] : String(cmd);
  if (/^'.*'$/s.test(c)) c = c.slice(1, -1).replace(/'\\''/g, "'");
  return c.replace(/\s+/g, " ").trim();
}
