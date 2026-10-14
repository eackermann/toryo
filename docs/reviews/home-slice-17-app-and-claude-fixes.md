# Home and desk controls, Slice 17: Fix the Codex app's folder check, a failed app turn, and Claude's later results

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 17 (the owner's fix slice, 14 Oct; [the first note](../decisions.md#2026-10-14-following-a-codex-app-turn-that-ended-with-an-error-and-a-fuller-session-timeline), [the second](../decisions.md#2026-10-14-the-codex-app-threads-real-folder-and-every-claude-result-kept)), in the owner's order: the folder check first, then the failed app turn, then Claude's later results.
**Tree:** uncommitted on top of the plan update (`8f73fb7`), after Slice 16 (`b2457c4`).
- **New:** `test/fixes.test.mjs`, this handoff.
- **Changed:**
  - `src/agents/codexapp.mjs`, `src/agents/claude.mjs`, `src/engine.mjs`, `src/protocol.mjs`;
  - `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `web/app.js`, `README.md`;
  - `test/helpers.mjs` (the stand-in Codex app moved here from `test/worktree.test.mjs`, which now imports it), `test/fake-agent.mjs`, `test/worktree.test.mjs`, `test/ui-check.mjs` (round 2).

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **The owner's other room** gets its app turns again once the owner sets where its thread really works. Its next refusal says how: the room's Codex app thread setting (*This thread works in*), `toryo app-folder <room> "<folder>"`, or MCP `toryo_app_folder`.
- **An app turn that ends with an error** shows the error, and *Follow it again* picks up the turn the app resumes.
- **A Claude run that answers twice** keeps both answers.
- **Stored:** `config.agents.codexapp.threadFolders` (thread id → the folder the owner says it works in).

## Round 2: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: Once the app resumed the work, someone else's message was no longer caught, and its reply could be taken. | **After a failed ending, the guard stays on until the reply Toryo takes:** `task_started` no longer clears it. Any user message without Toryo's marker (either way the app logs one: a `response_item` message from the user, or an `event_msg` `user_message`) before that reply ends the follow: *the thread moved on*. | `test/fixes.test.mjs`, *someone else's message after a failed ending, in either form, before or during the resumed work*: four cases (each form, before and after `task_started`), each with a reply saying APPROVED; none taken. |
| 2 | P1: Reply text hid an explicit error. | **An ending with an `error` is that error, whatever text came with it.** <ul><li>The first time, the turn ends with the error, and the text is quoted after it as what the app had written so far, without its status line, never as a reply (*… What it had written before that, which isn't taken as its answer: “Partial answer”*). The turn's text is empty, so it can't approve anything.</li><li>Following again goes past it like any failed ending.</li></ul> | *an ending with an error is that error even with text*: `Partial answer\nTORYO: APPROVED` with the capacity error: the first follow gives the error with the partial text quoted, and no text. Following again waits past it and takes the resumed turn's REVIEW. |
| 3 | P2: Adding the app with no default thread could clear the selected thread's saved folder, for every room. | **The folder field shows the folder saved for the thread actually selected** (the first listed when there's no default), read after the form is drawn. It's sent only when you edit it: an untouched form never sets or clears it. Changing the thread updates the field until you've edited it. | `test/ui-check.mjs` 5zb: no default thread, a folder saved for every thread; adding the Codex app to a room shows the selected thread's folder, and submitting unchanged keeps it in the config. With the old form (in a copy of the tree), the browser check fails there. |

**Mutations,** each failing its test: `task_started` clearing the guard; text hiding the error.

`npm test`: 309 tests, all passing. The browser check and the screenshot script pass.

## What changed

### A. The Codex app's folder check (first, since it blocks a room)

- **Windows' long-path forms** (`localFolder`): `\\?\C:\…` and `\\.\C:\…` are understood like `C:\…`, and so `/mnt/c/…` (as `\\?\UNC\…` already was).
- **Where a thread really works, set by the owner:**
  - **The setting:** a `control` action `app-folder` (`{ folder }`, empty to clear) sets `config.agents.codexapp.threadFolders[thread]` for the room's thread. It's per thread, so it counts in every room on that thread. It's only ever set by the owner and never guessed from the log. It must be an absolute, existing folder (its real path is kept).
  - **Where it's set:** the page's thread sheet (*This thread works in*, under the thread), `toryo app-folder [room] [/path] [--clear]`, and MCP `toryo_app_folder` (`folder`, `clear`). The room's summary shows it (`appThreadFolder`).
  - **What the check uses:** the adapter (`run`) checks the owner's folder when one is set, instead of reading the app's thread list.
- **The refusal names everything:** the engine writes every message (`#appFolderProblem`, given `{ path, set }`, `{ path, recorded }` or `{ reason }`):
  - **For the app's record:** what the app recorded (and its path here), what the room expects, and how to tell Toryo (*“This thread works in” in the room's Codex app thread setting, toryo app-folder <room> "<folder>", or MCP toryo_app_folder*), or to choose a thread opened in this folder.
  - **For the owner's folder:** *You said this room's Codex app thread works in X, not in this room's folder (Y)…*, and how to change it.
- **Rooms with their own worktree** still refuse the app (unchanged).

### B. A Codex app turn that ended with an error

