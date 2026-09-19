/**
 * The one relative-POSIX-path predicate the capture seam (DX-104), the contact
 * sheet (DX-105) and the wave-end banking step (DX-106) all read.
 * @purpose Single fail-closed predicate for "a relative, POSIX, non-escaping path", shared by the capture manifest's image paths, the contact sheet's image/receipt paths and a banked sheet-index entry's repo-relative path.
 * @status ACTIVE
 *
 * WHY IT IS ITS OWN LEAF MODULE. Three readers used to carry three hand-rolled
 * copies of this rule, and they drifted in BOTH directions: `lib/capture.mjs`
 * tested a `scheme://` regex, so `C:/ESCAPED/x.png` had no `://` to match and
 * validated clean, while `lib/contact-sheet-page.mjs` tested `scheme:` and
 * refused it — the same manifest accepted by one reader and refused by the
 * other, which is exactly what a fail-closed cross-seam guard may not do. This
 * file has NO imports, so any of the three (and `Tools/wave-end-gate-receipt.mjs`,
 * which sits a directory up) can import it without any possibility of an import
 * cycle; a shared home inside one of the three would have made
 * `contact-sheet-page.mjs` import the playwright-carrying capture module just to
 * ask whether a string has a backslash in it.
 *
 * WHY PERCENT-ESCAPES ARE REFUSED RATHER THAN DECODED-AND-ALLOWED. Node's `fs`
 * does not percent-decode, so `images/%2e%2e/%2e%2e/secret.png` lands in a
 * literal `%2e%2e` directory and escapes nothing on disk. A BROWSER does decode,
 * and the contact sheet's whole point is that the written directory is
 * self-contained and movable: `<img src="images/%2e%2e/%2e%2e/x.png">` resolves
 * outside the sheet the moment the page is opened. The escape is refused at the
 * validator rather than normalised, because a normaliser has to be right about
 * every encoding layer and a refusal only has to be right about one.
 *
 * @module relative-path
 */

/** Characters a percent-escape may not decode to, and why each one matters. */
const FORBIDDEN_ESCAPED_CHARACTERS = Object.freeze({
  ".": "a `..` segment the filesystem would not see but a browser would",
  "/": "a separator that changes the path's shape after decoding",
  "\\": "a Windows separator that changes the path's shape after decoding",
  "%": "a double-encoded escape whose second decode reaches one of the above",
});

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/g;
const MALFORMED_PERCENT = /%(?![0-9a-fA-F]{2})/;
const SCHEME_OR_DRIVE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// Scanned by code point rather than written as a character class: a literal
// control-character range is an eslint error (`no-control-regex`) precisely
// because it is usually a mistake, and here it is deliberate — a NUL or a
// newline in a path is a refusal, not a filename.
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
const DOTS_ONLY_SEGMENT = /^\.{2,}$/;

/**
 * Why `value` is not a relative POSIX path, or `null` when it is one.
 *
 * The rules, each of which some reader in this fleet once enforced alone:
 * a non-empty string; no backslash anywhere; no leading `/`; no `scheme:`
 * prefix (which refuses `https://…` AND `C:/…` with one clause — the drive
 * letter is why the clause tests `:` rather than `://`); no segment of two or
 * more dots; no control characters; and no percent-escape decoding to `.`,
 * `/`, `\` or `%`.
 *
 * @param {unknown} value The candidate path.
 * @returns {string|null} A one-line reason, or `null` when the path is sound.
 */
export function relativePosixPathViolation(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string";
  }
  if (value.includes("\\")) {
    return "must not contain a backslash — paths here are POSIX-separated";
  }
  if (value.startsWith("/")) {
    return "must be relative — a leading `/` is an absolute path";
  }
  if (SCHEME_OR_DRIVE.test(value)) {
    return "must not carry a `scheme:` or drive prefix — a url and a Windows drive path are both absolute";
  }
  if (hasControlCharacter(value)) {
    return "must not contain control characters";
  }
  for (const segment of value.split("/")) {
    if (DOTS_ONLY_SEGMENT.test(segment)) {
      return `must not contain the segment \`${segment}\` — it escapes the directory the path is resolved against`;
    }
  }
  if (MALFORMED_PERCENT.test(value)) {
    return "must not contain a malformed percent-escape";
  }
  for (const escape of value.match(PERCENT_ESCAPE) ?? []) {
    let decoded;
    try {
      decoded = decodeURIComponent(escape);
    } catch {
      return `must not contain the undecodable escape \`${escape}\``;
    }
    const why = FORBIDDEN_ESCAPED_CHARACTERS[decoded];
    if (why !== undefined) {
      return `must not contain the escape \`${escape}\`: it decodes to \`${decoded}\`, ${why}`;
    }
  }
  return null;
}

/**
 * Whether `value` is a relative, POSIX-separated, non-escaping path.
 *
 * @param {unknown} value The candidate path.
 * @returns {boolean} True when {@link relativePosixPathViolation} finds nothing.
 */
export function isRelativePosixPath(value) {
  return relativePosixPathViolation(value) === null;
}

export default { isRelativePosixPath, relativePosixPathViolation };
