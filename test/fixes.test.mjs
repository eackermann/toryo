import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { joinResults } from "../src/agents/claude.mjs";
import { localFolder } from "../src/agents/codexapp.mjs";
import { Engine } from "../src/engine.mjs";
import { parseStatus, preamble } from "../src/protocol.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { fakeCodexApp, mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const THREAD = "0aaaaaaa-0000-0000-0000-00000000000a";
const appEngine = async (t, app, options = {}) => {
  const e = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }), currentLimits: () => null } }, ...options });
  await e.init({ detect: false });
  e.updateConfig({ agents: { codexapp: { ...app.cfg, thread: THREAD } } });
  return e;
};

// ---------------------------------------------------------------- A. the Codex app's folder check

test("Windows' long-path forms of a thread's folder are the same folders", () => {
  for (const [recorded, path] of [
    ["\\\\?\\C:\\Users\\you\\project", "/mnt/c/Users/you/project"],
    ["\\\\.\\D:\\work", "/mnt/d/work"],
    ["C:\\Users\\you\\project", "/mnt/c/Users/you/project"],
    ["\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\you\\project", "/home/you/project"],
  ])
    assert.deepEqual(localFolder(recorded, { distro: "Ubuntu" }), { path }, recorded);
});

test("a thread whose real folder you set passes the folder check; one recorded elsewhere is refused, saying how to set it", async () => {
  const t = await setup([]);
  try {
    // The app records the thread's folder Windows' way, a scratch folder; the thread works in the project through wsl.
    const app = await fakeCodexApp(t.base, { [THREAD]: "\\\\?\\C:\\Users\\you\\scratch" });
    const e = await appEngine(t, app);
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: THREAD, text: "Hello?", to: "codexapp" });
    await waitFor(() => !e.running.size && e.roomView(room.id).questions.some((q) => q.kind === "error"), { label: "refused" });
    const refusal = turns(e, room.id).find((x) => x.state === "failed").error;
    assert.ok(refusal.startsWith("The Codex app records this thread's folder as \\\\?\\C:\\Users\\you\\scratch (/mnt/c/Users/you/scratch here), which isn't a folder on this machine"), refusal);
    assert.match(refusal, new RegExp(`so Toryo can't check it's this room's folder \\(${t.repo}\\)\\. Toryo sent it nothing\\.`));
    assert.match(refusal, new RegExp(`tell Toryo once: “This thread works in” in the room's Codex app thread setting, toryo app-folder ${room.id} "${t.repo}", or MCP toryo_app_folder`));
    assert.deepEqual(app.queued(), []);

    // Said once where the thread really works: it passes, and the app gets the message.
    assert.throws(() => e.control(room.id, "app-folder", { folder: "project" }), /absolute path/);
    assert.throws(() => e.control(room.id, "app-folder", { folder: join(t.base, "nope") }), /No folder at/);
    e.control(room.id, "app-folder", { folder: t.repo });
    assert.equal(e.summary(e.rooms.get(room.id)).appThreadFolder, t.repo);
    e.answer(room.id, { accept: true, questionId: e.roomView(room.id).questions[0].id });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "sent" });
    assert.deepEqual(app.queued(), [THREAD]);

    // It's kept for the thread, across a restart.
    e.shutdown();
    const again = await appEngine(t, app);
    assert.equal(again.summary(again.rooms.get(room.id)).appThreadFolder, t.repo);
    // Said to be somewhere else: refused, saying so.
    const elsewhere = join(t.base, "elsewhere");
    mkdirSync(elsewhere);
    again.control(room.id, "app-folder", { folder: elsewhere });
    again.postMessage(room.id, { text: "Again?", to: "codexapp" });
    await waitFor(() => !again.running.size && again.roomView(room.id).questions.some((q) => q.kind === "error"), { label: "refused again" });
    assert.match(turns(again, room.id).filter((x) => x.state === "failed").at(-1).error, new RegExp(`^You said this room's Codex app thread works in ${elsewhere}, not in this room's folder \\(${t.repo}\\)\\. Toryo sent it nothing\\. Change it in the room's Codex app thread setting`));
    // Cleared: the app's own record counts again.
    again.control(room.id, "app-folder", { folder: "" });
    assert.equal(again.summary(again.rooms.get(room.id)).appThreadFolder, null);
    assert.deepEqual(app.queued(), [THREAD]);
    again.shutdown();
  } finally {
    t.cleanup();
  }
});

