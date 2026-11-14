/**
 * Counts of named console lines over every console line of a page.
 * @purpose Pure counter for probe-landing-cells.mjs: given every console line and page error a page logged and the cell's list of named `{name, text}` patterns, the total line count and, per pattern, how many lines contain its text (case-sensitive substring of the whole text, never a truncated slice), split by line type, with the sequence number and the first 300 characters of the first match; a pattern list that is malformed (a repeated or empty name, an empty text, any other key such as a regex) is a violation list and the counter throws a TypeError on it. The record is `record.consoleLines`, written only for a cell that declares `consoleLines`.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. A forced-loss page logs about ninety lines and the page
 * record's `console` field keeps the first ten errors, so "no line says the
 * cloud march pipeline failed" could not be read from a report. This counts
 * over ALL the lines the probe collected, which it attaches without a cap.
 *
 * @module Tools/visual-regression/lib/console-named-lines
 */

/** Characters of the first matching line the record keeps. */
export const FIRST_MATCH_CHARS = 300;

const SPEC_KEYS = Object.freeze(["name", "text"]);

/**
 * What is wrong with a list of named line specs. Pure.
 *
 * @param {unknown} specs A list of `{name, text}`.
 * @returns {string[]} One string per violation; empty when the list is valid.
 */
export function consoleLineSpecViolations(specs) {
  if (!Array.isArray(specs)) {
    return ["the specs are not a list"];
  }
  const violations = [];
  const seen = new Set();
  specs.forEach((spec, index) => {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      violations.push(`spec ${index} is not an object`);
      return;
    }
    for (const key of Object.keys(spec)) {
      if (!SPEC_KEYS.includes(key)) {
        violations.push(
          `spec ${index} has the key ${JSON.stringify(key)}; a spec is {name, text} only`,
        );
      }
    }
    if (typeof spec.name !== "string" || spec.name.length === 0) {
      violations.push(`spec ${index} has no name`);
    } else if (seen.has(spec.name)) {
      violations.push(`spec ${index} repeats the name ${spec.name}`);
    } else {
      seen.add(spec.name);
    }
    if (typeof spec.text !== "string" || spec.text.length === 0) {
      violations.push(`spec ${index} has no text`);
    }
  });
  return violations;
}

/**
 * Count the lines that contain each named text. Pure.
 *
 * @param {Array<{seq?: number, type: string, text: unknown}>} lines Every
 *   console line and page error the page logged (`type` "pageerror" for the
 *   latter).
 * @param {Array<{name: string, text: string}>} specs
 * @returns {{totalLines: number, byType: Record<string, number>,
 *   patterns: Array<{name: string, text: string, count: number,
 *   byType: Record<string, number>, firstSeq: number|null,
 *   first: string|null}>}}
 * @throws {TypeError} When the specs have a violation.
 */
export function countNamedConsoleLines(lines, specs) {
  const violations = consoleLineSpecViolations(specs);
  if (violations.length > 0) {
    throw new TypeError(`consoleLines: ${violations.join("; ")}`);
  }
  const all = Array.isArray(lines) ? lines : [];
  const byType = {};
  const patterns = specs.map((spec) => ({
    name: spec.name,
    text: spec.text,
    count: 0,
    byType: {},
    firstSeq: null,
    first: null,
  }));
  for (const line of all) {
    const type = String(line?.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;
    const text = String(line?.text ?? "");
    patterns.forEach((pattern) => {
      if (!text.includes(pattern.text)) {
        return;
      }
      pattern.count++;
      pattern.byType[type] = (pattern.byType[type] ?? 0) + 1;
      if (pattern.first === null) {
        pattern.firstSeq = Number.isFinite(line?.seq) ? line.seq : null;
        pattern.first = text.slice(0, FIRST_MATCH_CHARS);
      }
    });
  }
  return { totalLines: all.length, byType, patterns };
}
