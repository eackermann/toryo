import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../util.mjs";
import { latestRateLimits, lineReader, parseRateLimits, scanBack } from "./logtail.mjs";

/**
 * EXPERIMENTAL. Your Codex desktop app's own thread as a crew member, so the
 * work stays visible and steerable in the app (and from the ChatGPT phone app).
 *
 * Sending: `codex.exe queue --thread <id> --message …` puts the message in the
 * thread's follow-up queue, the same one the app uses. Once the app has opened
 * a thread, it sends that thread's queue within a second whenever the thread
 * is idle, even with another thread on screen; nothing sends it for a thread
 * the app hasn't opened since it started (both tested 13 Oct 2026). So if the
 * message hasn't gone out after a few seconds, Toryo opens the thread with
 * the app's `codex://threads/<id>` link, which works even for threads the
 * sidebar hides.
 * Receiving: Toryo reads the thread's session log and waits for the turn
 * that carries its marker to complete.
 * Stopping: Toryo has no way to cancel a turn the app has queued or started,
 * so a stop doesn't end the turn here: Toryo keeps following it until it
 * finishes, and nothing else starts in the room meanwhile. Only `abandon` (a
 * second stop, deleting the room) or Toryo shutting down stops following.
 * A stop that comes before the message is queued means nothing is sent.
 * Running past the time limit only notifies you; following carries on.
 * Threads: each room has its own (`sessionId`); `cfg.thread` is only the
 * default for rooms that don't have one.
 */
const MAX_ARG = 28_000;

