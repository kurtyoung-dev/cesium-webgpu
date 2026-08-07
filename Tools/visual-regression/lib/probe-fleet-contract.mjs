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

/**
 * Line-ending–normalized source with line comments, block comments and string
 * literals blanked out (length-preserving, so offsets and line numbers survive).
 *
 * Blanking strings matters: several probes print the word "structural" or
 * "watchdog" inside a `console.error` on an EXCEPTION path, and a naive text
 * scan reads those as contract constructs.
 *
 * @param {string} source Raw file text.
 * @returns {string} Same length, with comment/string interiors replaced by spaces.
 */
export function blankNonCode(source) {
  const text = source.replaceAll("\r\n", "\n");
  const out = text.split("");
  let i = 0;
  let mode = "code";
  let quote = "";
  let templateDepth = 0;
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
      if (c === '"' || c === "'" || c === "`") {
        mode = "string";
        quote = c;
        templateDepth = 0;
        i += 1;
        continue;
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
      if (c === "}") {
        templateDepth -= 1;
      }
      i += 1;
      continue;
    }
    if (c === quote) {
      mode = "code";
      quote = "";
      i += 1;
      continue;
    }
    if (c !== "\n") {
      out[i] = " ";
    }
    i += 1;
  }
  return out.join("");
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
 * @param {string} code Comment/string-blanked source.
 * @returns {Array<{index: number, expression: string}>} Exit sites.
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
    sites.push({ index: m.index, expression: expression.trim() });
  }
  return sites;
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
 * @param {string} source Raw probe source text.
 * @returns {{launchesBrowser: boolean, hasWatchdog: boolean, closesBrowser: boolean, closeInFinally: boolean, exitCodes: string[], declaresStructuralExit: boolean, structuralRoutedToTwo: number[], violations: string[]}} Analysis.
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
    violations,
  };
}