test("where a room's Codex app thread really works, through the command line and MCP", async () => {
  await withServer([], async ({ engine, client, home, repo, base }) => {
    engine.updateConfig({ agents: { codexapp: { thread: THREAD } } });
    const room = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: THREAD });
    assert.match(await client.appFolder(room.id), /Toryo checks the folder the Codex app records for its thread\. If the thread really works elsewhere: toryo app-folder/);
    assert.match(await client.appFolder(room.id, { folder: repo }), new RegExp(`its Codex app thread works in ${repo} \\(you said so\\)`));
    const m = mcp(home);
    try {
      assert.match((await m.call("toryo_app_folder", { room: room.id })).text, /works in .* \(you said so\)/);
      assert.match((await m.call("toryo_app_folder", { room: room.id, clear: true })).text, /checks the folder the Codex app records/);
      const r = await m.call("toryo_app_folder", { room: room.id, folder: join(base, "nowhere") });
      assert.deepEqual([r.error, /No folder at/.test(r.text)], [true, true]);
    } finally {
      m.close();
    }
  });
});

// ---------------------------------------------------------------- B. a Codex app turn that ended with an error

// The owner's sample, minimized (ids replaced): the app ends the turn at capacity, then resumes the work hours later
// as a new turn in the same thread, with no new message, and finishes it with a handoff.
const failed = { timestamp: "2026-10-14T09:06:23.104Z", type: "event_msg", payload: { type: "task_complete", turn_id: "TURN-1", last_agent_message: null, error: { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" }, duration_ms: 1345013 } };
const resumed = [
  { timestamp: "2026-10-14T14:20:04.908Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "THREAD" } },
  { timestamp: "2026-10-14T14:20:04.915Z", type: "event_msg", payload: { type: "task_started", turn_id: "TURN-2", root_turn_id: "TURN-2" } },
  { timestamp: "2026-10-14T14:20:04.949Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "…" }] } },
  { timestamp: "2026-10-14T14:21:00.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"npm test"}' } },
  { timestamp: "2026-10-14T14:28:46.675Z", type: "event_msg", payload: { type: "task_complete", turn_id: "TURN-2", last_agent_message: "Built the slice; the handoff is in docs/reviews/x.md.\n\nTORYO: REVIEW Slice 1: It | docs/reviews/x.md" } },
];
const capacity = "Selected model is at capacity. Please try a different model. (server_overloaded)";

test("an app turn that ended with an error reports it; following it again goes past it to the resumed turn's reply", async () => {
  const t = await setup([]);
  try {
    const app = await fakeCodexApp(t.base, { [THREAD]: t.repo }, { after: [failed] });
    const run = (extra) => ADAPTERS.codexapp.run({ cfg: { ...app.cfg, thread: THREAD }, prompt: "Build it.", sessionId: THREAD, turnDir: mkdtempSync(join(t.base, "turn-")), timeoutMs: 60_000, ...extra });
    // The first time: the app's error, never an empty message.
    const first = await run();
    assert.equal(first.text, "");
    assert.equal(first.error, `The Codex app ended its turn with an error: ${capacity}`);
    const marker = readFileSync(app.rollout(THREAD), "utf8").match(/\[Toryo turn-\w+\]/)[0];
    // Following it again with nothing after the error: it keeps waiting, says so, and takes the resumed turn's reply.
    const said = [];
    const following = run({ attach: { marker }, onActivity: (a) => said.push(a) });
    await waitFor(() => said.some((a) => /ended this turn with an error \(Selected model is at capacity.*\)\. Toryo keeps following the thread/.test(a.text)), { label: "waiting, said" });
    app.append(THREAD, resumed);
    const r = await following;
    assert.equal(r.error, undefined);
    assert.match(r.text, /^Built the slice;/);
    assert.equal(parseStatus(r.text).status, "REVIEW");
    assert.ok(said.some((a) => /resumed the work in this thread/.test(a.text)));
  } finally {
    t.cleanup();
  }
});

test("after an app turn's error, someone else's message first means the thread moved on: its reply isn't taken", async () => {
  const t = await setup([]);
  try {
    const app = await fakeCodexApp(t.base, { [THREAD]: t.repo }, { after: [failed] });
    const run = (extra) => ADAPTERS.codexapp.run({ cfg: { ...app.cfg, thread: THREAD }, prompt: "Build it.", sessionId: THREAD, turnDir: mkdtempSync(join(t.base, "turn-")), timeoutMs: 60_000, ...extra });
    await run();
    const marker = readFileSync(app.rollout(THREAD), "utf8").match(/\[Toryo turn-\w+\]/)[0];
    app.append(THREAD, [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Something else, please." }] } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "TURN-3" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "TURN-3", last_agent_message: "Done with something else.\nTORYO: REPLY" } },
    ]);
    const r = await run({ attach: { marker } });
    assert.equal(r.text, "");
    assert.match(r.error, /^After the Codex app ended this turn with an error \(Selected model is at capacity.*\), its thread moved on to another message, not Toryo's, so Toryo doesn't take that reply for this turn\.$/);
  } finally {
    t.cleanup();
  }
});

test("someone else's message after a failed ending, in either form, before or during the resumed work: no reply is taken", async () => {
  const theirs = {
    item: { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Something else, please." }] } },
    event: { type: "event_msg", payload: { type: "user_message", message: "Something else, please." } },
  };
  const started = { type: "event_msg", payload: { type: "task_started", turn_id: "TURN-3" } };
  const reply = { type: "event_msg", payload: { type: "task_complete", turn_id: "TURN-3", last_agent_message: "Done with something else.\nTORYO: APPROVED" } };
  for (const form of ["item", "event"])
    for (const when of ["before", "during"]) {
      const t = await setup([]);
      try {
        const app = await fakeCodexApp(t.base, { [THREAD]: t.repo }, { after: [failed] });
        const run = (extra) => ADAPTERS.codexapp.run({ cfg: { ...app.cfg, thread: THREAD }, prompt: "Build it.", sessionId: THREAD, turnDir: mkdtempSync(join(t.base, "turn-")), timeoutMs: 60_000, ...extra });
        await run();
        const marker = readFileSync(app.rollout(THREAD), "utf8").match(/\[Toryo turn-\w+\]/)[0];
        app.append(THREAD, when === "before" ? [theirs[form], started, reply] : [started, theirs[form], reply]);
        const r = await run({ attach: { marker } });
        assert.equal(r.text, "", `${form} ${when}`);
        assert.match(r.error, /its thread moved on to another message, not Toryo's, so Toryo doesn't take that reply for this turn\.$/, `${form} ${when}`);
      } finally {
        t.cleanup();
      }
    }
});

test("an ending with an error is that error even with text: never a verdict, the first time or following again", async () => {
  const t = await setup([]);
  try {
    const partial = { ...failed, payload: { ...failed.payload, last_agent_message: "Partial answer\nTORYO: APPROVED" } };
    const app = await fakeCodexApp(t.base, { [THREAD]: t.repo }, { after: [partial] });
    const run = (extra) => ADAPTERS.codexapp.run({ cfg: { ...app.cfg, thread: THREAD }, prompt: "Review it.", sessionId: THREAD, turnDir: mkdtempSync(join(t.base, "turn-")), timeoutMs: 60_000, ...extra });
    const first = await run();
    assert.equal(first.text, "");
    assert.equal(first.error, `The Codex app ended its turn with an error: ${capacity}. What it had written before that, which isn't taken as its answer: “Partial answer”`);
    // Following again goes past it, as past any failed ending, to the resumed turn's reply.
    const marker = readFileSync(app.rollout(THREAD), "utf8").match(/\[Toryo turn-\w+\]/)[0];
    const said = [];
    const following = run({ attach: { marker }, onActivity: (a) => said.push(a) });
    await waitFor(() => said.some((a) => /Toryo keeps following the thread/.test(a.text)), { label: "waiting" });
    app.append(THREAD, resumed);
    const r = await following;
    assert.match(r.text, /^Built the slice;/);
    assert.equal(parseStatus(r.text).status, "REVIEW");
  } finally {
    t.cleanup();
  }
});

test("a room whose app turn ended with an error asks, naming it, and Follow it again picks up the resumed turn", async () => {
  const t = await setup([]);
  try {
    const app = await fakeCodexApp(t.base, { [THREAD]: t.repo }, { after: [failed] });
    const e = await appEngine(t, app);
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: THREAD, text: "Build it.", to: "codexapp" });
    await waitFor(() => e.roomView(room.id).questions.some((q) => q.kind === "app-lost"), { label: "asked" });
    const q = e.roomView(room.id).questions.find((x) => x.kind === "app-lost");
    assert.equal(q.question, `The Codex app ended its turn with an error: ${capacity}. It may still be working in the app, so Toryo sends it nothing else until you decide. If you resume that work in the app (in the same thread, without a new message), then choose “Follow it again”: Toryo picks up the resumed turn's reply.`);
    assert.equal(turns(e, room.id)[0].error, `The Codex app ended its turn with an error: ${capacity}`);
    // Resumed in the app; then Follow it again: the turn's result is the resumed turn's reply. Nothing sent twice.
    app.append(THREAD, resumed);
    e.answer(room.id, { accept: true, questionId: q.id });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "followed" });
    assert.match(turns(e, room.id).find((x) => x.state === "done").text, /^Built the slice;/);
    assert.deepEqual(app.queued(), [THREAD]);
    assert.equal(e.rooms.get(room.id).appTurn, null);
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- C. a Claude run with more than one result

test("a Claude run's answers are all kept, in order, the follow-up marked, with the last status line last", () => {
  const review = "## Review\n\nAll good.\n\nOpen: the docs need a line.\n\nTORYO: APPROVED Nothing blocking";
  const note = "That notice only means my log watcher timed out… the review above stands.\n\nTORYO: APPROVED Still nothing blocking";
  const both = joinResults([review, note]);
  assert.ok(both.startsWith("## Review\n\nAll good."));
  assert.match(both, /\n\n---\n\n\*\*Follow-up\*\* \(Claude answered again later in the same run\):\n\nThat notice only means/);
  assert.deepEqual(parseStatus(both), { status: "APPROVED", detail: "Still nothing blocking" });
  // A follow-up without a status line: the latest one before it moves to the end.
  const quiet = joinResults([review, "Just a note: the watcher stopped."]);
  assert.deepEqual(parseStatus(quiet), { status: "APPROVED", detail: "Nothing blocking" });
  assert.equal(quiet.split("TORYO: APPROVED").length - 1, 1, "said once");
  assert.ok(quiet.indexOf("Open: the docs need a line.") < quiet.indexOf("Follow-up"));
  assert.equal(joinResults([review]), review);
});

test("a review with a later follow-up keeps the whole review: the verdict, the ledger and the totals counted once", async () => {
  const review = "## Review\n\nThe slice holds up.\n\nOpen: README misses the new flag.\n\nTORYO: APPROVED";
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1: It | h.md", times: 1 },
    { agent: "codex", reply: "Next.\nTORYO: OWNER Done?" },
    { agent: "claude", reply: review, followUp: "That notice only means my log watcher timed out; the review above stands.\n\nTORYO: APPROVED" },
  ]);
  try {
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => t.engine.rooms.get(r.id).build?.approved?.length, { label: "approved" });
    const turn = turns(t.engine, r.id).find((x) => x.agent === "claude");
    assert.match(turn.text, /^## Review\n\nThe slice holds up\./);
    assert.match(turn.text, /\*\*Follow-up\*\* \(Claude answered again later in the same run\):\n\nThat notice only means/);
    assert.equal(turn.status, "APPROVED");
    assert.ok(t.engine.rooms.get(r.id).ledger.some((f) => f.kind === "open" && f.text === "README misses the new flag."));
    // Tokens add up across the answers; the cost is the run's (the last result's), not added twice.
    assert.deepEqual(turn.usage, { input: 15, cached: 1000, output: 47 });
    assert.equal(turn.cost, 0.015);
  } finally {
    t.cleanup();
  }
});

test("the briefing asks agents to stop their own background commands before their final message", () => {
  const brief = preamble({ agentLabel: "Claude", others: ["Codex"], project: { path: "/home/you/project", rules: "", decisions: "" } });
  assert.match(brief, /Before your final message, stop any background commands you started \(watchers, servers\), so your answer ends the turn\./);
});
