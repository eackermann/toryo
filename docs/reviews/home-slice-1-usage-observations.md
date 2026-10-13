# Home and desk controls, Slice 1: normalize usage observations

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 1
**Tree:** still entirely uncommitted. The plan is untouched. `docs/decisions.md` gains two of the owner's decisions this round: Cursor's read-only turns, and the notes below. Nothing here needs an owner decision.

**Also in this round:** the owner's notes on empty turns, fresh sessions and the ledger, editable notes, Enter to send, and Ask or Tell notes with building turns. They're described in their own handoff, `docs/reviews/owner-notes-empty-turns-fresh-sessions.md`. With them, `node --test` runs 92 tests, all passing, and `node test/ui-check.mjs` passes.

## Round 4: your two findings on cancelling notes in Build rooms

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Withdrawing the first queued builder note stranded the second | `postMessage` ties a note to the agent's queued turn first, whatever the room is doing: busy, quiet, paused or done. It does this whenever the agent isn't working (in chat, always), and says "Your note goes to … with its next turn". Before, only the quiet-room branch did, so a second note in a finished, paused build went to the "with its next turn" branch untied. A note to an agent that's working is still handled when its turn ends (`#queueNotesTurn`). | "in a finished, paused build, withdrawing the first of two notes to the builder keeps the turn for the second". The queued build-note lists both notes. After withdrawing the first, the turn stays and the build stays reopened; the builder's prompt then has KEEP-77 and not the withdrawn text. |
| 2 | Withdrawing a mid-turn note left its extra turn queued | `#queueNotesTurn` now tags its `build-notes` and `note-answer` turns with `forNotes` and their notes (for `note-answer`, the questions). Withdrawing the last of them drops the turn as before. Because such a turn holds the relay (it carries `after`), `editNote` then carries on from `after`, as if the agent had replied REPLY: checks and review after a builder's REVIEW, the review's verdict after a reviewer's answer. That goes through `#carryOn`, now shared with `#afterTurn`, and turns from a replaced run are skipped (`#stale`). | "withdrawing a note sent mid-turn skips its building turn, and the relay carries on to review". A note while the builder works, then pause; the queued `build-notes` lists the note. After withdrawing it, the queue holds `claude:review`, and the turns are build, then review, with no notes turn. "withdrawing a question sent mid-review skips the answer, and the review's verdict carries on": the queue holds `codex:build-fix`, with round 1 counted. |

`node --test` runs 92 tests, all passing; `node test/ui-check.mjs` passes.

