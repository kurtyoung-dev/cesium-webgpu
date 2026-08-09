// probe-fleet-contract.mjs — the machine-checkable half of the probe authoring
// contract.
//
// WHY THIS EXISTS. The 2026-08-07 machine-safety sweep found that 11 of the 34
// probes added in `47a940eed9..a6d4b1763a` shipped with NO watchdog, 5 of them
// also closing the browser outside any `try/finally`. The rule was already
// written down in three places (the loop-review memory, `DEBUGGING_GUIDE`'s
// "Batch-744 probe rules", and CLAUDE.md's campaign block) and was still
// violated, because **nothing checked it at authoring time**. That sweep was
// manual, so its own filing recorded the residual honestly: "the next batch of
// probes can reintroduce it."
//
// This module is the source anchor that closes it. It reads probe SOURCE TEXT —
// it never launches anything — so the spec that consumes it runs under plain
// `node --test` with no browser, no network and no GPU.
//
// WHAT IS LOAD-BEARING, AND WHAT IS NOT. Playwright registers a process `exit`
// handler that reaps the browser, so a missing `finally` leaks nothing PAST
// process exit, and a `finally` cannot run while its own `try` body is
// suspended. **The watchdog is the load-bearing half**: it is the only construct
// that ends a probe that hangs. The `finally` is worth having for the
// throw-path, not the hang-path. Both are checked, but a reader triaging this
// list should fix watchdogs first.
//
// DETECTOR DISCIPLINE. Every predicate below is written to fail CLOSED: when the
// analyzer cannot understand a construct it reports the contract as ABSENT, so
// an exotic-but-correct probe lands in the allowlist (visible, one line, easily
// removed) rather than passing silently. A detector that cannot detect is the
// exact failure this repo has paid for repeatedly, which is why
// `probe-fleet-contract.spec.mjs` runs the analyzer against synthetic mutants
// before it runs it against the fleet.

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_MAY_FOLLOW = /[=(,:[!&|?{};+\-*%~^<>]$/;
/** Keywords after which a `/` opens a regex literal rather than dividing. */
const REGEX_MAY_FOLLOW_KEYWORD =
  /\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof)$/;

/**
 * Index of the `/` closing the regex literal opened at `open`, or -1 when the
 * run is not a regex literal after all (no close before end of line).
 *
 * @param {string} text Line-ending–normalized source.
 * @param {number} open Index of the opening slash.
 * @returns {number} Index of the closing slash, or -1.
 */
function regexLiteralEnd(text, open) {
  let i = open + 1;
  let inClass = false;
  const LIMIT = text.length + 1;
  let guard = 0;
  while (i < text.length && guard++ < LIMIT) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") {
      return -1;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "]") {
      inClass = false;
    } else if (c === "/" && !inClass) {
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Index of the quote closing the string literal opened at `open`, or -1.
 *
 * Template holes are skipped whole so a quote inside `${…}` cannot be mistaken
 * for the terminator.
 *
 * @param {string} text Line-ending–normalized source.
 * @param {number} open Index of the opening quote.
 * @returns {number} Index of the closing quote, or -1.
 */
function stringLiteralEnd(text, open) {
  const quote = text[open];
  let i = open + 1;
  let holeDepth = 0;
  const LIMIT = text.length + 1;
  let guard = 0;
  while (i < text.length && guard++ < LIMIT) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      holeDepth += 1;
      i += 2;
      continue;
    }
    if (quote === "`" && holeDepth > 0) {
      if (c === "}") {
        holeDepth -= 1;
      }
      i += 1;
      continue;
    }
    if (c === quote) {
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Template-hole interiors replaced by spaces, so a literal's PRINTED text can be
 * matched without the code inside `${…}` contributing tokens of its own.
 *
 * @param {string} content String-literal interior.
 * @returns {string} Same length, holes blanked.
 */
function blankTemplateHoles(content) {
  const out = content.split("");
  let i = 0;
  const LIMIT = content.length + 1;
  let guard = 0;
  while (i < content.length && guard++ < LIMIT) {
    if (content[i] === "$" && content[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      out[i] = " ";
      out[i + 1] = " ";
      let g2 = 0;
      while (j < content.length && depth > 0 && g2++ < LIMIT) {
        if (content[j] === "{") {
          depth += 1;
        } else if (content[j] === "}") {
          depth -= 1;
        }
        if (content[j] !== "\n") {
          out[j] = " ";
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * One pass over the source producing both views the analyzer needs: the CODE
 * view (comments, string interiors and regex bodies blanked) and the inventory
 * of string literals with their printed text.
 *
 * Regex bodies are blanked because they are neither code nor printed output,
 * and because a regex is allowed to contain an unpaired quote. Before this was
 * handled, one such regex — `/Destroyed texture \[Texture "GlobeDepth-DepthCopy/`
 * — put the scanner into string mode for the ENTIRE REMAINDER of its file, so
 * every construct below it (watchdog, close-in-finally, exit sites) read as
 * absent. A scanner that goes silently blind mid-file is exactly the kind of
 * instrument this spec exists to prevent.
 *
 * @param {string} source Raw file text.
 * @returns {{code: string, strings: Array<{start: number, end: number, content: string}>, endedInCode: boolean}} Both views plus the terminal scanner state.
 */
function scanSource(source) {
  const text = source.replaceAll("\r\n", "\n");
  const out = text.split("");
  const strings = [];
  /** Trailing code characters, used to tell a regex literal from a division. */
  let lastCode = "";
  const recordString = (start, end) => {
    strings.push({
      start,
      end,
      content: blankTemplateHoles(text.slice(start + 1, end)),
    });
  };
  let i = 0;
  let mode = "code";
  let quote = "";
  let templateDepth = 0;
  let stringStart = -1;
  const LIMIT = text.length + 1;
  let guard = 0;
  while (i < text.length && guard++ < LIMIT) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (
        c === "/" &&
        (lastCode === "" ||
          REGEX_MAY_FOLLOW.test(lastCode) ||
          REGEX_MAY_FOLLOW_KEYWORD.test(lastCode))
      ) {
        const end = regexLiteralEnd(text, i);
        if (end > i) {
          for (let j = i + 1; j < end; j++) {
            if (out[j] !== "\n") {
              out[j] = " ";
            }
          }
          lastCode = `${lastCode}x`.slice(-12);
          i = end + 1;
          continue;
        }
        // No terminator on this line: it was a division after all.
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "string";
        quote = c;
        templateDepth = 0;
        stringStart = i;
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) {
        lastCode = `${lastCode}${c}`.slice(-12);
      }
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        i += 1;
        continue;
      }
      out[i] = " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") {
        out[i] = " ";
      }
      i += 1;
      continue;
    }
    // mode === "string"
    if (c === "\\") {
      out[i] = " ";
      if (next !== undefined && next !== "\n") {
        out[i + 1] = " ";
      }
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && next === "{") {
      templateDepth += 1;
      i += 2;
      continue;
    }
    if (quote === "`" && templateDepth > 0) {
      // Hole interiors stay CODE (a probe can call a helper there), but a
      // string inside a hole is still printed text and is recorded as one.
      if (c === '"' || c === "'" || c === "`") {
        const end = stringLiteralEnd(text, i);
        if (end > i) {
          recordString(i, end);
          i = end + 1;
          continue;
        }
      }
      if (c === "}") {
        templateDepth -= 1;
      }
      i += 1;
      continue;
    }
    if (c === quote) {
      recordString(stringStart, i);
      mode = "code";
      quote = "";
      lastCode = `${lastCode}x`.slice(-12);
      i += 1;
      continue;
    }
    if (c !== "\n") {
      out[i] = " ";
    }
    i += 1;
  }
  return { code: out.join(""), strings, endedInCode: mode === "code" };
}

/**
 * Whether the scanner reached the end of the file still reading CODE.
 *
 * A file cannot legally end inside a string or a block comment, so a `false`
 * here means the scanner mistook something for an opening delimiter and blanked
 * every construct after it. That is not a cosmetic parse gripe: the analyzer
 * reports missing constructs as contract violations, so a blind scanner both
 * invents violations and hides real ones.
 *
 * @param {string} source Raw file text.
 * @returns {boolean} True when the scan closed cleanly.
 */
export function scanEndsInCode(source) {
  return scanSource(source).endedInCode;
}

/**
 * Line-ending–normalized source with line comments, block comments, regex
 * bodies and string literals blanked out (length-preserving, so offsets and
 * line numbers survive).
 *
 * Blanking strings matters: several probes print the word "structural" or
 * "watchdog" inside a `console.error` on an EXCEPTION path, and a naive text
 * scan reads those as contract constructs.
 *
 * @param {string} source Raw file text.
 * @returns {string} Same length, with comment/string/regex interiors replaced by spaces.
 */
export function blankNonCode(source) {
  return scanSource(source).code;
}

/**
 * Every string literal in the source, with its PRINTED text — template holes
 * blanked, and the strings nested inside those holes listed as literals of
 * their own. `console.log(\`x: ${ok ? "PASS" : "FAIL"}\`)` therefore yields the
 * "PASS" and "FAIL" literals, which is where the fleet actually spells its
 * verdicts.
 *
 * @param {string} source Raw file text.
 * @returns {Array<{start: number, end: number, content: string}>} Literal spans.
 */
export function stringLiteralSpans(source) {
  return scanSource(source).strings;
}

/**
 * Index of the `}` matching the `{` at `open`, or -1.
 *
 * @param {string} code Comment/string-blanked source.
 * @param {number} open Index of the opening brace.
 * @returns {number} Index of the matching close brace, or -1.
 */
export function matchBrace(code, open) {
  if (code[open] !== "{") {
    return -1;
  }
  let depth = 0;
  const LIMIT = code.length + 1;
  let guard = 0;
  for (let i = open; i < code.length && guard++ < LIMIT; i++) {
    if (code[i] === "{") {
      depth += 1;
    } else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Matches an exit that terminates the process with a code. */
const EXIT_CALL = /process\.exit(?:Code)?\s*(?:\(|=)/g;

/**
 * Every `process.exit(...)` / `process.exitCode = ...` in `code`, with the
 * expression text that supplies the code.
 *
 * The two forms differ in WHEN they take effect, which the verdict-exit rule
 * depends on: a call terminates at that point in the program, an assignment
 * sets the code the process will eventually leave with no matter where it sits.
 *
 * @param {string} code Comment/string-blanked source.
 * @returns {Array<{index: number, expression: string, form: string}>} Exit sites.
 */
export function findExitSites(code) {
  const sites = [];
  EXIT_CALL.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = EXIT_CALL.exec(code)) !== null && guard++ < 10000) {
    const isCall = code[m.index + m[0].length - 1] === "(";
    let expression;
    if (isCall) {
      let depth = 1;
      let j = m.index + m[0].length;
      let g2 = 0;
      while (j < code.length && g2++ < 100000) {
        if (code[j] === "(") {
          depth += 1;
        } else if (code[j] === ")") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
        j += 1;
      }
      expression = code.slice(m.index + m[0].length, j);
    } else {
      const end = code.indexOf(";", m.index);
      expression = code.slice(m.index + m[0].length, end < 0 ? undefined : end);
    }
    sites.push({
      index: m.index,
      expression: expression.trim(),
      form: isCall ? "call" : "assignment",
    });
  }
  return sites;
}

/** Printed text that announces a run FAILED. */
const VERDICT_FAIL = /\bFAIL(?:S|ED|URE|URES)?\b/;
/** Printed text that announces a run PASSED. */
const VERDICT_PASS = /\bPASS(?:ES|ED)?\b/;

/**
 * Whether an exit-code expression can evaluate to something other than 0.
 *
 * @param {string} expression Exit-code expression text.
 * @returns {boolean} True unless the code is the literal 0.
 */
function canBeNonZero(expression) {
  return expression.trim() !== "0";
}

/**
 * Ways a probe prints a PASS/FAIL verdict that no exit code can carry.
 *
 * A probe that announces FAIL and then leaves with status 0 is worse than one
 * that announces nothing: an orchestrator or CI loop reading exit codes records
 * it as GREEN, so the failure is not merely unattributed, it is inverted. The
 * rule keys on the PAIR: a lone "LOAD-FAIL"-style status column on a diagnostic
 * dump is not a verdict and is not required to carry an exit code, while a
 * source that prints both outcomes of a gate is one that has taken a position.
 *
 * Position matters as much as presence. An `exit(1)` on some early fatal branch
 * does not rescue a verdict printed below it, so the check demands a non-zero
 * exit REACHABLE FROM the last FAIL print — either an exit call after it, or a
 * `process.exitCode` assignment, which applies wherever it sits.
 *
 * @param {string} source Raw probe source text.
 * @returns {string[]} Violations, empty when the verdict is carried by an exit.
 */
export function verdictExitViolations(source) {
  const { code, strings } = scanSource(source);
  const fails = strings
    .filter((s) => VERDICT_FAIL.test(s.content))
    .sort((a, b) => a.start - b.start);
  const prints = strings.some((s) => VERDICT_PASS.test(s.content));
  if (fails.length === 0 || !prints) {
    return [];
  }
  const nonZero = findExitSites(code).filter((s) => canBeNonZero(s.expression));
  if (nonZero.length === 0) {
    return ["prints a PASS/FAIL verdict but no exit path can be non-zero"];
  }
  const lastFail = fails[fails.length - 1];
  const reachable = nonZero.some(
    (s) => s.form === "assignment" || s.index > lastFail.start,
  );
  if (!reachable) {
    return ["the last FAIL verdict print is followed by no non-zero exit"];
  }
  return [];
}

/** A `setTimeout` whose callback terminates the process is a watchdog. */
export function hasWatchdog(code) {
  let i = 0;
  let guard = 0;
  while (guard++ < 10000) {
    const k = code.indexOf("setTimeout", i);
    if (k < 0) {
      return false;
    }
    const open = code.indexOf("{", k);
    const paren = code.indexOf("(", k);
    // The callback body must start before the argument list closes; a
    // `setTimeout(resolve, 0)` has no brace-delimited body at all.
    if (open >= 0 && paren >= 0 && open - paren < 200) {
      const close = matchBrace(code, open);
      if (close > open) {
        const body = code.slice(open, close);
        if (/process\.exit(?:Code)?\s*(?:\(|=)/.test(body)) {
          return true;
        }
      }
    }
    i = k + 10;
  }
  return false;
}

/**
 * The identifier a Playwright browser was launched into, e.g. `browser` in
 * `const browser = await chromium.launch()`. Falls back to `browser`.
 *
 * @param {string} code Comment/string-blanked source.
 * @returns {string[]} Candidate browser identifiers.
 */
export function browserIdentifiers(code) {
  const names = new Set();
  const re =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.launch\s*\(/g;
  let m;
  let guard = 0;
  while ((m = re.exec(code)) !== null && guard++ < 1000) {
    names.add(m[1]);
  }
  const assign =
    /([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.launch\s*\(/g;
  guard = 0;
  while ((m = assign.exec(code)) !== null && guard++ < 1000) {
    names.add(m[1]);
  }
  if (names.size === 0) {
    names.add("browser");
  }
  return [...names];
}

/** Every `finally { ... }` block body in `code`. */
export function finallyBodies(code) {
  const bodies = [];
  let i = 0;
  let guard = 0;
  while (guard++ < 10000) {
    const k = code.indexOf("finally", i);
    if (k < 0) {
      break;
    }
    const before = code[k - 1];
    const after = code[k + 7];
    const isWord =
      (before === undefined || !/[\w$]/.test(before)) &&
      (after === undefined || !/[\w$]/.test(after));
    if (isWord) {
      const open = code.indexOf("{", k);
      const close = open >= 0 ? matchBrace(code, open) : -1;
      if (close > open) {
        bodies.push(code.slice(open, close + 1));
      }
    }
    i = k + 7;
  }
  return bodies;
}

/** Identifiers that mean "the lane could not see its subject". */
const STRUCTURAL_WORD =
  /\b(?:[a-z]\w*)?(?:structural|Structural|vacuou|Vacuou|blind|Blind|unreachable|Unreachable)\w*/;
/** Identifiers that mean "the harness broke", which legitimately exits 2. */
const EXCEPTION_WORD =
  /\b(?:fatal|err|error|caught|exception|thrown|threw|crash|timedOut|watchdog)\w*/i;

/**
 * Sites where a STRUCTURAL condition is routed to exit code 2.
 *
 * The 0/1/2/3 contract reserves 2 for "the harness broke" and 3 for "the lane
 * could not see its subject". Collapsing the second into the first is how a
 * blind lane gets read as a flaky run.
 *
 * @param {string} code Comment/string-blanked source.
 * @returns {number[]} Character offsets of offending exits.
 */
export function structuralRoutedToTwo(code) {
  const offenders = [];
  for (const site of findExitSites(code)) {
    const codeExpr = site.expression;
    // Ternary form: `structural ? 2 : ...`
    if (/\?\s*2\b/.test(codeExpr)) {
      const test = codeExpr.slice(0, codeExpr.indexOf("?"));
      if (STRUCTURAL_WORD.test(test) && !EXCEPTION_WORD.test(test)) {
        offenders.push(site.index);
      }
      continue;
    }
    if (!/^2$/.test(codeExpr.trim())) {
      continue;
    }
    // Literal `exit(2)`: find the INNERMOST `if (...) { ... }` whose body
    // actually contains this exit. A lookback window is not good enough — the
    // pinned weather probes route `if (structural.length) { ...exitCode = 3 }`
    // several hundred characters above an unrelated `process.exit(2)` on the
    // watchdog/catch path, and a window reads that as a violation.
    const enclosing = innermostGuard(code, site.index);
    if (
      enclosing !== null &&
      STRUCTURAL_WORD.test(enclosing) &&
      !EXCEPTION_WORD.test(enclosing)
    ) {
      offenders.push(site.index);
    }
  }
  return offenders;
}

/**
 * Condition of the innermost `if (...) { ... }` block containing `index`.
 *
 * @param {string} code Comment/string-blanked source.
 * @param {number} index Character offset inside the block.
 * @returns {string|null} The condition text, or null when unguarded.
 */
export function innermostGuard(code, index) {
  const re = /\bif\s*\(/g;
  let best = null;
  let bestSpan = Infinity;
  let m;
  let guard = 0;
  while ((m = re.exec(code)) !== null && guard++ < 20000) {
    if (m.index > index) {
      break;
    }
    let depth = 0;
    let j = m.index + m[0].length - 1;
    let g2 = 0;
    while (j < code.length && g2++ < 100000) {
      if (code[j] === "(") {
        depth += 1;
      } else if (code[j] === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      j += 1;
    }
    const condition = code.slice(m.index + m[0].length, j);
    const open = code.indexOf("{", j);
    if (open < 0) {
      continue;
    }
    // A brace far past the `)` belongs to some later construct, not this `if`.
    if (code.slice(j + 1, open).trim() !== "") {
      continue;
    }
    const close = matchBrace(code, open);
    if (close < 0 || index < open || index > close) {
      continue;
    }
    const span = close - open;
    if (span < bestSpan) {
      bestSpan = span;
      best = condition;
    }
  }
  return best;
}

/**
 * Whether the source reaches an exit code of 3 on a STRUCTURAL condition.
 *
 * Deliberately not a literal `exit(3)` scan. The fleet spells its structural
 * tier four different ways and a literal-only detector reads the probes that
 * DEFINE the contract as not implementing it:
 *   - `process.exit(3)` / `process.exitCode = structural ? 3 : 0` — the plain form;
 *   - `EXIT_CODE.STRUCTURAL` — `probe-celestial-gates.mjs`, symbol imported from
 *     `lib/celestial-g1-gate.mjs`, no literal 3 anywhere in the probe;
 *   - `return 3;` inside `if (structural.length > 0) { … }` with the value
 *     carried to `process.exit(code)` by the caller — `probe-cold-optics-hq.mjs`;
 *   - `laneBlind ? 3 : …` folded into a local before the exit —
 *     `probe-skybox-star-modulation.mjs`.
 *
 * A bare `return 3` with no structural guard is NOT counted: this predicate
 * anchors a verdict tier, and an anchor that accepts any literal 3 would keep
 * reporting the tier as present after it was deleted.
 *
 * @param {string} code Comment/string-blanked source.
 * @returns {boolean} True when a structural tier reaching code 3 exists.
 */
export function hasStructuralTier(code) {
  if (
    /\bSTRUCTURAL\b\s*[:=]\s*3\b/.test(code) ||
    /EXIT(?:_CODE)?\s*\.\s*STRUCTURAL/.test(code) ||
    /\bexitCode\s*:\s*3\b/.test(code)
  ) {
    return true;
  }
  if (findExitSites(code).some((s) => /\b3\b/.test(s.expression))) {
    return true;
  }
  const ternary = /([A-Za-z_$][\w$.[\]]*)\s*\?\s*3\s*:/g;
  let m;
  let guard = 0;
  while ((m = ternary.exec(code)) !== null && guard++ < 5000) {
    if (STRUCTURAL_WORD.test(m[1]) && !EXCEPTION_WORD.test(m[1])) {
      return true;
    }
  }
  const ret = /\breturn\s+3\s*;/g;
  guard = 0;
  while ((m = ret.exec(code)) !== null && guard++ < 5000) {
    const condition = innermostGuard(code, m.index);
    if (
      condition !== null &&
      STRUCTURAL_WORD.test(condition) &&
      !EXCEPTION_WORD.test(condition)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Analyze one probe's source against the authoring contract.
 *
 * `verdictExitViolations` is reported ALONGSIDE `violations` rather than inside
 * it. `violations` is what the shrink-only allowlist exempts, and that list
 * carries inherited machine-safety debt from before the contract was checkable;
 * a verdict that exits 0 has no such amnesty — the spec asserts it over the
 * whole fleet with no exemptions, so folding it in would hide it behind 560
 * allowlist rows.
 *
 * @param {string} source Raw probe source text.
 * @returns {{launchesBrowser: boolean, hasWatchdog: boolean, closesBrowser: boolean, closeInFinally: boolean, exitCodes: string[], declaresStructuralExit: boolean, structuralRoutedToTwo: number[], verdictExitViolations: string[], violations: string[]}} Analysis.
 */
export function analyzeProbeSource(source) {
  const code = blankNonCode(source);
  const launchesBrowser =
    /\.launch\s*\(/.test(code) || /from\s*\(?\s*["'`]playwright/.test(source);
  const watchdog = hasWatchdog(code);
  const names = browserIdentifiers(code);
  const closePattern = new RegExp(
    `(?:${names.map((n) => n.replace(/[$]/g, "\\$")).join("|")})\\s*\\.\\s*close\\s*\\(`,
  );
  const closesBrowser = closePattern.test(code);
  const closeInFinally = finallyBodies(code).some((b) => closePattern.test(b));
  const exitCodes = [...new Set(findExitSites(code).map((s) => s.expression))];
  const declaresStructuralExit = hasStructuralTier(code);
  const badTwo = structuralRoutedToTwo(code);

  const violations = [];
  if (launchesBrowser && !watchdog) {
    violations.push("no watchdog");
  }
  if (launchesBrowser && closesBrowser && !closeInFinally) {
    violations.push("browser.close outside finally");
  }
  if (launchesBrowser && !closesBrowser) {
    violations.push("never closes the browser");
  }
  if (declaresStructuralExit && badTwo.length > 0) {
    violations.push("structural routed to exit 2");
  }
  return {
    launchesBrowser,
    hasWatchdog: watchdog,
    closesBrowser,
    closeInFinally,
    exitCodes,
    declaresStructuralExit,
    structuralRoutedToTwo: badTwo,
    verdictExitViolations: verdictExitViolations(source),
    violations,
  };
}
