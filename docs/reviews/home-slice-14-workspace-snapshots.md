# Home and desk controls, Slice 14: Make snapshots workspace-aware and lossless for supported trees

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 14, with *Room folders and worktrees* (the snapshot B a room's worktree starts from).
**Tree:** uncommitted on top of Slice 13 (`873908a`).
- **New:** `test/snapshots.test.mjs`, this handoff.
- **Changed:** `src/snapshots.mjs`, `src/engine.mjs`, `test/sharing.test.mjs`, `test/fake-agent.mjs`, `README.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **Snapshots are complete or refused,** never partial: files over 20 MB are no longer left out.
- **Every room has a workspace:** its project's own folder, *main*. Rooms from before get it at the restart.
- **A failed snapshot is said in the room,** once per reason.
- **Existing snapshots stay where they were:** the main folder keeps the shadow store's names (`refs/toryo/latest`, `toryo-index`), so old turns' diffs still work.

## Round 4: two more

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P2: A file name starting with a byte-order mark (U+FEFF) lost it when read, becoming another name. | **The names Git lists are decoded with `ignoreBOM`** (and `fatal`, as before), so a leading U+FEFF stays part of the name. | `test/snapshots.test.mjs`: `\ufeffREADME.md` beside `README.md`, with different bytes: each has its own. And a marked name alone (`\ufeffnotes.md`): there, under its own name. Without `ignoreBOM`, the test fails. |
| 2 | P3: The fake agent hid a count file it couldn't read. | **It starts from zero only when the file isn't there.** It reads again if it catches the file mid-change, and if it still can't read it after that, it stops with the error, rather than starting every rule's count again. The whole-copy writing stays. | Tried by hand: a broken count file makes the fake stop with the JSON error (exit 1); without the file, it runs (exit 0). The suite passes with it. |

`npm test`: 271 tests, all passing. The browser check passes.

## A failure in Toryo's own check run

Toryo's checks ran the suite before this review and one older test failed once: *holding Codex lets its turns finish in two rooms…* (`test/desk.test.mjs`). After the hold was released, one room's next building turn ran twice: once without a status, then again with one. That second run is what the relay does when a turn fails (it tries once more).

- **It doesn't come back:** 25 runs on their own, and 8 more while other test files ran beside it, all passed. It also passes in every full run here.
- **The one way I found for the test's fake agent to fail there:** that fake (`test/fake-agent.mjs`) keeps a small file shared by every fake running at once (how many times each rule has answered), and rewrote it in place. Two rooms' fakes start together at the release, so one could read it half-written and crash, which the relay takes for a failed turn.
- **The fix (test code only, not Toryo):** the file is now written whole (a finished copy renamed into place), and read again if it's ever caught mid-change; still unreadable, the fake stops with the error (round 4).
- **Not proven:** 450 fakes started three at a time didn't crash before the change either. If the failure comes back, it's something else, and I'd want to see the failed turn's error.

`npm test`: 271 tests, all passing.

## Round 3: five more cases

| # | Finding | Fix | Test (`test/snapshots.test.mjs`) |
|---|---|---|---|
| 1 | P1: Git stopping early on a long list could crash the desk (an unhandled `EPIPE` on its input). | **Errors on Git's input are handled:** an `EPIPE` (Git stopped reading) is ignored, since Git's own reason, on its error output and exit code, is what the failure says. Any other input error is added to it. | 6,000 names (more than the pipe holds), with Git unable to store anything (the shadow store's objects folder made read-only): it stops at the first, and the capture fails with Git's reason; no crash. Without the fix, the test process gets the uncaught `EPIPE`. (With 1,500 names the pipe never filled, so the first version of this test couldn't fail.) Also, an unreadable file on a long list is named. |
| 2 | P1: A file rewritten with the same size and its modification time put back kept its old blob. | **The change time is in the signature:** size, mode, modification time, change time (nanoseconds) and inode. A rewrite moves the change time, and putting the modification time back can't put that back. It's used both for reusing a file's blob and for noticing files changing during a capture. | A file at a fixed modification time, rewritten with other bytes of the same size and that time put back: read again. And again by a new `Snapshots` reading the record from disk. |
| 3 | P2: Names Git's list of names reads differently got another file's bytes. | **Such names go on their own, as an argument** (`hash-object -- <name>`, taken as it is): a line break anywhere, a carriage return at the end, a quote at the start (Git takes that as C quoting). | `"README.md"` (with its quotes) beside `README.md`, and `x.txt` with a carriage return beside `x.txt`: each has its own bytes. |
| 4 | P2: A pipe or socket where a file was looked like a deletion. | **Refused, naming it:** *data is a pipe, which a snapshot can't hold; Toryo's snapshots don't support that* (also a socket, or a device). A directory where a file was is still fine: its own files are listed with the others. | A tracked file replaced by a pipe, and by a socket: each refused, naming it. |
| 5 | P2: Link targets went through UTF-8. | **Read as bytes** (`readlink` with a buffer), and stored as they are. | A link whose target has a byte that isn't UTF-8: the snapshot holds the same bytes. |

**Also (of the same family):** the names Git lists are now read as bytes. A file name that isn't UTF-8 is refused, naming it, rather than read as a different name or as a deletion (*a file's name isn't UTF-8 ("caf\u00e9.txt" in Latin-1), which Toryo's snapshots don't support*). It's tested.

- `npm test`: 271 tests, all passing. The browser check and the screenshot script pass.
- **Mutations** (each fix taken out, in copies of the tree), each failing its test:
  - no input error handling: the long-list test, with the uncaught `EPIPE`;
  - no change time;
  - names only checked for line breaks;
  - pipes skipped;
  - link targets as text;
  - names decoded leniently.

## Round 2: your six findings

The first three came from one cause: the capture trusted Git's view of the folder. It started from HEAD and updated only the files Git reported as changed, and Git's view passes through filters, conversions and `core.filemode`. **It now reads the folder itself:**
- **Every file counts:** every path Git tracks (`ls-files --cached`) and every untracked one it doesn't ignore (`ls-files -o --exclude-standard`).
- **Each file as it is on disk:**
  - its bytes, written as blobs with `hash-object -w --no-filters`;
  - its mode from `lstat`: executable if any execute bit is set; a symbolic link holding its target; anything that isn't a file left out;
  - a tracked path that's gone is a deletion.
- **The snapshot is built from that list** (`update-index --index-info` into the workspace's own index, which starts empty each time).
- **A file isn't read twice for nothing:** each workspace keeps a record of what its last snapshot read (`toryo-read[-<id>].json`: signature, mode, blob). A file whose size, mode, modification time and inode are unchanged reuses its blob.

| # | Finding | Fix | Test (`test/snapshots.test.mjs`) |
|---|---|---|---|
| 1 | P1: Filtered contents weren't captured as they are. | **The bytes are read raw** (`--no-filters`): no clean filter, no line-ending or encoding conversion, whatever the project's attributes or your own Git settings. An LFS file's snapshot is its real contents, not its pointer. The handoff's earlier LFS sentence is corrected. | A clean filter that would turn `real` into `fake`: the snapshot has `real`. A file with Windows line endings (`eol=crlf`): CRLF kept. A UTF-16 file (`working-tree-encoding`): its UTF-16 bytes. `core.autocrlf=true` in your own Git config: a CRLF file stays CRLF. Without `--no-filters`, that last case fails. |
| 2 | P1: An untracked repository inside the folder disappeared silently. | **Refused, naming it:** Git lists it as `vendor/`; any such entry, before or after the files are read (one appearing during the capture), refuses the snapshot. *There's a repository inside the folder that Git doesn't track (vendor/), whose files a snapshot can't hold.* | `vendor/` made a repository with a file: refused, naming it. One appearing during the capture: refused, naming `late/`. |
| 3 | P2: `core.filemode=false` hid an executable-bit change. | **Modes come from the file system,** whatever Git's settings. With `core.symlinks=false`, Git checks a link out as a plain file holding its target, and that's what the snapshot has (a plain file with that text), as the folder does. | `core.filemode=false`, a script made executable: 100755. `core.symlinks=false`, a link checked out again: 100644, holding `README.md`. |
| 4 | P2: A workspace named without its folder was taken for the main one. | **`workspaceOf` keeps the workspace's identity** with no folder, and the capture fails: *the workspace “room-1” has no folder recorded*. The main folder's snapshots and reference are untouched. | `{ id: "room-1" }`: that failure; `refs/toryo/latest` is still the main folder's last snapshot; `failure()` names it. |
| 5 | P2: A reference that couldn't be written still meant success. | **`update-ref` is checked:** failing, the snapshot fails (*Toryo couldn't keep the snapshot: …*), and the record isn't updated. | A lock left on `refs/toryo/latest`: fails with that reason. |
| 6 | P3: A file that couldn't be read was called "files kept changing". | **Only an observed change is tried again.** A read failure ends the capture with Git's reason and the file's name (*Toryo couldn't read private.txt: … Permission denied*), as does an `lstat` error other than "gone". *Files kept changing* is kept for changes seen. | A file with no permissions: that failure, not *files kept changing*. |

**Also:**
- **Files Git takes as unchanged** (`assume-unchanged`) are no longer refused. Their bytes are read like any other, and the test shows the folder's new contents captured.
- **Files Git is told to skip** (`skip-worktree`) are still refused, since they may be missing from the folder.
- **A name with a line break** is read on its own, as Git's list of names can't hold it.

- `npm test`: 268 tests, all passing. The browser check and the screenshot script pass.
- **Mutations** (each fix taken out, in copies of the tree), each failing a test:
  - **filters applied:** the bytes test, with your own `core.autocrlf`. Without that setting, Toryo's shadow store has no working tree, so the project's attributes never applied there; your own settings do.
  - **modes from Git, not the files:** tests 1 and 7;
  - **nested repositories not refused:** tests 5 and 8;
  - **a workspace without a folder taken for the main one:** test 8;
  - **the reference's failure ignored:** test 8;
  - **read failures retried as changes:** test 8;
  - **the record reused for a changed file:** test 1.

## What changed

### Snapshots (`src/snapshots.mjs`)

- **Complete.** A snapshot holds, as they are in the folder (read from it directly since round 2):
  - every file Git tracks that's still there, staged or not (the working file: staged v2 with v3 on top is v3);
  - every deletion;
  - every untracked file Git doesn't ignore;
  - executable bits and symbolic links;
  - binaries, and files of any size. The 20 MB cut-off, which left big files out silently, is gone.
- **Ignored files stay out**, as Git leaves them out: a copied `.env`, build output. That's how private files copied into a worktree later stay out of its snapshots.
- **Files changing while it's taken.** The files are listed with a signature each (size, mode, modification time in nanoseconds and inode, or gone). After they're read, they're listed again.
  - Any difference means the snapshot is taken again, up to 3 times. Then it's refused: *files kept changing while Toryo took the snapshot*.
  - A file that was equal to HEAD and changes meanwhile shows up in the second list, so it counts too.
- **What a snapshot can't reproduce is refused with the reason,** `{ ok: false, unsupported: true, reason }`, never captured in part:
  - a sparse checkout (`core.sparseCheckout`);
  - submodules (an index entry of mode 160000);
  - a repository inside the folder that Git doesn't track (round 2);
  - files Git is told to skip (`skip-worktree`), which may not be in the folder. (Files Git treats as unchanged are read as they are, since round 2.)
- **Explicit failures, with reasons:** a missing folder (*the folder … isn't there*), a folder outside Git, and Git failing to list, read or record.
- **Workspaces.** `capture(project, label, workspace)` and `take(project, label, workspace)` take a workspace `{ id, path }`; none, or `main`, is the project's own folder.
  - Each workspace has its own index file (`toryo-index-<id>`), reference (`refs/toryo/ws/<id>/latest`) and lock, in the project's one shadow repository. Two workspaces of one repository share objects, and can be compared later (the worktree slices need that).
  - The main folder keeps the old names, so everything already there stays reachable.
- **Pinning:** `pin(project, name, commit)` keeps a snapshot under `refs/toryo/pins/<name>` (a room's starting point B, from Slice 15); `pinned` reads it.
- **Stays compatible.** `take` still returns `{ commit, tree }` or null, so existing callers, and the tests' snapshot doubles that override it, are unchanged. `capture` gives the reason, `failure(project, workspace)` says why the last one failed, and `changes`, `diff` and `hint` are as before.
- **The project's own Git is untouched:** only read commands, with optional locks off (`GIT_OPTIONAL_LOCKS=0`), and every write goes to the shadow repository.

### Rooms (`src/engine.mjs`)

- **Each room keeps its workspace:** `room.workspace = { id: "main", kind: "main", root, subdir }`.
  - `root` is the folder's top, as Slice 12 finds it.
  - `subdir` is the project's place inside it (`""` at the top). A project below its repository's top is snapshotted as the whole repository, with `subdir` saying where it is.
  - New rooms get it at creation, and rooms from before at load. Every room works in its project's own folder until Slice 15.
- **A turn's snapshots go through `#snapshot`,** which takes the room's workspace. When one can't be taken, the room says so once per reason (a warning line, not sent to agents): *Toryo couldn't take a snapshot of this room's folder: <reason>. The files its turns change can't be listed or compared until it can.* A snapshot that works again clears it. The turn records `filesKnown: false` (Slice 13).

## How to check

- **`npm test`:** 271 tests, all passing.
- **`test/snapshots.test.mjs`** (6 tests, disposable repositories):
  1. **Exactly the working files:**
     - a file staged at v2 with v3 on top unstaged: v3;
     - an untracked file in, an ignored `secret.env` out, a deleted file gone;
     - `run.sh` made executable (100755), a symbolic link (120000, its target);
     - 256 binary bytes, and a 21 MB file whole.
     - The project's index is the same byte for byte, even with a file written again with the same contents meanwhile. HEAD, branches and `git status` are unchanged.
     - `take`, `changes` and `diff` still work as the engine uses them.
  2. **An unborn repository** (staged and untracked files, no commit), and **a project in a folder of its repository** (the whole repository's files).
  3. **Two workspaces:** the folder and a linked worktree, each with a file of its own, captured at once. Each snapshot has only its own file, and each has its own reference. A pin keeps a snapshot named after later captures.
  4. **Changing files:** a file changed during the first try is taken again, with the content as it was once still. Changed on every try, refused with the reason; `take` gives null and `failure()` gives the reason.
  5. **Refused:** submodules, a sparse checkout, a skipped file, a file treated as unchanged (each `unsupported`, with its reason); a missing folder; a folder outside Git.
  6. **Rooms:**
     - a new room's workspace is `main`, at the repository's top;
     - a room saved without one gets it at the next start;
     - with a skipped file, two turns say *couldn't take a snapshot* once, with the reason, and their turns have no snapshot and `filesKnown: false`.
- **`test/sharing.test.mjs`:** one test wrote its "edited meanwhile" file as soon as the review was running, which could be before its first snapshot. The new capture takes a moment longer, so that edit could fall before the snapshot, and the race showed. It now waits for the review's first snapshot.
- **The browser check and the screenshot script pass.**
- **Mutations** (in copies of the tree), each failing a test:
  - **files over 20 MB left out:** test 1;
  - **no check for files changing:** test 4;
  - **no refusal:** tests 5 and 6;
  - **every workspace on the main folder's index and reference:** test 3;
  - **a failed snapshot not said:** test 6.
  - **Taking `GIT_OPTIONAL_LOCKS=0` away fails nothing:** the commands snapshots run (`diff HEAD`, `ls-files`) don't write the index anyway. It stays as a second guard; test 1 checks the index byte for byte with a file touched.

## Worth a look

1. **Snapshots of a project in a subfolder hold the whole repository,** as they did before. The workspace records where the project is (`subdir`). The worktree slices create the room's worktree for the whole repository and work in that subfolder of it.
2. **Git LFS and filters** (corrected in round 2): the snapshot has the folder's own bytes, with no filters applied. An LFS file's snapshot is its real contents, not its pointer, so a worktree made from it gets exactly what the folder had.
3. **The signature uses size, mode, modification and change times (to the nanosecond) and inode** (change time since round 3), both to see files changing during a capture and to reuse a file's blob from the last snapshot. A change that keeps all five wouldn't be seen; the change time can't be set back without changing the clock. Reading every file again each time would make each snapshot as slow as the first.
4. **Not in this slice** (as the plan says): snapshots keeping their own copies of objects, so a cleanup in the project can't break old snapshots (the near-term bug fix listed under Later). Also not here: using `capture` to create a worktree (Slice 15), which will refuse an incomplete one.
