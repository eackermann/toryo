import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "tokens.css"), "utf8");
const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = block(/:root \{([\s\S]*?)\n\}/);
const dark = { ...light, ...block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/) };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// The text colors the page puts on each background (styles.css), as [text, background].
const TEXT = [
  ["ink", "paper"], ["ink", "surface"], ["ink", "sunk"], ["ink", "tile"],
  ["ink-2", "surface"], ["ink-2", "sunk"], ["ink-2", "paper"],
  ["muted", "surface"], ["muted", "paper"], ["muted", "sunk"],
  ["plan-ink", "plan-soft"], ["plan-ink", "surface"], ["build-ink", "build-soft"], ["build-ink", "surface"],
  ["review-ink", "review-soft"], ["review-ink", "surface"], ["you-ink", "you-soft"], ["you-ink", "surface"],
  ["warn-ink", "warn-soft"], ["bad-ink", "bad-soft"], ["bad-ink", "surface"],
  ["surface", "review-ink"], ["agent-ink", "agent"], ["on-you", "you"], ["paper", "ink"],
  // Your notes: their text, and their code and quotes
  ["note-ink", "note"], ["note-ink", "note-sunk"],
];

test("every text color passes WCAG AA on the backgrounds it's used on, in light and in dark", () => {
  const failing = [];
  for (const [theme, t] of [["light", light], ["dark", dark]])
    for (const [fg, bg] of TEXT) {
      assert.ok(t[fg] && t[bg], `${theme}: --${fg} and --${bg} are both defined`);
      const r = ratio(t[fg], t[bg]);
      if (r < 4.5) failing.push(`${theme}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
    }
  assert.deepEqual(failing, []);
});

test("the dark theme is the same whether the system asks for it or you choose it", () => {
  const system = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/);
  assert.deepEqual(system, block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/));
});
