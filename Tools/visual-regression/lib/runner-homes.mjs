/**
 * package.json runner scripts, with a lane's pending runner homes applied.
 * @purpose Loads the root package.json scripts and, when RUNNER_HOMES_FILE names a lane's RUNNERS_<LANE>.txt, appends each declared `<script>=<spec>` home to its script, so a homing spec can be proven green before the seat appends the tokens at landing.
 * @status ACTIVE
 *
 * package.json is seat-owned: a lane declares new runner homes in
 * `RUNNERS_<LANE>.txt` (`<existing script key>=<spec path>` per line, plus a
 * `RUN:` line) and the seat appends the tokens when it lands the patch. A spec
 * that asserts every spec has a home is therefore red on the lane's own tree
 * for exactly the specs the lane is homing. Pointing `RUNNER_HOMES_FILE` at the
 * lane's file applies the same append the seat will make, and nothing else: an
 * unknown script key is an error, never a new script.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Parse a RUNNERS_<LANE>.txt body into `{ script, spec }` homes.
 * Blank lines, `#` comments and the `RUN:` line are not homes.
 * @param {string} text
 * @returns {{ script: string, spec: string }[]}
 */
export function parseRunnerHomes(text) {
  const homes = [];
  for (const raw of text.split(/\r?\n/)) {
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
  return homes;
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
 * The root package.json scripts, with `overlayFile`'s homes applied when given.
 * @param {{ root: string, overlayFile?: string }} options
 * @returns {{ scripts: Record<string, string>, homes: { script: string, spec: string }[] }}
 */
export function loadRunnerScripts({
  root,
  overlayFile = process.env.RUNNER_HOMES_FILE,
}) {
  const scripts =
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .scripts ?? {};
  if (!overlayFile) {
    return { scripts, homes: [] };
  }
  const homes = parseRunnerHomes(
    fs.readFileSync(path.resolve(root, overlayFile), "utf8"),
  );
  return { scripts: applyRunnerHomes(scripts, homes), homes };
}
