# Home and desk controls, Slice 11: Start a new session in a room

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 11, with *Session timeline and new sessions* (*Starting a new session*).
**Tree:** uncommitted on top of Slice 10 (`b361fe1`).
- **New:** `test/newsession.test.mjs`, this handoff.
- **Changed:** `src/engine.mjs`, `src/client.mjs`, `src/mcp.mjs`, `src/protocol.mjs`, `bin/toryo.mjs`, `web/phases.js`, `web/app.js`, `web/styles.css`, `test/phases.test.mjs`, `test/appthread.test.mjs`, `test/ui-check.mjs`, `test/ui-shots.mjs`, `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision; the choices the plan left open are listed under *Worth a look*.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart, each room offers *Start a new session…* under **Room**, and `toryo session new` and `toryo_session_new` work. Existing rooms are in their session 1 until then; nothing about them changes on its own. New things written: a `session` event in the transcript, `room.session` (its number, the marker's id, when it began), `room.sessionNotice`, and `notSent` on notes a new session didn't send.

## Round 2: your five findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P2: An approval in a new session settled an earlier session's finding because the slice names matched. | **Each ledger entry records its session and build** (`session`, `build`: the build's start). An approval settles only the changes asked for its slice in its own session and build. A finding from an earlier session (or an earlier build) is settled only by a review that says `Resolved: L<n>`. A fresh reviewer's ledger names the session of a finding from an earlier one: *L1 (Slice 1: One, session 1, round 1 changes, Claude)*. Entries from before this have no session: they count as session 1. | Desk test: Claude asks for changes on *Slice 1: One*; the room is stopped. A new session builds again, and a slice of the same name is approved. L1 stays open, and the new reviewer's prompt lists it with *session 1*. |
| 2 | P2: With memory kept, a first turn whose prompt a hook dropped cleared the new-session note, and the retry went without it. | **Undoing a turn's delivery** (a dropped prompt, an empty turn) now puts the note back, as it already did for a fresh start. | Desk test, with memory kept: a turn dropped by a hook, then *Retry*. Both tries carry *A new session … (session 2)*. Then an empty turn, retried once on its own: both carry *(session 3)*. The turn after doesn't. |
| 3 | P2: A second opinion on a message from an earlier session didn't carry that message. | **The message asked about goes along** when it's outside the current session: *Codex, from an earlier session in this room ← the message you were asked about*. The rest of the catch-up stays in the session. | Desk test: Codex answers in session 1; after a new session, Claude's second opinion on that answer has it, and not the rest of session 1 (the question before it). |
| 4 | P2: A reply in a new session marked an earlier note, read by a stopped turn, as answered. | **Replies are attributed to notes of the current session only.** | Desk test: a note read by a turn that's then stopped; a new session; another note, answered. The new note is answered; the old one has no `repliedBy`. |
| 5 | P2: A new session started elsewhere didn't fold the transcript of a chat or planning room on the page. | **A session marker always redraws the transcript,** whatever the room's mode, whether it comes live or with a refresh. | Browser check, step 5x: with the chat room open, session 3 is started through the API (as the terminal or another window would). The page shows *Session 3 started*, two folds (*Session 1*, *Session 2*), session 2's reply inside its fold, and the strip on *Session 3 ·*. |

- `npm test`: 233 tests, all passing. The browser check and the screenshot script pass.
- **Each fix taken out fails its own test** (in copies of the tree): the slice-name match alone (1), no note put back (2), no asked-about message (3), replies across sessions (4), and the redraw only in builds (5, step 5x).

## What changed

### The desk (`src/engine.mjs`)

**`newSession(roomId, { ends, keepMemory, then })`**, also `new-session` under `POST /api/rooms/<id>/control`.

- **Checks, before anything changes:**
  - **The session it ends.** `ends` must be the room's current session, or it's refused (409): *Session 1 has already ended: this room is in session 2 now. Nothing changed.* So a double click, a second window, or the terminal and the page at once start one session. Without `ends`, it's refused (400) and says which number to give.
  - **Nothing running or queued** (409), naming it: *Codex is replying. Wait for it to finish, or stop the room first, then start the new session.* The checks running, work queued (*Claude's review is queued*), and a Codex app turn the room still keeps all count.
  - **The first step**, if there is one, is checked as its own start would check it: a message needs text and a recipient; a plan, a topic; a build, a task or a plan file, and the handoff when it starts with the review. A refused step changes nothing.
- **What ends:**
  - every open question in the room closes (answer *(closed: a new session started)*, with `closedAt`), so an answer to one afterwards is refused;
  - notes the agents haven't had yet aren't sent: each gets `notSent` with the agents it didn't reach, and the page says *not sent to Claude: a new session started*;
  - the planning round or build (`room.plan`, `room.build` cleared), any discussion, and the queue;
  - a new flow starts, so anything from before is stale.
- **The room after:** chat, nothing queued, not paused, stopped or done. Nothing runs until you send something, or the first step does.
- **The agents:**
  - By default each starts fresh on its next turn, through the existing *Start fresh* mechanism (`room.fresh[agent] = "session"`). Its briefing says: *The owner started a new session in this room: what came before it is finished, so you start fresh.*
  - With `keepMemory`, their sessions carry on, and their next turn starts with a short *A new session* note, said once.
  - The Codex app always keeps its thread, so it always gets that note.
- **The marker:** a `session` event: `n`, `ends`, `fresh`, `kept`, `closed` (question ids), `notSent` (note ids). `room.session` keeps the number and the marker's id, saved with the room.
- **Only the session's events reach the agents.** What an agent catches up on (`#catchUpItems`), and a fresh agent's briefing (`#freshBrief`: the last messages, the latest handoff), start at the current session's marker. Kept memory or not, nothing from before is shown to them again.
- **Kept:** the room's name, crew, settings, project and folder, and its ledger (open findings stay open).

