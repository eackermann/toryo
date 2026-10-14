import { createInterface } from "node:readline";
import { ToryoClient } from "./client.mjs";

/**
 * A minimal MCP server (stdio, newline-delimited JSON-RPC) that lets any MCP
 * client, such as a Claude Code session you reach through Remote Control or the
 * Codex app, read Toryo's rooms and act on them.
 */
const TOOLS = [
  {
    name: "toryo_status",
    description: "List Toryo rooms: mode, status, who is working, and any question waiting for the owner.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "toryo_room",
    description: "Show a room's state and its most recent messages. Room is an id or part of its title; empty means the most recently active room.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        last: { type: "number", description: "How many recent items (default 8)" },
        full: { type: "boolean", description: "Include whole messages instead of excerpts" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toryo_say",
    description:
      "Send the owner's note to the crew in a room. `to` is auto, everyone, codex, claude, cursor or grok. `now` interrupts a running turn. `intent`: ask (a question that needs an answer) or tell (an instruction); left out, a question mark or a question means ask.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" }, to: { type: "string" }, now: { type: "boolean" }, intent: { type: "string", enum: ["ask", "tell"] } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "toryo_answer",
    description:
      "Answer a question a room is waiting on. Set accept to take the asking agent's recommendation. `question` is the id of the question you're answering (toryo_status and toryo_room list them); it can be left out only when just one question is open (in the room named, or in any room when no room is named).",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" }, accept: { type: "boolean" }, question: { type: "string" }, wait: { type: "boolean", description: "Accepting a ready plan starts its build: if another room is building in the same folder, wait for it" } },
      additionalProperties: false,
    },
  },
  {
    name: "toryo_plan",
    description:
      "Act on a plan that's ready to build. action check: the other planners (or `checkers`) check it, read-only, and the author addresses what they find. action forward: the owner's discussion with one planner since the plan was ready (`from`; can be left out when there's only one other planner) goes to the author as a change request. `question` is the id of the plan's Ready card (toryo_status lists it); it can be left out when only one plan is ready.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        action: { type: "string", enum: ["check", "forward"] },
        question: { type: "string" },
        from: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] },
        checkers: { type: "array", items: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] } },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "toryo_desk",
    description:
      "Desk-wide controls, across every room. pause: Pause everything (running turns and checks finish, nothing new starts). resume: undo that. hold / release: an agent (`target`: codex covers both headless Codex and the Codex app, codexapp the app only, claude…; `headless` with codex: headless Codex only). A release says what the usage guard still holds, with the toryo_guard arguments to pause that guard until its reset. use-folder / release-folder: you're using a project's folder yourself (an editor, the Codex app on its own), so Toryo starts nothing new in it until you release it (`project`: its id or name; the first project when left out).",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["pause", "resume", "hold", "release", "use-folder", "release-folder"] }, target: { type: "string" }, headless: { type: "boolean" }, project: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "toryo_guard",
    description:
      "The usage guard: it holds an agent's allowance when a limit window reaches its threshold (90% of the 5-hour and weekly windows unless changed) and lets it go at reset. action show (the default with nothing to change): its rules and what it holds. set: change the rules for `target` (an agent; left out, every agent) with fiveHour / weekly (a percentage, or \"off\"), rules ({ <window>: { enabled, at } }), autoRelease, or enabled (every rule on or off). pause-until-reset: let `target` run until `window` (\"5-hour\", \"weekly\") resets. release-expired-hold: release a hold whose window has reset (when automatic release is off). ok: hide the note about the guard.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "set", "pause-until-reset", "release-expired-hold", "ok"] },
        target: { type: "string" },
        window: { type: "string" },
        fiveHour: { type: ["number", "string"] },
        weekly: { type: ["number", "string"] },
        rules: { type: "object" },
        autoRelease: { type: "boolean" },
        enabled: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toryo_control",
    description: "Pause, resume or stop one room. (Pause everything, across rooms, is toryo_desk.)",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "stop"] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "toryo_session_new",
    description:
      "Start a new session in a room, for new work such as planning the next sprint: the session it's in ends (its planning round or build, and its open questions), its history stays, and each agent starts fresh unless keepMemory (the Codex app keeps its thread). Refused while anything runs or is queued in the room. Optionally start the first step: a message (chat), a planning topic (plan) or a build task (build).",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room id or part of its title; defaults to the most recent room" },
        keepMemory: { type: "boolean", description: "Keep the agents' memory of the earlier sessions" },
        mode: { type: "string", enum: ["chat", "plan", "build"], description: "A first step, optional" },
        text: { type: "string", description: "The message, planning topic or build task" },
        planPath: { type: "string" },
        builder: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] },
        reviewer: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] },
        wait: { type: "boolean", description: "A build as first step: if another room is building in the same folder, wait for it" },
        folder: { type: "string", enum: ["own", "shared"], description: "A build as first step: in the room's own worktree, or in the project's folder (shared). By default the room stays where it is" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toryo_start",
    description:
      "Start a new room: chat (a question for the crew), plan (a planning round on a topic) or build (a task, optionally with a plan file). For a build whose builder already finished a round, set reviewFirst: the reviewer goes first, using handoff (or, with the Codex app as builder, the thread's last reply).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["chat", "plan", "build"] },
        text: { type: "string", description: "The question, planning topic or build task" },
        planPath: { type: "string" },
        project: { type: "string", description: "Project id or name; defaults to the first project" },
        title: { type: "string" },
        builder: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] },
        reviewer: { type: "string", enum: ["codex", "claude", "cursor", "grok", "codexapp"] },
        reviewFirst: { type: "boolean", description: "Build only: start by reviewing work the builder already handed over" },
        handoff: { type: "string", description: "The builder's handoff message, for reviewFirst" },
        slice: { type: "string" },
        appThread: { type: "string", description: "With the Codex app in the crew: its thread id for this room (defaults to the project's, then the global default)" },
        wait: { type: "boolean", description: "Build only: if another room is building in the same folder, wait for it instead of being refused" },
        folder: { type: "string", enum: ["own", "shared"], description: "Build only: work in the room's own worktree (a separate copy of the project's folder, uncommitted changes included; the default for a crew without the Codex app, in a Git project) or in the project's folder, shared" },
      },
      required: ["mode", "text"],
      additionalProperties: false,
    },
  },
];

