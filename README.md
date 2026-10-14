![Tōryō: collaborative coding agent orchestration. Plan, build, review.](design/toryo-hero.png)

# Toryo

A local relay desk for coding agents. Codex, Claude, and optionally Cursor and Grok work in your repository in **rooms**. Toryo passes each finished turn to the next agent, keeps the builder moving through the plan, and stops only for decisions that are yours. No model runs the relay itself, so it costs no tokens and adds no delay.

Toryo (棟梁, *tōryō*) is the master carpenter who runs a Japanese building site: plans the job, assigns the craftsmen and inspects their work. It was called Foreman until 13 October 2026. The old names still work: the `foreman` command, `FOREMAN:` status lines, the `FOREMAN_*` settings and a `~/.foreman` data folder that hasn't been moved yet.

```
toryo            # start the desk: http://localhost:4777
toryo --open     # …and open it in your browser
```

If the desk is already running, `toryo --open` just opens it. Only one desk can use a data folder: a second one refuses to start, even if it can't reach the first. `toryo quit` stops the desk, and any turns that were running are offered again next time.

**Install.** Toryo needs Node 22 or newer and git. It has no dependencies, and runs on Linux, including WSL on Windows; other systems are untested. Clone it and link the `toryo` command:

```
git clone https://github.com/eackermann/toryo.git ~/toryo
ln -s ~/toryo/toryo ~/.local/bin/toryo
```

Then install and sign in to the agents you want in your crew: Codex and Claude Code, and optionally Cursor's CLI and Grok. `toryo doctor` shows which ones it finds, and how to install the others. The first time you open the desk, it asks for a project folder.

**Usage.** Each agent's plan usage (5-hour and weekly limits, where the agent reports them) shows in the Agents panel and on the crew cards. Each limit says how long ago its own reading was taken, since one limit's reading can be fresher than another's. Codex's comes from its session logs, so it shows straight away, and Toryo reads those logs again every 5 minutes, also between turns. If it can't read them, the panel says so under the last good reading. Claude reports usage while it works, so Claude's appears after its first turn in a room and is only as fresh as its last turn. A limit that has reset since its last reading shows *reset, waiting for a new reading* rather than the old percentage, even on a page left open, and a number the agent didn't report shows as *unknown*, never 0%. A model's own limit, such as Claude's weekly Opus limit, shows on its own. Codex and the Codex app draw on the same ChatGPT plan, so Toryo treats their readings as one allowance and never adds them together. Room settings, renaming and deleting are under **Room** in the top bar, or click the room's name.

Your config lives in `~/.toryo/config.json`: your projects, each with its house rules and checks, and the agents' settings. Everything else Toryo keeps (rooms, transcripts, snapshots) is under `~/.toryo/` too, never in your repository.

## Three ways to work, in one room

A room keeps each agent's session for its whole life. You can chat, then plan, then build in the same room, and everyone remembers what came before.

**Chat.** Write to one agent, several, or everyone. Recipients answer in parallel and see each other's replies on their next turn. Tick *Let them discuss* to give them 1 to 4 rounds of back-and-forth. Toryo stops early when they all agree, and otherwise lists the points still open. Chat turns are read-only unless you tick *Allow file changes*.

