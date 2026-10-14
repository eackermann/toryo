import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { codexapp } from "../src/agents/codexapp.mjs";
import { runAgentProcess } from "../src/agents/proc.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { setup, turns, waitFor } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real snapshots, but slow to take (a turn stays "being prepared" for a while), and failing on request. */
function slowSnapshots(home, { delayMs = 300, fail = () => false } = {}) {
  const real = new Snapshots(home);
  return {
    take: async (project, label) => {
      await sleep(delayMs);
      if (fail(label)) throw new Error("the snapshot failed");
      return real.take(project, label);
    },
    changes: (...a) => real.changes(...a),
    diff: (...a) => real.diff(...a),
    hint: (...a) => real.hint(...a),
  };
}

async function engineWith(t, adapters, snapshots) {
  t.engine.shutdown();
  const e = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: snapshots ?? new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, ...adapters } });
  await e.init({ detect: false });
  return e;
}

/** An in-process Codex app: each send or follow is recorded; `respond(call)` settles it (or it waits for `settle`). */
function fakeApp(respond = () => null) {
  const calls = [];
  const app = {
    ...ADAPTERS.codexapp,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) =>
      new Promise((resolve) => {
        const call = { how: args.attach ? "follow" : "send", thread: args.sessionId, prompt: args.prompt, args, settle: resolve };
        calls.push(call);
        args.signal?.addEventListener("abort", () => args.signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
        args.abandon?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
        const r = respond(call);
        if (r) resolve(r);
      }),
  };
  return { app, calls };
}

test("Pause everything or a hold that comes while a turn is being prepared sends it back unsent; its notes arrive with the later run", async () => {
  for (const how of ["hold", "pause"]) {
    const t = await setup([]);
    try {
      const sent = [];
      const codex = { ...ADAPTERS.codex, detect: async () => ({ installed: true }), run: async ({ prompt }) => (sent.push(prompt), { text: "Done.\nTORYO: REPLY", sessionId: "s" }) };
      const e = await engineWith(t, { codex }, slowSnapshots(t.home));
      const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "NOTE-ONE" });
      assert.equal(e.roomView(room.id).live[0]?.phase, "preparing");
      if (how === "hold") e.deskControl("hold", { target: "codex" });
      else e.deskControl("pause");
      await waitFor(() => turns(e, room.id).some((x) => x.state === "deferred"), { label: `${how}: sent back` });
      const [deferred] = turns(e, room.id);
      assert.match(deferred.error, how === "hold" ? /Not sent: you hold Codex/ : /Not sent: everything is paused/);
      assert.deepEqual(sent, [], "nothing reached the agent");
      assert.equal(e.rooms.get(room.id).queue.length, 1);
      assert.equal(e.summary(e.rooms.get(room.id)).status, "held");
      e.postMessage(room.id, { text: "NOTE-TWO", to: "codex" });
      e.deskControl(how === "hold" ? "release" : "resume", { target: "codex" });
      await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: `${how}: ran` });
      assert.equal(sent.length, 1, "sent once");
      assert.match(sent[0], /NOTE-ONE/);
      assert.match(sent[0], /NOTE-TWO/);
      e.shutdown();
    } finally {
      t.cleanup();
    }
  }
});