export function runMcpServer(client = new ToryoClient()) {
  const rl = createInterface({ input: process.stdin });
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications
    try {
      if (method === "initialize")
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "toryo", version: "0.1.0" },
            instructions: "Toryo relays work between coding agents. Use toryo_status first, then toryo_room for details.",
          },
        });
      if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "tools/call") {
        const a = params?.arguments ?? {};
        let text;
        switch (params?.name) {
          case "toryo_status":
            text = await client.statusText();
            break;
          case "toryo_room":
            text = await client.roomText(a.room, { last: a.last ?? 8, full: Boolean(a.full) });
            break;
          case "toryo_say":
            text = await client.say(a.room, a.text, { to: a.to ?? "auto", now: Boolean(a.now), intent: a.intent });
            break;
          case "toryo_answer":
            text = await client.answer(a.room, a.text ?? "", { accept: Boolean(a.accept), question: a.question, wait: Boolean(a.wait) });
            break;
          case "toryo_plan":
            text = await client.plan(a.room, a.action, { question: a.question, from: a.from, checkers: a.checkers });
            break;
          case "toryo_desk":
            text = await client.desk(a.action, { target: a.target, headless: Boolean(a.headless), project: a.project });
            break;
          case "toryo_guard": {
            const action = a.action ?? (a.rules || a.fiveHour != null || a.weekly != null || a.autoRelease != null || a.enabled != null ? "set" : "show");
            text = await client.guard({
              target: a.target,
              ok: action === "ok",
              pauseUntilReset: action === "pause-until-reset",
              releaseExpired: action === "release-expired-hold",
              window: action === "pause-until-reset" || action === "release-expired-hold" ? a.window : undefined,
              ...(action === "set" ? { fiveHour: a.fiveHour, weekly: a.weekly, rules: a.rules, autoRelease: a.autoRelease, enabled: a.enabled } : {}),
            });
            break;
          }
          case "toryo_control":
            text = await client.control(a.room, a.action);
            break;
          case "toryo_session_new":
            text = await client.newSession(a.room, a);
            break;
          case "toryo_start":
            text = await client.start(a);
            break;
          default:
            return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        }
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      }
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (error) {
      if (method === "tools/call")
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error.message }], isError: true } });
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
    }
  });
}
