// A small, safe Markdown renderer for agent messages. Everything is escaped
// first; file paths become links that open Toryo's file viewer.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const unesc = (s) =>
  String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

const PATH = /^\/?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z][\w]{0,7}(?::\d+(?:-\d+)?)?$|^[\w@+-]+\.(?:md|mdx|ts|tsx|js|mjs|cjs|json|py|css|html|yml|yaml|toml|sql|sh|txt)(?::\d+(?:-\d+)?)?$/;

function fileLink(raw, label) {
  const plain = unesc(raw);
  const m = plain.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/);
  return `<a href="#" class="file" data-file="${esc(m[1])}" data-line="${m[2] ?? ""}">${label}</a>`;
}

// Inline Markdown works on escaped text. Each piece of HTML it generates is
// held aside behind a placeholder, so no later replacement can reach into a
// tag or an attribute; the pieces go back in at the very end.
function inline(src) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  const emphasis = (s) =>
    s
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");
  let t = esc(String(src ?? "").replace(/\u0000/g, ""));
  t = t.replace(/`([^`\n]+)`/g, (_, c) => hold(PATH.test(unesc(c)) ? `<code>${fileLink(c, c)}</code>` : `<code>${c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s\u0000]+)\)/g, (_, label, url) => {
    const u = unesc(url);
    if (/^https?:\/\//i.test(u)) return hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`);
    if (/^[a-z][\w+.-]*:/i.test(u)) return label;
    return hold(fileLink(url.replace(/^\.\//, ""), emphasis(label)));
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)"\u0000]+[^\s<)".,;:\u0000])/g, (_, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  t = t.replace(
    /(^|[\s(])(\/?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z]\w{0,7}(?::\d+(?:-\d+)?)?)(?=[\s),.;:!?]|$)/g,
    (_, pre, p) => pre + hold(fileLink(p, p)),
  );
  t = emphasis(t);
  const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, n) => restore(held[Number(n)]));
  return restore(t);
}

const BLOCK = /^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s+|\|)/;

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+.-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : "";
      html += `<pre class="code"${lang}><code>${esc(buf.join("\n"))}</code></pre>`;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = Math.min(6, h[1].length + 2);
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html += "<hr>";
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      let body = "";
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
        i++;
      }
      html += `<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html += `<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const r = renderList(lines, i);
      html += r.html;
      i = r.next;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`;
  }
  return html;
}

function renderList(lines, i) {
  const items = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), text: m[3] });
      i++;
      continue;
    }
    if (!l.trim()) {
      if (i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) {
        i++;
        continue;
      }
      break;
    }
    if (items.length && (/^\s{2,}/.test(l) || !BLOCK.test(l))) {
      items[items.length - 1].text += "\n" + l.trim();
      i++;
      continue;
    }
    break;
  }
  let out = "";
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? "ol" : "ul";
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      out += `<${tag}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) out += `</li></${stack.pop().tag}>`;
      out += "</li>";
    }
    const task = it.text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
    out += task
      ? `<li class="task"><span class="box" data-done="${task[1] !== " "}"></span>${inline(task[2]).replace(/\n/g, "<br>")}`
      : `<li>${inline(it.text).replace(/\n/g, "<br>")}`;
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return { html: out, next: i };
}

export { esc };