test("a turn stopped before it launches starts no process, and no message goes to the Codex app", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-boundary-"));
  try {
    const stopped = new AbortController();
    stopped.abort("stop");
    const marker = join(base, "launched");
    const r = await runAgentProcess({ command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], args: [], cwd: base, stdin: "", signal: stopped.signal });
    assert.equal(r.aborted, true);
    await sleep(200);
    assert.equal(existsSync(marker), false, "no process ran");

    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-13T00-00-00-t1.jsonl"), "");
    const exe = join(base, "codex.exe");
    const log = join(base, "queued.log");
    writeFileSync(exe, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
    chmodSync(exe, 0o755);
    let submitting = 0;
    const turnDir = join(base, "turn");
    mkdirSync(turnDir);
    const result = await codexapp.run({ cfg: { exe, codexHome: home, thread: "t1" }, prompt: "Do it.", sessionId: "t1", turnDir, signal: stopped.signal, abandon: new AbortController().signal, onSubmitting: () => submitting++ });
    assert.equal(result.aborted, true);
    assert.equal(existsSync(log), false, "codex queue never ran");
    assert.equal(submitting, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the Codex app doesn't open its thread while it's held, and does once it's released", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-boundary-"));
  try {
    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, "rollout-2026-10-13T00-00-00-t1.jsonl");
    writeFileSync(rollout, "");
    const exe = join(base, "codex.exe");
    writeFileSync(exe, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(join(base, "queued"))}, process.argv[process.argv.indexOf("--message") + 1]);\n`);
    chmodSync(exe, 0o755);
    let held = true;
    const opened = [];
    const open = (id) => {
      opened.push(id);
      const msg = readFileSync(join(base, "queued"), "utf8");
      appendFileSync(rollout, [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } }, { type: "event_msg", payload: { type: "task_complete", last_agent_message: "ok\nTORYO: REPLY" } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
      return true;
    };
    const turnDir = join(base, "turn");
    mkdirSync(turnDir);
    const running = codexapp.run({ cfg: { exe, codexHome: home, thread: "t1", openAfterMs: 100, pollMs: 50, open }, prompt: "Hi.", sessionId: "t1", turnDir, canOpen: () => !held, timeoutMs: 20_000 });
    await sleep(500);
    assert.deepEqual(opened, [], "held: not opened");
    held = false;
    const result = await running;
    assert.deepEqual(opened, ["t1"]);
    assert.equal(result.text, "ok\nTORYO: REPLY");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("rooms on one Codex app thread take turns; rooms on different threads run together", async () => {
  const t = await setup([]);
  try {
    const { app, calls } = fakeApp();
    const e = await engineWith(t, { codexapp: app });
    // Each in a folder of its own: work handed to the Codex app counts as writing, and writers in one folder take turns.
    const room = (thread, projectId) => e.createRoom({ projectId, mode: "chat", members: ["codexapp"], appThread: thread, settings: { snapshots: false } });
    const a = room("t1", "repo");
    const b = room("t2", t.project("second", e));
    const c = room("t1", t.project("third", e));
    for (const r of [a, b, c]) e.postMessage(r.id, { text: "Go.", to: "codexapp" });
    assert.deepEqual(calls.map((x) => x.thread).sort(), ["t1", "t2"], "t2 runs beside t1; the second t1 room waits");
    calls[0].args.onSubmitted();
    calls[0].settle({ text: "ok\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => calls.length === 3, { label: "the t1 room that waited" });
    assert.equal(calls[2].thread, "t1");
    for (const x of calls.slice(1)) x.settle({ text: "ok\nTORYO: REPLY", sessionId: x.thread });
    await waitFor(() => [a, b, c].every((r) => turns(e, r.id).some((x) => x.state === "done")), { label: "all done" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a turn the app already has is followed after a restart, even held and in a paused room, and finishes without being sent again", async () => {
  const t = await setup([]);
  try {
    const first = fakeApp();
    let e = await engineWith(t, { codexapp: first.app });
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false }, text: "Build it." });
    await waitFor(() => first.calls.length === 1, { label: "sent" });
    first.calls[0].args.onSubmitted();
    e.deskControl("hold", { target: "codexapp" });
    e.control(room.id, "pause");
    e.shutdown();
    await waitFor(() => !e.running.size, { label: "stopped" });

    // The app finished while Toryo was down: following it again finds the end straight away.
    const second = fakeApp((call) => (call.how === "follow" ? { text: "Finished in the app.\nTORYO: REPLY", sessionId: "t1" } : null));
    e = await engineWith(t, { codexapp: second.app });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "followed to the end" });
    assert.deepEqual(second.calls.map((c) => c.how), ["follow"], "followed, never sent again");
    assert.equal(e.rooms.get(room.id).appTurn, null, "the thread is free again");
    assert.equal(e.deskView().holds[0].key, "codexapp", "still held");
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("the app saying twice that it has the message, or that it started, counts once", async () => {
  const t = await setup([]);
  try {
    const { app, calls } = fakeApp();
    const e = await engineWith(t, { codexapp: app });
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false }, text: "Hi." });
    await waitFor(() => calls.length === 1, { label: "sent" });
    const { args } = calls[0];
    args.onSubmitted();
    const appTurn = e.rooms.get(room.id).appTurn;
    const [ev] = turns(e, room.id);
    const submittedAt = ev.submittedAt;
    args.onSubmitted();
    args.onStarted({ sessionId: "t1" });
    const pickedUpAt = ev.pickedUpAt;
    args.onStarted({ sessionId: "t1" });
    assert.equal(e.rooms.get(room.id).appTurn, appTurn, "the same kept turn");
    assert.equal(ev.submittedAt, submittedAt);
    assert.equal(ev.pickedUpAt, pickedUpAt);
    const seen = e.rooms.get(room.id).seen.codexapp;
    assert.equal(new Set(seen).size, seen.length, "nothing marked read twice");
    assert.equal(e.roomView(room.id).live[0].phase, "working");
    calls[0].settle({ text: "ok\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "done" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a crash while handing a message to the app keeps its thread reserved and never sends it again; the turn is followed if the app has it", async () => {
  const t = await setup([]);
  try {
    // The first desk stops while `codex queue` runs: it was told it was being sent, never that it arrived.
    const first = fakeApp((call) => (call.args.onSubmitting(), null));
    let e = await engineWith(t, { codexapp: first.app });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    e.postMessage(a.id, { text: "ROOM-A", to: "codexapp" });
    await waitFor(() => first.calls.length === 1, { label: "sending" });
    assert.equal(e.roomView(a.id).live[0].phase, "sending");
    e.shutdown();
    await waitFor(() => !e.running.size, { label: "stopped" });

    const second = fakeApp();
    e = await engineWith(t, { codexapp: second.app });
    e.postMessage(b.id, { text: "ROOM-B", to: "codexapp" });
    await waitFor(() => second.calls.length === 1, { label: "following A" });
    assert.equal(second.calls[0].how, "follow", "A's message is watched for, not sent again");
    assert.equal(e.rooms.get(a.id).appTurn.uncertain, true);
    assert.ok(e.roomView(a.id).events.some((x) => x.type === "system" && /can't tell whether the app has it/.test(x.text)));
    await sleep(100);
    assert.equal(second.calls.length, 1, "B waits: the thread stays reserved");
    // The app had it after all: its turn appears and ends; then B goes.
    second.calls[0].settle({ text: "A done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => second.calls.length === 2, { label: "B sent" });
    assert.match(second.calls[1].prompt, /ROOM-B/);
    assert.equal(second.calls.filter((c) => c.how === "send" && /ROOM-A/.test(c.prompt)).length, 0);
    second.calls[1].settle({ text: "B done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => turns(e, b.id).some((x) => x.state === "done"), { label: "B done" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("when following an app turn times out, the thread stays reserved until that turn is settled", async () => {
  const t = await setup([]);
  try {
    const { app, calls } = fakeApp();
    const e = await engineWith(t, { codexapp: app });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    e.postMessage(a.id, { text: "A.", to: "codexapp" });
    await waitFor(() => calls.length === 1, { label: "A sent" });
    calls[0].args.onSubmitted();
    e.postMessage(b.id, { text: "B.", to: "codexapp" });
    calls[0].settle({ text: "", sessionId: "t1", error: "Timed out following the Codex app.", timedOut: true });
    await waitFor(() => e.rooms.get(a.id).waiting?.kind === "app-lost", { label: "asked what to do" });
    await sleep(100);
    assert.equal(calls.length, 1, "B still waits");
    assert.ok(e.rooms.get(a.id).appTurn.lost);
    // Follow it again: it ends, and the thread is free for B.
    e.answer(a.id, { accept: true });
    await waitFor(() => calls.length === 2, { label: "following again" });
    assert.equal(calls[1].how, "follow");
    calls[1].settle({ text: "A done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => calls.length === 3, { label: "B sent" });
    assert.equal(calls[2].how, "send");
    calls[2].settle({ text: "B done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => turns(e, b.id).some((x) => x.state === "done"), { label: "B done" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a turn whose preparation fails frees the thread it hadn't used, and the room waiting for it goes", async () => {
  const t = await setup([]);
  try {
    const { app, calls } = fakeApp((call) => ({ text: "ok\nTORYO: REPLY", sessionId: call.thread }));
    let failNext = true;
    const snapshots = slowSnapshots(t.home, { delayMs: 150, fail: () => failNext && !(failNext = false) });
    const e = await engineWith(t, { codexapp: app }, snapshots);
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1" });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1" });
    e.postMessage(a.id, { text: "A.", to: "codexapp" });
    e.postMessage(b.id, { text: "B.", to: "codexapp" });
    await waitFor(() => e.rooms.get(a.id).waiting?.kind === "error", { label: "A's turn failed" });
    await waitFor(() => turns(e, b.id).some((x) => x.state === "done"), { label: "B ran" });
    assert.equal(calls.length, 1);
    assert.equal(e.rooms.get(a.id).appTurn ?? null, null, "nothing kept for a turn the app never had");
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("handing a message to the app with no answer keeps its thread and watches for it; a proven failure is retried", async () => {
  // Returned without an answer (codex queue ran out of time), and thrown mid-hand-over: both are watched for, never resent.
  for (const how of ["returned", "thrown"]) {
    const t = await setup([]);
    try {
      const { app, calls } = fakeApp((call) => {
        if (call.how !== "send" || !/ROOM-A/.test(call.prompt)) return null;
        call.args.onSubmitting();
        if (how === "thrown") throw new Error("the queue command blew up");
        return { text: "", sessionId: "t1", uncertain: true, error: "codex queue didn't finish (ETIMEDOUT), so Toryo can't tell whether the Codex app has the message." };
      });
      const e = await engineWith(t, { codexapp: app });
      const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
      const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
      e.postMessage(a.id, { text: "ROOM-A", to: "codexapp" });
      e.postMessage(b.id, { text: "ROOM-B", to: "codexapp" });
      await waitFor(() => calls.some((c) => c.how === "follow"), { label: `${how}: watched for` });
      assert.equal(e.rooms.get(a.id).appTurn.uncertain, true, how);
      assert.ok(e.roomView(a.id).events.some((x) => x.type === "system" && /couldn't tell whether the Codex app got its message/.test(x.text)), how);
      await sleep(100);
      assert.deepEqual(calls.map((c) => c.how), ["send", "follow"], `${how}: A once, then watched; B waits`);
      calls[1].settle({ text: "A done.\nTORYO: REPLY", sessionId: "t1" });
      await waitFor(() => calls.length === 3, { label: `${how}: B sent` });
      assert.match(calls[2].prompt, /ROOM-B/);
      assert.equal(calls.filter((c) => c.how === "send" && /ROOM-A/.test(c.prompt)).length, 1, `${how}: A never sent twice`);
      calls[2].settle({ text: "B done.\nTORYO: REPLY", sessionId: "t1" });
      await waitFor(() => turns(e, b.id).some((x) => x.state === "done"), { label: `${how}: B done` });
      e.shutdown();
    } finally {
      t.cleanup();
    }
  }

  // The queue command said it failed: the app doesn't have it, so the usual retry sends it again.
  const t = await setup([]);
  try {
    const { app, calls } = fakeApp((call) => (call.args.onSubmitting(), { text: "", error: "codex queue failed: no such thread" }));
    const e = await engineWith(t, { codexapp: app });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false }, text: "ROOM-A" });
    await waitFor(() => e.rooms.get(a.id).waiting?.kind === "error", { label: "asked after the retry" });
    assert.deepEqual(calls.map((c) => c.how), ["send", "send"]);
    assert.equal(e.rooms.get(a.id).appTurn ?? null, null, "nothing kept for a message the app never got");
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("the app adapter: a queue command that runs out of time is uncertain; one that fails, or can't run, is a plain failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-boundary-"));
  try {
    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-13T00-00-00-t1.jsonl"), "");
    const exe = (name, body) => {
      const p = join(base, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const run = async (path) => {
      const turnDir = mkdtempSync(join(base, "turn-"));
      let submitting = 0;
      const r = await codexapp.run({ cfg: { exe: path, codexHome: home, thread: "t1", queueTimeoutMs: 300 }, prompt: "Hi.", sessionId: "t1", turnDir, onSubmitting: () => submitting++ });
      return { ...r, submitting };
    };
    const slow = await run(exe("slow.exe", "sleep 3"));
    assert.equal(slow.uncertain, true);
    assert.match(slow.error, /didn't finish \(ETIMEDOUT\)/);
    assert.equal(slow.submitting, 1);
    const failed = await run(exe("fail.exe", 'echo "no such thread" >&2; exit 3'));
    assert.equal(failed.uncertain, undefined);
    assert.match(failed.error, /codex queue failed: no such thread/);
    const missing = await run(join(base, "nowhere.exe"));
    assert.equal(missing.uncertain, undefined);
    assert.match(missing.error, /codex queue failed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Cursor held (or everything paused) while it creates its chat launches nothing; on release it's sent exactly once, with every note", async () => {
  for (const how of ["hold", "pause"]) {
    const t = await setup([]);
    const logDir = mkdtempSync(join(tmpdir(), "toryo-cursor-log-"));
    try {
      const bin = join(logDir, "agent");
      const log = join(logDir, "launches.jsonl");
      writeFileSync(
        bin,
        `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake 1"); process.exit(0); }
if (args[0] === "create-chat") { setTimeout(() => { console.log("chat-1"); process.exit(0); }, 400); }
else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.at(-1)) + "\\n");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok\\nTORYO: REPLY", session_id: "chat-1" }));
}
`,
      );
      chmodSync(bin, 0o755);
      writeFileSync(join(logDir, "package.json"), JSON.stringify({ type: "commonjs" }));
      const e = await engineWith(t, {});
      e.updateConfig({ agents: { cursor: { command: [process.execPath, bin] } } });
      const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["cursor"], settings: { snapshots: false }, text: "NOTE-ONE" });
      await sleep(150); // creating its chat now
      if (how === "hold") e.deskControl("hold", { target: "cursor" });
      else e.deskControl("pause");
      await waitFor(() => turns(e, room.id).some((x) => x.state === "deferred"), { label: `${how}: sent back` });
      await sleep(200);
      assert.equal(existsSync(log), false, `${how}: Cursor never launched`);
      e.postMessage(room.id, { text: "NOTE-TWO", to: "cursor" });
      e.deskControl(how === "hold" ? "release" : "resume", { target: "cursor" });
      await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: `${how}: ran` });
      const launches = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(launches.length, 1, `${how}: launched once`);
      assert.match(launches[0], /NOTE-ONE/);
      assert.match(launches[0], /NOTE-TWO/);
      e.shutdown();
    } finally {
      t.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  }
});

test("a queue command that runs out of time and exits with its own code is still uncertain", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-boundary-"));
  try {
    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-13T00-00-00-t1.jsonl"), "");
    const exe = join(base, "trap.exe");
    // Catches the stop and exits 7, as a CLI that cleans up on SIGTERM might.
    writeFileSync(exe, "#!/bin/sh\ntrap 'exit 7' TERM\nsleep 5 &\nwait\n");
    chmodSync(exe, 0o755);
    const turnDir = mkdtempSync(join(base, "turn-"));
    const r = await codexapp.run({ cfg: { exe, codexHome: home, thread: "t1", queueTimeoutMs: 300 }, prompt: "Hi.", sessionId: "t1", turnDir });
    assert.equal(r.uncertain, true);
    assert.match(r.error, /didn't finish \(ETIMEDOUT\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Copy Toryo's data folder the moment `when(event)` has just been written: what a desk restarted right then would find. */
function imageAt(store, when, { before = false } = {}) {
  const image = mkdtempSync(join(tmpdir(), "toryo-crash-"));
  let taken = false;
  const real = store.appendEvent.bind(store);
  const take = (event) => {
    if (taken || !when(event)) return;
    cpSync(store.home, image, { recursive: true });
    taken = true;
  };
  store.appendEvent = (roomId, event) => {
    if (before) take(event);
    real(roomId, event);
    if (!before) take(event);
  };
  return { image, taken: () => taken };
}

/** Start a desk from a crash image and check that A's message is watched for, never sent again, and B waits for it. */
async function checkImage(image, a, b) {
  const { app, calls } = fakeApp();
  const e = new Engine({ folderDefault: "shared", store: new Store(image), snapshots: new Snapshots(image), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
  await e.init({ detect: false });
  try {
    await waitFor(() => calls.length >= 1, { label: "something started after the restart" });
    await sleep(100);
    assert.deepEqual(calls.map((c) => c.how), ["follow"], "A is followed, B waits");
    assert.equal(e.rooms.get(a.id).appTurn.uncertain, true);
    calls[0].settle({ text: "A done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => calls.length === 2, { label: "B sent" });
    assert.match(calls[1].prompt, /ROOM-B/);
    calls[1].settle({ text: "B done.\nTORYO: REPLY", sessionId: "t1" });
    await waitFor(() => turns(e, b.id).some((x) => x.state === "done"), { label: "B done" });
  } finally {
    e.shutdown();
    rmSync(image, { recursive: true, force: true });
  }
}

test("a stop right after a hand-over's end is recorded keeps the thread: returned uncertain, or thrown", async () => {
  for (const how of ["returned", "thrown"]) {
    const t = await setup([]);
    try {
      const { app } = fakeApp((call) => {
        if (call.how !== "send" || !/ROOM-A/.test(call.prompt)) return null;
        call.args.onSubmitting();
        if (how === "thrown") throw new Error("the queue command blew up");
        return { text: "", sessionId: "t1", uncertain: true, error: "codex queue didn't finish (ETIMEDOUT)" };
      });
      const e = await engineWith(t, { codexapp: app });
      const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
      const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
      const crash = imageAt(e.store, (ev) => ev.state === "failed");
      // A is handed over and ends without an answer; B queues behind it on the same thread.
      e.postMessage(a.id, { text: "ROOM-A", to: "codexapp" });
      e.postMessage(b.id, { text: "ROOM-B", to: "codexapp" });
      await waitFor(() => crash.taken(), { label: `${how}: A's end recorded` });
      e.shutdown();
      await checkImage(crash.image, a, b);
    } finally {
      t.cleanup();
    }
  }
});

