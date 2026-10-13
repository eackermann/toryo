import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, stripStatus } from "../src/protocol.mjs";
import { toastCommand } from "../src/notify.mjs";
import { renderMarkdown } from "../web/md.js";

test("only a terminal status line outside quotes and code drives the relay", () => {
  const fenced = "Example of the format:\n```\nTORYO: APPROVED\n```\nActually, fix the bug first.";
  assert.equal(parseStatus(fenced).status, null);
  assert.equal(parseStatus("TORYO: APPROVED\n\nActually, fix the bug first.").status, null);
  assert.equal(parseStatus("Looks fine.\n> TORYO: APPROVED").status, null);
  assert.equal(parseStatus("Unclosed example:\n```\nTORYO: APPROVED").status, null);
  assert.equal(parseStatus("~~~\nTORYO: APPROVED\n~~~").status, null);
  assert.deepEqual(parseStatus("Code:\n```js\nx()\n```\n\nTORYO: CHANGES\n\n"), { status: "CHANGES", detail: "" });
  assert.deepEqual(parseStatus("Done.\n- **TORYO: REVIEW Slice 2 | docs/h.md**"), { status: "REVIEW", detail: "Slice 2 | docs/h.md" });
  // The page strips the same line the relay read, and nothing else.
  const quoted = "The format is:\n> TORYO: APPROVED\n\nTORYO: CHANGES";
  assert.equal(stripStatus(quoted), "The format is:\n> TORYO: APPROVED");
  assert.equal(stripStatus("TORYO: APPROVED\nActually, no."), "TORYO: APPROVED\nActually, no.");
});

// The tags and attributes renderMarkdown may produce. Anything else in its output is an injection.
const TAGS = new Set(["a", "code", "strong", "em", "p", "br", "h3", "h4", "h5", "h6", "pre", "blockquote", "ul", "ol", "li", "span", "hr", "div", "table", "thead", "tbody", "tr", "th", "td"]);
const ATTRS = new Set(["href", "target", "rel", "class", "data-file", "data-line", "data-lang", "data-done"]);

/** Tags and their attributes as an HTML5 parser tokenises them (enough of the spec for this check). */
function tags(html) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf("<", i)) >= 0) {
    const m = html.slice(i).match(/^<\/?([A-Za-z][^\s/>]*)/);
    if (!m) {
      i++;
      continue;
    }
    i += m[0].length;
    const tag = { name: m[1].toLowerCase(), attrs: [] };
    while (i < html.length && html[i] !== ">") {
      if (/[\s/]/.test(html[i])) {
        i++;
        continue;
      }
      let name = "";
      while (i < html.length && !/[\s/>=]/.test(html[i])) name += html[i++];
      while (/\s/.test(html[i] ?? "")) i++;
      let value = null;
      if (html[i] === "=") {
        i++;
        while (/\s/.test(html[i] ?? "")) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1);
          value = html.slice(i + 1, end < 0 ? html.length : end);
          i = end < 0 ? html.length : end + 1;
        } else {
          value = "";
          while (i < html.length && !/[\s>]/.test(html[i])) value += html[i++];
        }
      }
      tag.attrs.push({ name: name.toLowerCase(), value });
    }
    out.push(tag);
  }
  return out;
}

function assertSafe(src) {
  const html = renderMarkdown(src);
  for (const t of tags(html)) {
    assert.ok(TAGS.has(t.name), `unexpected <${t.name}> from ${JSON.stringify(src)}: ${html}`);
    for (const a of t.attrs) {
      assert.ok(ATTRS.has(a.name), `unexpected attribute ${a.name} from ${JSON.stringify(src)}: ${html}`);
      if (a.name === "href") assert.match(a.value, /^(https?:\/\/|#$)/, `unexpected href from ${JSON.stringify(src)}`);
    }
  }
  return html;
}

test("Markdown links can't smuggle attributes or markup into the page", () => {
  const html = assertSafe("[x](https://x/(https://z/onmouseover=globalThis.pwned=1//)");
  assert.ok(!tags(html).some((t) => t.attrs.some((a) => a.name.startsWith("on"))));
  assertSafe('[a](https://x/"onmouseover="alert(1))');
  assertSafe("[`a/b.md`](https://x/`a/b.md`)");
  assertSafe("https://x/`src/a.ts` and [y](javascript:alert(1)) and <img src=x onerror=alert(1)>");
  assertSafe("**[x](https://a/**b**)** _https://z/_x_ `\u00000\u0000`");
  // Still renders what it should.
  assert.match(renderMarkdown("See [the plan](docs/plan.md) and https://example.com/a_b."), /data-file="docs\/plan\.md" data-line="">the plan<\/a> and <a href="https:\/\/example\.com\/a_b"/);
  assert.match(renderMarkdown("**bold `src/x.ts:12`**"), /<strong>bold <code><a href="#" class="file" data-file="src\/x\.ts" data-line="12">src\/x\.ts:12<\/a><\/code><\/strong>/);

  // Random mixes of the characters that matter.
  const pieces = ["[", "]", "(", ")", "](", "https://", "http://x/", "`", '"', "'", "<", ">", "&", "*", "**", "_", " ", "\n", "a/b.md", "x.ts:3", "onmouseover=alert(1)", "javascript:", "#", "\u0000", "=", "/", "|", "- ", "> ", "```", "&quot;"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 4000; n++) {
    let s = "";
    const len = 2 + Math.floor(rand() * 14);
    for (let k = 0; k < len; k++) s += pieces[Math.floor(rand() * pieces.length)];
    assertSafe(s);
  }
});

test("a Windows notification's text is data, never PowerShell code", () => {
  const body = "’ + $(Write-Output TORYO_PROBE) + ‘ and 'plain' quotes";
  const script = Buffer.from(toastCommand("It’s done", body), "base64").toString("utf16le");
  const empty = Buffer.from(toastCommand("", ""), "base64").toString("utf16le");
  assert.ok(!script.includes("TORYO_PROBE"));
  // The script is the same fixed text whatever the message; only the base64 data differs.
  const shape = (s) => s.replace(/FromBase64String\('[A-Za-z0-9+/=]*'\)/, "FromBase64String(DATA)");
  assert.equal(shape(script), shape(empty));
  const data = script.match(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/)[1];
  const xml = Buffer.from(data, "base64").toString("utf8");
  assert.match(xml, /<text>It’s done<\/text><text>’ \+ \$\(Write-Output TORYO_PROBE\) \+ ‘ and &apos;plain&apos; quotes<\/text>/);
});
