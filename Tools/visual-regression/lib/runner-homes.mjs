/**
 * package.json runner scripts, with a lane's pending runner homes and script lines applied.
 * @purpose Loads the root package.json scripts and, when RUNNER_HOMES_FILE names a lane's RUNNERS_<LANE>.txt, applies the lane's declared `SCRIPT: <key>=<value>` replacements and then appends each `<script>=<spec>` home to its script, so a homing spec can be proven green before the seat makes the same package.json edits at landing.
 * @status ACTIVE
 *
 * package.json is seat-owned: a lane declares its package.json edits in
 * `RUNNERS_<LANE>.txt` and the seat makes them when it lands the patch:
 *   `<existing script key>=<spec path>`  appends the spec to that script;
 *   `SCRIPT: <existing script key>=<value>`  replaces that script verbatim;
 *   `RUN:` lines and `#` comments are for the reader.
 * A spec that asserts every spec has a home is therefore red on the lane's own
 * tree for exactly the specs the lane is homing. Pointing `RUNNER_HOMES_FILE` at
 * the lane's file applies the same edits the seat will make, and nothing else:
 * an unknown script key is an error, never a new script, and a SCRIPT value
 * carrying parentheses is prose and is refused.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Parse a RUNNERS_<LANE>.txt body into its `{ script, spec }` homes and its
 * `{ script, value }` SCRIPT replacements. Blank lines, `#` comments and the
 * `RUN:` line are neither.
 * @param {string} text
 * @returns {{ homes: { script: string, spec: string }[], scriptLines: { script: string, value: string }[] }}
 */
export function parseRunnerLines(text) {
  const homes = [];
  const scriptLines = [];
  for (const raw of text.split(/\r?\n/)) {
    // Matched on the raw line, as the seat's applier does: an indented
    // `SCRIPT:` is not one and falls through to the unreadable-line refusal.
    if (raw.startsWith("SCRIPT:")) {
      const body = raw.slice("SCRIPT:".length).trim();
      const eq = body.indexOf("=");
      if (eq <= 0) {
        throw new Error(`runner-homes: malformed SCRIPT line: ${raw}`);
      }
      const value = body.slice(eq + 1).trim();
      if (/[()]/.test(value)) {
        throw new Error(
          `runner-homes: SCRIPT value carries parentheses (prose, not a command): ${raw}`,
        );
      }
      scriptLines.push({ script: body.slice(0, eq).trim(), value });
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
 * Replace each named script verbatim, as the seat's landing does. The key must
 * already exist: a new script is a seat decision, not a lane's.
 * @param {Record<string, string>} scripts
 * @param {{ script: string, value: string }[]} scriptLines
 * @returns {Record<string, string>}
 */
export function applyScriptLines(scripts, scriptLines) {
  const result = { ...scripts };
  for (const { script, value } of scriptLines) {
    if (!Object.hasOwn(result, script)) {
      throw new Error(
        `runner-homes: SCRIPT line names script "${script}", which package.json does not declare (a new script is the seat's decision)`,
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
 * the SCRIPT replacements first, then the home appends. The seat edits the
 * scripts before it appends the runner tokens, and a home appended to a script
 * the same file also replaces belongs on the replaced value; the reverse order
 * would drop the appended token.
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
