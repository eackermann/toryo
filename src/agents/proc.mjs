import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { readOnlyCommand } from "./readonly.mjs";

/**
 * What a turn can't write to (`readOnly` for runAgentProcess): a read-only turn, its folder (`readOnlyPaths`); in a
 * room's own worktree (`protect`), also the project's main folder, of which a writing turn keeps the room's own Git
 * folders writable. Null: nothing.
 */
export function lockFor(access, readOnlyPaths, protect) {
  const main = protect?.paths ?? [];
  if (access !== "write") {
    const paths = [...new Set([...(readOnlyPaths ?? []), ...main])];
    return paths.length ? paths : null;
  }
  return main.length ? { paths: main, writable: protect.writable ?? [] } : null;
}

/**
 * Spawn an agent CLI in its own process group, feed the prompt on stdin, and
 * stream stdout line by line. Aborting the signal stops the whole group
 * (SIGINT, then SIGTERM, then SIGKILL), so tools the agent started stop too.
 * `readOnly` lists folders the agent and everything it runs can't write to
 * (see readonly.mjs), or is { paths, writable }: those folders, except the
 * ones in `writable` inside them; `readOnly` in the result says whether that
 * held.
 */
export function runAgentProcess({
  command,
  args,
  cwd,
  env,
  stdin,
  onLine,
  rawLogPath,
  signal,
  timeoutMs,
  readOnly,
  canLaunch,
}) {
  return new Promise((resolve) => {
    // Stopped before it started (while the turn was being prepared, say): start nothing at all.
    if (signal?.aborted) return resolve({ code: null, signal: null, stderr: "", aborted: true, timedOut: false });
    // Held (a hold, Pause everything) since the turn began: it's sent back unsent, so start nothing (see `canLaunch`).
    if (canLaunch && !canLaunch()) return resolve({ code: null, signal: null, stderr: "", aborted: true, held: true, timedOut: false });
    const [program, ...prefix] = Array.isArray(command) ? command : [command];
    let cmd = program;
    let fullArgs = [...prefix, ...args];
    let locked = null;
    const lock = Array.isArray(readOnly) ? { paths: readOnly, writable: [] } : readOnly;
    if (lock?.paths?.length) {
      const wrapped = readOnlyCommand(lock.paths, cmd, fullArgs, lock.writable ?? []);
      locked = wrapped ? "enforced" : "unenforced";
      if (wrapped) ({ cmd, args: fullArgs } = wrapped);
    }
    const childEnv = { ...process.env, ...env };
    // If Toryo was started from inside a Claude Code session, don't tie its agents to that session.
    for (const key of Object.keys(childEnv)) if (key === "CLAUDECODE" || key === "CLAUDE_PID" || key.startsWith("CLAUDE_CODE_")) delete childEnv[key];
    // Agent CLIs are often Node scripts; make sure the Node running Toryo is on PATH.
    childEnv.PATH = `${dirname(process.execPath)}:${childEnv.PATH ?? ""}`;
    for (const key of Object.keys(env ?? {})) if (env[key] === undefined) delete childEnv[key];

    let child;
    try {
      child = spawn(cmd, fullArgs, {
        cwd,
        env: childEnv,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: -1, signal: null, stderr: String(error.message), aborted: false, readOnly: locked });
      return;
    }

    const raw = rawLogPath ? createWriteStream(rawLogPath, { flags: "a" }) : null;
    let stderr = "";
    let buffer = "";
    let aborted = false;
    let timedOut = false;
    const timers = [];

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const stop = () => {
      if (aborted) return;
      aborted = true;
      killGroup("SIGINT");
      timers.push(setTimeout(() => killGroup("SIGTERM"), 5_000));
      timers.push(setTimeout(() => killGroup("SIGKILL"), 12_000));
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
    if (timeoutMs) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs),
      );
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      raw?.write(chunk);
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.trim()) safe(onLine, line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code, sig) => {
      if (buffer.trim()) safe(onLine, buffer.replace(/\r$/, ""));
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener?.("abort", stop);
      raw?.end();
      resolve({ code, signal: sig, stderr, aborted, timedOut, readOnly: locked });
    });

    child.stdin.on("error", () => {
      /* agent exited before reading the prompt */
    });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function safe(fn, line) {
  try {
    fn?.(line);
  } catch (error) {
    console.error("[toryo] output handler failed:", error);
  }
}

export function tryJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
