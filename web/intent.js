// Ask or Tell: whether a note to the crew asks something (and so needs an answer) or tells them what to do.
// Shared by the page, which suggests it as you type, and the server, which uses it when a note doesn't say.

// A question word; "is/are/was/were …"; or "do/should/have … you/we/it …". Not "Do the migration first" or
// "Have a look", which are instructions, nor "Could you add tests" without a question mark: a polite request.
const QUESTION_START =
  /^\s*(?:@\w+[,:]?\s+)?(?:(?:what|why|how|which|when|where|who|whom|whose|is|are|was|were|any (?:thoughts|ideas|objections))\b|(?:do|does|did|should|shall|have|has|had)\s+(?:you|we|i|they|it|this|that|these|those|there|he|she)\b)/i;
const QUESTION_PHRASE = /\b(?:what do you think|what would you|do you think|your (?:thoughts|opinion|view|take)|thoughts on|which (?:one|option|would you)|would you rather|do you prefer|or not\b|wdyt)\b/i;

/** "ask" when the text asks something: a question mark, a question, or a request for an opinion or a choice. Otherwise "tell". */
export function noteIntent(text) {
  const t = String(text ?? "");
  if (t.includes("?") || QUESTION_START.test(t) || QUESTION_PHRASE.test(t)) return "ask";
  return "tell";
}