**Plan.** A structured planning round, deliberately not free chat:
1. **Independent proposals.** Each planner drafts on its own, without seeing the others, so nobody anchors on the first idea.
2. **Critiques.** Each one reads the others' proposals and says what's better, what's missing, and where they disagree.
3. **Your call.** Toryo collects every `Q: … (Recommended: …)` question into one form, with the recommendations filled in. Change what you like and choose who writes the plan. When every question has a recommendation, *Accept all recommendations* takes them as shown, and the decisions record each choice with the planner who recommended it. `toryo answer --accept` does the same, with the builder as the author. Your call is taken once: a second one, from another tab or a terminal, is refused rather than starting a second plan.
4. **The written plan.** That agent writes `docs/plans/<topic>.md`, with one `### Slice N:` heading per slice, and records your decisions following the repository's convention, such as a *Recording Decisions* section in its CLAUDE.md.
5. **One check.** The other planners check the written plan once, read-only. If one asks for changes, the author addresses them once. A check counts as an approval only if it says so (`TORYO: APPROVED`). One that ends without a verdict is asked once for it; if it still gives none, the plan's card says so.
6. **Ready.** The plan's card says who checked it and what came of it. From there:
   - **Start building** with that plan in the same room. Accepting the recommendation from a terminal or your phone (`toryo answer --accept`) does the same.
   - **Ask Claude to check it** (or whichever planners didn't write it). They check it read-only, their findings go to the author by themselves, the author addresses them once, and the plan is ready again. An approving check leaves it as it is.
   - **Ask for changes**: write what to change. The author revises the plan; then, with *Re-check after changes* on (a room setting, on by default), the other planners check the revision once and the author addresses what they find. Then the plan is ready again. Nothing checks the author's answer to a check, so it never loops.
   - **Talk it over with another planner first.** Write to Claude about the ready plan; its reply then offers *Send this discussion to Codex as a change request* (with the names of your planners). Your messages, your answers to its questions, and its replies since the plan was ready go to the author once, each with who said it (and, for an answer, the question it answered), and the same revise-and-check follows. The author is told your words are yours and the planner's are suggestions.

   Each of these names the card it came from. If the plan has moved on (it's being revised or checked, or a newer version is ready), the click is refused, so a double click does nothing twice. If the plan file changes while it's being checked, the card says the check was of an earlier version. A restart carries on where the round was. *Stop* ends it, and *Resume* brings the card back, saying the check or revision was stopped.

**Build.** One agent builds and the other reviews:
- **Each slice.** The builder implements a slice, writes a review handoff and ends with `TORYO: REVIEW`.
- **Checks first.** Toryo runs your project checks (your typechecks or tests, say) before every review, the final one included. If they fail, the work goes straight back to the builder without spending a review. If you stop the room, the checks stop too, and none that haven't started yet run. Each check has a time limit, 20 minutes unless you set another in Settings; a check that runs out of time fails.
- **Review.** The reviewer reviews read-only. Its findings go back verbatim until it approves.
- **A fresh reviewer for each slice.** By default the reviewer starts a new session for each new slice: each slice gets an independent look, and its session doesn't grow for the whole build, which gets expensive once the cache has gone cold. Within a slice it keeps its session, so it remembers its own findings. A fresh reviewer gets a short briefing instead of its memory: its role, the plan and where it stands, the latest handoff, and the room's **ledger**. The ledger holds findings still open from earlier slices, and your answers to the build's questions. Toryo keeps it from the reviews: a slice's findings close when it's approved, a finding the reviewer leaves for later stays open until a later review marks it resolved, and the room's side panel shows what's open. The final review of a plan always gets a fresh reviewer. Turn this off in **Room** settings (*Fresh reviewer for each new slice*). To start any agent afresh in a room, use *Start … fresh in this room* on its crew card; its next turn begins a new session with the same briefing.
- **Keep going.** After approval, the builder continues into the next slice on its own. That's the end of “why did you stop?”. If it stops without a status line anyway, Toryo nudges it, twice by default, before asking you.
- **When you're asked.** Only for a real decision (`TORYO: OWNER …`), after 4 rounds on one slice (a review without a status line counts as a round), on an error, or when a turn runs out of time (4 hours by default). A turn that comes back empty is an error, never a verdict: Toryo tries it once more, then asks you, with *Retry*. If a Claude Code hook dropped the prompt before Claude saw it (the stream says *Prompt dropped by a hook: …*), Toryo asks you straight away and names the hook, since trying again would only be dropped again. If two agents ask at once, both questions wait for you, and you can answer them in any order. From a terminal, a note to an agent answers its question only when it has just one open; with several, answer each from its card. Your answer reaches the agent with the question it answers, so a bare “Yes” says what it's yes to. Your answer goes to the agent that asked: when the reviewer asks, it gets your answer and finishes its review with a verdict.

You can swap builder and reviewer at any time. If a round is under way when you swap (someone is working, a review is waiting its turn, or a question is waiting for you), that round is checked and reviewed with the old roles, and the swap takes effect before the next building turn, so nobody reviews their own work.

Starting a new build or planning round in a room replaces the old one. A turn from the old one that is still running finishes, but its result no longer moves anything forward.

**Picking up a round that's already finished.** If the builder has already written a handoff and is waiting for a review, tick *The builder already finished a round: start with the review*. You'll usually be moving over from copy-and-paste here. The reviewer goes first, with the builder's message passed on verbatim. The builder gets Toryo's briefing with that review on its first turn, and the relay carries on from there. With the Codex app as builder, leave the message empty and Toryo uses the last reply in the room's Codex app thread. From a terminal:

```
toryo start build "Carry on with the plan after the review" --project myapp \
  --builder codexapp --reviewer claude --review-first --plan docs/plans/checkout-redesign.md
```

**Reviewing Toryo with Toryo.** Toryo is a project too. Its rules keep agents away from the running desk, and its checks run the syntax check and the tests. Claude wrote it, so Codex reviews it and Claude addresses the findings. The review starts from the handoff in `docs/reviews/`:

```
toryo start build "Address Codex's review" --project Toryo --builder claude --reviewer codex \
  --review-first --handoff-file ~/toryo/docs/reviews/foreman-initial-review.md
```

Edits made in that room take effect after `toryo quit` and a fresh `toryo`, and running turns resume. The desk keeps serving the page it started with, so a half-finished edit never breaks the page you're using; when the files on disk differ, the page says *Toryo has been updated. Restart Toryo to use it* and gives the command.

## The status protocol

Every turn ends with one line, and that line is the only thing Toryo reads. It has to be the message's last line, outside quotes and code blocks: a status quoted as an example, or followed by more text, doesn't count.

| Who | Line | What happens |
|---|---|---|
| Builder | `TORYO: REVIEW <slice> \| <handoff>` | checks run, then the reviewer gets the message verbatim |
| Builder | `TORYO: DONE` | checks run, then a final review of the whole plan |
| Reviewer | `TORYO: APPROVED` / `CHANGES` | builder moves on / builder fixes |
| Anyone | `TORYO: OWNER <question>` | the room waits for you, and you're notified |
| Planners | `PROPOSAL`, `CRITIQUE`, `AGREE`, `DISAGREE <point>` | drive the planning and discussion steps |

## What you see

The page follows Toryo's design system ([docs/design-system.md](docs/design-system.md)). Color means what's happening, never who: the logo's purple plans, its blue builds and its mint reviews, and orange is only for what needs you. Agents are told apart by name and a neutral monogram. Light and dark follow your system, or the theme button in the top bar. The fonts ship with the page, so it still loads nothing from the internet.

- **Home.** The page that opens first (`#/`; the Toryo name and the rail's *Home* lead back to it, and a phone has a Home tab). Every room at a glance:
  - **A sentence** on what's going on, and the desk's controls:
    - *Pause everything* (or *Resume everything*, saying what it lets go);
    - each of your holds, with *Release*;
    - each of the usage guard's holds, with *Let it run until the reset*, *Release it* once it has reset, or, when its reset time isn't known, *Turn this rule off*.

    *Usage guard* opens its settings: each window's threshold, on or off, and release at reset. The guard's note shows until you press *OK*. After *Release*, Home says what still holds the agent, with *Pause this guard until reset* for each window.
  - **Needs you:** every open question, oldest first, with its room, how long it has waited and the recommendation.
    - **Answer it here:** *Use the recommendation*, or *Write my own answer* (Ctrl+Enter sends).
    - **A failed turn:** *Retry*, or retry with a note.
    - **A planning checkpoint:** every recommendation as shown, and *Accept all recommendations*, naming who writes the plan. If one has no recommendation, the form in the room.
    - **A ready plan:** *Start building*, *Ask Claude to check it*, or *Ask for changes*.

    What you type is kept in this browser until it's sent, through news and reloads, and a card you're typing in isn't redrawn. An answer to an agent that's held is saved, and Home says when the agent will get it. A question answered elsewhere while you were writing says so and keeps your text; nothing is sent.
  - **Working now:** who is working where, on what (slice and round, or the task), and for how long. A turn's times are kept apart: preparing, waiting in the Codex app's queue, working. Each card has its latest output and how long ago it came, and says which rooms share its folder.
  - **Other rooms:** paused, held, stopped, idle or done, with what keeps them.
  - **Agents and usage:** each allowance's limits, with the guard's threshold marked, the reset date and time, and how old each reading is. Each agent has a line on what it's doing and what holds it, with *Hold* or *Release*. Headless Codex and the Codex app share one allowance but each has its own line, and *Hold both* holds them together.
  - **Recent:** finished turns, questions, your answers, failed checks, approvals, and the desk's own events (holds, pauses, the guard), newest first.

  Home is fetched as one summary, never whole transcripts, and updates as things happen. Cut off from the desk, it says so, and fetches afresh when it's back. Its buttons do what `toryo` and the MCP tools do, with the same results.
- **The top bar.** How many rooms are working, and how many questions need you; that count opens the room with the oldest question and shows it to you. The logo is live: each of its blocks breathes while that kind of work runs anywhere (blue builds, purple plans, mint reviews).
- **The rooms.** Grouped by project. Each room's tile wears a ring for what it's doing:
  - **At work:** a sparkler runs round it in the color of the work.
  - **The checks:** grey dashes march round it.
  - **A question for you:** it pulses orange.
  - **Still:** dashed when paused, dotted with a lock when held, mint with a check when done, red when a turn failed.

  The same rings show in the room's header, and on an agent's monogram while it works. *What the rings mean* is under the rooms. With reduced motion, the rings stay but nothing moves. Each room also shows one line about what it's doing: what needs you comes first (*Needs you · Codex asks*), then who is working on what (*Claude building*), otherwise its state (*Paused*, *Stopped*, *Done*, *Idle*). Hover over a room for the same in words.
- **The room's header.** A sentence about what the room is doing: who is building, reviewing or planning, on which slice, and for how long; and whether a question waits for you. Next to it: the mode, *Pause*, *Stop* and *Room*.
- **The session strip.** Under the room's header, one line per kind of work (planning, building, reviewing, checks, and other work such as replies) on one time axis, filling in as the room works. Time spent waiting for you is shaded orange; paused or held time is hatched. A stretch of more than 30 minutes with nothing running is drawn short and marked with its length. Hover over a piece for who did it, on which slice, and when; click it to go to that turn. Beside the strip, the totals in words (*Building 3 h 10 · Reviewing 1 h 05 · Checks 22 min · 5 h 20 in all*): click them, or press Enter, for the whole list, phase by phase, with each piece of work a link. Work done side by side counts once in its phase; different phases can overlap (a reply while building), so the totals can add up to more than the session. Codex app work counts from when the app takes the turn up, not while it waits in the app's queue; checks stopped before the end still count the time they ran. On a phone, the strip is one bar of the totals. For now a room's session is its whole history.
- **The timeline.** Every message in full (Markdown), with its status, the files it changed, and its tokens. A status takes the color of what happens next: *Ready for review* is mint, because review is next. *Prompt* shows exactly what Toryo sent to that agent. In a build, each slice starts with its marker, and a slice's earlier review rounds fold into one line you can open. Your notes are the dark bubbles on the right.
- **Live activity.** Commands, edits and remarks stream in while an agent works. *Interrupt with a note* delivers a message mid-turn.
- **Decision cards.** Each question comes with the agent's recommendation and a one-click *Use the recommendation*, which sends *Go with your recommendation:* and the recommendation itself, without the brackets or punctuation around it in the agent's message (*(Recommended: yes to both)?* sends *Go with your recommendation: yes to both.*). Every answer, *Retry* and planning call names the question it was given for. A note is tied to a question when you begin writing it: to the question the composer shows, or to the card whose *Write my own answer* you pressed. Each room keeps its own draft, with that tie and the recipient you chose, when you switch rooms or reload the page. If that question was answered meanwhile (in another tab, a terminal or your phone), Toryo refuses it and says so, and your text stays in the box. It never lands on a newer question. Sent again, it goes as a note and answers nothing.
- **Snapshots and diffs.** Toryo snapshots the tree before and after every turn in a shadow git store in `~/.toryo/shadow`; your repository's `.git` is only read. *N files changed* shows that turn's exact diff. Reviewers are told which snapshot they're reviewing, and the command to diff it against their last review.
- **Plan, Crew and Ledger.** Beside the timeline, or as tabs in the room on a narrower screen. *Plan* shows the plan file's slices, with a bar of how far the build has got and how long each approved slice took. *Crew* shows each agent, what it's doing, its usage and its settings. *Ledger* shows what a reviewer starting fresh reads first. On a phone, the rooms and the room are two tabs at the bottom.
- **Shared docs.** The plans, decisions and handoffs the agents touched in the room, one click away.
- **While you were away.** A summary when you come back to a room, with *Jump to the first new message*.
- **Second opinion.** Ask any other agent to look at any message.
- **Your note's route.** The composer shows who gets your note and why: an `@mention`, the agent waiting for your answer, wording about checking (goes to the reviewer) or fixing (goes to the builder), or whoever acts next.
- **Notes: Ask or Tell.** Mark a note *Ask* (a question, which needs an answer) or *Tell* (an instruction). Until you choose, a question mark or a question means Ask. Notes don't turn building into answering:
  - **To the builder while it works.** Its next turn is a building turn, *Building: your notes*. It acts on your notes there, and answers any Ask in the same turn. Then the relay carries on as it would have: checks, then review.
  - **The outcome of each note.** That turn opens with one line per note: *done*, *scheduled* (for which slice) or *declined* (and why). The note shows that outcome, so you can see every note landed.
  - **To a reviewer, or in a room that isn't building.** Only an Ask gets a turn: a short, read-only *Answering your question*. Then the room goes back to exactly what it was doing; answering doesn't change a verdict. A Tell goes with that agent's next turn.
  - **Where a note is.** Under each note you see where it is: waiting for that agent's turn to end, being read, then its outcome or *replied*, with a link. Until an agent has it, you can *Edit* the note or *Cancel* it; once it has gone, it stays as sent. If it goes while you're changing it, your change isn't lost: it stays under the note until you *Send it as a new note* or *Dismiss* it. A note that answered a question stays as sent from the start, so the question never ends up answered by text you've since changed or withdrawn.
- **Writing.** Enter sends; Shift+Enter starts a new line.

## Keeping Codex in its app (experimental)

You can add a **Codex desktop app thread** to the crew instead of headless Codex: pick *Codex app* as the builder, or tick it in the crew.
- **Each room has its own thread.** You choose it in the New room form whenever the Codex app is in the crew. The form suggests the project's default thread, else the default for every project; both are in Settings, and changing them never moves an existing room. The crew card shows the room's thread, opens it in the app, and changes it while the Codex app isn't working in that room. Toryo won't give a room a thread the Codex app is working in for another room. Sharing a thread with a room that's idle is allowed, with a warning, and only one room's turn runs in a thread at a time.
- **Sending.** Toryo puts each message into that thread's follow-up queue with `codex queue`, the same queue the app uses.
- **Receiving.** It reads the thread's session log to stream activity and to catch the end of the turn.
- **Why use it.** The work stays visible and steerable in the app, and from the ChatGPT phone app.

The catch: the app sends a thread's queued messages only once it has opened that thread since it started. On 13 Oct a queued message sat for 50 minutes on a thread the app hadn't opened. Opening the thread sent all three waiting messages within a second, in order. After that the app sent new ones within a second, even with another thread on screen. So when a message hasn't gone out after eight seconds, Toryo opens the thread with the app's `codex://threads/<id>` link, which brings the app to the front. To stop that, set `"openThread": "never"` under `agents.codexapp` in the config. If the thread is busy with your own turn, the message waits for it to finish. Permissions and the model are the app's own; Toryo can't make this agent read-only.

Toryo also can't stop or interrupt a turn in the app. *Stop* lets the app's turn finish and starts nothing else in the room until it has; stop it in the app if you need to, or press *Stop* again to make Toryo stop waiting for it. A stop that comes before Toryo has handed the message to the app means it isn't sent at all. A note sent *Now* to the Codex app goes with its next turn. When the app's turn runs past the room's time limit, Toryo tells you and keeps following it. Once the app has a message, Toryo follows that turn to its end, also across restarts and in a stopped or paused room, and never sends it twice. Until that turn ends, the room sends the app nothing else and no other room sends into that thread. If Toryo loses track of the turn (it can't read the app's log, say), it keeps it and asks you: follow it again, or stop waiting for it. If Toryo stops in the moment it's handing a message to the app, or the handover gets no answer (the app's queue command runs out of time), it can't tell whether the app got it. It never sends it again by itself. It watches the thread instead, follows the turn if the app sends it, and keeps the thread for that room until then. It tells you, so you can *Stop waiting for it* and send it again if you know it never arrived.

## From your phone

Toryo's own page runs on this machine. To reach it while you're away, use the apps you already have, through Toryo's MCP server:

```
claude mcp add --scope user toryo -- ~/toryo/toryo mcp
```

Open that Claude Code session with Remote Control (`claude --remote-control`, or `/remote-control`), then ask from the Claude app: *“What's Toryo doing?”*, *“Tell Codex to leave the migrations alone”*, *“Accept Claude's recommendation”*. The tools are `toryo_status`, `toryo_room`, `toryo_say`, `toryo_answer`, `toryo_plan` (check a ready plan, or forward your discussion of it), `toryo_control` (one room), `toryo_desk` (Pause everything, holds), `toryo_guard` (the usage guard) and `toryo_start`.

Codex can use the same server: `codex mcp add toryo -- ~/toryo/toryo mcp` in WSL. For the Windows desktop app, run `codex mcp add toryo -- wsl.exe -e /home/<you>/toryo/toryo mcp` in PowerShell; that path is untested.

For a push to your phone when someone needs you, put an [ntfy](https://ntfy.sh) topic in Settings. Windows notifications are on by default.

The same commands work in any terminal while Toryo runs:

```
toryo status                     toryo show [room] [--full]
toryo say --to codex "…"         toryo answer --accept
toryo pause|resume|stop [room]   toryo start plan "…"
toryo plan check                 toryo plan forward --from claude
toryo pause --all                toryo hold codex    toryo guard
```

`toryo show` and `toryo_room` start with the session in a sentence (*This session, 5 h 20: building 3 h 10, reviewing 1 h 05, checks 22 min, waiting for you 1 h 30.*), the same totals as the page's strip; `toryo status` adds each room's session length once it has run a minute. `toryo status`, `toryo show`, `toryo_status` and `toryo_room` list each open question with its id. `toryo answer` and `toryo_answer` look in the room you name, or in every room if you don't. With just one question open there, they answer it. With several, they send nothing and list them; name one with `--question <id>` (`question` for `toryo_answer`). `toryo plan check` asks the other planners to check a ready plan (`--checker claude` for one of them); `toryo plan forward` sends your discussion with a planner to the author (`--from claude`, which can be left out when there's only one other planner). Both act on the only ready plan, or on the one you name with `--question <id>` (its card's id). Over the HTTP API, an answer (`POST /api/rooms/<id>/answer`), a retry and the planning calls (`retry`, `synthesize`, `accept-checkpoint`, `plan-check` and `forward-discussion` under `POST /api/rooms/<id>/control`) must name their question (`questionId`).

## Safety

- **Who writes.** Only the builder, and the plan's author while it writes or revises the plan and the decision records, change files. Reviews, plan proposals, critiques, plan checks and chat replies are read-only, unless you tick *Allow file changes* on a chat message. Proposals stay in the room rather than the repository: several planners write them at the same time, and only the agreed plan belongs in `docs/plans/`. Every proposal is kept in the room's transcript.
- **How read-only is enforced.** Codex gets its own `read-only` sandbox. For Claude, Cursor and Grok, Toryo mounts the project folder read-only for that turn, so neither the agent nor any command it runs (shell commands, scripts, git) can change it; the rest of the machine, such as `/tmp`, stays writable. This uses Linux user namespaces (`unshare` from util-linux 2.38 or newer), which WSL has. Where they aren't available, the crew panel says so, and Claude falls back to its own permission rules, which stop its edit tools but not shell commands. Cursor then falls back to its Ask mode. A Cursor chat keeps Ask mode once it has had it, so Toryo starts Cursor in a new chat, with a short briefing, before its next turn that changes files. That's why Toryo uses the mount, not Ask mode, wherever the mount works. If an agent misbehaves with the mount, `"readOnlyMount": false` under that agent in `~/.toryo/config.json` turns it off for that agent. The Codex app follows its own permissions. In every case, if files change during a read-only turn, Toryo tells you.
- **Builders.** Codex builds in its `workspace-write` sandbox with network access. To match the Codex app's “ask, and an automatic reviewer approves”, choose that in Settings; it isn't tested headless yet. Claude runs in `auto` permission mode.
- **Commits.** Nothing is committed unless your house rules allow it.
- **One builder per tree.** Don't run a Toryo build room and the Codex app on the same working tree at the same time, unless the Codex app *is* that room's builder.
- **Restarts.** Turns running when Toryo stops are offered again, paused, when it starts, and each agent resumes its own session. Checks that were running simply run again. The Codex app is different: it keeps working while Toryo is down, so Toryo reconnects to the same turn and sends nothing twice. If an agent never got a turn's message (it failed to start, or Toryo stopped first), the retry sends the whole message again.
- **The page.** Toryo reads its page files once, when it starts, and serves them from memory, so the page always matches the running desk. If one is missing, Toryo doesn't start and says which.
- **Network.** The server listens on 127.0.0.1 only. It refuses other Host headers and cross-site requests, and `--lan` requires a token. The page loads nothing from the internet; it uses fonts already on your computer.
- **Files.** The file viewer shows only files that really live in the project: a link that points outside it is refused.

## Agents

| Agent | How Toryo runs it | Status |
|---|---|---|
| Codex | `codex exec --json`, then `codex exec resume <id>` | tested |
| Claude | `claude -p --output-format stream-json`, `--session-id`, then `--resume` | tested |
| Cursor | `agent -p --output-format stream-json --resume <chat>`, with `--force` when it builds | tested on 13 Oct with Cursor CLI 2026.10.01 |
| Grok | `grok -p --output-format json -s <session>` | written from the docs, not yet run |
| Codex app | `codex.exe queue --thread <id>`, then the thread's session log | experimental: queueing, delivery by the app and reading the reply tested on 13 Oct; a full build relay through the app not yet run |

`toryo doctor` shows what's installed. Each session can be continued in a terminal; the crew panel shows the resume command.

## Desk-wide controls and the usage guard

These work across every room. Turns and checks already running always finish: the controls only stop new ones from starting.

**The usage guard** is on unless you turn it off, on new desks and existing ones alike.
- **What it does.** When an agent's 5-hour or weekly usage reaches 90%, Toryo holds every agent that draws on that allowance. Headless Codex and the Codex app share one; Claude has its own. Running turns finish and nothing new starts, retries of failed turns included.
- **When it lets go.** When that limit resets, the hold ends by itself and the work carries on, even with no new reading (Claude reports its usage only while it works). Toryo looks at least every 30 seconds and before starting anything, so a desk that slept through the reset decides as if it hadn't.
- **What it reads.** It acts on new readings only: Codex's logs, read every 5 minutes, and what agents report during their turns. A late reading of a window that has already reset holds nothing. A limit whose reset time isn't known is never released by guesswork: a new reading under the threshold ends that hold. When Toryo starts, it looks at the latest saved readings again before anything starts, so a hold it couldn't save comes back.
- **Notifications.** One when it holds an agent, and one when it lets go. A room it holds up shows *Held*, with the reason.
- **Your settings.** `toryo guard` shows what it does and holds.
  - **Thresholds:** `toryo guard codex --five-hour 85 --weekly 95` changes them; `--weekly off` turns one window's rule off (`--window weekly-opus --at off` for any other window); `--off` and `--on` turn all of an agent's rules off or on. Without an agent, each command is for every agent. A change that's refused (a threshold over 100%, say) changes nothing.
  - **Release at reset:** with `--no-auto-release`, a reset waits for you: `toryo guard codex --window weekly --release-expired-hold`.
  - **Changes apply at once:** a rule you turn off, or raise above the current reading, lets go straight away.
- **Getting past it.**
  - **Release:** `toryo release codex` releases your own hold, and says what the guard still holds, window by window. Each comes with the command, and the MCP arguments, to let the agent run anyway until that limit resets: `toryo guard codex --window weekly --pause-until-reset`.
  - **After the reset:** the guard watches again.
  - **No known reset time:** the guard can't be paused until then, and you're offered turning that rule off instead.
- **The note.** `toryo status` explains the guard once, until you hide it with `toryo guard ok`. Settings you've changed are kept, and stay as you set them.

**Pause everything and holds.** `toryo pause --all` and `toryo resume --all`; `toryo hold codex` and `toryo release codex` (or `claude`, `codexapp`, `codex --headless`). Over MCP they're `toryo_desk` and `toryo_guard`; over HTTP, `POST /api/desk`:
- `{ "action": "pause" }` and `"resume"`;
- `{ "action": "hold" | "release", "target": "codex" }`;
- `"guard"`, with `target`, `rules`, `autoRelease` and `enabled`;
- `"guard-pause"` and `"guard-release"`, with `target` and `window`;
- `"guard-ok"`.

- **Hold scopes.** `"codex"` holds both headless Codex and the Codex app. `"codexapp"` holds only the app, and `"codex"` with `"headless": true` only headless Codex. Any other agent's name holds that agent.
- **Graceful.** Turns and checks already running finish; nothing new starts. Pause everything also stops new project checks, while a hold on an agent doesn't. Following a Codex app turn the app already has is never held up.
- **Turns not yet sent.** A turn being prepared (its snapshot, its prompt, or Cursor creating its chat) when a hold or Pause everything comes isn't sent. It goes back to the front of the queue, unsent, with your notes still waiting for it, and the room shows it as *Not sent yet*. A held Codex app isn't asked to open its thread either, since opening it would start the turn.
- **Separate from each room's own Pause.** Resuming the desk doesn't resume a room you paused, and resuming a room doesn't release a hold.
- **Visible.** A room whose work is held up shows *Held* in the room list, and says once, in the room, what it's waiting for.
- **Kept across restarts.** The controls, the guard's settings and what it holds live in `~/.toryo/desk.json` and are in force before any room starts. What the guard did is also written to `~/.toryo/desk-events.jsonl`.
- **When the file is a problem.** If Toryo can't read that file, or a newer Toryo wrote it, nothing new starts and the file is left alone. Fix it and restart, or reset the controls (`"action": "reset"`, which sets the old file aside and starts with the guard at its defaults). If Toryo can't save a new hold, or the guard's state, the hold applies anyway and nothing new starts until it's saved (`"action": "save"`). A release it can't save doesn't happen.


## Planned

A room will be able to start a new session, for example to plan the next sprint: the session strip starts again and the agents start fresh, while the earlier sessions stay in the room.

New headless Build rooms will default to their own worktree, with the shared-folder choice still available and existing rooms left in place. Worktrees will live under `~/.toryo/worktrees`, include current uncommitted work, and show the room's own changes for an explicit return to main as uncommitted files. Conflicts will leave main untouched. The Codex app stays in main for this release. A second builder in one folder will be refused. A planning author can write shared documents into main between active turns/checks/reviews, then the build room gets a note listing changed files. Setup and checks will run one at a time per project unless its settings allow parallel runs; commands receive their room ID, folder, and port offset.

These additions are **planned, not yet available**. The [implementation plan](docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md) has already given the page the new look the owner approved (a design system, with rings that show what each room is doing), the plan checks described under *Plan* above, the usage guard, Home, and the session strip. Next come new sessions, followed by a small builder guard, shared-file coordination, and worktrees. [Accepted review decisions](docs/decisions.md#2026-10-13-accepted-plan-review-and-worktree-defaults) and [plan-review decisions](docs/decisions.md#2026-10-13-plan-checks-and-discussion-handoffs) record the choices and why. The review's open questions are settled.

Later retains one-turn overrides, usage forecasts and advance warnings, further Swap work, turn caps, provider-exhaustion recovery, and immediate pause. Managed dev servers, general resource declarations, and test-database naming are also deferred; a worktree and port offset do not by themselves isolate services. Folder restoration would ask first because it overwrites files; a commit offer would require project permission. Separately, snapshots keeping their own copies of referenced data is a bug fix to do soon, outside this plan, so a project's Git cleanup cannot break old snapshots.

## Development

```
cd ~/toryo && node --test --test-concurrency=1 test/*.test.mjs
```

The tests drive the whole engine through `test/fake-agent.mjs`, which speaks the Codex and Claude output formats. Toryo has no dependencies. `node test/ui-check.mjs` also checks the page in a real browser, against a desk of its own with fake agents and a fake Codex app; it needs a `playwright-core` folder (`PLAYWRIGHT_CORE=…`) and skips itself without one. `node test/ui-shots.mjs [folder]` takes screenshots of the page at three widths, in both themes, and fails if anything scrolls sideways on a phone.

## License

[MIT](LICENSE)
