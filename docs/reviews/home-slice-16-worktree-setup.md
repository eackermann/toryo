# Home and desk controls, Slice 16: Copy configured files and run setup before the first turn

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 16, with *Copy files, setup, and simple project check ordering* (its copy and setup parts; one-at-a-time per project and the room's environment values are Slice 19, after the owner's two new slices).
**Tree:** uncommitted on top of Slice 15 (`543d65d`).
- **New:** `test/setup.test.mjs`, this handoff.
- **Changed:** `src/worktrees.mjs`, `src/snapshots.mjs`, `src/engine.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `web/app.js`, `README.md`, `test/ui-check.mjs`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **Settings** has, per project, *Files copied into each new worktree* (patterns), a *Setup command*, and *Show what a new worktree gets*.
- **A new worktree** gets those files, and its setup runs before the room's first turn.
- **Existing worktree rooms** and projects without these settings are unchanged.
- **Stored:**
  - a project's `worktree: { copy: [patterns], setup, setupTimeoutMin? }`;
  - a worktree room's `workspace.private` (the files copied in), `workspace.copy` (patterns, copied, not copied and why) and `workspace.setup` (command, state, attempt, times, exit code);
  - setup runs are `gate` events with `setup: true` (attempt, output, the files it changed).

## Round 3: your two findings

| # | Finding | Fix | Test (`test/setup.test.mjs`) |
|---|---|---|---|
| 1 | P2: A short write could drop the rest of a copied file. | **Every byte read is written:** `copyInto` loops on each write until the whole piece is written; a write that takes nothing stops the copy, saying so (*writing it in the worktree made no progress*), and the worktree's making fails. Tests can pass a `write` function. | *every byte is copied however little each write takes…*: a 100 KB file (more than one read) written 5 bytes at a time arrives whole; a write taking nothing stops it. |
| 2 | P2: A path deeper than the scan's limit was missed without a word. | **Too deep fails the scan openly** (more than 40 folders), like too many files: *the copy pattern “…” reaches folders more than 40 deep, so Toryo stopped looking; make it narrower*, with no files, so no part is copied. | *the project's own files don't crowd out…*: a `.env` 42 folders down, named exactly: refused with that reason, no files. |

**Mutations,** each failing its test: the byte count ignored; the depth limit silent.

`npm test`: 298 tests, all passing. The browser check and the screenshot script pass.

## The owner's note N1 (14 Oct): two slices added to the plan

The owner asked, without interrupting Slice 16, to record two things as their decisions and to add them to the plan as slices after Slice 16, the fix first. Done in this turn; no code changed for it.
- **`docs/decisions.md`** has a new entry, *2026-10-14: Following a Codex app turn that ended with an error, and a fuller session timeline*, with each decision and why. It doesn't name the other project the error happened in.
- **The plan:**
  - *Slice 17: Follow a Codex app turn that ended with an error*, with a fixture from the owner's minimized sample. It's kept apart from *Recognized provider exhaustion*, as the owner said.
  - *Slice 18: Earlier sessions, a time ruler, and zoom and pan on the session timeline*.
  - The later slices move up by two (17–20 become 19–22).
  - The behavior is also under *Codex app boundary* and *Session timeline and new sessions*.
  - The slice count and order paragraphs are updated. The plan still parses into its 22 slices in order (`parseSlices`).
- **The README's** *Planned* section mentions both.

These docs aren't part of Slice 16's files. Once Slice 16 is approved and committed, I'll commit them on their own (*Home plan: add the owner's Slices 17 and 18*).

## Round 2: your five findings

| # | Finding | Fix | Test (`test/setup.test.mjs`) |
|---|---|---|---|
| 1 | P1: Any answer to the setup question retried it. | **Only Retry (accepting the recommendation) runs it again.** A written answer is kept on the question, runs nothing, and the room isn't asked again (`declined`). It says how to retry: *Retry setup* in the room's header (new), `toryo setup --retry`, MCP `toryo_setup`. Retry clears `declined`. | *a failed setup holds the room…*: *No, don't run it again* leaves attempt 1, still failed, no new question, the answer kept; then `retry-setup` runs it. |
| 2 | P1: Setup could launch before its running state was saved (snapshots off). | **`#startSetup` saves the room before the command starts:** the attempt marked running, its step already out of the queue. If that save fails, nothing starts: the setup is failed with the reason, and the room asks. | *the running attempt is on disk before its command starts…*: with snapshots off, a hook reads `room.json` just before the command is launched: running, attempt 1 with its command, no setup queued. The command reads it too, and a restart then finds it interrupted and doesn't run it again. *a setup whose start can't be saved isn't started*: the disk refuses that save (ENOSPC); the command never runs; the room asks, saying why; no attempt is kept. |
| 3 | P1: Copying trusted the scan's earlier checks. | **Each file is checked again as it's copied** (`copyInto`): <ul><li>every folder on its way must still be a real folder;</li><li>it's opened with `O_NOFOLLOW`, and its device and inode must be the ones the scan saw (`findCopies` records them);</li><li>it's read through that descriptor;</li><li>it's written with `O_EXCL \| O_NOFOLLOW`;</li><li>its permissions are taken from the open file, not the scan.</li></ul> Anything changed stops the copy, naming it (the worktree's making fails; Retry). | *a file that changes between being found and being copied…*: `.env` made a link outside; `secrets/` made a link to a folder outside; another file in `.env`'s place: each refused, nothing written. Permissions tightened to 0600 after the scan: copied as 0600. |
| 4 | P2: Interrupted attempts vanished from the history, and attempts lost their commands. | **Each attempt is kept in the room's record when it starts** (`workspace.setup.attempts`: number, command, timeout, times, outcome, exit code). At the end it's updated. At a restart it's marked interrupted, and a setup card says so (*Setup interrupted (Toryo stopped while it ran)*). `setupView`, `toryo setup` and MCP list every attempt with its own command and outcome, plus its output where there is any. | *Toryo stopping during the setup…*: after Retry, attempts are `[1, "echo started…; sleep 30", interrupted]` and `[2, "echo again…", done]`, and the interrupted card is there. *a failed setup…*: each attempt's own command. |
| 5 | P2: The scan stopped silently, letting the project's own files crowd out a later pattern. | **Each pattern's matches are sorted as it's scanned:** the project's own files are refused per pattern (in batches of 500 paths) and don't count toward the 500-file limit. **A scan past its limit fails openly** (50,000 files and folders looked at), as do too many matches and a Git check that fails. The worktree's making stops, saying why; the Settings preview and `toryo project` show it. The room shows the first 10 refusals and says how many more. | *the project's own files don't crowd out…*: 1,001 tracked `source*` files, then `.env`: `.env` is copied, and the 1,001 are refused. With a limit of 100: *the copy pattern “source*” reaches more than 100 files and folders, so Toryo stopped looking*. |