test("a stop during recovery, right after an app turn is marked interrupted, keeps the thread", async () => {
  const t = await setup([]);
  try {
    const first = fakeApp((call) => (call.args.onSubmitting(), null));
    const e = await engineWith(t, { codexapp: first.app });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    e.postMessage(a.id, { text: "ROOM-A", to: "codexapp" });
    await waitFor(() => first.calls.length === 1, { label: "handing over" });
    e.postMessage(b.id, { text: "ROOM-B", to: "codexapp" });
    e.shutdown();
    await waitFor(() => !e.running.size, { label: "stopped" });
    // The next desk recovers, and stops right after recording that A's turn was interrupted.
    const store = new Store(t.home);
    const crash = imageAt(store, (ev) => ev.state === "interrupted");
    const second = new Engine({ folderDefault: "shared", store, snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: fakeApp().app } });
    await second.init({ detect: false });
    second.shutdown();
    assert.ok(crash.taken());
    await checkImage(crash.image, a, b);
  } finally {
    t.cleanup();
  }
});

test("a stop just after a turn's end is recorded: the next step happens once, for the Codex app or a headless builder", async () => {
  const cases = [
    ["app review", "codexapp", "Built.\nTORYO: REVIEW S1 | h.md"],
    ["app question", "codexapp", "One question first.\nTORYO: OWNER Tabs or spaces?"],
    ["headless review", "codex", "Built.\nTORYO: REVIEW S1 | h.md"],
  ];
  for (const [name, builder, reply] of cases) {
    const t = await setup([{ agent: "claude", reply: "Reviewed.\nTORYO: OWNER Ship it?" }]);
    try {
      const pending = [];
      const builderAdapter = (id) => ({
        ...ADAPTERS[id],
        detect: async () => ({ installed: true }),
        currentLimits: () => null,
        run: (args) => new Promise((resolve) => {
          if (id === "codexapp" && !args.attach) args.onSubmitted?.();
          pending.push(() => resolve({ text: reply, sessionId: id === "codexapp" ? "t1" : "s1" }));
        }),
      });
      const e = await engineWith(t, { [builder]: builderAdapter(builder) });
      const room = e.createRoom({ projectId: "repo", mode: "build", members: [builder, "claude"], builder, reviewer: "claude", task: "x", appThread: builder === "codexapp" ? "t1" : undefined, settings: { snapshots: false } });
      await waitFor(() => pending.length === 1, { label: `${name}: building` });
      const crash = imageAt(e.store, (ev) => ev.type === undefined && ev.state === "done");
      pending[0]();
      await waitFor(() => crash.taken(), { label: `${name}: end recorded` });
      e.shutdown();

      const follows = [];
      const again = new Engine({
        folderDefault: "shared",
        store: new Store(crash.image),
        snapshots: new Snapshots(crash.image),
        notifier: { send() {} },
        adapters: { ...ADAPTERS, [builder]: { ...builderAdapter(builder), run: (args) => (follows.push(args), new Promise(() => {})) } },
      });
      await again.init({ detect: false });
      try {
        const r = () => again.rooms.get(room.id);
        if (/review/.test(name)) {
          await waitFor(() => r().waiting?.kind === "review-owner", { label: `${name}: reviewed after the restart` });
          assert.deepEqual(turns(again, room.id).map((x) => `${x.agent}:${x.kind}:${x.status ?? x.state}`), [`${builder}:build:REVIEW`, "claude:review:OWNER"]);
        } else {
          await waitFor(() => r().waiting?.kind === "build-owner", { label: `${name}: asked after the restart` });
          assert.match(r().waiting.question, /Tabs or spaces\?/);
          assert.equal(again.roomView(room.id).events.filter((x) => x.type === "question" && x.open).length, 1, `${name}: asked once`);
        }
        assert.deepEqual(follows, [], `${name}: the builder's turn isn't run or followed again`);
        assert.equal(r().appTurn ?? null, null);
        assert.equal(r().pendingOutcome, null);
        assert.ok(again.roomView(room.id).events.some((x) => x.type === "system" && /stopped just as .* turn ended/.test(x.text)));
      } finally {
        again.shutdown();
        rmSync(crash.image, { recursive: true, force: true });
      }
    } finally {
      t.cleanup();
    }
  }
});

