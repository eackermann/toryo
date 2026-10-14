import { createHash } from "node:crypto";
/**
 * The relay protocol: what Toryo tells each agent, and how it reads the
 * status line an agent ends its turn with (`TORYO: <STATUS> <detail>`).
 */

// One rule for the server and the page: web/status.js.
export { parseStatus, stripStatus } from "../web/status.js";

/** Owner questions written as `- Q: question (Recommended: answer)`. */
export function parseQuestions(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*\d.)]*\s*(?:\*\*)?Q(?:uestion)?(?:\*\*)?\s*[:.]\s*(.+?)\s*$/i);
    if (!m) continue;
    const { question, recommendation } = splitRecommendation(m[1], { parenthesizedOnly: true });
    out.push({ question: question.replace(/\*\*/g, "").trim(), recommendation });
  }
  return out;
}

/**
 * A question and the recommendation that comes with it: "Do X and Y? (Recommended: yes to both)", "Do X and Y
 * (Recommended: yes to both)?", or "… I recommend Z." A recommendation in parentheses is read up to its own closing
 * parenthesis, so parentheses, quotes and punctuation inside it stay, and the wrapper around it doesn't: the question
 * keeps what came after it ("?"), the recommendation doesn't. Without parentheses, it runs to the end of the line,
 * less any closing parenthesis left over from a wrapper.
 */
export function splitRecommendation(text, { parenthesizedOnly = false } = {}) {
  const s = String(text ?? "");
  const open = /\(\s*(?:\*\*)?Recommend(?:ed|ation)(?:\*\*)?\s*[:.\-–—]\s*/i.exec(s);
  if (open) {
    // Its own closing parenthesis: counting the ones it opens, and none inside `code` or quotes.
    let depth = 0;
    let end = -1;
    for (let i = open.index; i < s.length; i++) {
      const quoted = quoteEnd(s, i);
      if (quoted > 0) i = quoted;
      else if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    const inner = s.slice(open.index + open[0].length, end < 0 ? s.length : end);
    const before = s.slice(0, open.index).trimEnd();
    const after = end < 0 ? "" : s.slice(end + 1);
    // "Delimiter? (Recommended: …)?": one question mark, not two.
    const question = (/[?.!]$/.test(before) && /^[\s?.!]*$/.test(after) ? before : `${before}${after}`).trim();
    return { question, recommendation: inner.replace(/\*\*/g, "").trim() };
  }
  if (parenthesizedOnly) return { question: s.trim(), recommendation: "" };
  const m = /\b(?:I\s+)?recommend(?:ed|ation)?\b\s*[:\-–—]?\s*(.+)/i.exec(s);
  if (!m) return { question: s.trim(), recommendation: "" };
  let rec = m[1].replace(/\*\*/g, "").trim();
  // A wrapper's leftovers: a closing parenthesis it never opened, and what followed it ("yes to both)?").
  const unopened = () => (rec.match(/\)/g) ?? []).length > (rec.match(/\(/g) ?? []).length;
  while (unopened() && /\)[\s?.!]*$/.test(rec)) rec = rec.replace(/\)[\s?.!]*$/, "").trim();
  return { question: s.trim(), recommendation: rec };
}

const QUOTES = { "`": "`", '"': '"', "“": "”", "'": "'", "‘": "’" };
const WORD = /[\p{L}\p{N}]/u;

/**
 * Where the quotation opening at `i` ends, or -1 if there's none there: `code`, "text" (where \" doesn't end it),
 * 'text' and ‘text’. An apostrophe inside a word (don't, the owners' choice) opens nothing, a single quote followed
 * by a letter (it's) closes nothing, and a quote that's never closed is just a character.
 */