**Mutations,** each failing its test:
- the save before launch;
- any answer retrying;
- the identity check;
- `O_NOFOLLOW`;
- the scan limit;
- the interrupted attempt's record.

`npm test`: 297 tests, all passing. The browser check and the screenshot script pass.

## What changed

### The settings (`Engine.updateProject` → `worktreeSettings`, `copyPatternProblem`)

- **What they are:** a project's `worktree.copy` (patterns relative to its folder: `.env*`, `config/*.local.json`, `**` for folders in between), `worktree.setup` (a command), and `setupTimeoutMin` (30 by default).
- **Patterns refused when saved, saying why:** absolute or `~`, a `..` or `./` part, a backslash, anything in `.git`, empty.
- **Changed from:** Settings, `PATCH /api/projects/:id`, `toryo project [name] --copy … --setup … [--no-copy] [--no-setup]`, MCP `toryo_project`.
- **Preview:** `GET /api/projects/:id/worktree-files[?copy=…]` gives what a new worktree would get: the matching files (names), those not copied and why, the destination, and the setup command. Settings' preview passes the patterns as written, not yet saved.

### Copying (`findCopies`, `copyInto` in `src/worktrees.mjs`; in `#provision`)

- **Which files:** after the worktree's starting files are staged, the patterns are matched in the project's folder. Only regular files that Git ignores (and doesn't track) are copied: `ls-files --cached --others --exclude-standard` on the candidates with literal pathspecs.
- **Refused, each with its reason:**
  - one of the project's own files, which the worktree already has (`.env.example`, say);
  - a link;
  - a folder;
  - anything reached through a link;
  - more than 500 files.
- **How they're copied:** to the same place in the worktree, with `COPYFILE_EXCL` (never over a file that's there) and the source's permissions (0600 stays 0600). Each folder on the way in the worktree must be a real folder: a link there stops the copy, saying where, and nothing is written through it.
- **Said in the room, names only:** *Copied into the worktree (only their names are shown): .env, … Not copied: x (why)*.
- **A copy that fails** fails the worktree's making (Retry, as in Slice 15).
- **Never in snapshots:** the copied files are the workspace's `private` list. Every snapshot of the worktree leaves them out (`Snapshots` `workspace.exclude`, applied to its listing), whatever the room's `.gitignore` or index says. So they're never in a turn's diff, the changed-files note, a comparison from the starting point, or (later) a returned change.

