import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { which } from "../util.mjs";

/**
 * Read-only turns, enforced by the operating system. The agent, and every
 * command it runs, gets its own mount namespace in which the project folder is
 * mounted read-only; the rest of the machine (its own settings, /tmp) stays
 * writable. Linux user namespaces do this without root, through util-linux's
 * `unshare` (2.38 or newer, for --map-user):
 *
 *   unshare --user --map-root-user --mount   a namespace where we may mount
 *     sh: bind each folder onto itself, remount it read-only, cd back in
 *     unshare --user --map-user=<you>        drop back to your own user id
 *       the agent
 *
 * The cd matters: a process that was already inside the folder would
 * otherwise keep writing through the old, writable mount.
 *
 * Folders inside a read-only one can be kept writable (`writable`): mounted
 * again onto themselves, writable. A room's own worktree uses this for the
 * main folder: read-only, except the Git folders the room's index, objects
 * and branch live in.
 */
const SCRIPT = `uid=$1 gid=$2 inner=$3; shift 3
here=$(pwd -P)
while [ "$1" != "--" ]; do
  { mount --bind -- "$1" "$1" && mount -o remount,bind,ro -- "$1"; } || { echo "Toryo couldn't make $1 read-only." >&2; exit 97; }
  shift
done
shift
while [ "$1" != "--" ]; do
  { mount --bind -- "$1" "$1" && mount -o remount,bind,rw -- "$1"; } || { echo "Toryo couldn't keep $1 writable." >&2; exit 97; }
  shift
done
shift
cd -- "$here" || exit 97
exec "$inner" --user --map-user="$uid" --map-group="$gid" -- "$@"`;

/**
 * The command that runs `cmd args` with `paths` read-only (except the folders in `writable`, inside them), or null
 * where that isn't possible.
 */
export function readOnlyCommand(paths, cmd, args, writable = []) {
  const unshare = support().unshare;
  if (!unshare || !paths?.length) return null;
  const uid = process.getuid();
  const gid = process.getgid();
  return {
    cmd: unshare,
    args: ["--user", "--map-root-user", "--mount", "--", "/bin/sh", "-c", SCRIPT, "toryo-readonly", String(uid), String(gid), unshare, ...paths, "--", ...writable, "--", cmd, ...args],
  };
}

let probed = null;

function support() {
  if (probed) return probed;
  const unshare = process.platform === "linux" ? which("unshare") : null;
  if (!unshare) return (probed = { ok: false, unshare: null, why: "This needs Linux and util-linux's unshare." });
  probed = { ok: false, unshare };
  const dir = mkdtempSync(join(tmpdir(), "toryo-readonly-"));
  try {
    // Inside the folder: a write must fail, and the agent must still be you.
    // (The write is in a subshell: a failed redirection on `:` would end the whole shell.)
    const wrapped = readOnlyCommand([dir], "/bin/sh", ["-c", 'if ( : > probe ) 2>/dev/null; then exit 3; fi; [ "$(id -u)" = "$1" ]', "probe", String(process.getuid())]);
    const r = spawnSync(wrapped.cmd, wrapped.args, { cwd: dir, timeout: 10_000, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status === 0) probed = { ok: true, unshare };
    else probed = { ok: false, unshare: null, why: firstLine(r.stderr) || "Linux user namespaces aren't available here." };
  } catch (error) {
    probed = { ok: false, unshare: null, why: String(error.message ?? error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return probed;
}

/** Whether read-only turns can be enforced on this machine: { ok, why }. Checked once. */
export function readOnlySupport() {
  const { ok, why } = support();
  return ok ? { ok } : { ok, why };
}

/**
 * The folders to make read-only for a project: the project itself, and its git
 * folder when that lives elsewhere (a worktree). Never a folder that holds your
 * home folder, where the agents keep their own sessions.
 */
export function readOnlyPaths(projectPath) {
  let root;
  try {
    root = realpathSync(projectPath);
  } catch {
    return [];
  }
  const paths = [root];
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
    const real = common ? realpathSync(common) : null;
    if (real && !inside(real, root)) paths.push(real);
  } catch {
    /* not a git repository */
  }
  const home = homedir();
  return paths.filter((p) => !inside(home, p));
}

const inside = (path, folder) => {
  const rel = relative(folder, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const firstLine = (s) => String(s ?? "").trim().split("\n")[0];