## Round 3: your five findings on the additional changes

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Cursor could lose read-only protection without a working mount | The Ask-mode choice now follows whether the mount really happens. `canMount(paths)` is `readOnlyCommand(paths, …)`, the same test `runAgentProcess` uses to wrap the command. So "paths given, but user namespaces unavailable" gets `--mode ask`. `cursorArgs` takes `mounted` instead of the paths. Such a turn reports `askMode`, and the engine remembers that chat in `room.askMode`. Cursor's next turn that writes in that chat starts fresh (reason `ask-mode`): a new chat, with the fresh brief explaining why, so it never hits "Ask mode is on". | `cursor.test.mjs`. **Arguments** for mounted and not mounted. **Through the adapter** with `mountable: () => false` and nonempty paths: the read call has `--mode ask` and reports `askMode`, then the resumed write call has `--force`. **In a room:** an Ask-mode read turn, then "Now change it" with file changes allowed; the write turn gets no session (a new chat), and its prompt explains Ask mode. |
| 2 | A zero-turn Claude result kept the session and lost the handoff on retry | The engine now treats any turn with no text as never really had (`silent`), whether or not the adapter also reported an error ("Claude ran no turns"). `#uncommitDispatch` then restores delivery and the session before the retry. `empty` (the "returned an empty message" error) stays for silent turns without an error of their own. | "Claude's zero-turn result is retried whole, in a new session, with the handoff". The fake agent's new `zeroTurns` gives exactly that result shape. Both calls carry HANDOFF-888, and the retry uses a new `--session-id` that differs from the failed one. |
| 3 | A hook drop followed by diagnostic text counted as a success | A recognized drop is an error with `dropped: true` whatever text comes with it. To keep this safe in a repository that quotes the notice (this one does), only Claude Code's own notices count: events other than `assistant`, `user` (tool results) and `result`, whose string *starts* with "Prompt dropped by a hook". | "a dropped prompt is an error even when diagnostic text follows; the model quoting the notice is not a drop". **The drop:** a system event, then a result with "Hook cache-tax blocked this prompt (exit 2)." That's an `error` question naming cache-tax, with no review-status turn and no automatic retry. **After Retry:** a reply that *starts* with "Prompt dropped by a hook: …" is a normal approval. |
| 4 | Withdrawing one note stranded another that shared its queued turn | Queued turns now carry the list of notes they were queued for or carry along (`notes`, with `forNotes` when the turn exists only for notes). A note that rides along on a queued turn is added to its list, also for an Ask riding on a queued `note-answer`. Withdrawing a note takes it off every list, and drops a turn only when it was queued for notes and none are left. Turns queued anyway (a relay turn, the answer to a question) stay. Old turns with a single `note` are read the same way. | "withdrawing one of two notes that share a queued turn keeps the turn for the other". In a paused room, two notes share one turn and the first is withdrawn: the turn stays, and the agent gets only KEEP-ME-321. Withdrawing a lone third note drops its turn. |
| 5 | A question arriving during a standalone answer got no follow-up | A `note-answer` without `after` now checks for questions that arrived during it and queues another standalone answer for them (`#queueAnswer`), alongside the work. Tell notes still go with the next turn. | "a question that arrives while the reviewer answers another is answered next, and the build carries on". While Codex builds, a question to the idle reviewer, then SECOND-Q during that answer: two `note-answer` turns, then the build's review; SECOND-Q's outcome is `answered`. |

`node --test` runs 89 tests, all passing; `node test/ui-check.mjs` passes. The README's note on Cursor's Ask-mode fallback now says that Toryo starts a new chat before a writing turn.

