import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";

/**
 * The page Toryo serves, loaded into memory once, when the desk starts. Serving only that set means
 * the page always matches the server that's running, even while a build room edits web/ on disk.
 * Every file under web/ is included; nothing is listed by hand.
 */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Every file under `dir`, as URL paths ("/app.js") mapped to their bytes. */
function readTree(dir) {
  const files = new Map();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(`/${relative(dir, full).split(sep).join("/")}`, readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

/** One fingerprint for a set of files: names and contents. */
function fingerprint(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) hash.update(name).update("\0").update(files.get(name)).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/**
 * The local files a page file refers to: scripts, stylesheets, icons and images in HTML (any attribute
 * quoting: double, single or none), and the modules a script imports. A query string or fragment is
 * dropped, as the server ignores it too; remote addresses and in-page links aren't followed.
 */
function references(name, content) {
  const text = content.toString("utf8");
  const found = [];
  if (name.endsWith(".html"))
    for (const m of text.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) found.push(m[1] ?? m[2] ?? m[3]);
  if (/\.m?js$/.test(name))
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*\(?\s*["']([^"']+)["']/gm)) found.push(m[1] ?? m[2]);
  return found
    .map((ref) => ref.trim().split(/[?#]/)[0])
    .filter((ref) => ref && !/^[a-z][\w+.-]*:|^\/\//i.test(ref))
    .map((ref) => (ref.startsWith("/") ? posix.normalize(ref) : posix.normalize(posix.join(posix.dirname(name), ref))));
}

/**
 * Load the page from `dir`. Throws a plain explanation if index.html, or a file the page refers to,
 * is missing, so the desk refuses to start rather than serve a broken page.
 */
export function loadPage(dir) {
  let files;
  try {
    files = readTree(dir);
  } catch (error) {
    throw new Error(`Toryo can't read its page files in ${dir}: ${error.message}`);
  }
  if (!files.has("/index.html")) throw new Error(`Toryo's page is incomplete: ${join(dir, "index.html")} is missing.`);
  const missing = [];
  for (const [name, content] of files) for (const ref of references(name, content)) if (!files.has(ref)) missing.push(`${ref.slice(1)} (used by ${name.slice(1)})`);
  if (missing.length) throw new Error(`Toryo's page is incomplete. Missing in ${dir}: ${[...new Set(missing)].join(", ")}.`);
  const version = fingerprint(files);
  let disk = { at: 0, stamp: "", version };
  return {
    version,
    names: [...files.keys()].sort(),
    /** The file for a URL path ("/" is index.html), or null. */
    get(path) {
      const name = path === "/" ? "/index.html" : path;
      const body = files.get(name);
      return body ? { body, type: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream" } : null;
    },
    /** The fingerprint of what's on disk now, to tell when it differs from what's served. Re-read only when something changed. */
    onDisk() {
      if (Date.now() - disk.at < 1_000) return disk.version;
      let stamp = "";
      try {
        const walk = (folder) => {
          for (const entry of readdirSync(folder, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const full = join(folder, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
              const st = statSync(full);
              stamp += `${full}:${st.size}:${st.mtimeMs};`;
            }
          }
        };
        walk(dir);
        if (stamp !== disk.stamp) disk = { at: Date.now(), stamp, version: fingerprint(readTree(dir)) };
        else disk.at = Date.now();
      } catch {
        disk = { at: Date.now(), stamp: "", version: "unreadable" };
      }
      return disk.version;
    },
  };
}