function quoteEnd(s, i) {
  const close = QUOTES[s[i]];
  if (!close || (s[i] === "'" && WORD.test(s[i - 1] ?? ""))) return -1;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\" && close !== "`") j++;
    else if (s[j] === close && !((close === "'" || close === "’") && WORD.test(s[j + 1] ?? ""))) return j;
  }
  return -1;
}

/** Taking a recommendation, in words: "Go with your recommendation: yes to both." (one full stop, no wrapper). */
export function acceptRecommendation(rec) {
  const r = String(rec ?? "").trim().replace(/[\s.]+$/, "");
  if (!r) return "Go with your recommendation.";
  return `Go with your recommendation: ${r}${/[!?]$/.test(r) ? "" : "."}`;
}

export const DEFAULT_DECISIONS =
  "If the repository documents how decisions and plans are recorded (CLAUDE.md, AGENTS.md, CONTRIBUTING, docs/), follow it. " +
  "Otherwise append decisions to docs/decisions.md (number, date, decision, why) and keep plans in docs/plans/.";

/** Which version of a project's house rules and decision conventions an agent has. */
export function rulesKey(project) {
  return createHash("sha256").update(`${project?.rules ?? ""}\u0000${project?.decisions ?? ""}`).digest("hex").slice(0, 16);
}

/**
 * The house rules changed since this agent last got them. Agents whose session carries Toryo's introduction only
 * from their first message (Codex, the Codex app, Cursor, Grok) get the new rules in full; Claude, whose
 * instructions carry them on every turn, gets a pointer.
 */
export function rulesUpdate(project, { inInstructions = false } = {}) {
  if (inInstructions)
    return "## The owner updated the house rules\nThe current house rules and decision conventions are in your instructions. They replace the earlier ones; follow them from now on.";
  return [
    "## The owner updated the house rules",
    "These replace the house rules and decision conventions you were given earlier in this room. Follow them from now on.",
    project.rules ? `House rules from the owner:\n${project.rules}` : "House rules from the owner: (none)",
    `Decisions: ${project.decisions || DEFAULT_DECISIONS} Never record something as decided that the owner has not decided.`,
  ].join("\n\n");
}

/**
 * Toryo's introduction for an agent in a room. `workspace`: the room's own worktree ({ cwd, branch, main, base }),
 * where all its work happens, with the project's main folder named only as off-limits; null for the project's folder.
 */
export function preamble({ agentLabel, others, project, workspace = null }) {
  const crew = others.length ? others.join(", ") : "no other agents";
  return [
    `You are ${agentLabel}, working inside Toryo: a relay that passes messages between AI coding agents and their owner. In this room: the owner and ${crew}.`,
    "Messages from the owner and the other agents arrive in your prompt under “Since your last turn”. Your final message is forwarded to them verbatim, so write it for them: concrete and self-contained, with file paths and line numbers where they help.",
    workspace ? worktreeBrief(workspace) : `Repository: ${project.path}. Follow its own conventions (CLAUDE.md, AGENTS.md and similar).`,
    `Decisions: when the owner decides something, or the crew agrees on something durable, record it in the repository. ${project.decisions || DEFAULT_DECISIONS} Never record something as decided that the owner has not decided.`,
    "End every turn with exactly one status line, chosen from the ones your prompt allows: `TORYO: <STATUS> <optional detail>`. Before your final message, stop any background commands you started (watchers, servers), so your answer ends the turn.",
    project.rules ? `House rules from the owner:\n${project.rules}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Where a worktree room's agents work, and the main folder they leave alone. */
function worktreeBrief({ cwd, branch, main }) {
  return [
    `Repository: ${cwd}. This is this room's own worktree of the project (a Git worktree on the branch ${branch}): do all your work here, and read the files here. Follow its own conventions (CLAUDE.md, AGENTS.md and similar).`,
    `The project's main folder, ${main}, is off-limits: don't edit, create or delete anything there, and don't run commands that change it. This room's changes reach it only when the owner brings them back.`,
    "This worktree started from the main folder as it was, uncommitted changes included, and those are staged in its own index: plain `git diff` shows only the changes made here since, while `git diff --cached` or `git diff HEAD` also show the ones it started with. What this room changed is Toryo's comparison of the worktree with the snapshot it started from, whatever is staged or committed.",
  ].join("\n");
}

/** The "Since your last turn" block: everything this agent hasn't seen yet. */
export function catchUp(items, { maxChars = 120_000 } = {}) {
  if (!items.length) return "";
  const blocks = items.map((it) => `### ${it.heading}\n${it.body.trim()}`);
  let total = blocks.reduce((n, b) => n + b.length, 0);
  // Trim the oldest blocks first if the backlog is huge.
  for (let i = 0; i < blocks.length - 1 && total > maxChars; i++) {
    const before = blocks[i].length;
    blocks[i] = blocks[i].slice(0, 2_000) + "\n…(trimmed by Toryo; ask the owner if you need the rest)";
    total -= before - blocks[i].length;
  }
  return `## Since your last turn\n\n${blocks.join("\n\n")}\n`;
}

const statusBlock = (lines) => `End with exactly one status line:\n${lines.map((l) => `  ${l}`).join("\n")}`;

export const prompts = {
  buildKickoff: ({ reviewer, task, planPath }) => `## Your role: builder
You implement; ${reviewer} reviews each round. Toryo passes your final message to ${reviewer}, and its review back to you, automatically. The owner has pre-authorised you to keep working through the whole plan without asking whether to continue.

Task: ${task || "Work through the plan."}
Plan: ${planPath || "(none given; agree the slices in your first message)"}

Each round:
1. Implement the next unfinished slice of the plan, or address the review you were given, and verify it.
2. Keep a review handoff for ${reviewer}: what changed, invariants, how to test it, and what remains. Name its path in your status line.
3. ${statusBlock([
    "TORYO: REVIEW <slice name> | <handoff path>   (ready for review)",
    "TORYO: OWNER <one-line question>              (blocked on a decision only the owner can make; recommend a default in your message)",
    "TORYO: DONE                                   (every slice is implemented and has passed review)",
  ])}
Don't end a turn just to report progress or to ask whether to continue.`,

  buildFix: ({ reviewer, round, maxRounds }) => `${reviewer} reviewed your last round (round ${round} of at most ${maxRounds} on this slice); the review is above. Address every finding: fix it, or explain in your handoff why not. Re-verify, update the handoff, and end with TORYO: REVIEW, OWNER or DONE.`,

  buildNext: ({ reviewer, slice }) => `${reviewer} approved ${slice ? `“${slice}”` : "your last round"}; its review is above. Apply any minor notes that are cheap and safe, then continue straight into the next unfinished slice of the plan. End with TORYO: REVIEW when it is ready for review, or TORYO: DONE if no slices remain.`,

  buildNudge: ({ count, max }) => `Your last turn ended without a TORYO status line (nudge ${count} of ${max}). You are cleared to keep working through the plan without asking. If work remains, continue now. End with TORYO: REVIEW, OWNER or DONE.`,

  buildAnswer: () => `The owner answered (above). Carry on accordingly, and end with TORYO: REVIEW, OWNER or DONE.`,

  reviewAnswer: ({ builder, final }) => `The owner answered your question (above). Finish your ${final ? "final " : ""}review of ${builder}'s work with that answer: findings ranked by severity, each with file:line, the failure scenario and the fix you expect. You are still read-only: don't edit files in the repository.
${statusBlock([
    `TORYO: APPROVED   (nothing blocking${final ? "; the plan is complete" : `; ${builder} moves on`})`,
    `TORYO: CHANGES    (${builder} must address findings first)`,
    "TORYO: OWNER <one-line question>   (only the owner can unblock this)",
  ])}`,

  buildGate: ({ failures }) => `Before review, Toryo ran the project's checks and some failed:\n\n${failures}\n\nFix these first, then end with TORYO: REVIEW (or OWNER if you are blocked).`,

  review: ({ builder, snapshot, round, final }) => `## Your role: reviewer
${final ? `${builder} reports that every slice of the plan is done. Do a final review of the whole change against the plan.` : `${builder} finished a round${round > 1 ? ` (round ${round} on this slice)` : ""}; its message is above, verbatim.`} Review it as you normally would, starting from any handoff it names. You are read-only: don't edit files in the repository (use a scratch directory for probes), don't commit, and don't touch live data.
${snapshot ? `\n${snapshot}\n` : ""}
Write the review for ${builder}: findings ranked by severity, each with file:line, the failure scenario and the fix you expect. Keep decisions that only the owner can make separate, with your recommendation. If you approve but leave a finding for later, put it on its own line starting with “Open:”, so Toryo keeps it in the room's ledger for later reviews.
${statusBlock([
    `TORYO: APPROVED   (nothing blocking${final ? "; the plan is complete" : `; ${builder} moves on`}; minor notes may stay in the review)`,
    `TORYO: CHANGES    (${builder} must address findings first)`,
    "TORYO: OWNER <one-line question>   (only the owner can unblock this)",
  ])}`,

  statusOnly: ({ allowed }) => `Your last message had no TORYO status line. Reply with only the status line for that message, one of: ${allowed.join(", ")}.`,

  planProposal: ({ topic, others }) => `## Planning, step 1 of 4: your own proposal
The owner wants to plan: “${topic}”.
${others.length ? `${others.join(" and ")} ${others.length > 1 ? "are" : "is"} drafting independently at the same time; you'll see theirs next.` : ""} Read whatever you need in the repository, but don't change files yet.

Write a proposal: goals and non-goals, the approach, a sequence of small reviewable slices (each with how it will be verified), the risks, and alternatives you rejected and why. Finish with a “Questions for the owner” section, one line per question in this form:
- Q: <question> (Recommended: <your answer>)

End with: TORYO: PROPOSAL`,

  planCritique: () => `## Planning, step 2 of 4: critique
The other proposals are above. Compare them with yours: what is better in theirs, what is missing or risky in each, where you disagree and why, and what you would now change in your own plan. Put any new owner questions in the same “- Q: … (Recommended: …)” form. Don't change files.

End with: TORYO: CRITIQUE`,

  planSynthesis: ({ planPath }) => `## Planning, step 3 of 4: write the plan
The owner chose you to write the plan; the owner's decisions are above. Write it to ${planPath}, following the repository's conventions for plans. Merge the best of every proposal and critique. Use one heading per slice in the form “### Slice N: <name>”, each with its scope, how it will be verified, and when it counts as done. Record the owner's decisions following the repository's decision convention. Don't implement anything yet.

End with: TORYO: REVIEW ${planPath}`,

  planCheck: ({ author, planPath }) => `## Planning, step 4 of 4: check the written plan
${author} wrote the plan to ${planPath}. Check it against the discussion and the owner's decisions: is anything lost, contradictory, untestable, or too big for one review round? Are the decisions recorded where the repository expects them? Don't rewrite it; list concrete fixes. Don't change files.

End with TORYO: APPROVED or TORYO: CHANGES.`,

  planRevise: ({ planPath }) => `The plan check is above. Revise ${planPath} to address it (or explain why not), keeping decisions recorded. End with: TORYO: REVIEW ${planPath}`,

  // A ready plan: the owner's change request, or a discussion the owner forwarded, is above.
  planChange: ({ planPath }) => `The owner asked for changes to the plan (above). Revise ${planPath} accordingly, keeping decisions recorded. End with: TORYO: REVIEW ${planPath}`,

  // The other planners' check of the author's revision: once, read-only.
  planRecheck: ({ author, planPath }) => `## Check the revised plan
The owner asked for changes to the plan, and ${author} revised ${planPath} (both above). Check the revision: does it do what the owner asked, without losing anything decided before? Is anything contradictory, untestable, or too big for one review round? Don't rewrite it; list concrete fixes. Don't change files.

End with TORYO: APPROVED or TORYO: CHANGES.`,

  // A plan check that ended without a verdict: asked once, for the verdict alone.
  planVerdict: () =>
    "Your check of the plan ended without a verdict. Reply with only the status line for it: TORYO: APPROVED if the plan can stand as it is, or TORYO: CHANGES if your findings need the author to act. Don't change files.",

  // The author's one answer to that check (no check follows it).
  planAddress: ({ planPath, checkers }) => `${checkers} checked the plan, and their findings are above. Address them in ${planPath} (or explain why not), keeping decisions recorded. End with: TORYO: REVIEW ${planPath}`,

  chat: ({ canWrite, others }) =>
    `Reply to the owner${others.length ? `; ${others.join(" and ")} may reply too` : ""}. ${canWrite ? "You may change files in the repository if the owner asked for it." : "Don't change files in the repository in this conversation turn."} If you need a decision only the owner can make, end with TORYO: OWNER <question>; otherwise end with TORYO: REPLY.`,

  discuss: ({ round, rounds, others }) =>
    `Discussion round ${round} of ${rounds}: respond to ${others.join(" and ")} above. Agree, disagree with reasons, or refine; be brief and specific, and don't repeat points already settled. Don't change files. End with TORYO: AGREE if you now agree with the others on the open points, otherwise TORYO: DISAGREE <the main open point>.`,

  opinion: ({ author }) => `## Second opinion requested
The owner wants your independent view on ${author}'s message above. Check it against the repository: what is right, what is wrong or risky, and what would you do differently? Be concrete. Don't change files.

End with: TORYO: OPINION`,

  interrupted: () => `The owner interrupted your previous turn with the note above. Take it into account and continue with your task. End with the status line your task requires.`,
  newSession: (n) =>
    `## A new session\nThe owner started a new session in this room (session ${n}). What came before it is finished: its questions are closed, and nothing from it is pending. You keep your memory of it; start from what follows.`,

  /** The builder's turn for notes the owner sent while it worked: it acts on them, then the relay carries on. */
  buildNotes: ({ status, detail, next }) => {
    const before = status ? `TORYO: ${status}${detail ? ` ${detail}` : ""}` : "no status line";
    return `## Building: your notes
The owner sent you notes while you were working; they're above. You're still the builder: act on them now, in this turn, as part of the work. Don't stop to discuss them.

If this changes the work, end with TORYO: REVIEW <slice> | <handoff> (update the handoff), or DONE, or OWNER <question> if you need a decision. If nothing needed changing now, end with TORYO: REPLY, and the relay carries on from your last turn (${before})${next ? `: ${next}` : ""}.`;
  },

  /** A reviewer's (or anyone not building) short answer to the owner's question; then everything carries on as it was. */
  noteAnswer: () => `## Answering your question
The owner asked you something (above). Answer it briefly and directly. This is a short read-only turn: don't change files, and don't redo or extend your work. Toryo then carries on exactly where it was.

End with TORYO: REPLY.`,

  /** Appended to a building turn that carries the owner's notes: one line per note, so each note's outcome shows. */
  noteAcks: (notes) => `### Your notes in this turn
${notes.map((n) => `- ${n.n} (${n.intent}): “${n.preview}”`).join("\n")}
Start your message with one line per note, then carry on with your message:
  ${notes[0].n}: done — <what you did>
  ${notes[0].n}: scheduled for <slice> — <why later>
  ${notes[0].n}: declined — <why>
${notes.some((n) => n.intent === "ask") ? "A note marked ask is a question: answer it right after its line.\n" : ""}`,

  noteReply: ({ role, canWrite, status, detail }) => {
    const before = status ? `TORYO: ${status}${detail ? ` ${detail}` : ""}` : "no status line";
    const act =
      role === "builder"
        ? `If it does, act on it now, then resubmit: end with TORYO: REVIEW <slice> | <handoff> (or DONE, or OWNER if you need a decision). If it doesn't, end with TORYO: REPLY, and Toryo carries on from your last turn (${before}).`
        : role === "reviewer"
          ? `You are still read-only: don't change files. If the note changes your verdict, end with the new one (TORYO: APPROVED, CHANGES or OWNER <question>); otherwise end with TORYO: REPLY to keep it (${before}).`
          : `${canWrite ? "" : "Don't change files. "}If the note changes your answer, end with the status line your task requires; otherwise end with TORYO: REPLY to keep your last one (${before}).`;
    return `## The owner wrote to you while you were working
The owner's note is above. Before Toryo moves on, answer it briefly. Start your reply with “To you:”, answer any questions, and say whether the note changes your work. ${act}`;
  },
};
