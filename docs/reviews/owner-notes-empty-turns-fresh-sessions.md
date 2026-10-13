# The owner's notes of 13 Oct: empty turns, fresh sessions and the ledger, editable notes, Enter to send, Ask or Tell

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Context:** outside the plan, from the owner's notes while Slice 1 was in review (round 2). Reviewed together with `docs/reviews/home-slice-1-usage-observations.md`.
**Tree:** uncommitted. The owner's decisions are recorded in `docs/decisions.md` ("Empty turns are errors; fresh sessions and the reviewer's ledger; editable notes"), and the README describes the behavior.

## 1. An empty or hook-dropped turn is an error, never a verdict

In a long-running project room, a Claude Code plugin's hook dropped two review prompts. Claude returned no text, `num_turns: 0`, and a stream message "Prompt dropped by a hook: …". Toryo read "no status" as changes requested and sent the builder an empty review.

- **`src/agents/claude.mjs`.** Any stream event containing "dropped by a hook" is remembered. The message is found wherever it sits in the event (`findText`), since the exact event shape isn't documented.
  - If the turn ends with no text, the result is `error: "Claude never saw the prompt. Prompt dropped by a hook: <the message>. (a Claude Code hook stopped it; check the plugins and hooks in Claude Code's settings)"` with `dropped: true`.
  - Separately, a result with `num_turns: 0` and no text is an error: "Claude ran no turns and returned nothing."
- **`src/engine.mjs`, `#executeTurn`.** A turn that would be `done` but has no text is `failed`, with "<Agent> returned an empty message: no text and no status line." This applies to every agent. The turn event records `dropped` and `empty`.

  For a dropped or empty turn, the new `#uncommitDispatch` undoes what the turn counted as delivered. It removes the turn's catch-up from `seen`, removes the agent from the notes' `deliveredTo`/`readBy`, and resets `introduced`, the builder's briefing and a pending fresh start. It also restores the session the agent had before the turn (`run.sessionBefore`). The next try therefore sends the whole message again, the builder's handoff included. A session that only the dropped turn started is forgotten: there's nothing in it to resume.
- **`#afterTurn`.** A failed turn still gets one quiet retry, except a hook drop, which goes straight to the owner, since the hook would drop it again. After that comes the usual `error` question, recommending Retry. Nothing reaches `#afterBuild`, so no round is counted and nothing goes to the builder.

## 2. Fresh sessions, the fresh-reviewer setting and the ledger

- **Start fresh.** `control(room, "fresh", { agent })` (the crew card's *Start <agent> fresh in this room*) sets `room.fresh[agent] = "you"`.
  - It refuses an agent not in the room, and the Codex app: its session is its thread, which the owner chooses (`canStartFresh`).
  - The next turn (`#executeTurn`; never one that follows a Codex app turn) deletes `room.sessions[agent]` and `introduced[agent]`. The agent then gets the preamble, a **fresh brief**, the usual "Since your last turn" and the instruction.
  - `room.fresh[agent]` is cleared only when the agent really starts the turn (`#commitDispatch`), and restored if the turn never really ran (`#uncommitDispatch`). A launch failure keeps the fresh start for the retry. A turn running when you press it finishes in its old session; the next turn starts fresh.
- **The fresh brief** (`#freshBrief`).
  - **In a build:** the agent's role and the task, then the plan path with the slices approved so far and the one in progress (from `planView`). Then the latest builder handoff (REVIEW or DONE), verbatim with its status line, unless it is already in this turn's catch-up. A fresh builder also gets the review of that handoff, and a fresh reviewer gets the ledger.
  - **In chat or planning:** the last six messages not already in the catch-up.
- **Fresh reviewer for each new slice.** This is a room setting, `freshReviewer`, **on by default**: `DEFAULT_SETTINGS`, and rooms without the setting count as on. It's in Room settings and in the side panel.
  - `#queueReview` marks the reviewer fresh (`"new-slice"`) when the slice differs from the one it last reviewed (`build.reviewedSlice`) and it has a session to forget. Round 2 of the same slice keeps the session.
  - **The final review is always fresh** (`"final"`), whatever the setting.
- **The ledger** (`room.ledger`, kept per room across builds):
  - **Entries** (`#ledgerFromReview`, called once per review that has a status; a review that has to be asked for its status counts with the review it belongs to):
    - **CHANGES**, or no status in the end: an open `changes` finding (L<n>) with the review's text, without its status line, up to 3,000 characters.
    - **APPROVED:** closes the slice's open `changes` findings ("Slice 1 approved in round 2"). Each line starting `Open:` becomes an open finding.
    - **Any review:** a line `Resolved: L<n>` closes that finding.
  - **Decisions:** the owner's answers to build questions (`build-owner`, `review-owner`, `max-rounds`, `nudges`, `gates`, `slice-approved`) become `decision` entries (D<n>) with the question and who asked.
  - **What a fresh reviewer gets** (`#ledgerText`): the open findings, the last 20 decisions, and how to write `Resolved:`.
  - The review prompt now asks for `Open:` lines when approving with something left for later.
  - The side panel lists open findings and the last five decisions, with a count of resolved findings.

## 3. Edit or cancel a note while it's queued

- **`editNote(room, eventId, { text } | { cancel: true })`**, also `PATCH` / `DELETE /api/rooms/:id/notes/:eventId`.
  - **Only for plain notes:** not answers, topics or decisions.
  - **Only while queued:** delivered to no one, read by no one, and not carried by a turn that's starting (any running turn's `dispatch`). Otherwise it refuses with 409 "already gone to the crew".
  - **Editing** patches the text and sets `editedAt`. The agent gets the new text, since catch-up reads the event when the turn starts.
  - **Cancelling** sets `cancelled`. Catch-up and `#notesDuring` skip the note, and a system line says it was withdrawn. Turns queued only for this note go too: `postMessage` now tags the chat or build-note turns it queues with `note: <event id>`. A build-note that had reopened a finished build closes it again. A discussion started by the note is dropped if it hasn't begun.
