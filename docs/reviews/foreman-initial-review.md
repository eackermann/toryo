# Foreman: first external review

**Author:** Claude (built 12–13 Oct 2026, overnight; no external review yet)
**Reviewer:** Codex
**Tree:** everything in this repository is uncommitted. Review the whole tree, not a diff.

## What Foreman is

A local relay desk for coding agents. The owner (one person, on a Windows PC with WSL Ubuntu) runs it with `foreman`. It serves a web page on 127.0.0.1:4777. In **rooms**, Codex and Claude (and optionally Cursor and Grok) take turns in a project's working tree:

- **Chat:** parallel read-only replies, with an optional bounded discussion.
- **Plan:** blind proposals, then critiques, the owner's decisions, a written plan with decision records, and one check.
- **Build:** the builder implements a slice and ends with `FOREMAN: REVIEW <slice> | <handoff>`. Foreman runs the project's checks, then the reviewer reviews read-only and ends with `APPROVED` or `CHANGES`. Findings go back to the builder; approval moves it to the next slice; `DONE` triggers a final review.

No model runs the relay. The engine is a plain state machine that reads the status line at the end of each turn.

## Map

| Area | Files | Notes |
|---|---|---|
| CLI and server start | `bin/foreman.mjs`, `foreman` (bash launcher) | Picks the newest nvm Node. One desk per data folder. `quit`, `status`, `say`, `answer`, `start`, `mcp`, `doctor` |
| Engine | `src/engine.mjs` | Rooms, queue/pump, turns, catch-up ("Since your last turn"), the build/plan/chat state machines, waiting questions, restart recovery |
| Protocol | `src/protocol.mjs` | Every prompt Foreman sends, the status-line parser, owner-question parser |
| Snapshots | `src/snapshots.mjs` | Shadow bare repo per project in `~/.foreman/shadow/`, borrowing the project's objects via alternates. Before/after snapshot of every turn. Must never touch the project's own `.git` index, refs or config |
| Checks | `src/gates.mjs` | Project commands run with `bash -lc` before each review |
| Adapters | `src/agents/*.mjs` | `codex` (`codex exec --json`, resume), `claude` (`claude -p` stream-json), `cursor`, `grok` (from docs, never run), `codexapp` (the Windows Codex desktop app: `codex.exe queue` plus reading the thread's session log) |
| Server | `src/server.mjs` | HTTP API + SSE. Host check; non-GET needs `x-foreman` header and same-origin; `--lan` requires a token; path checks on file reads |
| MCP | `src/mcp.mjs`, `src/client.mjs` | stdio MCP server so a Claude Code / Codex session (and so the owner's phone, via Remote Control) can read rooms, say, answer, pause and start |
| Notifications | `src/notify.mjs` | Windows toast through `powershell.exe -EncodedCommand`; optional ntfy |
| Web UI | `web/app.js`, `web/md.js`, `web/styles.css`, `web/index.html` | No framework. `md.js` is a small Markdown renderer whose output goes into `innerHTML`, so check its escaping |
| Tests | `test/*.test.mjs`, `test/fake-agent.mjs` | The fake agent speaks the Codex/Claude headless formats from a JSON script |

## Invariants I intend

1. **Read-only turns don't write the project.** Claude gets `--disallowedTools Edit/Write/NotebookEdit(<repo>/**)`; Codex gets `-c sandbox_mode="read-only"`, re-passed on resume. The `codexapp` agent can't be made read-only, and the UI says so.
2. **Snapshots never change the project's git state.** That covers the index, refs, config and `.git/index.lock`. `GIT_OPTIONAL_LOCKS=0` and a separate index file are used.
3. **A turn's message reaches the next agent verbatim.** Only the trailing status line is shown as a chip in the UI.
4. **The relay never loops forever.** The limits are: at most `maxNudges` nudges when a status is missing, `maxRounds` review rounds per slice, two gate-fix attempts, and one retry on error. After those it asks the owner.
5. **Restarting Foreman loses no work.** In-flight turns are re-queued paused on the next start, and agent sessions are resumed by id.
6. **The local API can't be driven by a web page on another origin.** That includes DNS rebinding (Host check) and CSRF (header plus Origin).
7. **Nothing is sent off the machine except what the agents themselves send.** The one exception is ntfy, which the owner opts into.

## Where I'd like the hardest look

- **Engine races:** pause, stop or an interrupt while a turn is finishing; an owner answer arriving while a turn runs; `#clearWaiting` vs. a new question; parallel chat turns and `seen` bookkeeping; review-first starts (`startBuild({ reviewFirst })`, new today) and the one-time builder briefing (`build.briefed`).
- **Injection:** gate commands are the owner's own, but check anything built from agent output or room data that reaches a shell, PowerShell, `cmd.exe /c start` (the `codex://threads/<id>` link) or `git`.
- **XSS in the UI:** agent messages are untrusted and rendered as Markdown (`web/md.js`, `renderMarkdown` in `app.js`), as are file names, diffs, thread names and room titles.
- **The `codexapp` adapter:** the turn marker, reading a 1.7 GB session log from the end (`lastAppMessage`), the offset handling while the app appends, the >28K-character fallback to a UNC file path, and the 8-second auto-open.
- **Snapshots on large repos:** the main project, a large monorepo, takes 57–74 ms per snapshot. Check untracked files, `.gitignore`, symlinks, submodules, and a project with no commits.
- **Status parsing:** false positives (a status line quoted inside a message) and false negatives (Markdown decoration).
- **Things I couldn't test:** Cursor and Grok adapters; Codex `auto-review` permissions (Claude Code's own safety check refused to launch it); ntfy; `--lan`; the Windows Codex app as an MCP client.

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
node --test --test-concurrency=1 test/*.test.mjs     # 14 tests, ~6 s
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
```

The UI flows were checked with Playwright from another project's `node_modules` (`playwright-core@1.63.0`, Chromium). A run like that against a server started on another port with a temporary `FOREMAN_HOME` is fine.

## Please don't

- Stop, restart or send requests to the running Foreman on port 4777, or edit `~/.foreman/`. The owner is using it, and this review runs inside it.
- Launch real Codex, Claude, Cursor or Grok sessions, or touch the Codex desktop app (its queue, threads, database or `codex://` links). Use `test/fake-agent.mjs`.
- Commit. The owner decides when Foreman gets its first commit.
