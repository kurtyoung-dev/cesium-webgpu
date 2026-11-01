/**
 * package.json runner scripts, with a lane's pending runner homes and script lines applied.
 * @purpose Loads the root package.json scripts and, when RUNNER_HOMES_FILE names a lane's RUNNERS_<LANE>.txt, applies the lane's declared `SCRIPT NEW: <key>=<value>` additions, then its `SCRIPT: <key>=<value>` replacements, then appends each `<script>=<spec>` home to its script, so a homing spec can be proven green before the seat makes the same package.json edits at landing.
 * @status ACTIVE
 *
 * package.json is seat-owned: a lane declares its package.json edits in
 * `RUNNERS_<LANE>.txt` and the seat makes them when it lands the patch:
 *   `<existing script key>=<spec path>`  appends the spec to that script;
 *   `SCRIPT: <existing script key>=<value>`  replaces that script verbatim;
 *   `SCRIPT NEW: <new script key>=<value>`  adds a script package.json does not
 *     declare yet (refused when the key already exists);
 *   `RUN:` lines and `#` comments are for the reader.
 * A spec that asserts every spec has a home is therefore red on the lane's own
 * tree for exactly the specs the lane is homing. Pointing `RUNNER_HOMES_FILE` at
 * the lane's file applies the same edits the seat will make, and nothing else:
 * an unknown key on a `SCRIPT:` or home line is an error (the typo guard), a new
 * script is only ever minted by an explicit `SCRIPT NEW:` line, and a SCRIPT or
 * SCRIPT NEW value carrying parentheses is prose and is refused. The edits apply
 * in the order new keys, replacements, home appends, so a home may target a new
 * key and a replacement may shorten the script a moved spec leaves.
 */
import fs from "node:fs";
import path from "node:path";

/** One `SCRIPT:` or `SCRIPT NEW:` line (`label` is the text before its colon) as a script line. */
function parseScriptLine(raw, label) {
  const body = raw.slice(label.length + 1).trim();
  const eq = body.indexOf("=");
  if (eq <= 0) {
    throw new Error(`runner-homes: malformed ${label} line: ${raw}`);
  }
  const value = body.slice(eq + 1).trim();
  if (value === "") {
    throw new Error(`runner-homes: empty ${label} value: ${raw}`);
  }
  if (/[()]/.test(value)) {
    throw new Error(
      `runner-homes: ${label} value carries parentheses (prose, not a command): ${raw}`,
    );
  }
  const script = body.slice(0, eq).trim();
  return label === "SCRIPT NEW"
    ? { script, value, isNew: true }
    : { script, value };
}

/**
 * Parse a RUNNERS_<LANE>.txt body into its `{ script, spec }` homes and its
 * `{ script, value }` script lines. A `SCRIPT:` line is a replacement; a
 * `SCRIPT NEW:` line is the same pair tagged `isNew: true`, so the entries a
 * caller reads for replacements keep their shape. Blank lines, `#` comments
 * and the `RUN:` line are neither.
 * @param {string} text
 * @returns {{ homes: { script: string, spec: string }[], scriptLines: { script: string, value: string, isNew?: true }[] }}
 */
export function parseRunnerLines(text) {
  const homes = [];
  const scriptLines = [];
  for (const raw of text.split(/\r?\n/)) {
    // Matched on the raw line, as the seat's applier does: an indented
    // `SCRIPT:` is not one and falls through to the unreadable-line refusal.
    if (raw.startsWith("SCRIPT NEW:")) {
      scriptLines.push(parseScriptLine(raw, "SCRIPT NEW"));
      continue;
    }
    if (raw.startsWith("SCRIPT:")) {
      scriptLines.push(parseScriptLine(raw, "SCRIPT"));
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("RUN:")) {
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9:._-]*)=(\S+)$/.exec(line);
    if (!match) {
      throw new Error(`runner-homes: unreadable home line: ${line}`);
    }
    homes.push({ script: match[1], spec: match[2] });
  }
  return { homes, scriptLines };
}

/**
 * Parse a RUNNERS_<LANE>.txt body into `{ script, spec }` homes. Kept as the
 * homes-only view so existing callers read the same array; SCRIPT lines are
 * validated (a malformed one still throws) but are read through
 * `parseRunnerLines`.
 * @param {string} text
 * @returns {{ script: string, spec: string }[]}
 */
export function parseRunnerHomes(text) {
  return parseRunnerLines(text).homes;
}

/**
 * Add each `SCRIPT NEW:` script, then replace each `SCRIPT:` script verbatim,
 * as the seat's landing does. A replacement's key must already exist (a typo
 * must not mint a script), counting a key a NEW line of the same file added; a
 * NEW line's key must not exist yet.
 * @param {Record<string, string>} scripts
 * @param {{ script: string, value: string, isNew?: true }[]} scriptLines
 * @returns {Record<string, string>}
 */
export function applyScriptLines(scripts, scriptLines) {
  const result = { ...scripts };
  for (const { script, value } of scriptLines.filter((line) => line.isNew)) {
    if (Object.hasOwn(result, script)) {
      throw new Error(
        `runner-homes: SCRIPT NEW line names script "${script}", which already exists (use SCRIPT: to replace it)`,
      );
    }
    result[script] = value;
  }
  for (const { script, value } of scriptLines.filter((line) => !line.isNew)) {
    if (!Object.hasOwn(result, script)) {
      throw new Error(
        `runner-homes: SCRIPT line names script "${script}", which package.json does not declare (a new script needs a SCRIPT NEW: line)`,
      );
    }
    result[script] = value;
  }
  return result;
}

/**
 * Append each home's spec to its script, as the seat does at landing.
 * @param {Record<string, string>} scripts
 * @param {{ script: string, spec: string }[]} homes
 * @returns {Record<string, string>}
 */
export function applyRunnerHomes(scripts, homes) {
  const result = { ...scripts };
  for (const { script, spec } of homes) {
    if (typeof result[script] !== "string") {
      throw new Error(
        `runner-homes: ${spec} names script "${script}", which package.json does not declare`,
      );
    }
    result[script] = `${result[script]} ${spec}`;
  }
  return result;
}

/**
 * The root package.json scripts, with `overlayFile`'s edits applied when given:
 * the SCRIPT NEW additions and SCRIPT replacements first, then the home appends.
 * The seat edits the scripts before it appends the runner tokens, and a home
 * appended to a script the same file also adds or replaces belongs on that
 * value; the reverse order would drop the appended token or find no script.
 * @param {{ root: string, overlayFile?: string }} options
 * @returns {{ scripts: Record<string, string>, homes: { script: string, spec: string }[], scriptLines: { script: string, value: string }[] }}
 */
export function loadRunnerScripts({
  root,
  overlayFile = process.env.RUNNER_HOMES_FILE,
}) {
  const scripts =
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .scripts ?? {};
  if (!overlayFile) {
    return { scripts, homes: [], scriptLines: [] };
  }
  const { homes, scriptLines } = parseRunnerLines(
    fs.readFileSync(path.resolve(root, overlayFile), "utf8"),
  );
  return {
    scripts: applyRunnerHomes(applyScriptLines(scripts, scriptLines), homes),
    homes,
    scriptLines,
  };
}
