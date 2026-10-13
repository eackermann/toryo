import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";

export const nowIso = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const shortId = (prefix = "") =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function toryoHome() {
  if (process.env.TORYO_HOME || process.env.FOREMAN_HOME) return process.env.TORYO_HOME || process.env.FOREMAN_HOME;
  // Data from before the rename stays usable until it is moved to ~/.toryo.
  const home = join(homedir(), ".toryo");
  const legacy = join(homedir(), ".foreman");
  return existsSync(home) || !existsSync(legacy) ? home : legacy;
}

export function slugify(text, max = 48) {
  return (
    String(text)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, max)
      .replace(/-$/, "") || "untitled"
  );
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Keep the tail of a long string (useful for logs). */
export function tail(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}

export function firstLine(text, max = 160) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return truncate(line ?? "", max);
}

/** Run a command and collect output. Never throws; returns { code, stdout, stderr }. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 60_000, ...opts },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error && typeof error.code !== "number" ? error.message : undefined,
        });
      },
    );
  });
}

/**
 * Resolve an executable: PATH first, then the usual per-user install places
 * (~/.local/bin, every nvm Node version), newest Node first.
 */
export function which(bin) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  const home = homedir();
  dirs.push(join(home, ".local", "bin"), join(home, "bin"), join(home, ".bun", "bin"));
  try {
    const nvm = join(home, ".nvm", "versions", "node");
    const versions = readdirSync(nvm).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const v of versions) dirs.push(join(nvm, v, "bin"));
  } catch {
    /* no nvm */
  }
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}
