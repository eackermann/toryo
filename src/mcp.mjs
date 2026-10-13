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
    description: "Answer the question a room is waiting on. Set accept to take the asking agent's recommendation.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" }, accept: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "toryo_control",
    description: "Pause, resume or stop a room.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "stop"] } },
      required: ["action"],
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
            text = await client.answer(a.room, a.text ?? "", { accept: Boolean(a.accept) });
            break;
          case "toryo_control":
            text = await client.control(a.room, a.action);
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