## Round 2: your four findings, and the owner's Cursor fix

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | A later reset bypassed source-time ordering | `choose()` now compares when the readings were taken **first**. A reading taken earlier never replaces one taken later, whatever reset time it reports, and an undated reading never replaces a dated one. Two exceptions. A reading taken later still loses if it describes an *earlier* window that was already over when it was taken (`overAt`: its reset is at or before its own `sourceAt`): that's an obsolete window. And when the reading Toryo has is undated (migrated), the window decides as before. For shared allowances, `groupView` no longer reduces with `choose()`, which depended on order. It sorts with `newestFirst`: a reading of a window still running beats one of a window already over, then dated beats undated, then the reading taken last, then the later reset, then the one received last, then the agent name. | "a reading taken earlier never replaces a later one, even when it reports a later reset". **Individual:** your reproduction (80% at 08:00, then 20% at 07:00 with a reset 30 min later) is kept at 80%, `older`; an undated reading with a later reset is `older`; against a migrated reading, an earlier window is `older-window` and the same window `newer`. **Shared, in both arrival orders:** your reproduction gives Codex at 80%; a later reading of an already-over window loses; and dated beats undated. The earlier test's "late report from the old window" case (taken after its own reset) is still `older-window`. |
| 2 | Real log failures never reached the error handling | `latestRateLimits` no longer swallows errors. A log with no reading returns null; a log that can't be read throws, with its `code`. `codexCurrentLimits` treats a missing `sessions` folder (no Codex sessions yet) and a log deleted meanwhile (`ENOENT`) as "no reading", and throws anything else. The Codex app's `currentLimits` does the same through `rolloutFor(…, { strict: true })`. `refreshUsage` therefore records a failure and keeps the last good reading. `agentView` now carries `error`, also for an agent with no reading yet. The page shows *Couldn't read the latest usage 3 min ago: …* under the meters. The reading Codex's turn returns (`codexLimits`) still treats a failure as "no reading", so a usage log can't fail a turn; the next 5-minute read reports it. | "a Codex log that can't be read is a failed read, not an empty one, and the last good reading stays". **The reader itself:** a log with no reading gives null, a missing one `ENOENT`, a directory in its place `EISDIR`. **The Codex app's read, through its own folders:** one good thread, one with no log, one whose log is a directory. **Headless Codex through the engine**, with the real adapter and `CODEX_HOME` pointing at a temporary folder: a good read (41%), then the log replaced by a directory (41% kept, `error` set, in `state().usage.errors`, and on the page), then a good read again (43%, error cleared). |
| 3 | Partial updates made older windows look fresh | Every meter now says how old its own reading is, on its second row: *just now*, *6 h ago*. A migrated reading has no time of its own, only when Toryo had it, so it reads *14 h ago or earlier*; with neither time, *time unknown*. The single "Reported … ago" line for the whole block is gone. `agentView().at` stays for older callers. The meters moved from `app.js` into a small module, `web/meters.js`, so the tests can render them at a given moment. | "each meter says how old its own reading is, …": a fresh 5-hour reading next to a six-hour-old weekly one shows *just now* and *6 h ago*. A migrated window shows *14 h ago or earlier*, and an unknown percentage still has its age. Labels are escaped, and there's no block-wide "Reported". |
| 4 | An idle page didn't expire its meters | The page redraws every `.limits[data-agent]` block from the state it already has every 30 seconds. Expiry and ages are worked out against the current time, so a reset shows, and ages move on, with no new reading and no event; a re-read still isn't news. | The same unit test renders the meters 15 minutes later: *reset · waiting for a new reading*, no 64%, *16 min ago*. In the browser, `test/ui-check.mjs` has a new step 0. The desk starts with a seeded `limits.json` (5-hour at 64%, resetting in 10 minutes). A page with Playwright's controlled clock opens it, and nothing else happens. After fast-forwarding 15 minutes, the meter reads *reset … waiting for a new reading* and no longer 64%. To be sure the step tests the timer, I ran it once with the timer's interval raised out of reach: it failed. With the timer it passes. |

**The owner's Cursor fix** (`src/agents/cursor.mjs`, outside the plan):
- Read-only turns no longer pass `--mode ask` when the read-only mount is in use. Cursor keeps a resumed chat's mode, so one Ask turn stopped the chat from ever editing again. `--mode ask` is now only the fallback without the mount, and write turns keep `--force`.
- The result event's `usage` is reported as `{ input: inputTokens + cacheWriteTokens, cached: cacheReadTokens, output: outputTokens }`.
- The adapter is marked `tested: true`, and its header says it was tested on 13 Oct 2026 with Cursor CLI 2026.10.01.
- `cursorArgs` and `cursorUsage` are exported, so the tests can check them directly.

`test/cursor.test.mjs` checks:
- A read turn with the mount gets neither `--mode` nor `--force`.
- Without the mount (null, undefined or empty), it gets `--mode ask`.
- A write turn gets the exact argument list, with `--force`.
- Usage is mapped, including missing fields and null.
- A whole turn through a stand-in CLI: it creates a chat, the right arguments are recorded, and the usage comes back.

The README's Agents table and its *How read-only is enforced* note are updated. The owner's decision is recorded in `docs/decisions.md`.

`test/server.test.mjs`'s list of page files now includes `/meters.js`.

Usage readings now say which window they describe, when the agent took them and when Toryo received them, and which allowance they belong to. Late, repeated, malformed and stale readings can no longer pass for current ones. The meters look as before, except a limit that has reset says so, and a number the agent didn't report says *unknown* instead of 0%. No holds or projections yet; those are Slices 6 and Later.

## What changed