**The summary** (`session`) now has the session's number, and `earlier`: each earlier session's number, start, end, length and totals.

### One calculation, split by session (`web/phases.js`)

- **`Sessions`** keeps a `Timeline` per session, starting a new one at each `session` event. An event belongs to the session it arrived in, also when it changes later (a question closing as the new session starts stays in the old one).
- **An earlier session's view** ends where the next began, and is kept until one of its events changes.
- **The desk and the page** both use it.
- **New helpers:** `workWords` (*building 3 h 10, reviewing 1 h 05*, *under a second of work*, *nothing run*) and `earlierWords`. `sessionWords` takes a label, for *Session 1, …*.

### Command line and MCP

- **`toryo session new [room] [--keep-memory] [chat|plan|build "text"] [--plan file] [--builder …] [--reviewer …]`.** The room is optional (or `--room`), as for the other commands.
  - It sends the session the room is in as `ends`, so two commands at once start one session.
  - It says: *Session 2 started in “Sprint room”; session 1 is kept in its history. Each agent starts fresh on its next turn (the Codex app keeps its thread). Nothing runs until you send something.*
- **`toryo_session_new`:** the same, with `room`, `keepMemory`, `mode`, `text`, `planPath`, `builder` and `reviewer`.
- **Refusals:** the desk's own words, the same everywhere.
- **`toryo show` and `toryo_room`:**
  - *Session 2.* before the session's sentence;
  - a line per earlier session (*Earlier, session 1, 13 Oct, 09:00 to 14 Oct, 18:30: building 3 h 10.*);
  - *— Session 2 started.* in the transcript.

### The page (`web/app.js`, `web/styles.css`)

- **Room → *Start a new session…*** opens a sheet:
  - what ends: the planning round or build, the open questions, the notes not sent yet;
  - the session's totals, and that the room's name, crew, settings, folder and ledger stay;
  - *Keep the agents' memory of this room*, saying the Codex app keeps its thread either way;
  - the first step as four cards: *Nothing yet*, *Chat*, *Plan*, *Build* (with the handoff fields, as the new-room form has).
- **When the room is busy,** the sheet says what's running or queued, in the desk's words, with *Stop the room*. A refusal from the desk shows there too.
- **The button is disabled while the request is on its way,** and the desk refuses a second request for the same session anyway.
- **In the transcript:**
  - the marker (*Session 2 started · date · Codex and Claude start fresh · 1 question closed · 1 note not sent*);
  - each earlier session folded into one line: *Session 1 · dates · building 3 h 10 · 12 turns*, which opens to show it.
  - A link into an earlier session (a strip piece, a jump) opens every fold it's in.
- **The strip:**
  - It shows the current session, *Session 2 · …* once there's more than one. A new session with nothing run yet still shows it, so the earlier ones stay reachable.
  - Its list has a *Sessions* section. Each earlier session can be shown on the strip (*Session 1 (earlier) · …*), with *Back to session 2* beside the words. Its pieces link into its fold.

## How to check