- **The error is reported** (`codexapp.run`): a `task_complete` with an `error` (whatever text came with it; round 2) ends the first follow with *The Codex app ended its turn with an error: \<message> (\<codex_error_info>)*, never as an empty message. The room keeps the app's turn (Slice 3's *lost track*), and asks.
- **The question** (`#appLost`) now names the app's error and says what to do: *The Codex app ended its turn with an error: … It may still be working in the app, so Toryo sends it nothing else until you decide. If you resume that work in the app (in the same thread, without a new message), then choose “Follow it again”: Toryo picks up the resumed turn's reply.* For other lost turns, the same sentence follows *Toryo lost track of the Codex app's turn (…)*.
- **Following again goes past the failed ending:**
  - Read from Toryo's marker, an error ending is kept as `failed`, and following carries on, saying so in the activity (*The Codex app ended this turn with an error (…). Toryo keeps following the thread…*).
  - A `task_started` after it is the same work resumed (said in the activity), and that turn's reply is the result, as long as no user message without Toryo's marker comes first, before or during it (round 2).
  - A user message without Toryo's marker first ends the turn: *After the Codex app ended this turn with an error (…), its thread moved on to another message, not Toryo's, so Toryo doesn't take that reply for this turn.*
  - Nothing after it yet: following keeps waiting (Stop twice still lets it go).
- **A capacity error isn't a usage limit:** nothing here touches usage readings or holds (*Recognized provider exhaustion* stays in Later).

### C. A Claude run with more than one result

- **Every result is kept** (`claude.mjs`, `joinResults`): in order, each later one after `---` and **Follow-up** *(Claude answered again later in the same run)*.
- **The status is the last status line:** if the follow-up has none, the latest one before it moves to the end (said once), so the relay and the ledger still see the review's verdict and its `Resolved:`/`Open:` lines.
- **Totals:**
  - tokens add up across results (each result's `usage` is its own);
  - the cost is the last result's `total_cost_usd` (cumulative over the run, as in the owner's sample), never added twice;
  - `num_turns` add up;
  - the run's error state is its latest result's.
- **The briefing** (the owner's optional point) now ends its status-line paragraph with *Before your final message, stop any background commands you started (watchers, servers), so your answer ends the turn.*

## How to check

- `npm test`: 307 tests, all passing. The browser check and the screenshot script pass.
- **`test/fixes.test.mjs`** (9 tests):
  1. **Long-path forms:** `\\?\C:\…`, `\\.\D:\…`, `C:\…` and `\\?\UNC\wsl.localhost\…` map to their folders.
  2. **The owner's folder** (a stand-in app whose thread is recorded as `\\?\C:\Users\you\scratch`):
     - refused, naming the recorded folder, its path here, the room's folder, and `toryo app-folder <room> "<repo>"`, with nothing queued;
     - a relative or missing folder is refused;
     - set to the project: the app gets the message;
     - kept across a restart;
     - set elsewhere: *You said … not in this room's folder*;
     - cleared: back to the app's record.
  3. **Command line and MCP:** `toryo app-folder` shows and sets it; MCP `toryo_app_folder` shows, clears, and refuses a missing folder.
  4. **The owner's sample** (`task_complete` with `error`, then `thread_settings_applied`, `task_started`, a developer message, work, and the handoff):
     - the first follow ends with the error, `codex_error_info` included;
     - following again from the marker keeps waiting with only the failed ending, saying so;
     - once the resumed turn is appended, it returns its handoff (status REVIEW) and says the work was resumed.
  5. **Moved on:** someone else's message after the error, then their turn: the follow-again ends saying the thread moved on, taking no reply.
  6. **In a room:** the question's exact wording; after the resumed turn, *Follow it again* (accepting) completes the turn with the resumed reply. The app was sent the message once, and the room lets the app turn go.
  7. **`joinResults`:** order, the follow-up mark, the last status; a follow-up without a status moves the earlier one to the end, once, after the `Open:` line; one result unchanged.
  8. **A real review with a follow-up** (the fake Claude's new `followUp`, in the owner's sample's shape):
     - the turn's text keeps the review and the marked follow-up, and its status is APPROVED;
     - the ledger has the review's `Open:` line;
     - tokens are summed (`output` 40 + 7), and the cost is 0.015, not 0.025.
  9. **The briefing** asks agents to stop their background commands.
- **Changed tests:** the worktree app tests use the new messages and the moved stand-in app.
- **Mutations** (each fix taken out, in copies of the tree), each failing its test:
  - long paths;
  - the owner's folder;
  - errors read as replies;
  - not going past a failed ending;
  - the moved-on check;
  - last result only;
  - cost added twice.

## Worth a look

- **The owner's folder is per thread,** in the desk's config, not per room. A thread works in one place, so every room on it gets the same answer. The room's sheet and the CLI name the room only to find its thread.
- **The first follow still ends at the error** (so the owner sees it and is asked). Only *Follow it again* waits past it. That's the owner's split: *reported as that error*, then *following again goes past a failed ending*.
- **Not verified against the real app:** the owner's sample is the only source for the error shape and the resumed turn. `event_msg` `user_message` is treated as a user message too, in case the real log records Toryo's or someone's message that way.

## What remains

Slice 18 (earlier sessions, a time ruler, and zoom and pan on the strip), then Slices 19–22 (one at a time per project, review, return and cleanup of worktrees).