| Where | Change |
|---|---|
| `src/usage.mjs` (new) | Pure helpers and the `UsageBook`. **Windows** get a type (`five_hour`, `weekly`, a model's own such as `weekly_opus`, or `<n>_minute` for other Codex lengths), a length in minutes when known, `used` (null when missing or malformed) and `resetsAt` (null likewise). A window with neither number is dropped. **Allowances**: `DEFAULT_GROUPS` puts `codex` and `codexapp` in `openai` (the owner's belief that they share an account); `normalizeGroups(mapping, { strict })` validates a replacement mapping for Slice 2's `desk.json`. **The book** keeps, per agent and window type, the reading to trust, chosen by `choose()` (below), and persists as `{ version: 2, agents }`. `agentView()` is the old per-agent shape plus `type/minutes/sourceAt/receivedAt/checkedAt/source/expired`; `groupView()` gives each allowance's best reading per window with the other agents' readings under `others`, never a sum. |
| `src/agents/logtail.mjs` | `parseRateLimits(rl, { sourceAt })` returns typed windows, `reached` (Codex's `rate_limit_reached_type` kept as given, not just a truthy flag), and `sourceAt`. `latestRateLimits` passes the log line's own `timestamp`. A window without `window_minutes` is left out: it can't be told apart from the others. |
| `src/agents/claude.mjs` | `claudeLimits(info, { sourceAt })` (now exported) maps `seven_day` to `weekly` and `seven_day_<model>` to `weekly_<model>`. The stream is live, so `sourceAt` is when the event arrived; the turn's final `limits` is the same object, so it's recognized as the same reading. |
| `src/agents/codexapp.mjs` | Stream readings carry the log line's timestamp. `currentLimits(cfg, { threads })` reads the default thread and the rooms' threads and keeps the newest. `rolloutFor` remembers where a thread's log is while the file exists, since usage is now re-read every 5 minutes and finding the log walks the app's folders on the Windows disk. |
| `src/engine.mjs` | `this.usage` (a `UsageBook`) replaces the `limits` object; `engine.limits` is now a getter returning `agentView()`, so the page, the tests and the state shape keep working. `limits.json` is loaded through `UsageBook.load`, which migrates the old format. `#setLimits(agent, reading, source)` returns whether the reading was news, and `state` is only emitted for news. New `refreshUsage()` re-reads `currentLimits` for installed agents (codex, codexapp); `refreshAgents` uses it; `init` starts a 5-minute timer (`usagePollMs` option, `0` turns it off; `unref`'d), `shutdown()` clears it. A failing read is recorded and shown in `state().usage.errors`. `state()` gains `usage: groupView()`. |
| `web/meters.js` (new), `web/app.js`, `web/styles.css` | `limitMeters(l, agent, now)` shows *reset · waiting for a new reading* for a window whose reset has passed, *unknown* for a missing percentage, and the usual bar otherwise. Each window shows its own reading's age, and any read error appears under the meters. `app.js` imports it and redraws the meters every 30 s. |
| `test/fake-agent.mjs` | A Claude rule can set `rateLimit`: the usage event(s) to report instead of the usual one, or `null` for none. |
| `test/helpers.mjs` | Sets `CODEX_HOME` to an empty temporary folder. Headless Codex reads plan usage from Codex's session logs after each turn, and until now the tests' fake Codex turns listed the real `~/.codex/sessions`. |
| `README.md` | The *Usage* paragraph describes the 5-minute re-read, *reset* and *unknown*, model-specific limits, and the shared Codex allowance. |

## The rules for a new reading (`choose()` in `src/usage.mjs`)

Per agent and window type:

1. **No reading yet:** keep it (even if its window has already reset; it then shows as reset).
2. **The reading Toryo has is dated:**
   - an undated new reading, or one taken earlier, is ignored: *older*, or *older-window* if it also reports an earlier window;
   - one taken at the same moment is the same measurement (*same*: only `checkedAt` moves);
   - one taken later wins: *newer*, or *new-window* if its reset is 15 minutes or more later. It doesn't win when it reports an earlier window that was already over when it was taken: that's *older-window*.
3. **The reading Toryo has is undated (migrated):** an earlier window is *older-window*, a later one *new-window*, the same numbers again *same*; otherwise the new one wins.

Reset times within 15 minutes of each other are the same window, since they can drift by seconds between readings. Status, `reached` and plan follow the newest accepted reading. Shared allowances use the order-independent `newestFirst` sort described under finding 1.

## Invariants

- A missing or malformed percentage or reset time is `null` all the way to the page, never 0.
- Re-reading the same log line doesn't make a reading fresh, and doesn't emit `state`.
- A reading taken earlier never replaces one taken later, whatever reset it reports. An undated reading never replaces a dated one. A reading of a window already over when it was taken never replaces one of a running window.
- A log that can't be read is a failed read: shown, with the last good reading kept. A log with no reading, or no logs yet, isn't a failure.
- Each window's age is its own. What the meters say is worked out again every 30 s, so a reset shows on an idle page.
- A window whose reset has passed keeps its percentage, marked `expired`; the page doesn't show it as current.
- Codex and Codex app readings of one window are compared, never added. `others` keeps the losing readings for attribution.
- Model-specific windows (`weekly_opus`) stay separate from `weekly`.
- Old `limits.json` entries keep their numbers; their `at` becomes `receivedAt`, with `sourceAt: null` and `source: "migrated"`. That's because the old `at` was the log's time for Codex but the receipt time for Claude. The page's "Reported … ago" is unchanged for them. A file with a newer `version` is read as empty and never overwritten.
- No test reads the real Codex logs or the app: `CODEX_HOME` points at an empty temporary folder, the engine tests stub `currentLimits`, and detection stays off.

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 75 tests, ~28 s
node test/ui-check.mjs                               # passes, including the idle-page meter step
```

Round 2's tests are described in the table above. The round 1 tests are in `test/usage.test.mjs`:

- **Parsers.** Valid, missing and malformed Codex and Claude reports, `reached`, and the Opus window keeping its identity.
- **The book.** Ordering by source time; the same log line read twice; a fresh flat reading; a delayed reading; expiry keeping the percentage; a new window, then a late reading from the old one; reset-time drift; six kinds of unusable input.
- **Allowances.** Codex 40% and the app 55% give 55% for the shared allowance, with Codex under `others`. Model windows stay separate. The mapping can be split, and bad entries are ignored, or refused when strict.
- **Migration.** The old format, with a reading from a window that has since reset, an unknown entry, and the round trip through version 2. A version 3 file isn't overwritten.
- **The engine.** A fake Claude turn reports a valid event, then a malformed one that doesn't erase it. A legacy `limits.json` is migrated on start. `refreshUsage` reads the same line twice and emits `state` once. A failing read shows in `state().usage.errors`. `shutdown()` clears the timer, and a restart loads the same `sourceAt`s.

In round 1 I also rendered the meters in a browser against a desk of its own, with a temporary `TORYO_HOME` and a seeded `limits.json`. One window had reset, one had no percentage, and one was the Opus window at 45%. The panel read *5-hour limit · reset · waiting for a new reading*, *weekly limit · unknown · resets in 23 h*, *weekly (Opus) limit · 45% · resets in 23 h*, *Reported 2 h ago*, with no page errors. Since round 2, each meter shows its own age instead of that last line.

## What remains (by the plan)

- `desk.json` storage of the allowance mapping and its edits: Slice 2. For now the mapping is `DEFAULT_GROUPS`.
- Using these readings for holds, guard thresholds and their reset release: Slice 6. The guard must skip `expired` windows and windows with `used: null`.
- Showing `others`, and disagreement between Codex and the app, on Home: Slice 7.
- The history store and projections: Later.

## Worth a look

- **Old zeros.** The old code stored a missing Claude utilization or Codex `used_percent` as 0, so a migrated 0 might really mean "unknown". It keeps its number, marked `migrated`, with its age showing. Each window is replaced by the next real reading of it.
- **Re-reading Codex's logs** runs on the event loop with synchronous reads every 5 minutes. `scanBack` stops at the newest `rate_limits` line, usually within the last few KB. For the app, the cached log path avoids walking its session folders each time.

## Not verified

Real Codex and Claude output, as before; the parsers follow the formats the adapters already read, and the tests use synthetic logs and fake agents.