- **`npm test`:** 233 tests, all passing.
  - **`test/newsession.test.mjs`** (10 tests: round 2's four are in the table above):
    1. **Refused, then started once.**
       - Refused while Codex works (*Codex is replying…*), and while a reply is queued (*Codex's reply is queued…*), changing nothing; without `ends`, refused with the number to give.
       - Once stopped, accepted. The same request again is refused (*Session 1 has already ended…*), and there's one marker. The room is in session 2, idle.
    2. **What ends and what stays.**
       - The open question closes with `closedAt`, and an answer to it afterwards is refused. The unsent note gets `notSent: ["claude"]`.
       - The room is in chat, not paused or stopped, with nothing queued. Its name, settings, crew, project and ledger are unchanged.
       - The marker lists who's fresh and what closed.
       - The next message: Codex and Claude each start a new session, with the new-session briefing and the new message. Neither prompt has anything from before (the old question, the unsent note).
    3. **Keep memory:** Codex resumes the same session, and its next prompt starts with *A new session … (session 2)*. The one after doesn't.
    4. **First steps:** a plan with no topic, or a build with neither task nor plan file, is refused and nothing changes. A planning round starts from it (mode plan, its topic, proposals run). After stopping, a build starts from it (mode build, its task, the builder runs).
    5. **Totals and restart:**
       - A reply of 0.6 s in session 1. After the new session, every total is 0, and `earlier[0]` has session 1's totals.
       - After a restart, the same split and totals. The next turn's prompt has only session 2, and session 1's totals are still unchanged.
       - A `Sessions` fed the room's events (as the page does) has session 1's totals too.
    6. **API, command line and MCP:** while Codex works, the command line and MCP give the same refusal. Once stopped:
       - the command line starts session 2;
       - MCP starts session 3, with memory kept and a first message, which Codex answers;
       - the API starts session 4, and the same request again is a 409 with the desk's words;
       - `toryo show` has *Session 4.*, the three earlier sessions, and the marker.
  - **`test/appthread.test.mjs`:** a new session in a room with the Codex app.
    - The marker has it as kept, the room's thread is unchanged, and the next two turns go to the same thread.
    - The first of them has *A new session* and nothing from session 1; the second doesn't have the note.
  - **`test/phases.test.mjs`:**
    - sessions split at the marker;
    - a question closing as the new one starts stays in the old one, with its 10 minutes of waiting;
    - an earlier view ends where the next began and is kept;
    - `of()`, `earlierWords`, `workWords`.
- **The browser check passes,** steps 0 to 6, with a new step 5x in the room from step 5u:
  - *Hold this.* keeps Codex working. **Room** → *Start a new session…*: the sheet says *Codex is replying. Wait for it to finish, or stop the room first.* *Stop the room* stops it.
  - *Chat*, *Next sprint.*, then a **double click** on *Start session 2*. The sheet closes, *Session 2 started* shows, and the room has exactly one session event.
  - Session 1 is one closed fold (*Session 1 …*), with its old turn hidden.
  - The strip reads *Session 2 · Other work n s · n s in all* once the reply has run.
  - From the list, *Session 1* goes on the strip (*Session 1 (earlier) · Other work …*, with *Back to session 2*). Its piece opens the fold to its turn. *Back to session 2* returns.
- **The screenshot script passes**, with new shots: the new-session sheet at 1440, 390 and 320 (light and dark), and a room in its second session (the fold, the marker, the strip). They pass the contrast and sideways-scrolling checks.
- **Mutations** (in copies of the tree), each failing a test:
  - **catch-up not scoped to the session:** the test of what ends (old messages in the prompt);
  - **`ends` not checked:** the refusal test and the API test;
  - **the busy check removed:** the refusal test and the API test;
  - **the new-session note not cleared:** the keep-memory test and the Codex app test (*said once*);
  - **`Sessions` not splitting:** the unit test, the totals test and the API test;
  - **earlier sessions not folded on the page:** the browser check, step 5x.

## Worth a look

These are choices the plan left open:

1. **A new session clears a pause or a stop.** The plan says the room then waits in chat with nothing queued; with the queue empty, nothing runs until you send something. Keeping the pause would make the sheet's first step wait for a resume.
2. **Notes not yet delivered aren't sent.** They were written for the session that ends. Carried over, they'd reach agents starting fresh with no context. They're listed in the sheet before you confirm, and marked on the note after.
3. **The agents see only the new session's messages, even when they keep their memory.** The ones that keep it remember the earlier sessions anyway; the others start clean. The previous handoff, in a new build, isn't quoted to a fresh reviewer.
4. **A result arriving late from before can't happen by construction:** a new session is refused while anything runs or is queued, including a Codex app turn the room keeps. What remains is answers to its questions, which are refused (tested). Anything else from the old flow would be stale (the new flow).
5. **The earlier session's turn count** in its fold counts real turns, not an imported handoff.