function windowsCodex() {
  const users = "/mnt/c/Users";
  if (!existsSync(users)) return null;
  const found = [];
  for (const user of readdirSync(users)) {
    const bin = join(users, user, "AppData", "Local", "OpenAI", "Codex", "bin");
    try {
      for (const v of readdirSync(bin)) {
        const exe = join(bin, v, "codex.exe");
        if (existsSync(exe)) found.push({ exe, home: join(users, user, ".codex"), mtime: statSync(exe).mtimeMs });
      }
    } catch {
      /* not this user */
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0] ?? null;
}

/** Bring the thread up in the Codex app, which makes the app send its queue. */
export function openInApp(thread) {
  try {
    spawn("cmd.exe", ["/c", "start", "", `codex://threads/${thread}`], { cwd: "/mnt/c/Windows/Temp", stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
    return true;
  } catch {
    return false;
  }
}

function locate(cfg) {
  const auto = windowsCodex();
  return { exe: cfg.exe ?? auto?.exe ?? null, home: cfg.codexHome ?? auto?.home ?? null };
}

// Where each thread's log is. Finding it walks the app's session folders on the Windows disk, and usage is
// re-read from these logs every few minutes, so the answer is remembered while the file is still there.
const rollouts = new Map();

/** The thread's log, or null when there's none. With `strict`, a folder that can't be read throws instead. */
function rolloutFor(home, thread, { strict = false } = {}) {
  const key = `${home}\n${thread}`;
  const known = rollouts.get(key);
  if (known && existsSync(known)) return known;
  try {
    const found = findRollout(home, thread);
    if (found) rollouts.set(key, found);
    else rollouts.delete(key);
    return found;
  } catch (error) {
    if (strict && error.code !== "ENOENT") throw error;
    return null;
  }
}

function findRollout(home, thread) {
  const root = join(home, "sessions");
  const years = readdirSync(root).sort().reverse();
  for (const y of years)
    for (const m of readdirSync(join(root, y)).sort().reverse())
      for (const d of readdirSync(join(root, y, m)).sort().reverse()) {
        const f = readdirSync(join(root, y, m, d)).find((n) => n.includes(thread) && n.endsWith(".jsonl"));
        if (f) return join(root, y, m, d, f);
      }
  return null;
}

/** The thread's last finished reply, read from the end of its session log (these logs reach gigabytes). */
export function lastAppMessage(cfg = {}) {
  const { home } = locate(cfg);
  const rollout = home && cfg.thread ? rolloutFor(home, cfg.thread) : null;
  if (!rollout) return "";
  const hit = scanBack(rollout, (line) => {
    if (!line.includes('"task_complete"')) return null;
    try {
      const ev = JSON.parse(line);
      return ev.payload?.type === "task_complete" ? ev.payload.last_agent_message || null : null;
    } catch {
      return null;
    }
  });
  return hit?.value ?? "";
}

/** Query a copy of the app's thread database, so Toryo never holds a lock on the app's own file. */
async function queryThreads(home, sql, params = []) {
  if (!home || !existsSync(join(home, "state_5.sqlite"))) return [];
  const dir = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    for (const f of readdirSync(home).filter((n) => n.startsWith("state_5.sqlite"))) copyFileSync(join(home, f), join(dir, f));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "state_5.sqlite"), { readOnly: true });
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows.map((r) => ({ ...r }));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Recent app threads, newest first, for choosing one in Settings. */
export async function listAppThreads(cfg = {}) {
  return queryThreads(
    locate(cfg).home,
    "select id, name, substr(preview, 1, 140) as preview, cwd, updated_at_ms as updated from threads where archived = 0 and source = 'vscode' order by updated_at_ms desc limit 25",
  );
}

/** The name the app shows for a thread (or the start of its first message). */
async function threadName(home, thread) {
  const [row] = await queryThreads(home, "select name, substr(preview, 1, 60) as preview from threads where id = ?", [thread]);
  return row?.name || row?.preview || null;
}

export const codexapp = {
  id: "codexapp",
  label: "Codex app",
  vendor: "OpenAI",
  tested: false,
  experimental: true,
  // Toryo can't cancel or interrupt the app's turn; see "Stopping" above.
  cancellable: false,

  /**
   * Plan usage before any turn in Toryo, and between turns: the newest reading in the logs of the default
   * thread and the rooms' threads (`threads`). Every thread draws on the same plan, so the newest one wins.
   * Null when none has a reading; throws when a log or the app's folders can't be read, so the failure shows
   * instead of an old reading passing for the latest. A thread whose log is gone is skipped.
   */
  currentLimits(cfg = {}, { threads = [] } = {}) {
    const { home } = locate(cfg);
    if (!home) return null;
    let best = null;
    for (const thread of new Set([cfg.thread, ...threads].filter(Boolean))) {
      const rollout = rolloutFor(home, thread, { strict: true });
      let reading = null;
      try {
        reading = rollout ? latestRateLimits(rollout) : null;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (reading && (!best || (reading.sourceAt ?? "") > (best.sourceAt ?? ""))) best = reading;
    }
    return best;
  },

  async detect(cfg = {}) {
    const { exe, home } = locate(cfg);
    if (!exe || !home) return { installed: false, hint: "Needs the Codex desktop app on Windows (WSL only)." };
    // Each room chooses its thread; cfg.thread is only the default for new rooms.
    if (!cfg.thread) return { installed: true, path: exe, version: "no default thread" };
    const name = rolloutFor(home, cfg.thread) ? await threadName(home, cfg.thread) : null;
    return { installed: true, path: exe, version: name ? `default thread “${name}”` : `default thread ${cfg.thread.slice(0, 8)}…`, threadName: name };
  },

  async run({ cfg = {}, prompt, sessionId, turnDir, onActivity, onStarted, onSubmitting, onSubmitted, canOpen, canLaunch, signal, abandon, timeoutMs, attach }) {
    const { exe, home } = locate(cfg);
    // The room's own thread first; the default only for a room that has none.
    const thread = sessionId ?? cfg.thread;
    if (!exe || !home || !thread) return { text: "", error: "The Codex app isn't set up: choose a thread for this room." };
    const rollout = rolloutFor(home, thread);
    if (!rollout) return { text: "", error: `Can't find the Codex app thread ${thread}.` };

    const marker = attach?.marker ?? `[Toryo ${turnDir.split("/").pop()}]`;
    let message = `${marker}\n${prompt}`;
    if (message.length > MAX_ARG) {
      const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
      const unc = `\\\\wsl.localhost\\${distro}${join(turnDir, "prompt.md").replace(/\//g, "\\")}`;
      message = `${marker}\nToryo relayed a long message. Read the whole file ${unc} (Markdown) and act on it exactly as if it had been sent here. It starts:\n\n${prompt.slice(0, 2_000)}…`;
    }

    let offset = statSync(rollout).size;
    if (attach) {
      // Toryo restarted while the app worked on this turn. The app carried on, so follow the same
      // turn again from where the message appears in the log, rather than sending it twice.
      const found = scanBack(rollout, (line) => line.includes(marker));
      if (found) offset = found.offset;
      onActivity?.({
        kind: "say",
        text: found ? "Following the Codex app's turn again after Toryo restarted." : "Waiting for the Codex app to send Toryo's queued message.",
      });
    } else {
      // Last chance to send nothing: once queued, the app's turn can't be taken back.
      if (signal?.aborted || abandon?.aborted) return { text: "", sessionId: thread, aborted: true };
      // Held (a hold, Pause everything) since the turn began: it goes back unsent.
      if (canLaunch && !canLaunch()) return { text: "", sessionId: thread, aborted: true, held: true };
      // From here until the app says it has it, a crash leaves it uncertain whether it got the message.
      onSubmitting?.();
      const sent = spawnSync(exe, ["queue", "--thread", thread, "--message", message], {
        encoding: "utf8",
        cwd: "/mnt/c/Windows/Temp",
        input: "",
        timeout: cfg.queueTimeoutMs ?? 60_000,
      });
      if (sent.status !== 0) {
        // Not queued, for certain: the command couldn't start, or it ran and said it failed. Otherwise it was stopped
        // (it ran out of time, or was killed) and the app may have the message: that's never sent again by itself.
        // Stopped first: a command that ran out of time may still exit with a code of its own (it caught the signal).
        const stopped = sent.error?.code === "ETIMEDOUT" || Boolean(sent.signal);
        const neverRan = ["ENOENT", "EACCES", "ENOEXEC"].includes(sent.error?.code);
        if (!stopped && (neverRan || typeof sent.status === "number"))
          return { text: "", error: `codex queue failed: ${(sent.stderr || sent.stdout || sent.error?.message || "").trim().slice(0, 300)}` };
        return {
          text: "",
          sessionId: thread,
          uncertain: true,
          error: `codex queue didn't finish (${sent.error?.code ?? sent.signal ?? "stopped"}), so Toryo can't tell whether the Codex app has the message.`,
        };
      }
      onSubmitted?.();
      onActivity?.({ kind: "say", text: "Queued in your Codex app thread. The app sends it when that thread is open and idle." });
    }
    // "auto": open the thread if the app hasn't sent the message within a few seconds. "never": leave it to you.
    const openAfter = cfg.openThread === "never" ? Infinity : (cfg.openAfterMs ?? 8_000);
    const open = cfg.open ?? openInApp;
    let opened = false;

    const started = Date.now();
    const poll = cfg.pollMs ?? 1_500;
    const readLines = lineReader();
    let seen = false;
    let warned = false;
    let stopNoted = false;
    let lateNoted = false;
    let limits = null;
    while (true) {
      if (abandon?.aborted || signal?.reason === "shutdown") return { text: "", sessionId: thread, aborted: true };
      if (signal?.aborted && !stopNoted) {
        stopNoted = true;
        onActivity?.({ kind: "warn", text: "Toryo can't stop a Codex app turn. It keeps running in the app; Toryo waits for it to finish before starting anything else here." });
      }
      if (timeoutMs && !lateNoted && Date.now() - started > timeoutMs) {
        lateNoted = true;
        const min = Math.round(timeoutMs / 60_000);
        onActivity?.({ kind: "warn", notify: true, text: `The Codex app's turn has run past ${min} min. Toryo keeps following it; press Stop twice to stop waiting for it.` });
      }
      let size = offset;
      try {
        size = statSync(rollout).size;
      } catch {
        /* the log is briefly unavailable: look again next time */
      }
      if (size > offset) {
        const fd = openSync(rollout, "r");
        const buf = Buffer.alloc(Math.min(size - offset, 32 * 1024 * 1024));
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset += buf.length;
        for (const line of readLines(buf)) {
          if (!line.trim()) continue;
          if (!seen && line.includes(marker)) {
            seen = true;
            // When the app took it up: that log line's own time, which may be while Toryo was stopped.
            let at = null;
            try {
              const ts = JSON.parse(line).timestamp;
              if (typeof ts === "string" && Number.isFinite(Date.parse(ts))) at = new Date(ts).toISOString();
            } catch {
              /* a line Toryo can't read: the time it saw it will do */
            }
            onStarted?.({ sessionId: thread, at });
          }
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          const p = ev.payload ?? {};
          if (p.type === "token_count" && p.rate_limits) {
            const fresh = parseRateLimits(p.rate_limits, { sourceAt: ev.timestamp });
            if (fresh) {
              limits = fresh;
              onActivity?.({ kind: "limits", limits: fresh });
            }
          }
          if (!seen) continue;
          if (ev.type === "response_item" && p.type === "custom_tool_call") {
            const cmds = [...String(p.input ?? "").matchAll(/cmd:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
            for (const c of cmds.length ? cmds : [p.name ?? "tool"]) onActivity?.({ kind: "command", text: c.replace(/^wsl(?:\.exe)? -d \S+ (?:-- )?(?:bash -lc )?/, "") });
          } else if (ev.type === "response_item" && p.type === "function_call") {
            onActivity?.({ kind: "command", text: `${p.name} ${String(p.arguments ?? "").slice(0, 200)}` });
          } else if (ev.type === "response_item" && p.type === "message" && p.role === "assistant") {
            const t = (p.content ?? []).map((c) => c.text ?? "").join("");
            if (t.trim()) onActivity?.({ kind: "say", text: t });
          } else if (ev.type === "event_msg" && p.type === "task_complete") {
            return { text: p.last_agent_message ?? "", sessionId: thread, limits };
          }
        }
      }
      // After a stop, don't push a message the app hasn't sent yet.
      // Not while Toryo holds the app or has paused everything: opening the thread would make it start the turn.
      if (!seen && !opened && !signal?.aborted && Date.now() - started > openAfter && (canOpen?.() ?? true)) {
        opened = true;
        if (open(thread)) onActivity?.({ kind: "say", text: "Opened the thread in the Codex app so it sends the message." });
      }
      if (!seen && !warned && Date.now() - started > 120_000) {
        warned = true;
        onActivity?.({
          kind: "warn",
          notify: true,
          text: "The Codex app hasn't sent Toryo's message yet. It waits while that thread is busy; otherwise open the thread in the app.",
        });
      }
      await sleep(poll);
    }
  },
};
