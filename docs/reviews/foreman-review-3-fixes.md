# Foreman: fixes for Codex's third review, and the owner's three requests

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Responds to:** Codex's review of `docs/reviews/foreman-review-2-fixes.md` (five findings), and three owner requests from the same round:
- notes get answers;
- "waiting for you" first in the room list;
- the desk serves the page it started with.

**Tree:** still entirely uncommitted. The earlier handoffs (`foreman-review-1-fixes.md`, `foreman-review-2-fixes.md`) still describe what this round doesn't change. The one exception: `room.following` from round 2 is replaced by `room.appTurn` (finding 2 below), and old rooms are migrated.

All five findings and all three requests are done. `node --test` runs 55 tests, all passing in about 26 s, and the browser check, `node test/ui-check.mjs`, passes. The owner's three decisions are appended to `docs/decisions.md`; the planning room's section and the earlier thread decision are untouched. The README describes all of it.

## Codex's findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | App rooms never got the house rules; a thread change kept stale delivery state | Briefing is now tracked per session. `room.introduced[agent]` records which session got Foreman's introduction (house rules, decision recording). The introduction goes to any session that hasn't had it (`engine.mjs:1107`): an agent's first turn here, or a new Codex app thread. Such a session also gets the agent's own earlier messages in this room. Changing a room's thread (`:813`) clears the app's `seen` and its introduction, and sets `build.briefed = false` if the app is the builder. Its next turn then carries the introduction, the room's history (trimmed as usual if huge) and, for a builder, the kickoff. Older rooms are migrated: an agent that already had a turn counts as introduced in its session. | `notes.test.mjs`: “the Codex app gets the house rules in a new room, and again with the room's history in a new thread”: the first app prompt has the rules; the second in the same thread doesn't; after a thread change the rules, the first question and the app's own earlier reply return; a builder moved to a new thread gets `## Your role: builder` again. |
| 2 | An observation error freed an accepted app turn's reservation | One persisted record per room, `room.appTurn` (`:102`): `{ marker, thread, req, lost }`. It's set the moment the app accepts the message (`onSubmitted`, `:1179`) and cleared only when that turn finishes or you let it go (`:1221`). While it exists, `#pump` sends the room's app nothing else (`:1007`). `#appThreadWorking` blocks every other room on that thread, including across restarts (it's in `room.json`). A thread change or another room taking the thread is refused (`#appBusy`). If following it fails (an error or a crash after submission), the record is marked `lost`, Foreman stops following, and you're asked (`app-lost`, `#appLost` `:1408`): *Follow it again*, which follows the same marker and never resends, or *Stop waiting for it* (`app-release`, `:762`). A second Stop also releases it. That question survives new runs and a first Stop (`#clearWaiting` keeps it). Round 2's `room.following` is migrated into `appTurn`. | “when following the app's turn fails, the turn stays kept…”, your reproduction extended. The adapter accepts, then throws. Afterwards no other room can take the thread, room B's turn waits, a new planning run in room A neither sends nor drops the question, a restart keeps it, a first Stop keeps it, *Follow it again* follows, and only once that turn ends does room B send. |
| 3 | Stop during reconnect preparation abandoned accepted work | The preparation check (`:1157`) cancels only an **unsent** turn on a stop. A follow (`req.attach`) carries on after a first Stop, and only abandon skips it. The adapter's own pre-send check is unchanged. | “a first Stop while Foreman reconnects to the app's turn keeps following it” (restart with an accepted turn, a slow snapshot, Stop during it). The calls are `send, follow`, and Resume sends nothing while the turn runs. The round-2 stop-before-submission test still passes. |
| 4 | The owner's note answers weren't implemented | See *Notes get answers* below. | Below. |
| 5 | “Waiting for you” wasn't detected for chat questions, nor shown first | Open chat questions are tracked in `room.openChat`, rebuilt from events on load, added when an agent asks, and removed when you write to it. They count as waiting: `#status` returns `waiting` before `running`, `waitingCount` includes them, `summary.waiting` shows the first (`#firstAsk`, `:686`), and auto-routing sends your reply to the agent that asked. The page uses the same rule for its route preview and placeholder (`asking`, `app.js:788`). The room list is redone; see *The room list* below. | “a question asked in chat makes the room wait for you, even while another agent works”: Codex asks while Claude still works, so status is `waiting` with Claude in `working`; it stays waiting once Claude is done; a plain reply is routed to Codex and clears it. The browser check confirms the asking room's first item is the “needs you” pill. |

## The owner's requests

### Notes get answers

