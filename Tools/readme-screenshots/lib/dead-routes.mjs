// dead-routes.mjs — the URLs a demo page still asks for that NOTHING serves any
// more, derived from the pages themselves and checked against the disk. Pure
// Node: no browser, no network, no GPU.
// @purpose Derives the legacy script URLs demo pages still request but nothing serves, and fulfils them with empty 200s so only real 404s stay fatal.
// @status ACTIVE
//
// THE DEFECT THIS REPLACES. `Apps/Sandcastle/gallery/*.html` still carries the
// three script tags the legacy Sandcastle app installed. Two of the three files
// were deleted with that app, so every one of those pages emits
//
//     Failed to load resource: the server responded with a status of 404
//
// The capture script's console gate is strict by design, so eighteen scenes
// that had rendered correctly — right boot state, right pixels — were rejected
// for that noise. The gate was not wrong; the page was. And the suppression
// that was supposed to cover it could never have worked: it matched the
// SCRIPT NAME against the message TEXT, and the text of a 404 does not contain
// the URL. Chromium carries the URL in the console message's LOCATION.
//
// WHY FULFILMENT AND NOT A WIDER SUPPRESSION. Suppressing "404" as a class
// would blind the run to a missing tileset, a missing model, a missing shader
// bundle — the failures a screenshot run most needs to see. Answering these
// specific URLs with an empty 200 means the 404 never happens: nothing to
// suppress, nothing to hide behind. Every OTHER 404 stays fatal.
//
// WHY THE LIST IS DERIVED AND NOT WRITTEN DOWN. A hard-coded list rots in both
// directions — it keeps routing a file that has come back (masking a real
// regression in it), and it misses the next tag a page grows. `scanPageReferences`
// reads the real `src`/`href` attributes out of the real pages, and
// `resolveDeadRoutes` keeps only the ones that are NOT on disk. Restore
// `Sandcastle-header.js` and it stops being routed, with no edit here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Content type served for a fulfilled dead route, by file extension. */
const CONTENT_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
});

/** Extensions worth routing at all; anything else is left to fail loudly. */
const ROUTABLE = Object.freeze(Object.keys(CONTENT_TYPES));

const REFERENCE_PATTERN = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
const CSS_IMPORT_PATTERN = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;

/**
 * Normalise a page-relative URL to a root-relative one.
 *
 * @param {string} pageDir POSIX directory of the referring page, repo-relative.
 * @param {string} reference The raw attribute value.
 * @returns {string|null} A root-relative URL, or null when it is not local.
 */
export function toRootRelative(pageDir, reference) {
  const url = reference.trim();
  if (url.length === 0 || /^(?:[a-z]+:|\/\/|#|\?)/i.test(url)) {
    return null;
  }
  if (url.startsWith("/")) {
    return url.split(/[?#]/)[0];
  }
  const segments = `${pageDir}/${url.split(/[?#]/)[0]}`.split("/");
  const stack = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

/**
 * Every local resource the given pages reference, root-relative and de-duped.
 *
 * `src`/`href` attributes and CSS `@import url(...)` are both read: the demo
 * pages pull their layout stylesheet through an inline `@import`, and a
 * stylesheet that stopped resolving would collapse the page's layout as surely
 * as a missing script would. Stylesheets that ARE on disk are then scanned in
 * turn, because the layout the demos depend on arrives through two levels of
 * `@import` — `bucket.css` imports the widgets stylesheets — and a break at the
 * second level is invisible from the page.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {string[]} pagePaths Repo-relative page paths (POSIX separators).
 * @returns {string[]} Root-relative URLs, sorted.
 */
export function scanPageReferences(repoRoot, pagePaths) {
  const found = new Set();
  const queue = pagePaths.map((rel) => rel.replaceAll("\\", "/"));
  const scanned = new Set();
  while (queue.length > 0) {
    const rel = queue.shift();
    if (scanned.has(rel)) {
      continue;
    }
    scanned.add(rel);
    const absolute = join(repoRoot, rel);
    if (!existsSync(absolute)) {
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    const dir = rel.split("/").slice(0, -1).join("/");
    for (const pattern of [REFERENCE_PATTERN, CSS_IMPORT_PATTERN]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const url = toRootRelative(dir, match[1]);
        if (url === null) {
          continue;
        }
        found.add(url);
        if (url.endsWith(".css")) {
          queue.push(url.replace(/^\//, ""));
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Keep only the references nothing on disk answers, with a content type each.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {string[]} urls Root-relative URLs, as produced by `scanPageReferences`.
 * @returns {{url: string, contentType: string}[]} Routes to fulfil, sorted.
 */
export function resolveDeadRoutes(repoRoot, urls) {
  const routes = [];
  for (const url of urls) {
    const extension = url.slice(url.lastIndexOf(".")).toLowerCase();
    if (!ROUTABLE.includes(extension)) {
      continue;
    }
    if (existsSync(join(repoRoot, url.replace(/^\//, "")))) {
      continue;
    }
    routes.push({ url, contentType: CONTENT_TYPES[extension] });
  }
  return routes.sort((a, b) => a.url.localeCompare(b.url));
}