### Setup (`#queueSetup`, `#startSetup`, `#afterSetup`, `#keepSetup`, `#askSetup`, `#retrySetup`, `setupView`)

- **Queued first:** when the worktree is ready and the project has a setup command, the room's `workspace.setup` is `pending` and a `setup` step goes first in its queue. It belongs to the worktree, not to the room's runs (no flow).
- **Nothing runs before it:**
  - `#accessBlock` holds every other request in the room (*its setup runs first*, or *its setup hasn't finished: retry it*);
  - `#executeTurn` refuses to start a turn there too, as a second guard.
- **Running it:** in the worktree, with the checks' `runShell` (its own process group, stopped with the room's Stop; out of time after `setupTimeoutMin`). Snapshots are taken before and after; the files it changed are listed on its record and in the room. The copied private files never are; ignored dependencies aren't either.
- **Shown like the checks:** the room's setup card (`setupEl`) has *Setup finished / failed (exit n) / stopped / ran out of time*, the command, the attempt, the files it changed, and *What it printed* (open when it failed). The room's header says *Setup* while it runs; Home's card says *Setup · running the worktree's setup*.
- **Pause:** Pause everything holds it (`blockersFor`, as for the checks). The room's Pause holds it (`#nextStartable`). A hold on agents doesn't (`toryo` isn't an agent).
- **When it doesn't finish:** failed, stopped (Stop), or interrupted (Toryo stopped while it ran: `#recover` turns `running` into `interrupted`). It's never run again by itself. The room asks, Toryo's own `setup` question: *…Nothing runs in the room until it has. Run it again?* (recommended: Retry).
- **Retry:** the answer, or `control retry-setup` (API; `toryo setup --retry`; MCP `toryo_setup` with `retry`). It runs the project's setup command as it is then, so a fixed command can be retried. No command any more means the setup is done.
- **After a Stop** (which empties the queue and clears questions): `#keepSetup`, in the scheduler, queues a pending setup again and asks about one that didn't finish, once the room isn't stopped.
- **Its output:** `GET /api/rooms/:id/setup` (`setupView`) gives the command, state, attempt, files copied and not copied, and every attempt (its own command and outcome; round 2) with what it printed and the files it changed. `toryo setup [room]` and MCP `toryo_setup` say the same.

### Shown

- **Settings:** the project's *A room's own worktree* fields and the preview.
- **New-room and *Start building* forms:** their *Its own worktree* choice says which files are copied in and which setup runs.
- **Room header:** *setup to run / running / failed / stopped / interrupted* after the worktree's path.
- **`toryo status`:** unchanged (the room's status and *Waiting* reasons say it).

## How to check

- `npm test`: 293 tests, all passing.
- The browser check and the screenshot script pass. New browser step 5za:
  - a room's own worktree with a project setup: the room shows *Setup finished* with the command, and *Copied into the worktree … .env*;
  - Settings shows the setup command, and the preview of patterns as written lists `.env` and refuses `.gitignore` (one of the project's own files);
  - the file's contents appear nowhere on the page.
- **`test/setup.test.mjs`** (7 tests):
  1. **Private files:**
     - copied: `.env` (0600, kept), `.env.local`, `secrets/key.json`;
     - refused: `.env.example` (tracked), `.env.link` (a link), `linked/*.json` (through a link);
     - patterns that escape refused when saved;
     - the room says the names;
     - the builder un-ignores `.env`, stages it and changes it: its turn's diff, and the comparison from the starting point, have only `.gitignore`;
     - the secrets appear nowhere in the room's records;
     - the main folder is unchanged.
  2. **Copying never through a link in the worktree's way,** nor over a file that's there.
  3. **Setup before the first turn:**
     - the builder starts after it;
     - it runs in the worktree (`pwd`) with `.env` there;
     - its changes (`generated.txt`, `where.txt`) are listed and are part of the delta from the starting point; `node_modules` (ignored) isn't;
     - nothing appears in the main folder.
  4. **A failed setup:**
     - the room asks (exit 3, output kept), no turn runs, and the blocked reason says so;
     - fixed in Settings and retried: attempt 2 with the new command finishes, then the builder runs;
     - retrying a finished setup is refused.
  5. **Restart during setup:** interrupted, the room asks, not run again by itself (its file has one line), and Retry runs it.
  6. **Pausing and stopping:**
     - the room's Pause holds it, and so does Pause everything (with the reason);
     - a hold on Codex doesn't, while the builder waits for the hold;
     - Stop during `sleep 30 && echo late` ends it (`late.txt` never appears); resuming asks, not running it again (attempt 1); Retry runs it.
  7. **Command line and MCP:**
     - `toryo project` saves and shows the copy patterns (what they match, what's refused) and the setup;
     - a bad pattern is refused;
     - `toryo setup` shows copies, state, attempts and output;
     - MCP `toryo_setup` (with retry) and `toryo_project` (clearing the setup).

**Mutations** (each fix taken out, in copies of the tree), each failing its test:
- copied files left in snapshots;
- the project's own files not refused;
- links copied;
- the setup gate in `#accessBlock` (the failed-setup test; while setup runs, queue order alone keeps the builder back, so the ordering test can't tell);
- both setup guards;
- a restart not marking setup interrupted;
- copying through a link in the worktree's way.

## Worth a look

- **Retry runs the project's current setup command,** not the one recorded at the first attempt, so fixing a broken command in Settings is enough. Each attempt records the command it ran.
- **Different rooms' setups and checks can still run at the same time;** Slice 19 makes them one at a time per project. Setup doesn't get the room's environment values yet (also Slice 19).
- **What the setup command prints is shown as it is.** A command that prints a secret (`cat .env`) would show it; Toryo only guarantees the copied files' contents never come from Toryo itself.
- **Setup time counts as checks** on the session's strip (its record is a `gate` event).

## What remains (later slices)

- Following a Codex app turn that ended with an error (17, the owner's bug fix, added 14 Oct).
- Earlier sessions, a time ruler, and zoom and pan on the session timeline (18, added 14 Oct).
- One at a time per project, and room environment values (19).
- The full review of a room's changes, and a return preview (20).
- Apply (21).
- Disk use and removing worktrees (22).