- **The page.** Under a queued note: *Edit* (in place, with Save / Keep as it was) and *Cancel note*. A cancelled note is struck through and says *withdrawn*; an edited one says *edited*.

## 4. Enter sends, Shift+Enter is a new line

The composer sends on Enter without Shift, except while an input method is composing (`isComposing` / keyCode 229). Shift+Enter inserts a new line. The placeholders say so.

## 5. Notes don't turn building into answering (Ask or Tell)

A later note from the owner. It replaces the "To you:" reply turn that every mid-turn note used to get (`note-reply`).

- **Ask or Tell** (`web/intent.js`, shared by the page and the server). `postMessage({ intent })` stores `intent` on the note. Without one, `noteIntent(text)` decides:
  - **Ask:** a question mark, a question word, "is/are/was/were …", "do/should/have" followed by a pronoun, or a request for an opinion or a choice.
  - **Tell:** anything else, including "Do the migration first", "Have a look" and "Could you add tests" without a question mark.
  - The composer has an Ask/Tell switch that follows the text until you choose. The CLI takes `toryo say --ask|--tell`, and MCP's `toryo_say` takes `intent`.
- **Numbered notes.** `#catchUpItems` numbers the plain notes to this agent N1, N2… and puts the number in the heading: "The owner (to you) · note N1, ask". A building turn that carries notes gets `prompts.noteAcks`: the list, and "start your message with one line per note: done / scheduled for <slice> / declined", plus "answer each ask after its line". The numbers are kept in `run.dispatch.notes`, so a restart keeps them.
- **`#queueNotesTurn`** (replaces `#queueNoteReply` for new turns):
  - **The builder** gets `build-notes`, *Building: your notes*. If it resubmits (REVIEW, DONE, OWNER), that's the new outcome. If it replies REPLY, the relay carries on with the outcome from before (`req.after`), so it's checks, then review. There's no separate reply turn.
  - **Anyone else** gets a turn only for an Ask: `note-answer`, *Answering your question*, which is read-only. The room then carries on with `req.after`, **whatever status the answer gives**, so a verdict never changes by answering. A Tell goes with that agent's next turn.
  - **An Ask to an agent that isn't working and isn't the builder** is answered at once: `postMessage` queues a parallel read-only `note-answer` with no `after`. A builder answers in its next building turn.
- **`#noteOutcomes`.** When a turn finishes, the outcome lines (`N1: done — …`, `scheduled`, `declined`, `answered`) are read into `note.outcomes[agent] = { status, detail, turnId }`; an answered Ask becomes `answered`. The note's chip shows "Codex: done — added note.txt" and links to the turn.
- **Turns queued before the change.** `note-reply` turns still in a room's queue keep their old handling and prompt.

