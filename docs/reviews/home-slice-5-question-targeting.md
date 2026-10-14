# Home and desk controls, Slice 5: target questions safely across every existing client

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 5. It was Slice 4 until the owner's plan change today (below), and this file was `home-slice-4-question-targeting.md`.
**Tree:** Slice 3 is committed (`de35af1`). This slice is uncommitted on top of it. Its files are `src/engine.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `web/app.js`, `README.md`, `test/ui-check.mjs`, the new `test/questions.test.mjs` and this handoff. Once it's approved, I'll commit only those. Separately, I'll commit the plan change: the plan, the new `docs/decisions.md` entry and the README's *Planned* paragraph. Nothing needs an owner decision.

## The plan changed: please review it too

The owner sent a note (N1): a new slice, a design system and re-skin of the page, goes right after Slice 3. In `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`:
- **New *Slice 4: Design system and re-skin*.** Its text is from the owner's note: the approved prototype, tokens and `docs/design-system.md`, color meaning activity, the activity rings and sparkler, the restyled page, bundled fonts, what's kept, and the optional split into two reviews. Verification and Done-when follow the plan's format.
- **Renumbering.** Slices 4–17 became 5–18, with every reference in the plan's text. "Slices 11-17" is now "Slices 12-18", "seventeen" is now "eighteen", and "Slice 4's question-targeted operations" is now Slice 5's.
- **The order paragraph** under *Reviewable slices* names the re-skin after the app-thread boundary, and the summary that follows it now starts with Slice 4.

In `docs/decisions.md`, a new entry records the owner's decision: the approved prototype is the look, and the new slice and its rules. It also says older entries count slices the old way, and records one crew choice. In `README.md`, the *Planned* paragraph mentions the new look first.

**The crew choice: this slice keeps going first.** It was already built and in its last review round when the plan changed. It finishes this review under its new number, and I build Slice 4 right after. The owner has since confirmed that order: Slice 4 once this slice is approved, then Slice 6 onwards. The decisions entry now says so. Its status line now says *Slice 5*. The relay counts a new slice name as a new slice, so its round count starts again, and you may get a fresh session. Rounds 1 to 4 below give the history. Nothing in the code changed for the renumbering.

**Restart:** not live until the owner restarts the desk (`toryo quit && toryo`). What changes after the restart:
- The room page ties each note to the question it shows when you begin writing it. Each room keeps its own draft, with that tie and the recipient you chose, across room switches and reloads. Its answer buttons, *Retry* and the planning form name their question. An answer to a question that was answered meanwhile is refused instead of landing on a newer one.
- The planning form gets *Accept all recommendations*.
- Over HTTP, an answer, a retry and the planning calls must name their question.
- Agents read each answer next to the question it answers.
- A note that answered a question can no longer be edited or withdrawn.
- A draft left in the box from before the restart comes back as a plain note that answers nothing. Press a card's *Write my own answer* to make it that question's answer.

The terminal and MCP commands start fresh each time, so they use this code straight away. Until the desk restarts, they answer the way they used to, since an older desk doesn't list question ids. The one exception: an answer that names a question is refused with a message to restart first (tested).

Every way of answering now says which question it answers. The desk acts on that question only if it's still open. A second client, an old screen, or a phone that is a moment behind gets a refusal (409) and nothing is sent. Nothing goes to a different question, and no continuation is queued twice. The same goes for *Retry* and for the planning call: a second submission can't start a second plan. A plain note no longer closes an agent's questions wholesale.

## Round 7 (round 3 as Slice 5): your finding

| Finding | Fix | Test |
|---|---|---|
| P2: A send noted the saved revision as it was at that moment. If another tab had already saved a newer draft for the room, the send took that revision as its own, and its late reply then cleared the newer draft or undid its question. | **A tab remembers the saved revision of the draft it actually has** (`S.loaded`): the one it wrote (`revise`), or the one it loaded on opening the room (`restoreDraft`). A send notes that one, not the current saved one. When a tab opens a room whose saved revision has changed since it last had the room, the draft it now shows is a different one, so its own revision moves on too. The reply checks two things separately: whether this tab still has the draft it sent (`mine`), and whether the saved drafts still hold it (`shared`). The saved draft and its tie are cleared, or set to answer nothing, only when both hold. This tab's box is emptied after a success, or its tie set to answer nothing after a refusal, only when it still shows the sent draft. | Browser check, step 5k, where the second tab writes first. The first tab writes an answer tied to the first question. The second tab then opens the room, writes a newer draft and chooses the second question. Only after that does the first tab send its older answer, which is held back. All four cases run: success or refusal, with the first tab moved on or still in the room. Each time the saved draft, its tie to the second question and its recipient stay. A first tab that stayed shows an empty box after a success and keeps its text after a refusal. The second tab's draft then answers its question. Step 5j still covers a second tab that writes during the send. Three fixes removed in turn each fail the check: noting the saved revision as it is at sending, as last round; not noticing another tab's newer draft on returning to a room; and ignoring this tab's own changes. The test also waits for the second tab's own reply before closing it. Closing a tab mid-send leaves its draft saved, and that had made the check flaky. |

- `node --test` runs 146 tests, all passing.
- The browser check passes.

## Round 6 (round 2 as Slice 5): your finding

| Finding | Fix | Test |
|---|---|---|
| P2: The revision was only kept in one tab, while every tab shares the saved drafts. A late reply in one tab could clear, or undo the question choice of, a newer draft another tab saved for that room. | **The revision is also saved with the draft** (`toryo.revision.<room>`), which every tab shares. `revise` writes a new one whenever a tab changes a room's draft: its text, its recipient or the question it answers. A reply now acts only if both are unchanged: this tab's revision, and the saved one it noted when sending. This tab's revision stays as you asked. It's also what still protects the draft when the browser won't save anything (storage turned off or full), because the saved revision then reads the same before and after. | Browser check, step 5j, with a second tab in the same browser. The first tab sends in a room, its send held back, and moves to another room. The second tab opens that room, writes a newer draft and chooses the other question. The late reply then arrives in the first tab, in all four combinations: success or refusal, with the first tab still elsewhere or back in the room showing the newer draft. Each time the saved draft, its tie to the newer question and its recipient stay, and in the "back" case so does the box. The second tab's draft then answers the question it chose. With only this tab's revision checked, as last round, the step fails. |

- `node --test` runs 146 tests, all passing.
- The browser check passes. Its main page now opens through a browser context, so a second tab can share its storage.
- Codex marked L10 resolved.

## Round 5 (round 1 as Slice 5): your finding

| Finding | Fix | Test |
|---|---|---|
| P2: A late reply recognised its draft by its text alone. Suppose you sent "Yes." to question A, then pressed question B's *Write my own answer* while it was on its way, leaving "Yes." in the box. A's late success cleared B's draft, and a late refusal undid its tie to B. | **Each room's draft has a revision.** It changes when you type, when you choose a recipient (a recipient button, *Write my own answer*, *Discuss more first*, *Interrupt with a note*), and when you choose a card's question (`revise`). `send` notes the revision it sent, and its reply acts only if the room's draft is still at that revision. The text alone no longer decides. Revisions are kept per room, so this also holds after switching rooms. | Browser check, step 5i, in a room where Codex has two questions open. You type "Yes.", which ties to the first. Its send is held back while you press the second card's *Write my own answer*, leaving the same words in the box. The late success answers the first question and leaves the box, its tie to the second question and its recipient alone; Enter then answers the second. The same again with "No.", where the first question is answered elsewhere so the late reply is a refusal. With the text-only comparison put back, the step fails. I also reran round 4's late-reply checks against the new code; each still fails when its fix is removed. |

- `node --test` runs 146 tests, all passing.
- The browser check passes.
- Codex marked L8 and L9 resolved, and L10's cross-room and old-draft cases as passing.

## Round 4: your two findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: A reply that arrived after a room switch acted on the open room's draft. A late refusal replaced its tie, so the next Enter tied it to a newer question; a late success cleared its text. | **A send's reply acts only on the draft it sent, in its own room.** `send` notes its room, its text and its recipient. On success, that room's stored draft and tie are cleared only if the draft is still the text that was sent, and the box is cleared only if you're still in that room. On a refusal, that draft's tie becomes "answers nothing" under the same condition. The message names the room if you've moved on. `keepAnswer` now changes the composer's tie only for the open room; for any other room it changes only what's stored. A room sends one note at a time, so Enter pressed again while a note is on its way doesn't send it twice. *Send* is greyed out only in that room. | Browser check, step 5g. Notes from the first room are held back, like a slow connection. You send there, switch, and write in the second room. Both questions are then answered elsewhere, and the second room's agent asks again. The first room's refusal arrives in the second room. It's shown as "In “Asking room”: …", and the second room keeps its text and its tie: Enter there is refused, and its newer question stays open. You go back: the first room's text is still there, now a plain note. You send it, held back again, and switch away. The success clears the first room's draft but not the second room's text, and the first room's box is empty when you return. With either part put back as before, the step fails. |
| 2 | P1: A draft from before this update was tied to whatever question was open when it came back. | **A draft with no record of what it answers comes back as a note that answers nothing.** It can't answer whatever question is open now. To make it an answer, press that question's *Write my own answer*, or clear the box and start again. | Browser check, step 5h: a saved draft with no tie, as the earlier page left it, in a room where a question is open. After a reload, the draft is back and the box says it's "a note, not an answer". Enter sends it as a note, and the question stays open. With it tied as before, the step fails. |

- `node --test` runs 146 tests, all passing; the desk wasn't changed this round.
- The browser check passes.
- I reran the browser check with each page fix from rounds 2 to 4 removed in turn; every run fails.

## Round 3: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: Switching rooms kept the text and tied it to the new room's question. | **Each room keeps its own draft.** Drafts were already saved per room (`toryo.draft.<room>`), but the box kept its text when you switched. Now opening a room puts back that room's own draft, with its tie and its recipient (`restoreDraft`). A room with no draft gets an empty box. Text from one room is never tied to another room's question. The startup restore, which ran separately 800 ms after load, is gone: opening the first room does it. Switching rooms also clears the *Ask*/*Tell* choice, which belonged to the other room's draft. | Browser check, step 5e, with two rooms that each have a question. You write in the first room and switch: the second room's box is empty. You write there and switch back: the first draft is back, tied to its question. Enter answers the first room's question with the first room's text, and the second room's question stays open. Then the second room's draft answers its own question. With the old switching put back, the step fails. |
| 2 | P1: A reload lost the recipient you'd chosen. | **The recipient is kept with the draft** (`route` in the stored tie). It's saved when you begin writing, and updated when you choose a recipient, *Write my own answer*, *Discuss more first* or *Interrupt with a note* (`setRoute`). Opening the room or reloading puts it back. | Browser check, step 5f: Codex and Claude each ask. You choose the agent whose question came second and type "Yes.". After a reload, that recipient is still selected, the box says "your answer to" its question, and Enter answers it while the other agent's question stays open. With the recipient not restored, the step fails. |
| 3 | P2: A queued note that answered questions could be withdrawn or edited, leaving the questions answered with text that was never sent. | **A note that answered a question stays as sent.** The desk refuses to change or withdraw a note that carries `answers` (409, "That note answered a question, so it stays as sent"). The page shows no *Edit* or *Cancel note* on it. Answers from a card already couldn't be changed. This covers notes the page sends naming questions, and plain notes from a terminal that answer an agent's only question. | "a queued note that answered questions stays as sent…": Codex and Claude are both held. A note to both answers their questions and is queued. Withdrawing it is refused, and so is editing; the note, its text, the questions' answers and both queued turns are unchanged. A plain note to a held agent can still be withdrawn. After release, both agents reply. With the refusal removed, the test fails. |

- `node --test` runs 146 tests, all passing.
- The browser check passes.
- The page checks from round 2 still fail when their fix is removed.

## Round 2: your five findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: A reply typed straight into the composer wasn't tied to a question, so it could answer a replacement. | **A note is tied to its question when you begin writing it.** The page records, per agent, the question the composer offers: the room's first question if that agent asked it, else that agent's only open question, else none. *Write my own answer* records its card's question instead. The record is stored with the draft (`toryo.answering.<room>` in the browser), so it survives updates, room switches and reloads. When you send, the page names that question (`answering: id`). For a note to several agents it names their chat questions (`[ids]`); for a note that answers nothing, `false`. An emptied draft lets go of the tie, unless you chose a card. The composer's route line says what the note answers. When that question was answered meanwhile, the line says the note won't be sent, and Enter is refused with a message; your text stays. Sent again, it goes as a note and answers nothing. The page reads open questions from the questions themselves. The room's own lists arrive a moment later, so binding to them missed a question that had just appeared; the browser check caught that. | Browser check, step 5c2. You type straight into the composer, and the route line says "your answer to “SQLite or Postgres?”". The question is then answered over the API, the agent asks again, and the page reloads. The draft comes back, still tied to the old question. Enter is refused, the text stays, and the newer question is open. Enter again sends a note that answers nothing, and the newer question stays open. I put back each part in turn: sending notes unbound, as before, fails the step, and so does a reload that forgets the tie. |
| 2 | P1: `retry`, `synthesize` and `accept-checkpoint` worked over HTTP without a question id. | **The server refuses them (400) unless they name their question.** `POST /api/rooms/<id>/control` with those three actions needs `questionId`, like `/answer`. The engine's own callers can still leave it out. | "a retry or a planning decision…": with a later failure open, an unnamed `retry` gets 400. At a checkpoint, `synthesize` and `accept-checkpoint` without an id each get 400, and the checkpoint stays open. With the check removed, the test fails. |
| 3 | P2: Against an older desk, the CLI dropped an explicit `--question` and posted to the latest room. | **A named answer is refused against an older desk**, with "Restart it first: toryo quit && toryo". Nothing is sent. Without a named question, it answers as before. | "against a desk started before this update…": `--question` with and without `--room` is refused and posts nothing; then an unnamed `--accept` posts as before. With the refusal removed, the test fails. |
| 4 | P2: The sole-question check counted questions the room waits on and chat questions separately. | **They're counted together.** Without `answering` (`toryo say`, an older page), a note to an agent answers its question only when that agent has exactly one open of either kind. A lost-app-turn card doesn't count; it has its own buttons. Then: a question the room waits on is answered by a note to that agent alone, and a chat question by any note that reaches it. | "an agent with a question the room waits on and a chat question…": the builder has *Tabs or spaces?* (the room waits on it) and *MIT or Apache?* (asked in chat). A plain note answers neither: both stay open, and no *The owner answered* turn runs. With them counted separately, the test fails. |
| 5 | P2: The agent got only "Yes", without the question. | **Each answer keeps its question** (`answers: [{ id, from, question }]` on your message). Answers from a card, the composer, the terminal and MCP all carry it, and so do notes that close a chat question. The asking agent's prompt heads your message with *answering your question “…”*. The timeline shows it too (*answers “…”*). | "an answer reaches the agent with the question it answers…": two yes/no questions. "Yes." to the second gives a prompt with `answering your question “Should I add docs?”` followed by `Yes.`, and nothing about the first. "No." through the page's `answering` gives `answering your question “Should I add tests?”`. With the heading removed, the test fails. |

**Also in this round:** an HTTP `/answer` naming the old question while a newer one is open gets 409. I added that to the first test. The terminal now catches a stale id before it reaches the desk, so without this case the desk's own check went untested. A note to several agents whose named chat question has been answered meanwhile is refused (409) and nothing is sent. Naming a question the room waits on that way is refused (400).

- `node --test` runs 145 tests, all passing.
- The browser check passes.
- **Each safeguard, removed in turn, fails a test.** That's the eleven from round 1 (checked again on this round's code) and the five above, plus the two page parts.

## What changed

**Desk (`src/engine.mjs`)**
- **Open questions have ids everywhere.** `summary(room).questions` and `roomView().questions` list every open question, `{ id, kind, from, question, recommendation }`. The questions the room waits on come first, then questions agents asked in chat. `summary.waiting` now carries its `id` too.
- **`answer(room, { questionId })`.** A stale `questionId` is refused with 409. If the id names a planning checkpoint, `accept` takes every recommendation (below), and text becomes your decisions. Before this change, both went to `synthesize` without any check.
- **`postMessage(room, { answering })`.** `answering` says what the note answers:
  - **A question id:** that question. The note goes to whoever asked it, even if it's a chat question.
  - **A list of ids:** chat questions of the agents the note goes to.
  - **`false`:** nothing.
  - **Any of them no longer open:** the note is refused (409) before anything happens, so a stopped room isn't resumed either.
  - **Planning checkpoints and lost-app-turn cards** have their own buttons, so a note can't answer them.
  - **Left out:** the sole-question rule from finding 4.
- **Answers keep their question** (`answers`), and prompts show it (finding 5).
- **`synthesize(room, { questionId, synthesizer, … })`**:
  - It needs an open checkpoint, and the one named if `questionId` is given. Otherwise it's refused with 409. It used to go ahead anyway and queue a second plan writer.
  - An author who isn't one of the round's planners is refused (400) instead of silently replaced by the builder.
  - With no author named, it's the builder if they're a planner, else the first planner. That's the same default the form shows.
- **`acceptCheckpoint(room, { questionId, synthesizer, planPath })`** is the shared "accept everything" step, which Home will reuse. It's also control `accept-checkpoint`, and the path for `answer(accept)` on a checkpoint.
  - It refuses (400) when any question has no recommendation, naming those questions and pointing to the form.
  - Otherwise your decisions are the questions as shown, `- <question> → <recommendation> (<planner>'s recommendation)`. They're recorded in the timeline, and the checkpoint closes with that answer.
- **control `retry`** takes a `questionId`. A stale one is refused with 409, so it never retries a newer failure.

**Server (`src/server.mjs`).** It refuses (400) `/answer`, and control `retry`, `synthesize` and `accept-checkpoint`, when they don't name their question.

**Terminal and MCP (`src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`)**
- `toryo status`, `toryo show`, `toryo_status` and `toryo_room` list every open question with `[id …]`.
- `toryo answer [--room R] [--question ID] "…" | --accept` and `toryo_answer { room?, question?, text?, accept? }` work like this:
  - **With an id:** they answer that question. Without a room, they find the question's room. If no open question has that id, they say it was answered or the id is wrong.
  - **Without an id:** they look in the room named, or in every room. If exactly one question is open there, they post **its id**.
  - **With several open:** nothing is sent; they list them, with room titles when the questions span rooms.
  - Before this change, no room meant the most recently active room's first question.
  - **Against an older desk:** a named question is refused with a restart message; otherwise they answer as before.
- `--question` is added to the flags that take a value.

**Page (`web/app.js`)**
- **The tie between a note and its question** (round 2, finding 1): `bindAnswer`, `answerFor` and `openAsks`. Each room's draft, tie and recipient come back together through `restoreDraft` and `setRoute` (round 3). A send's reply acts only on its own room's draft, and a draft from before the update answers nothing (round 4). A reply acts only on the draft revision it sent (`revise`, round 5), checked in this tab and in the saved draft every tab shares (round 6).
- A note that answered a question has no *Edit* or *Cancel note*.
- *Use the recommendation* on a chat question posts `/answer { accept, questionId }`. It used to post a plain note, "Go with your recommendation: …", which closed every question from that agent.
- The planning form sends its `questionId`. It has **Accept all recommendations** when every question has one, using the author and plan file picked in the form.
- Your answers in the timeline say which question they answer.
- `api()` errors carry the HTTP status.

## How to check

- `node --test test/questions.test.mjs` runs 13 tests:
  - **Two clients answer one question at once (HTTP).** One gets 200, the other 409, and the builder gets one *The owner answered* turn. Unnamed over HTTP gives 400. Then the builder asks a newer question, and the old question is answered again four ways: the page's `answering` note, HTTP `/answer`, `toryo answer --question <old>`, and MCP `toryo_answer { question: <old> }`. All four are refused; one answer and one continuation stand, and the newer question is open. Then status and room text show `[id …]`, and MCP with one open question answers it by id.
  - **No room named, two rooms with a question each.** Nothing is sent, and both are listed with their rooms. `--question` alone finds its room, and is refused once the question is answered.
  - **Two chat questions from one agent.** A plain note closes neither, and the CLI refuses to guess and sends nothing. Answering the second by id leaves the first open. *Use the recommendation* closes the first; doing it again gives 409.
  - **The page's `answering` note.** It closes only its question. Afterwards a plain note to an agent with one question answers it, and a stale `answering` gives 409.
  - **Two planners' questions.** Answering the later one by id leaves the earlier one waiting.
  - **Retry and planning.**
    - Retry pressed twice at once: one counts. The turn fails again, and a Retry still naming the first failure is refused; so is one with no id. The new failure stays open.
    - Unnamed planning calls: 400.
    - *Accept all* with a question missing a recommendation: 400, naming it.
    - An author who isn't a planner: 400, checkpoint still open.
    - Two plan submissions at once: one plan writer, one decisions entry.
    - A late one after the round moved on: 409.
  - **Accepting every recommendation.** Done via `answer(accept)` (the default author) and via the page's control with Claude picked. Each recorded line names the choice and who recommended it; the author writes the plan with them.
  - **A held recipient.** The answer is accepted, the question closes, and the continuation waits in the queue, listed as blocked. Nothing starts until the hold is released.
  - **An older desk.** A named answer is refused; an unnamed one goes as before.
  - **Cases from round 2:** a question the room waits on plus a chat question, a note to several agents, and the question shown with its answer (findings 4 and 5).
  - **Case from round 3:** a held note that answered questions can't be withdrawn or changed.
- `node --test` runs 146 tests, all passing.
- **The browser check passes:** `PLAYWRIGHT_CORE=… node test/ui-check.mjs`.
  - **Step 5c.** Press *Write my own answer*, then answer that question over the API, and the agent asks again. Enter is refused with a message, the text stays, and the newer question stays open. Then *Use the recommendation* closes its own card's question.
  - **Step 5c2.** Type straight into the composer, then reload; see finding 1.
  - **Steps 5e and 5f.** Drafts in two rooms, and a reload with two agents asking; see round 3.
  - **Steps 5g and 5h.** Late replies after a room switch, and a draft from before the update; see round 4.
  - **Step 5i.** A late reply after you chose another question with the same words in the box; see round 5.
  - **Step 5j.** Late replies when a second tab saves a newer draft for the room while the send is pending; see round 6.
  - **Step 5k.** Late replies when the second tab saved its draft before the first tab sent; see round 7.
  - **Step 5d.** A planning room's *Accept all recommendations*, with Claude picked as author, records both choices, and Claude writes the plan.

## Worth a look

- **The engine stays lenient for its own callers.** `answer()` and control `retry` without a `questionId` still take the first matching question. `postMessage` without `answering` follows the sole-question rule. Internal paths and older tests use them. Everything that comes from outside the desk names its question, except `toryo say`, which is a plain note.
- **Tabs don't update each other's open drafts.** A tab showing a room keeps the draft it showed until you switch rooms or reload. A late reply never overwrites another tab's newer draft. Between tabs, the last one to type wins, as before.
- **What a note is tied to is decided once, when you begin writing.** If no question was showing then and one appears while you write, your note goes as a note and doesn't answer it. The route line says so ("a note, not an answer to the question waiting now"). To answer it, clear the box and start again, or use its card.