test("a stop during recovery, after the interrupted turn is offered again but before it's marked: offered once, run once", async () => {
  const t = await setup([]);
  try {
    const launches = [];
    const codex = (respond) => ({ ...ADAPTERS.codex, detect: async () => ({ installed: true }), run: (args) => (launches.push(args.prompt), new Promise((resolve) => respond(resolve, args))) });
    // The first desk stops while Codex is working.
    let e = await engineWith(t, { codex: codex((resolve, args) => args.signal.addEventListener("abort", () => resolve({ text: "", aborted: true }))) });
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], settings: { snapshots: false }, text: "WORK-1" });
    await waitFor(() => launches.length === 1, { label: "working" });
    e.shutdown();
    await waitFor(() => !e.running.size, { label: "stopped" });
    // The second desk queues it again, saves, and stops before marking the old turn interrupted.
    const store = new Store(t.home);
    const crash = imageAt(store, (ev) => ev.state === "interrupted", { before: true });
    e = new Engine({ folderDefault: "shared", store, snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: codex(() => {}) } });
    await e.init({ detect: false });
    e.shutdown();
    assert.ok(crash.taken());
    // The third desk starts from that moment: the turn is offered once, and runs once on Resume.
    const third = new Engine({ folderDefault: "shared", store: new Store(crash.image), snapshots: new Snapshots(crash.image), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: codex((resolve) => resolve({ text: "Done.\nTORYO: REPLY", sessionId: "s" })) } });
    await third.init({ detect: false });
    try {
      const r = third.rooms.get(room.id);
      assert.equal(r.queue.length, 1, "offered once");
      assert.equal(r.paused, true);
      launches.length = 0;
      third.control(room.id, "resume");
      await waitFor(() => turns(third, room.id).some((x) => x.state === "done"), { label: "ran" });
      await sleep(100);
      assert.equal(launches.length, 1, "run once");
    } finally {
      third.shutdown();
      rmSync(crash.image, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

/** Like imageAt, for any store write: `method` is "appendEvent" (when gets the event) or "saveRoom" (when gets the room). */
function imageOn(store, method, when) {
  const image = mkdtempSync(join(tmpdir(), "toryo-crash-"));
  let taken = false;
  const real = store[method].bind(store);
  store[method] = (...args) => {
    real(...args);
    if (!taken && when(args.at(-1))) {
      cpSync(store.home, image, { recursive: true });
      taken = true;
    }
  };
  return { image, taken: () => taken };
}

/** A build room whose headless Codex builder answers `reply`; Claude (the fake CLI) reviews with OWNER. */
async function buildRoom(t, reply) {
  const codex = { ...ADAPTERS.codex, detect: async () => ({ installed: true }), run: async () => ({ text: reply, sessionId: "s1" }) };
  const e = await engineWith(t, { codex });
  return { e, codex };
}

/** Start a desk from a crash image (Codex never runs again), wait for `until`, and hand back what it did. */
async function restartFrom(image, codex, until, label) {
  const again = new Engine({ folderDefault: "shared", store: new Store(image), snapshots: new Snapshots(image), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: { ...codex, run: () => new Promise(() => {}) } } });
  await again.init({ detect: false });
  await waitFor(() => until(again), { label });
  await sleep(150);
  return again;
}

test("a stop at any point while a turn's outcome is acted on: the review is queued once, the question asked once", async () => {
  const review = "Built.\nTORYO: REVIEW S1 | h.md";
  const question = "Before I go on.\nTORYO: OWNER Tabs or spaces?";
  const cases = [
    // [name, builder's reply, where the copy is taken]
    ["after the review is queued and saved", review, (e) => imageOn(e.store, "saveRoom", (room) => room.queue?.some((q) => q.kind === "review") && !room.pendingOutcome)],
    ["after the question is written to the timeline", question, (e) => imageOn(e.store, "appendEvent", (ev) => ev.type === "question")],
    ["after the question is saved in the room", question, (e) => imageOn(e.store, "saveRoom", (room) => room.waiting?.kind === "build-owner")],
  ];
  for (const [name, reply, at] of cases) {
    const t = await setup([{ agent: "claude", reply: "Reviewed.\nTORYO: OWNER Ship it?" }]);
    try {
      const { e, codex } = await buildRoom(t, reply);
      const crash = at(e);
      const room = e.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { snapshots: false } });
      await waitFor(() => crash.taken(), { label: `${name}: copy taken` });
      e.shutdown();
      await sleep(100);
      const again = await restartFrom(crash.image, codex, (x) => x.rooms.get(room.id)?.waiting, `${name}: carried on`);
      try {
        const events = again.roomView(room.id).events;
        if (reply === review) {
          assert.equal(turns(again, room.id).filter((x) => x.kind === "review").length, 1, `${name}: one review`);
          assert.equal(again.rooms.get(room.id).queue.length, 0, `${name}: none queued besides`);
        } else {
          assert.equal(events.filter((x) => x.type === "question" && x.open).length, 1, `${name}: asked once`);
          assert.equal(again.rooms.get(room.id).waiting.kind, "build-owner");
          assert.equal(again.rooms.get(room.id).waitingQueue?.length ?? 0, 0);
        }
      } finally {
        again.shutdown();
        rmSync(crash.image, { recursive: true, force: true });
      }
    } finally {
      t.cleanup();
    }
  }
});

