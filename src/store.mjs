import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { pidAlive } from "./util.mjs";

/** The pid of the desk holding the lock socket, as it answers (or null). */
function holder(name) {
  return new Promise((resolve) => {
    let data = "";
    const socket = connect(name);
    const done = () => resolve(Number(data.trim()) || null);
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("data", (d) => (data += d));
    socket.on("close", done);
    socket.on("error", () => {});
  });
}

/**
 * Plain-file persistence under TORYO_HOME:
 *   config.json                  projects and agent defaults
 *   rooms/<id>/room.json         room state (rewritten atomically)
 *   rooms/<id>/events.jsonl      append-only timeline; later lines with the same id patch earlier ones
 *   rooms/<id>/turns/<turn>/     prompt, raw agent output, final message
 *   desk.lock                    the pid of the desk using this folder (the lock itself is a socket; see lockDesk)
 */
export class Store {
  constructor(home) {
    this.home = home;
    mkdirSync(join(home, "rooms"), { recursive: true });
  }

  path(...parts) {
    return join(this.home, ...parts);
  }

  /**
   * One desk per data folder. On Linux the lock is an abstract Unix socket named after the folder:
   * only one process can listen on it, and the kernel frees it the moment that process ends, so a
   * desk that died never leaves a stale lock and two starting desks can't both win. Whoever holds it
   * answers with its pid. Returns { ok, release } or { ok: false, pid }.
   */
  async lockDesk() {
    const file = this.path("desk.lock");
    if (process.platform !== "linux") return this.#lockFile(file);
    const name = `\0toryo-desk-${createHash("sha256").update(realpathSync(this.home)).digest("hex").slice(0, 32)}`;
    const server = createServer((socket) => socket.end(String(process.pid)));
    const taken = await new Promise((resolve, reject) => {
      server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
      server.listen(name, () => resolve(true));
    });
    if (!taken) return { ok: false, pid: await holder(name) };
    server.unref();
    writeFileSync(file, String(process.pid)); // for people reading the folder; the socket is the lock
    return {
      ok: true,
      release: () => {
        server.close();
        this.#unlock(file);
      },
    };
  }

  /** Elsewhere, a lock file (best effort: two desks reclaiming a dead desk's lock at the same moment could both win). */
  #lockFile(file) {
    const mine = `${file}.${process.pid}`;
    writeFileSync(mine, String(process.pid));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          linkSync(mine, file); // atomic: fails if the lock exists
          return { ok: true, release: () => this.#unlock(file) };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const pid = Number(this.readText(file).trim());
          if (pid === process.pid) return { ok: true, release: () => this.#unlock(file) };
          if (pidAlive(pid)) return { ok: false, pid };
          rmSync(file, { force: true });
        }
      }
      return { ok: false, pid: null };
    } finally {
      rmSync(mine, { force: true });
    }
  }

  #unlock(file) {
    if (this.readText(file).trim() === String(process.pid)) rmSync(file, { force: true });
  }

  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  /** Write a JSON file in one step: the old file stays until the new one replaces it, and a failed write leaves no temporary file. */
  writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    try {
      this.rename(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing more to clean */
      }
      throw error;
    }
  }

  /** Replace `to` with `from` in one step: `to` is never missing in between. */
  rename(from, to) {
    renameSync(from, to);
  }

  /** Copy a file to a new name (never over an existing one). */
  copyFile(from, to) {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }

  loadConfig() {
    return this.readJson(this.path("config.json"), null);
  }

  saveConfig(config) {
    this.writeJson(this.path("config.json"), config);
  }

  roomDir(roomId) {
    return this.path("rooms", roomId);
  }

  listRoomIds() {
    try {
      return readdirSync(this.path("rooms")).filter((d) =>
        existsSync(join(this.path("rooms"), d, "room.json")),
      );
    } catch {
      return [];
    }
  }

  loadRoom(roomId) {
    return this.readJson(join(this.roomDir(roomId), "room.json"), null);
  }

  saveRoom(room) {
    mkdirSync(this.roomDir(room.id), { recursive: true });
    this.writeJson(join(this.roomDir(room.id), "room.json"), room);
  }

  /** Add one JSON line to a file under Toryo's home (a journal). */
  appendLine(name, value) {
    appendFileSync(this.path(name), JSON.stringify(value) + "\n");
  }

  appendEvent(roomId, event) {
    mkdirSync(this.roomDir(roomId), { recursive: true });
    appendFileSync(join(this.roomDir(roomId), "events.jsonl"), JSON.stringify(event) + "\n");
  }

  loadEvents(roomId) {
    let raw = "";
    try {
      raw = readFileSync(join(this.roomDir(roomId), "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    const order = [];
    const byId = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // a torn final line after a crash
      }
      if (byId.has(ev.id)) Object.assign(byId.get(ev.id), ev);
      else {
        byId.set(ev.id, ev);
        order.push(ev.id);
      }
    }
    return order.map((id) => byId.get(id));
  }

  turnDir(roomId, turnId) {
    const dir = join(this.roomDir(roomId), "turns", turnId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
