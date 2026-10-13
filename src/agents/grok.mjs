import { join } from "node:path";
import { run, uuid, which } from "../util.mjs";
import { runAgentProcess, tryJson } from "./proc.mjs";

/**
 * Grok Build CLI (`grok`), headless with -p and --output-format json.
 * Built from xAI's documentation; not yet run against a real install.
 * Grok has no read-only switch: read-only turns rely on the project folder
 * being mounted read-only (readonly.mjs), and Toryo's tree check flags any
 * change where that isn't available.
 */
export const grok = {
  id: "grok",
  label: "Grok",
  vendor: "xAI",
  defaultBin: "grok",
  tested: false,

  async detect(cfg = {}) {
    const bin = cfg.command?.[0] ?? which(cfg.bin ?? this.defaultBin);
    if (!bin) return { installed: false, hint: "Install Grok Build from x.ai, then grok login" };
    const v = await run(bin, [...(cfg.command?.slice(1) ?? []), "--version"], { timeout: 15_000 });
    return { installed: v.code === 0, path: bin, version: v.stdout.trim().split("\n")[0] };
  },

  async run({ cfg = {}, cwd, prompt, sessionId, access, turnDir, onActivity, onStarted, signal, timeoutMs, readOnlyPaths, canLaunch }) {
    const command = cfg.command ?? [which(cfg.bin ?? this.defaultBin) ?? "grok"];
    const session = sessionId ?? uuid();
    // Grok takes the prompt as an argument; keep it well under the OS argument limit.
    const body = prompt.length > 100_000 ? prompt.slice(prompt.length - 100_000) : prompt;
    const args = ["--no-auto-update", "--output-format", "json", "--cwd", cwd, "-s", session];
    if (cfg.model) args.push("-m", cfg.model);
    if (access === "write") args.push("--always-approve");
    args.push(...(cfg.extraArgs ?? []), "-p", body);

    const lines = [];
    const proc = await runAgentProcess({
      canLaunch,
      command,
      args,
      cwd,
      rawLogPath: join(turnDir, "output.jsonl"),
      signal,
      timeoutMs,
      readOnly: access !== "write" ? readOnlyPaths : null,
      onLine: (line) => {
        if (!lines.length) onStarted?.({ sessionId: session });
        lines.push(line);
      },
    });
    let text = "";
    let error = null;
    const parsed = tryJson(lines.join("\n")) ?? tryJson(lines.at(-1) ?? "");
    if (parsed) {
      text = pickText(parsed);
      if (parsed.error) error = String(parsed.error.message ?? parsed.error);
    } else text = lines.join("\n");
    if (text) onActivity?.({ kind: "say", text });
    if (!error && proc.code !== 0 && !proc.aborted)
      error = `Grok exited with code ${proc.code}: ${proc.stderr.trim().split("\n").slice(-3).join(" ")}`;
    // Grok takes the session id from Toryo; it only exists once Grok has answered.
    return { text, sessionId: lines.length ? session : sessionId, usage: null, error, aborted: proc.aborted, held: proc.held, timedOut: proc.timedOut };
  },
};

function pickText(obj) {
  for (const key of ["result", "text", "response", "output", "content", "message"]) {
    const v = obj?.[key];
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      const inner = pickText(v);
      if (inner) return inner;
    }
  }
  if (Array.isArray(obj)) return obj.map(pickText).filter(Boolean).join("\n");
  return "";
}