test("a stop while a restarted desk is acting on that outcome: still one review, one question, one notice", async () => {
  for (const [name, reply] of [["review", "Built.\nTORYO: REVIEW S1 | h.md"], ["question", "Before I go on.\nTORYO: OWNER Tabs or spaces?"]]) {
    const t = await setup([{ agent: "claude", reply: "Reviewed.\nTORYO: OWNER Ship it?" }]);
    try {
      const { e, codex } = await buildRoom(t, reply);
      // First stop: just after the builder's end is recorded, before its outcome is acted on.
      const first = imageOn(e.store, "appendEvent", (ev) => ev.state === "done");
      const room = e.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { snapshots: false } });
      await waitFor(() => first.taken(), { label: `${name}: first copy` });
      e.shutdown();
      await sleep(100);
      // Second stop: the restarted desk acts on the outcome and stops before saving it: just after it writes the
      // question to the timeline, or (for the review, which is only saved with the room) just after its notice.
      const store = new Store(first.image);
      const second = imageOn(store, "appendEvent", (ev) => (name === "question" ? ev.type === "question" : ev.type === "system" && ev.reconciled));
      const mid = new Engine({ folderDefault: "shared", store, snapshots: new Snapshots(first.image), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: { ...codex, run: () => new Promise(() => {}) } } });
      await mid.init({ detect: false });
      mid.shutdown();
      assert.ok(second.taken());
      const again = await restartFrom(second.image, codex, (x) => x.rooms.get(room.id)?.waiting, `${name}: carried on`);
      try {
        const events = again.roomView(room.id).events;
        assert.equal(events.filter((x) => x.type === "system" && x.reconciled).length, 1, `${name}: one notice`);
        if (name === "review") assert.equal(turns(again, room.id).filter((x) => x.kind === "review").length, 1, "one review");
        else assert.equal(events.filter((x) => x.type === "question" && x.open).length, 1, "asked once");
        assert.equal(again.rooms.get(room.id).pendingOutcome, null);
      } finally {
        again.shutdown();
        rmSync(first.image, { recursive: true, force: true });
        rmSync(second.image, { recursive: true, force: true });
      }
    } finally {
      t.cleanup();
    }
  }
});

