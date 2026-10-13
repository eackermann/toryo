# Research: cross-agent build and review (13 Oct 2026)

## How other people run it

| Workflow | Examples | Who builds / reviews | How it loops | Fit for us |
|---|---|---|---|---|
| Review on every stop | [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) (Hamel Husain), the review gate in OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Claude builds, Codex reviews | A Claude `Stop` hook runs Codex on the uncommitted changes; findings go back; Claude fixes. One pass, or until clean with the gate. | The mirror image of ours. Proves the cross-model idea; no Codex-builds version exists. |
| Plan-driven loop | [ralphex](https://github.com/umputun/ralphex), Codex `/goal`, the "Ralph loop" | Claude builds (Codex optional), many review agents | Reads `### Task N` checkboxes, runs each task in a fresh session, runs validation commands, commits per task, then review phases. | Closest to "keep going through the plan". Commits per task and refuses an in-place run with other uncommitted files. |
| Pull-request loop | [coding-review-agent-loop](https://github.com/wwind123/coding-review-agent-loop) | Claude builds, Codex reviews (configurable) | Coder pushes a PR; reviewers comment on the PR head; repeat until all approve or 10 rounds; evidence-backed disagreement goes to a human. | Needs pushes to GitHub each round. Good ideas, wrong transport for an uncommitted local tree. |
| Live peers | [AgentBridge](https://github.com/raysonmeng/agent-bridge) | Either | Claude and Codex share messages through a Codex app-server proxy and Claude channel notifications. The human steers; there's no fixed loop. | Shows how to inject into a Codex thread (`turn/start`). Terminal only; needs Bun. |
| Parallel fleets | Conductor, Vibe Kanban (sunsetting), Agor, Agent Teams AI, nimbalyst, clideck and many more ([list](https://github.com/andyrewlee/awesome-agent-orchestrators)) | Many agents in parallel worktrees | The human reviews diffs in a UI. | Optimises throughput. Our bottleneck is review quality, not parallelism. |
| Ask the other model | `/codex:review`, `/codex:adversarial-review`, `/codex:rescue` in codex-plugin-cc; Codex MCP server | Claude is the hub | Claude calls Codex as a tool or subagent. | Zero-build option if Claude drives. Uses Claude's context to hold Codex's output. |

## Worth borrowing

1. **Review an exact snapshot.** PR loops review a fixed head commit. In our loop the reviewer reads a tree that may still be moving. Each round should carry a snapshot ID (a patch hash or a `git stash create` object) so findings point at a known state.
2. **A fresh reviewer at the right moments.** ralphex runs each task in a fresh session, and others start a fresh session for the final review. Plan: keep one reviewer session for the rounds of a slice, so it remembers its own findings, then start a fresh one per slice or for a final adversarial pass.
3. **Explicit stop rules.** These are a round limit, stalemate detection (ralphex `--review-patience`) and "evidence-backed disagreement goes to the human". Everything else keeps moving.
4. **The plan as the source of truth for progress.** Read slices from the plan file so Foreman knows what remains, and resends "continue" itself.
5. **Gates the orchestrator runs itself.** ralphex runs the validation commands rather than trusting "tests pass". A quick gate (typechecks plus targeted tests) before review saves reviewer time.
6. **Codex `/goal`** is the built-in fix for "why did you stop". It judges its own completion, though, so it belongs inside a reviewed loop, not instead of one.

## Environment facts found while probing

- The Codex desktop app runs on Windows (`CODEX_HOME=C:\Users\<you>\.codex`, the owner's main thread since 3 Oct, model `gpt-6-astra`, effort xhigh, `on-request` approvals with the auto-review guardian). WSL has a separate `codex` 0.162.1 CLI with its own login and sessions.
- `codex exec resume` does not keep the model or effort: pass `-m` and `-c model_reasoning_effort=…` on every turn. It also switches approvals to `never` unless overridden. Claude Code's auto mode refused to let Claude test that override, so it's a setting the owner turns on.
- `codex exec --json` streams `thread.started`, `item.started/completed` (`command_execution`, `agent_message`, `file_change`) and `turn.completed` with usage. `-o FILE` writes the final message.
- `claude -p --session-id <uuid>`, then `--resume <uuid>`, keeps one reviewer session. `--output-format stream-json --verbose` streams tool calls. `--disallowedTools "Edit(//repo/**)" "Write(//repo/**)"` blocked writes to the repo in a test.
- Billing: with a subscription login, `claude -p` still draws on plan limits. Anthropic paused the June 2026 Agent SDK credit change ([support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).

## Keeping phone access (tested 13 Oct)

**Codex `queue`.** `codex queue --thread <id> --message …` returns at once. It writes the message to the per-thread follow-up inbox (`queue_1.sqlite`, table `queued_items`). The Codex app uses the same inbox for its own follow-ups: the owner's main thread has 33 queue revisions.
- Nothing runs the message by itself. The app's embedded app-server left it untouched for two minutes on a thread nobody had open.
- A headless `codex exec resume` folded the queued message into its next turn, placed before its own prompt.
- Still unconfirmed: whether the app sends queued messages when the thread is open (a test thread, preview "Foreman queue test thread").
- Turn ends are visible without touching the app: each finished turn appends `task_complete` with `last_agent_message` to the thread's rollout file.
- The app runs Codex on Windows (`codex.exe app-server` plus `exec-server --remote https://codex-cloud-environments.chatgpt.com/api`). The second process is presumably how the phone reaches it.

**Claude.** Remote Control reaches interactive sessions only (`claude --remote-control`, `/remote-control`, `remoteControlAtStartup`, or server mode `claude remote-control`), not `claude -p`. Channels (research preview) let a local MCP server push messages into a running session, and Claude answers through the channel's reply tool. Custom channels need `--dangerously-load-development-channels server:<name>` during the preview. AgentBridge uses exactly this on the Claude side.

**Resulting shape that keeps both phone apps working:**
- Codex stays in the app.
- Foreman tails its rollout file for `task_complete`, then pushes the message into an interactive Remote Control Claude session through a Foreman channel.
- Claude's reply goes back to Codex with `codex queue`.
- Foreman never owns either session. It only carries messages, so both stay visible and steerable from the phone.
