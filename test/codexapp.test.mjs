import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexapp, lastAppMessage } from "../src/agents/codexapp.mjs";

test("Codex app agent queues into the thread and returns the turn that carries its marker", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000001";
    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-13T00-00-00-${thread}.jsonl`);
    writeFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "an older turn" } }) + "\n");
    // A stand-in for codex.exe: `queue --thread T --message M` makes the "app" run the turn.
    const fake = join(base, "codex.exe");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const msg = args[args.indexOf("--message") + 1];
const lines = [
  { type: "event_msg", payload: { type: "task_complete", last_agent_message: "the owner's own turn finishing" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } },
  { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.exec_command({cmd:"wsl -d Ubuntu -- bash -lc \\\\"pnpm test\\\\""})' } },
  { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1792000000 } } } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working on it." }] } },
  { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done.\\nTORYO: REVIEW Slice 1 | h.md" } },
];
setTimeout(() => fs.appendFileSync(${JSON.stringify(rollout)}, lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n"), 300);
console.log("Queued message x for thread ${thread}.");
`,
    );
    chmodSync(fake, 0o755);
    const turnDir = join(base, "turn-t1");
    mkdirSync(turnDir);
    const activity = [];
    const result = await codexapp.run({
      cfg: { exe: fake, codexHome: home, thread },
      prompt: "Your role: builder\nDo the slice.",
      turnDir,
      onActivity: (a) => activity.push(a),
      timeoutMs: 20_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.text, "Done.\nTORYO: REVIEW Slice 1 | h.md");
    assert.equal(result.sessionId, thread);
    assert.ok(activity.some((a) => a.kind === "say" && a.text === "Working on it."));
    assert.ok(activity.some((a) => a.kind === "command" && /pnpm test/.test(a.text)));
    assert.equal(result.limits.windows[0].label, "5-hour");
    assert.equal(result.limits.windows[0].used, 12);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Codex app agent opens the thread when the app hasn't sent the message", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000002";
    const home = join(base, "codex-home");
    const day = join(home, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-13T00-00-00-${thread}.jsonl`);
    writeFileSync(rollout, "");
    // This "app" only sends the queue once the thread is opened, as the real one does.
    const fake = join(base, "codex.exe");
    writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(join(base, "queued"))}, process.argv[process.argv.indexOf("--message") + 1]);\n`);
    chmodSync(fake, 0o755);
    const opened = [];
    const open = (id) => {
      opened.push(id);
      const msg = readFileSync(join(base, "queued"), "utf8");
      const lines = [
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } },
        { type: "event_msg", payload: { type: "task_complete", last_agent_message: "opened-ok\nTORYO: REPLY" } },
      ];
      appendFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return true;
    };
    const turnDir = join(base, "turn-t2");
    mkdirSync(turnDir);
    const activity = [];
    const result = await codexapp.run({
      cfg: { exe: fake, codexHome: home, thread, openAfterMs: 500, open },
      prompt: "Say opened-ok.",
      turnDir,
      onActivity: (a) => activity.push(a),
      timeoutMs: 20_000,
    });
    assert.deepEqual(opened, [thread]);
    assert.equal(result.text, "opened-ok\nTORYO: REPLY");
    assert.ok(activity.some((a) => /Opened the thread/.test(a.text)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the Codex app thread's last finished reply can be read as a handoff", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000001";
    const day = join(base, "sessions", "2026", "10", "03");
    mkdirSync(day, { recursive: true });
    const done = (m) => JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: m } });
    const filler = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "é".repeat(3_000) }] } });
    writeFileSync(join(day, `rollout-2026-10-03T21-32-41-${thread}.jsonl`), [done("older"), filler, done("Ready for review: docs/plans/x-review.md ✓"), filler, filler].join("\n") + "\n");
    assert.equal(lastAppMessage({ codexHome: base, exe: "/nonexistent", thread }), "Ready for review: docs/plans/x-review.md ✓");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("reading a session log from the end finds whole lines and their offsets, across chunk edges", async () => {
  const { scanBack } = await import("../src/agents/logtail.mjs");
  const base = mkdtempSync(join(tmpdir(), "toryo-logtail-"));
  try {
    const lines = ["first ✓", "middle é漢字 marker-A", "x".repeat(50), "last ü"];
    const path = join(base, "log.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    for (const chunk of [3, 7, 1024]) {
      const hit = scanBack(path, (l) => (l.includes("marker-A") ? l : null), { chunk });
      assert.equal(hit.value, "middle é漢字 marker-A");
      assert.equal(hit.offset, Buffer.byteLength("first ✓\n"));
      assert.equal(scanBack(path, (l) => (l.startsWith("first") ? l : null), { chunk }).value, "first ✓");
      assert.equal(scanBack(path, () => null, { chunk }), null);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("after a restart, the Codex app agent follows its turn from the marker without sending again", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000001";
    const day = join(base, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const marker = "[Toryo told-before-restart]";
    const rollout = join(day, `rollout-2026-10-13T00-00-00-${thread}.jsonl`);
    const L = (o) => JSON.stringify(o) + "\n";
    writeFileSync(
      rollout,
      L({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "an older turn" } }) +
        L({ timestamp: "2026-10-13T10:30:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${marker}\nDo it.` }] } }) +
        L({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 30, window_minutes: 300 } } } }),
    );
    setTimeout(() => appendFileSync(rollout, L({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done after restart.\nTORYO: REVIEW S | h.md" } })), 300);
    const turnDir = join(base, "turn-new");
    mkdirSync(turnDir);
    const activity = [];
    const started = [];
    const result = await codexapp.run({
      cfg: { exe: join(base, "no-such-codex.exe"), codexHome: base, thread, open: () => assert.fail("must not open") },
      prompt: "ignored",
      turnDir,
      attach: { marker },
      onActivity: (a) => activity.push(a),
      onStarted: (s) => started.push(s),
      timeoutMs: 20_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.text, "Done after restart.\nTORYO: REVIEW S | h.md");
    // It took the turn up at 10:30 (perhaps while Toryo was stopped): that's the time it says, not now.
    assert.deepEqual(started, [{ sessionId: thread, at: "2026-10-13T10:30:00.000Z" }]);
    assert.ok(activity.some((a) => a.kind === "limits" && a.limits.windows[0].used === 30));
    assert.ok(activity.some((a) => /Following the Codex app's turn again/.test(a.text ?? "")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the app log is read in whole lines, so a character split between writes survives", async () => {
  const { lineReader } = await import("../src/agents/logtail.mjs");
  const bytes = Buffer.from('{"t":"café ✓"}\n{"t":"漢字"}\n', "utf8");
  for (let cut = 1; cut < bytes.length; cut++) {
    const read = lineReader();
    const lines = [...read(bytes.subarray(0, cut)), ...read(bytes.subarray(cut))];
    assert.deepEqual(lines, ['{"t":"café ✓"}', '{"t":"漢字"}']);
  }
});

test("a stop doesn't drop the app's turn: Toryo follows it to the end unless told to let go", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000001";
    const day = join(base, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-13T00-00-00-${thread}.jsonl`);
    writeFileSync(rollout, "");
    const fake = join(base, "codex.exe");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    const L = (o) => Buffer.from(JSON.stringify(o) + "\n", "utf8");
    const run = (turn, signal, abandon) => {
      const turnDir = join(base, turn);
      mkdirSync(turnDir);
      return codexapp.run({ cfg: { exe: fake, codexHome: base, thread, openThread: "never", pollMs: 50 }, prompt: "x", turnDir, signal, abandon, onActivity: () => {}, timeoutMs: 20_000 });
    };

    const stop = new AbortController();
    const pending = run("turn-a", stop.signal, new AbortController().signal);
    stop.abort("stop");
    await new Promise((r) => setTimeout(r, 200));
    // The app sends the message and finishes; the reply ends mid-character in one write.
    const done = Buffer.concat([L({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[Toryo turn-a]\nx" }] } }), L({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "café\nTORYO: REPLY" } })]);
    const cut = done.indexOf(Buffer.from("é")) + 1;
    appendFileSync(rollout, done.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(rollout, done.subarray(cut));
    const result = await pending;
    assert.equal(result.aborted, undefined);
    assert.equal(result.text, "café\nTORYO: REPLY");

    const abandon = new AbortController();
    const second = run("turn-b", new AbortController().signal, abandon.signal);
    setTimeout(() => abandon.abort(), 100);
    assert.equal((await second).aborted, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a stopped turn isn't queued in the app at all, and a long one is only reported, never dropped", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-codexapp-"));
  try {
    const thread = "0199c0de-0000-7000-8000-000000000001";
    const day = join(base, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-13T00-00-00-${thread}.jsonl`);
    writeFileSync(rollout, "");
    const log = join(base, "queued");
    const fake = join(base, "codex.exe");
    writeFileSync(fake, `#!/bin/sh\necho queued >> ${JSON.stringify(log)}\n`);
    chmodSync(fake, 0o755);
    const cfg = { exe: fake, codexHome: base, openThread: "never", pollMs: 50 };
    const turnDir = (n) => (mkdirSync(join(base, n)), join(base, n));

    const stopped = new AbortController();
    stopped.abort("stop");
    const result = await codexapp.run({ cfg, prompt: "x", sessionId: thread, turnDir: turnDir("turn-s"), signal: stopped.signal, onActivity: () => {} });
    assert.equal(result.aborted, true);
    assert.equal(existsSync(log), false, "nothing was queued in the app");

    const activity = [];
    const submitted = [];
    setTimeout(() => {
      const L = (o) => JSON.stringify(o) + "\n";
      appendFileSync(rollout, L({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[Toryo turn-l]\nx" }] } }) + L({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Late but done.\nTORYO: REPLY" } }));
    }, 600);
    const late = await codexapp.run({ cfg, prompt: "x", sessionId: thread, turnDir: turnDir("turn-l"), timeoutMs: 200, onSubmitted: () => submitted.push(1), onActivity: (a) => activity.push(a) });
    assert.equal(late.text, "Late but done.\nTORYO: REPLY");
    assert.equal(late.timedOut, undefined);
    assert.deepEqual(submitted, [1]);
    assert.ok(activity.some((a) => a.notify && /run past/.test(a.text)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
