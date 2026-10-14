import { createServer as createHttpServer } from "node:http";
import { UserError } from "./engine.mjs";
import { loadPage } from "./page.mjs";
import { listAppThreads } from "./agents/codexapp.mjs";

/**
 * `page` is what loadPage() read when the desk started; only those files are served, so the page
 * always matches the running server. (`webDir` alone loads it here, for tests.)
 */
export function createServer({ engine, page, webDir, host = "127.0.0.1", port = 4777, token = null, allowedHosts = [] }) {
  page ??= loadPage(webDir);
  const clients = new Set();
  // The page compares webVersion with the version it loaded (a restarted desk: reload) and with
  // webOnDisk (files changed under a running desk: restart Toryo to use them).
  const state = () => ({ ...engine.state(), webVersion: page.version, webOnDisk: page.onDisk() });
  const send = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  let stateTimer = null;
  const pushState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => send("state", state()), 150);
  };
  engine.on("event", (d) => send("event", d));
  engine.on("room", (d) => {
    send("room", d);
    pushState();
  });
  engine.on("activity", (d) => send("activity", d));
  engine.on("notify", (d) => send("notify", d));
  engine.on("state", pushState);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);
  // Tell open pages promptly when the files on disk change, even if nothing else is happening.
  let lastOnDisk = page.onDisk();
  const diskCheck = setInterval(() => {
    const now = page.onDisk();
    if (now !== lastOnDisk) {
      lastOnDisk = now;
      pushState();
    }
  }, 3_000);
  diskCheck.unref?.();

  const okHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...allowedHosts]);

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!okHosts.has(hostname) && host !== "0.0.0.0") return text(res, 403, "Host not allowed.");
      if (token) {
        if (url.searchParams.get("token") === token)
          res.setHeader("Set-Cookie", `toryo=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        else if (!authorised(req, url, token)) return text(res, 401, "Add ?token=… from the Toryo console to the address.");
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.headers["x-toryo"] !== "1" && req.headers["x-foreman"] !== "1") return text(res, 403, "Missing x-toryo header.");
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return text(res, 403, "Cross-site request refused.");
      }

      const file = req.method === "GET" && !url.pathname.startsWith("/api/") ? page.get(url.pathname) : null;
      if (file) {
        res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-cache" });
        return res.end(file.body);
      }

      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return text(res, 404, "Not found");
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readJson(req) : {};
      const result = await route(engine, req.method, parts.slice(1), url, body);
      if (result?.__text != null) return text(res, 200, result.__text);
      return json(res, 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof UserError ? error.status : 500;
      if (status === 500) console.error("[toryo]", error);
      // A refusal can say why in a way a client acts on (`code`), and name what it's about (`room`).
      return json(res, status, { error: error.message ?? String(error), ...(error.code ? { code: error.code } : {}), ...(error.room ? { room: error.room } : {}) });
    }
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(diskCheck);
  });
  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const res of clients) res.end();
        clients.clear();
        clearInterval(heartbeat);
        clearInterval(diskCheck);
        server.close(() => resolve());
      }),
  };
}

async function route(engine, method, parts, url, body) {
  const [a, id, b, c, d] = parts;
  if (a === "state" && method === "GET") return engine.state();
  if (a === "config" && method === "PATCH") return engine.updateConfig(body);
  if (a === "agents" && id === "refresh" && method === "POST") return engine.refreshAgents();
  if (a === "agents" && id && b === "models" && method === "GET") return engine.listModels(id);
  if (a === "notify" && id === "test" && method === "POST") {
    engine.notifier?.send("Toryo", "Test notification: this is how Toryo tells you something needs you.");
    return { ok: true };
  }
  // Home: every room at a glance, and Recent page by page (?before=<the last page's `next`>&limit=40).
  if (a === "home" && !id && method === "GET") return engine.home({ recent: Number(url.searchParams.get("recent") ?? 40) || 40 });
  if (a === "feed" && !id && method === "GET") return engine.feed({ limit: Number(url.searchParams.get("limit") ?? 40) || 40, before: url.searchParams.get("before") || null });
  // Desk-wide controls: Pause everything, holds on agents ({ action, target, headless }); see Engine.deskControl.
  if (a === "desk" && !id && method === "GET") return engine.deskView();
  if (a === "desk" && !id && method === "POST") return engine.deskControl(body.action, body);
  if (a === "codexapp" && id === "threads" && method === "GET") return listAppThreads(engine.config.agents.codexapp ?? {});
  if (a === "projects") {
    if (!id && method === "POST") return engine.addProject(body);
    if (id && !b && method === "PATCH") return engine.updateProject(id, body);
    if (id && b === "file" && method === "GET") return engine.readProjectFile(id, url.searchParams.get("path") ?? "");
    // Where a new room would work: the project's folder, or its own worktree (with the id the room would have).
    if (id && b === "workspace" && method === "GET") return engine.previewWorkspace(id);
    // What a new worktree of the project gets: the files its copy patterns match now (names only), and its setup.
    if (id && b === "worktree-files" && method === "GET") return engine.worktreeFiles(id, url.searchParams.has("copy") ? { copy: url.searchParams.getAll("copy").filter(Boolean) } : {});
  }
  if (a === "rooms") {
    if (!id && method === "POST") return engine.createRoom(body);
    if (!id) throw new UserError("Not found", 404);
    if (!b && method === "GET") return engine.roomView(id);
    if (!b && method === "DELETE") return engine.deleteRoom(id);
    if (b === "messages" && method === "POST") return engine.postMessage(id, body);
    // An answer names its question, so it can never land on a different one that opened since.
    if (b === "answer" && method === "POST") {
      if (!body?.questionId) throw new UserError("Say which question you're answering (questionId). The room lists its open questions with their ids.");
      return engine.answer(id, body);
    }
    // A note still waiting for its agents: change it (PATCH, { text }) or withdraw it (DELETE).
    if (b === "notes" && c && method === "PATCH") return engine.editNote(id, c, { text: body.text });
    if (b === "notes" && c && method === "DELETE") return engine.editNote(id, c, { cancel: true });
    if (b === "control" && method === "POST") {
      // These act on one question too (a failed turn, a planning round's checkpoint, a ready plan): they must name it.
      if (["retry", "synthesize", "accept-checkpoint", "plan-check", "forward-discussion"].includes(body.action) && !body.questionId)
        throw new UserError("Say which question this is for (questionId). The room lists its open questions with their ids.");
      return engine.control(id, body.action, body);
    }
    if (b === "plan" && method === "GET") return engine.planView(id);
    // The room's worktree setup: its command, state, attempts and what each printed. Retry: control "retry-setup".
    if (b === "setup" && method === "GET") return engine.setupView(id);
    // Where the room's next build would work (its own worktree, or the project's folder), with the exact folders.
    if (b === "workspace" && method === "GET") return engine.roomWorkspace(id);
    // A file in the folder the room works in (its own worktree, or the project's).
    if (b === "file" && method === "GET") return engine.readRoomFile(id, url.searchParams.get("path") ?? "");
    if (b === "turns" && c && d === "diff" && method === "GET") return engine.turnDiff(id, c, url.searchParams.get("path") || undefined);
    if (b === "turns" && c && d === "prompt" && method === "GET") return { __text: engine.turnPrompt(id, c) };
  }
  throw new UserError("Not found", 404);
}

function authorised(req, url, token) {
  if (url.searchParams.get("token") === token) return true;
  if (req.headers["x-toryo-token"] === token || req.headers["x-foreman-token"] === token) return true;
  const cookie = req.headers.cookie ?? "";
  const parts = cookie.split(/;\s*/);
  return parts.includes(`toryo=${token}`) || parts.includes(`foreman=${token}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 4_000_000) {
        reject(new UserError("Request too large.", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new UserError("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function text(res, status, value) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}