- **When it happens.** A turn has ended, and the owner wrote to that agent during it with a note the turn didn't carry (`#notesDuring`, `:1373`). Before acting on the turn's status, Foreman queues a `note-reply` turn for the same agent, at the front of the queue (`#queueNoteReply`, `:1385`). The prompt (`prompts.noteReply`, `protocol.mjs:139`) asks for a reply that starts with “To you:”, answers the questions, and says whether the note changes the work.
- **Builder.** If the note changes the work, the builder acts on it and resubmits (REVIEW, DONE or OWNER). If not, it ends with `FOREMAN: REPLY`, and the relay continues with its earlier status.
- **Reviewer.** It stays read-only: same access, so the read-only mount applies. It may give a new verdict, or `FOREMAN: REPLY` to keep the old one.
- **Others.** Planners and second opinions likewise.
- **How the relay continues.** `#afterTurn` (`:1360`) acts on the outcome: the reply's own status if it gave one other than REPLY, otherwise the status of the turn it answered for. The final-review intent travels with it. Notes during a reply get a reply too. In chat mode the existing queued chat reply already answers, so nothing changes there.
- **Note states.** Delivery records `readBy[agent]` (the turn reading it); the end of a finished turn records `repliedBy[agent]`. Under each note the page shows *waiting for X's turn to end* (or *next turn*), *X is reading it*, then *X replied*, which links to the reply (`noteStates`, `app.js:527`). Turns of this kind are labelled *Answer to your note*.
- **Tests** (`notes.test.mjs`):
  - “a note sent mid-turn gets an answer before the reviewer starts”: the order is `build:REVIEW`, `note-reply:REPLY`, `review`, and the reviewer's prompt has both messages. `readBy` and `repliedBy` point at the reply.
  - “a note can change the work…”: the builder's reply writes a file and resubmits under a new slice name. The reviewer's reply runs read-only (`--disallowedTools` plus “You are still read-only”) and turns CHANGES into APPROVED, so the builder moves to the next slice.

### The room list

The order is the one the owner asked for (`roomIndicator`, `app.js:348`):
1. **Needs you:** a bold amber pill, and the row gets an amber border.
2. **Working:** the agent's initials chip with its task (🔨 building, 👓 reviewing; 📝/🔍/🧪/💬 for the other kinds).
3. **Otherwise the state:** ⏸ paused, ⏹ stopping or stopped, ✓ done, ⏳ starting, and the text **Zzz** for idle.

The tooltip and screen-reader text say the same in words, for example “Codex is waiting for your answer · Claude is reviewing · build room”.

### The desk serves the page it started with

- **Load at startup.** New `src/page.mjs` (`loadPage`, `:64`) reads every file under `web/` into memory once; nothing is listed by hand. The server serves only that set, with types by extension; anything else is a 404. `bin/foreman.mjs` loads the page before taking the desk lock or recovering any room. `FOREMAN_WEB_DIR` points it at another copy, for testing.
- **Startup check.** `index.html`, and every local file referenced by `src`/`href` in HTML or by `import`/`export … from` in scripts, must exist. Otherwise Foreman exits with `Foreman's page is incomplete. Missing in …: status.js (used by app.js).` before touching any room.
- **The notice.** The state carries `webVersion` (a fingerprint of what's served) and `webOnDisk` (a fingerprint of what's on disk, re-read only when sizes or mtimes change, at most once a second). The server pushes state when the disk fingerprint changes, checking every 3 s. The page (`checkPageVersion`, `app.js:107`) offers *Reload* only when the desk restarted with a different page. When the files on disk differ from what's served it says “Foreman has been updated. Restart Foreman to use it: `foreman quit && foreman`”, with *Copy* and a dismiss button.
- **Tests:**
  - `server.test.mjs` “the desk serves the page it started with…”: a server on a copy of `web/` keeps serving the original `app.js` after it's rewritten to import a new `new.js`, `/new.js` is a 404, and the state says the disk differs.
  - “a page with a missing file stops the desk from starting”: `loadPage` names the missing `status.js` and its importer, the real `bin` exits 1 with that message and writes no `server.json`, and a missing `index.html` is named too.
  - The browser check changes `styles.css` under its desk and waits for the restart notice.

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 55 tests, ~26 s
node test/ui-check.mjs                               # needs playwright-core; see the file's header
```

The browser check now also covers the “needs you” pill being first for an unanswered chat question, and the restart notice after a page file changes on disk. It runs its desk on a free port with a temporary data folder, a copy of `web/` and fake agents, so nothing live is touched.

## Not verified

- The real Codex app, as before; its stand-ins honour the adapter contract (`onSubmitted` after `codex queue`, follow by marker).
- Real agents' handling of the note-reply prompt. The protocol is the usual status line, and a reply with no status keeps the earlier one, so a missing status can't stall the relay.

## What remains

Nothing from this review. Still open from before, unchanged: an owner answer to a reviewer's question goes to the builder.