## Tests

`test/fresh.test.mjs` (new, 6 tests):
- **A hook drop on a review:**
  - It's an `error` question naming cache-tax, recommending Retry; the turn is `failed` with `dropped`.
  - There is no automatic retry, no builder turn, no round counted, and the dropped turn's session is forgotten.
  - The owner's Retry sends the builder's handoff again in a new session, and the slice is approved.
- **An empty review:** one quiet retry, then the error. Both tries carry the builder's message, and no round is counted.
- **Starting fresh:**
  - Only Claude's session goes; Codex keeps `resume` and its session.
  - Claude's next call uses a new `--session-id`, and its prompt has the fresh brief with the earlier messages.
  - `fresh` is cleared afterwards, and an agent that isn't in the room is refused.
- **Two slices plus the final review:** CHANGES, then approval with `Open:`, a builder question answered by the owner, slice 2 with `Resolved: L2`, then DONE.
  - The reviewer's sessions are new, resume, new (fresh), new (final).
  - The slice 2 prompt has the brief, `L2 … tidy the README section later`, no `L1`, and `D1 (Slice 1, Codex asked): Use SQLite or Postgres? → Use SQLite.`
  - The ledger ends with L1 resolved by approval in round 2, L2 resolved by Claude's slice 2 review, and D1.
- **The same flow with `freshReviewer: false`:** new, resume, resume, and new for the final review.
- **Notes:**
  - Withdrawing a queued note removes its queued turn, so nothing runs.
  - An edited note reaches the agent with the new text only.
  - Editing after delivery is refused, and the system line is there.

`test/notes.test.mjs`: the first two tests and the Codex app restart test are rewritten for the new behavior, and three tests are new:
- **A question to the builder mid-turn:** `build:REVIEW`, `build-notes:REPLY`, then `review:OWNER`. The prompt has "note N1, ask", the N1 list and "answer it right after its line", and no "To you:". The reviewer sees the answer, and the note's outcome is `answered — tabs it is.`
- **An instruction to the builder mid-turn, then a question to the reviewer mid-review:** `build`, `build-notes:REVIEW` (the slice renamed), `review:CHANGES`, `note-answer:APPROVED`, `build-fix:OWNER`. The CHANGES verdict stands, the answer was read-only, and the outcomes are `done — added note.txt` and `answered`.
- **An instruction to the reviewer mid-review:** no extra turn. It arrives in round 2's prompt as "note N1, tell".
- **A question to the idle reviewer while the builder works:** answered beside the build. A note with a question mark that you marked Tell gets no turn.
- **The Ask/Tell rules.**

`test/fake-agent.mjs` gains `empty` (ends the turn with no message) and, for Claude, `hookDrop` (reports "Prompt dropped by a hook: …", then an empty result with `num_turns: 0`).

`test/ui-check.mjs`, in a real browser:
- Shift+Enter makes a two-line message, and Enter sends it and empties the box.
- The queued note (the Codex app is busy) is edited, shows *edited*, then is cancelled and shows *withdrawn*.
- *Start Codex fresh in this room* turns into "Starts fresh on its next turn".

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 92 tests, all pass
node test/ui-check.mjs                               # passes
```

## Worth a look

- **The hook message's shape is a guess.** The owner reported the text, not the event. Since round 3, Toryo looks for a string that *starts* with "Prompt dropped by a hook" in Claude Code's own events only: not the model's messages, tool results or the final message, which may quote it. If the real notice arrives some other way, the empty-turn rule still catches a turn with no text. It then gets one quiet retry, which the hook also drops, before the error.
- **An empty turn is an error for every agent,** the Codex app included: an app turn whose last message is empty now asks the owner instead of nudging or treating it as no status.
- **The first review of a build** isn't marked fresh when the reviewer has no session yet. When the reviewer has a session from planning in the same room, the first review *is* fresh ("new-slice"), which drops the planning context. The plan path and the ledger cover what matters, and an independent first review is arguably what the owner wants.
- **`Open:` and `Resolved:` are a light convention,** asked for in the review prompt. A reviewer that doesn't follow it only weakens the ledger: CHANGES findings still open and close by themselves.
- **No terminal or MCP commands** for starting fresh or editing notes yet. These are page and API only, and the owner didn't ask for more.
