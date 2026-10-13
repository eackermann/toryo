import { spawn } from "node:child_process";
import { tail } from "./util.mjs";

/**
 * Checks Toryo runs itself before sending work to review, so the reviewer
 * never spends a round on something a typecheck would have caught. Stopping
 * (the signal) ends the running command and starts no further ones; results
 * then carry `cancelled: true`.
 */
export async function runGates(project, { signal, onActivity, killGraceMs = 5_000 } = {}) {
  const results = [];
  for (const gate of project.gates ?? []) {
    if (!gate?.command?.trim()) continue;
    if (signal?.aborted) return Object.assign(results, { cancelled: true });
    onActivity?.({ kind: "command", text: `gate: ${gate.command}` });
    const started = Date.now();
    const r = await runShell(gate.command, project.path, (gate.timeoutMin ?? 20) * 60_000, signal, killGraceMs);
    if (r.cancelled) return Object.assign(results, { cancelled: true });
    results.push({
      name: gate.name || gate.command,
      command: gate.command,
      // A check that ran out of time fails, whatever it exited with when it was stopped.
      ok: r.code === 0 && !r.timedOut,
      code: r.code,
      timedOut: r.timedOut || undefined,
      seconds: Math.round((Date.now() - started) / 1000),
      output: tail(r.output, 6_000),
    });
  }
  return results;
}

/** Run one command in its own process group. A stop or a timeout sends SIGTERM to the group, then SIGKILL. */
export function runShell(command, cwd, timeoutMs, signal, killGraceMs = 5_000) {
  if (signal?.aborted) return Promise.resolve({ code: null, output: "", cancelled: true });
  return new Promise((resolve) => {
    let output = "";
    let cancelled = false;
    let timedOut = false;
    let killTimer = null;
    const child = spawn("bash", ["-lc", command], { cwd, detached: true, env: { ...process.env, CI: "1" } });
    const signalGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* gone */
      }
    };
    const kill = () => {
      if (killTimer) return;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n[toryo] timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`}`;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (d) => {
      output += d;
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      output += e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, output, cancelled, timedOut });
    });
  });
}