test("a build whose Codex app turn Toryo lost track of keeps its folder when stopped, until you let that turn go", async () => {
  const t = await setup([{ agent: "claude", hang: true }]);
  try {
    const { app, calls } = fakeApp();
    const e = await engineWith(t, { codexapp: app });
    const a = e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "APP-BUILD", title: "App build", appThread: "t1", settings: { snapshots: false } });
    await waitFor(() => calls.length === 1, { label: "sent" });
    calls[0].args.onSubmitted();
    calls[0].settle({ text: "", sessionId: "t1", error: "Timed out following the Codex app.", timedOut: true });
    await waitFor(() => e.rooms.get(a.id)?.appTurn?.lost, { label: "lost track of it" });
    // Stopped, nothing running: the app may still be writing, so the folder is still this room's.
    e.control(a.id, "stop");
    assert.equal(e.running.size, 0);
    assert.throws(() => e.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "Elsewhere" }), (err) => err.code === "folder-busy" && err.room.id === a.id);
    // Nor can the room be deleted: nothing would be left to say the app may be writing there.
    assert.throws(() => e.deleteRoom(a.id), (err) => err.status === 409 && /The Codex app still has a turn from this room and may be writing in its folder/.test(err.message));
    assert.ok(e.rooms.has(a.id));
    // Let go (Stop again): the folder is free.
    e.control(a.id, "stop");
    assert.equal(e.rooms.get(a.id).appTurn, null);
    assert.equal(e.summary(e.rooms.get(a.id)).folder, null);
    const b = e.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "Elsewhere", title: "After", settings: { gates: false, snapshots: false } });
    assert.equal(e.summary(e.rooms.get(b.id)).folder.holding, true);
    e.control(b.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});
