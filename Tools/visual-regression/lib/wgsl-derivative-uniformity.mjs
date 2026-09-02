// wgsl-derivative-uniformity.mjs — textual WGSL derivative-uniformity analysis.
//
// @purpose Reports implicit-derivative calls reached through non-uniform control flow without requiring a browser, GPU, or WGSL compiler.
// @status ACTIVE

// Implicit-derivative builtins. Explicit LOD, gradient, comparison-level, and
// load operations deliberately do not appear here.
const DERIVATIVE_BUILTINS = [
  "textureSample",
  "textureSampleBias",
  "textureSampleCompare",
  "dpdx",
  "dpdy",
  "dpdxFine",
  "dpdyFine",
  "dpdxCoarse",
  "dpdyCoarse",
  "fwidth",
  "fwidthFine",
  "fwidthCoarse",
];

const DERIVATIVE_SET = new Set(DERIVATIVE_BUILTINS);
const DERIVATIVE_CALL = new RegExp(
  `\\b(${DERIVATIVE_BUILTINS.join("|")})\\s*\\(`,
);
const IDENTIFIER = /^[A-Za-z_]\w*$/;

// The mutant spec changes this literal on an in-memory copy of this module.
// The fallback is the original line-oriented conditional-return analyzer.
const HARDENED_SHAPES = true;

function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  return withoutBlocks.split("\n").map((line) => {
    const marker = line.indexOf("//");
    return marker >= 0 ? line.slice(0, marker) : line;
  });
}

function braceDelta(line) {
  let delta = 0;
  for (let i = 0; i < line.length; ++i) {
    if (line[i] === "{") {
      delta++;
    } else if (line[i] === "}") {
      delta--;
    }
  }
  return delta;
}

function legacyDerivativeReachingFunctions(lines) {
  const bodies = new Map();
  for (let i = 0; i < lines.length; ++i) {
    const declaration = /^\s*fn\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
    if (!declaration) {
      continue;
    }

    let depth = 0;
    let opened = false;
    const body = [];
    for (let j = i; j < lines.length; ++j) {
      body.push(lines[j]);
      const before = depth;
      depth += braceDelta(lines[j]);
      if (!opened && depth > before) {
        opened = true;
      }
      if (opened && depth <= 0) {
        break;
      }
    }
    bodies.set(declaration[1], body.join("\n"));
  }

  const reaching = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (reaching.has(name)) {
        continue;
      }
      const direct = DERIVATIVE_CALL.test(body);
      const indirect = [...reaching].some((callee) =>
        new RegExp(`\\b${callee}\\s*\\(`).test(body),
      );
      if (direct || indirect) {
        reaching.add(name);
        grew = true;
      }
    }
  }
  return reaching;
}

function analyzeLegacy(source) {
  const lines = blankComments(source);
  const reaching = legacyDerivativeReachingFunctions(lines);
  const reachingCall =
    reaching.size > 0
      ? new RegExp(`\\b(${[...reaching].join("|")})\\s*\\(`)
      : null;
  const findings = [];

  for (let i = 0; i < lines.length; ++i) {
    if (!/^\s*@fragment\b/.test(lines[i])) {
      continue;
    }

    let depth = 0;
    let opened = false;
    let poisonedAt = 0;
    for (let j = i; j < lines.length; ++j) {
      const line = lines[j];

      if (poisonedAt > 0) {
        const direct = DERIVATIVE_CALL.exec(line);
        const indirect = reachingCall ? reachingCall.exec(line) : null;
        const hit = direct ?? indirect;
        if (hit) {
          findings.push({
            line: j + 1,
            symbol: hit[1],
            shape: "conditional-return",
            afterReturnOnLine: poisonedAt,
          });
        }
      }

      const before = depth;
      depth += braceDelta(line);
      if (!opened && depth > before) {
        opened = true;
      }
      if (/\breturn\b/.test(line) && Math.max(before, depth) > 1) {
        poisonedAt = j + 1;
      }
      if (opened && depth <= 0) {
        break;
      }
    }
  }

  return findings;
}

function tokenize(source) {
  const tokens = [];
  const tokenPattern =
    /[A-Za-z_]\w*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fihu]?|->|==|!=|<=|>=|&&|\|\||\+\+|--|<<|>>|[{}()[\],;:.<>@=+\-*/%!&|?]/g;

  for (const [lineIndex, line] of blankComments(source).entries()) {
    tokenPattern.lastIndex = 0;
    for (let match; (match = tokenPattern.exec(line));) {
      tokens.push({
        value: match[0],
        line: lineIndex + 1,
        column: match.index + 1,
      });
    }
  }
  return tokens;
}

function matchingToken(tokens, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; ++i) {
    if (tokens[i].value === open) {
      depth++;
    } else if (tokens[i].value === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function parseParameters(tokens, open, close) {
  const parameters = new Set();
  for (let i = open + 1; i < close; ++i) {
    if (
      tokens[i].value === ":" &&
      i > open + 1 &&
      IDENTIFIER.test(tokens[i - 1].value)
    ) {
      parameters.add(tokens[i - 1].value);
    }
  }
  return parameters;
}

function parseFunctions(tokens) {
  const functions = [];

  for (let i = 0; i < tokens.length; ++i) {
    if (
      tokens[i].value !== "fn" ||
      !tokens[i + 1] ||
      !IDENTIFIER.test(tokens[i + 1].value)
    ) {
      continue;
    }

    let parametersOpen = i + 2;
    while (
      parametersOpen < tokens.length &&
      tokens[parametersOpen].value !== "(" &&
      tokens[parametersOpen].value !== "{"
    ) {
      parametersOpen++;
    }
    if (tokens[parametersOpen]?.value !== "(") {
      continue;
    }

    const parametersClose = matchingToken(tokens, parametersOpen, "(", ")");
    if (parametersClose < 0) {
      continue;
    }

    let bodyOpen = parametersClose + 1;
    while (bodyOpen < tokens.length && tokens[bodyOpen].value !== "{") {
      bodyOpen++;
    }
    if (bodyOpen >= tokens.length) {
      continue;
    }

    const bodyClose = matchingToken(tokens, bodyOpen, "{", "}");
    if (bodyClose < 0) {
      continue;
    }

    functions.push({
      name: tokens[i + 1].value,
      declaration: i,
      bodyOpen,
      bodyClose,
      parameters: parseParameters(tokens, parametersOpen, parametersClose),
    });
    i = bodyClose;
  }

  return functions;
}

function decoratedVaryingNames(tokens) {
  const names = new Set();
  const varyingAttributes = new Set(["location", "builtin"]);

  for (let i = 0; i < tokens.length - 1; ++i) {
    if (
      tokens[i].value !== "@" ||
      !varyingAttributes.has(tokens[i + 1].value)
    ) {
      continue;
    }

    let cursor = i + 2;
    if (tokens[cursor]?.value === "(") {
      const close = matchingToken(tokens, cursor, "(", ")");
      if (close < 0) {
        continue;
      }
      cursor = close + 1;
    }

    while (cursor < tokens.length) {
      const value = tokens[cursor].value;
      if (["{", "}", ",", ";"].includes(value)) {
        break;
      }
      if (IDENTIFIER.test(value) && tokens[cursor + 1]?.value === ":") {
        names.add(value);
        break;
      }
      cursor++;
    }
  }

  return names;
}

function callsBuiltin(tokens, start, end, predicate) {
  for (let i = start; i < end; ++i) {
    if (
      IDENTIFIER.test(tokens[i].value) &&
      tokens[i + 1]?.value === "(" &&
      predicate(tokens[i].value)
    ) {
      return true;
    }
  }
  return false;
}

function reachingFunctions(tokens, functions, directPredicate) {
  const reaching = new Set();

  for (const fn of functions) {
    if (callsBuiltin(tokens, fn.bodyOpen + 1, fn.bodyClose, directPredicate)) {
      reaching.add(fn.name);
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const fn of functions) {
      if (reaching.has(fn.name)) {
        continue;
      }
      if (
        callsBuiltin(tokens, fn.bodyOpen + 1, fn.bodyClose, (symbol) =>
          reaching.has(symbol),
        )
      ) {
        reaching.add(fn.name);
        grew = true;
      }
    }
  }

  return reaching;
}

function collectControls(tokens, fn) {
  const ifs = [];
  const loops = [];
  const loopCounters = new Set();

  for (let i = fn.bodyOpen + 1; i < fn.bodyClose; ++i) {
    if (tokens[i].value === "if" && tokens[i + 1]?.value === "(") {
      const conditionClose = matchingToken(tokens, i + 1, "(", ")");
      const bodyOpen = conditionClose + 1;
      if (conditionClose > i && tokens[bodyOpen]?.value === "{") {
        const bodyClose = matchingToken(tokens, bodyOpen, "{", "}");
        if (bodyClose > bodyOpen) {
          const control = {
            open: bodyOpen,
            close: bodyClose,
            conditionStart: i + 2,
            conditionEnd: conditionClose,
            line: tokens[i].line,
            nonUniform: false,
          };
          ifs.push(control);

          if (
            tokens[bodyClose + 1]?.value === "else" &&
            tokens[bodyClose + 2]?.value === "{"
          ) {
            const elseOpen = bodyClose + 2;
            const elseClose = matchingToken(tokens, elseOpen, "{", "}");
            if (elseClose > elseOpen) {
              ifs.push({
                ...control,
                open: elseOpen,
                close: elseClose,
              });
            }
          }
        }
      }
    }

    if (
      (tokens[i].value === "for" || tokens[i].value === "while") &&
      tokens[i + 1]?.value === "("
    ) {
      const headerClose = matchingToken(tokens, i + 1, "(", ")");
      const bodyOpen = headerClose + 1;
      if (headerClose < 0 || tokens[bodyOpen]?.value !== "{") {
        continue;
      }
      const bodyClose = matchingToken(tokens, bodyOpen, "{", "}");
      if (bodyClose < 0) {
        continue;
      }

      loops.push({
        open: bodyOpen,
        close: bodyClose,
        line: tokens[i].line,
      });

      if (tokens[i].value === "for") {
        for (let j = i + 2; j < headerClose; ++j) {
          if (!["var", "let"].includes(tokens[j].value)) {
            continue;
          }
          for (let k = j + 1; k < headerClose; ++k) {
            if (
              IDENTIFIER.test(tokens[k].value) &&
              [":", "="].includes(tokens[k + 1]?.value)
            ) {
              loopCounters.add(tokens[k].value);
              break;
            }
            if (tokens[k].value === ";") {
              break;
            }
          }
        }
      }
    }

    if (tokens[i].value === "loop" && tokens[i + 1]?.value === "{") {
      const bodyClose = matchingToken(tokens, i + 1, "{", "}");
      if (bodyClose > i + 1) {
        loops.push({
          open: i + 1,
          close: bodyClose,
          line: tokens[i].line,
        });
      }
    }
  }

  return { ifs, loops, loopCounters };
}

function isInside(index, range) {
  return index > range.open && index < range.close;
}

function expressionEnd(tokens, start, limit) {
  let parentheses = 0;
  let brackets = 0;

  for (let i = start; i < limit; ++i) {
    const value = tokens[i].value;
    if (value === "(") {
      parentheses++;
    } else if (value === ")") {
      if (parentheses === 0) {
        return i;
      }
      parentheses--;
    } else if (value === "[") {
      brackets++;
    } else if (value === "]") {
      brackets--;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      [";", "{", "}"].includes(value)
    ) {
      return i;
    }
  }

  return limit;
}

function assignmentRecords(tokens, fn) {
  const records = [];

  for (let i = fn.bodyOpen + 1; i < fn.bodyClose; ++i) {
    if (["let", "var", "const"].includes(tokens[i].value)) {
      const end = expressionEnd(tokens, i + 1, fn.bodyClose);
      let equals = -1;
      let name = null;

      for (let j = i + 1; j < end; ++j) {
        if (tokens[j].value === "=") {
          equals = j;
          break;
        }
      }
      if (equals < 0) {
        continue;
      }

      for (let j = i + 1; j < equals; ++j) {
        if (
          IDENTIFIER.test(tokens[j].value) &&
          [":", "="].includes(tokens[j + 1]?.value)
        ) {
          name = tokens[j].value;
          break;
        }
      }
      if (!name && IDENTIFIER.test(tokens[equals - 1]?.value)) {
        name = tokens[equals - 1].value;
      }
      if (name) {
        records.push({
          name,
          index: i,
          rhsStart: equals + 1,
          rhsEnd: end,
        });
      }
      continue;
    }

    if (IDENTIFIER.test(tokens[i].value) && tokens[i + 1]?.value === "=") {
      records.push({
        name: tokens[i].value,
        index: i,
        rhsStart: i + 2,
        rhsEnd: expressionEnd(tokens, i + 2, fn.bodyClose),
      });
    }
  }

  return records;
}

function readsNonUniform(tokens, start, end, nonUniformNames, textureReaching) {
  for (let i = start; i < end; ++i) {
    const symbol = tokens[i].value;
    if (!IDENTIFIER.test(symbol)) {
      continue;
    }
    if (nonUniformNames.has(symbol)) {
      return true;
    }
    if (
      tokens[i + 1]?.value === "(" &&
      (symbol.startsWith("texture") || textureReaching.has(symbol))
    ) {
      return true;
    }
  }
  return false;
}

function classifyUniformity(
  tokens,
  fn,
  controls,
  varyingNames,
  textureReaching,
) {
  const nonUniformNames = new Set([
    ...fn.parameters,
    ...varyingNames,
    ...controls.loopCounters,
  ]);
  const assignments = assignmentRecords(tokens, fn);

  let grew = true;
  while (grew) {
    grew = false;

    for (const assignment of assignments) {
      if (nonUniformNames.has(assignment.name)) {
        continue;
      }

      const nonUniformRhs = readsNonUniform(
        tokens,
        assignment.rhsStart,
        assignment.rhsEnd,
        nonUniformNames,
        textureReaching,
      );
      const nonUniformControl = controls.ifs.some(
        (control) =>
          isInside(assignment.index, control) &&
          readsNonUniform(
            tokens,
            control.conditionStart,
            control.conditionEnd,
            nonUniformNames,
            textureReaching,
          ),
      );

      if (nonUniformRhs || nonUniformControl) {
        nonUniformNames.add(assignment.name);
        grew = true;
      }
    }
  }

  for (const control of controls.ifs) {
    control.nonUniform = readsNonUniform(
      tokens,
      control.conditionStart,
      control.conditionEnd,
      nonUniformNames,
      textureReaching,
    );
  }
}

function derivativeCalls(tokens, fn, derivativeReaching) {
  const calls = [];

  for (let i = fn.bodyOpen + 1; i < fn.bodyClose; ++i) {
    const symbol = tokens[i].value;
    if (
      tokens[i + 1]?.value === "(" &&
      (DERIVATIVE_SET.has(symbol) || derivativeReaching.has(symbol))
    ) {
      calls.push({
        index: i,
        line: tokens[i].line,
        symbol,
      });
    }
  }

  return calls;
}

function nestedBlockDepthAt(tokens, fn, index) {
  let depth = 0;
  for (let i = fn.bodyOpen + 1; i < index; ++i) {
    if (tokens[i].value === "{") {
      depth++;
    } else if (tokens[i].value === "}") {
      depth--;
    }
  }
  return depth;
}

function latestEventBefore(events, index, predicate = () => true) {
  let latest = null;
  for (const event of events) {
    if (
      event.endIndex < index &&
      predicate(event) &&
      (!latest || event.tokenIndex > latest.tokenIndex)
    ) {
      latest = event;
    }
  }
  return latest;
}

function analyzeHardened(source) {
  const tokens = tokenize(source);
  const functions = parseFunctions(tokens);
  const varyingNames = decoratedVaryingNames(tokens);
  const derivativeReaching = reachingFunctions(tokens, functions, (symbol) =>
    DERIVATIVE_SET.has(symbol),
  );
  const textureReaching = reachingFunctions(tokens, functions, (symbol) =>
    symbol.startsWith("texture"),
  );
  const findings = [];
  const seen = new Set();

  function entryStage(fn) {
    let boundary = fn.declaration - 1;
    while (boundary >= 0 && ![";", "{", "}"].includes(tokens[boundary].value)) {
      boundary--;
    }

    for (let i = boundary + 1; i + 1 < fn.declaration; ++i) {
      if (
        tokens[i].value === "@" &&
        ["fragment", "vertex", "compute"].includes(tokens[i + 1].value)
      ) {
        return tokens[i + 1].value;
      }
    }

    return null;
  }

  const functionByName = new Map(functions.map((fn) => [fn.name, fn]));
  const stagedFunctions = functions
    .map((fn) => ({ fn, stage: entryStage(fn) }))
    .filter(({ stage }) => stage !== null);
  const inScope = new Set();

  if (stagedFunctions.length === 0) {
    for (const fn of functions) {
      inScope.add(fn.name);
    }
  } else {
    const pending = [];
    for (const { fn, stage } of stagedFunctions) {
      if (stage === "fragment") {
        inScope.add(fn.name);
        pending.push(fn.name);
      }
    }

    for (let cursor = 0; cursor < pending.length; ++cursor) {
      const caller = functionByName.get(pending[cursor]);
      for (let i = caller.bodyOpen + 1; i < caller.bodyClose; ++i) {
        const callee = tokens[i].value;
        if (
          tokens[i + 1]?.value !== "(" ||
          !functionByName.has(callee) ||
          inScope.has(callee)
        ) {
          continue;
        }
        inScope.add(callee);
        pending.push(callee);
      }
    }
  }

  function report(call, shape, details) {
    const key = `${call.index}:${shape}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push({
      line: call.line,
      symbol: call.symbol,
      shape,
      ...details,
      _index: call.index,
    });
  }

  for (const fn of functions) {
    if (!inScope.has(fn.name)) {
      continue;
    }

    const controls = collectControls(tokens, fn);
    classifyUniformity(tokens, fn, controls, varyingNames, textureReaching);

    const returns = [];
    const breaks = [];
    const continues = [];

    for (let i = fn.bodyOpen + 1; i < fn.bodyClose; ++i) {
      const value = tokens[i].value;

      if (value === "return" && nestedBlockDepthAt(tokens, fn, i) > 0) {
        returns.push({
          tokenIndex: i,
          endIndex: expressionEnd(tokens, i + 1, fn.bodyClose),
          line: tokens[i].line,
        });
      }

      if (!["break", "continue"].includes(value)) {
        continue;
      }

      const containingIf = controls.ifs.some((control) => isInside(i, control));
      const containingLoops = controls.loops
        .filter((loop) => isInside(i, loop))
        .sort((left, right) => right.open - left.open);

      if (!containingIf || containingLoops.length === 0) {
        continue;
      }

      const event = {
        tokenIndex: i,
        endIndex: expressionEnd(tokens, i + 1, fn.bodyClose),
        line: tokens[i].line,
        loop: containingLoops[0],
      };
      if (value === "break") {
        breaks.push(event);
      } else {
        continues.push(event);
      }
    }

    for (const call of derivativeCalls(tokens, fn, derivativeReaching)) {
      const afterReturn = latestEventBefore(returns, call.index);
      if (afterReturn) {
        report(call, "conditional-return", {
          afterReturnOnLine: afterReturn.line,
        });
      }

      const afterBreak = latestEventBefore(breaks, call.index, (event) =>
        isInside(call.index, event.loop),
      );
      if (afterBreak) {
        report(call, "conditional-break", {
          afterBreakOnLine: afterBreak.line,
        });
      }

      const afterContinue = latestEventBefore(continues, call.index, (event) =>
        isInside(call.index, event.loop),
      );
      if (afterContinue) {
        report(call, "conditional-continue", {
          afterContinueOnLine: afterContinue.line,
        });
      }

      const enclosingNonUniformIf = controls.ifs
        .filter(
          (control) => control.nonUniform && isInside(call.index, control),
        )
        .sort((left, right) => right.open - left.open)[0];
      if (enclosingNonUniformIf) {
        report(call, "non-uniform-if", {
          insideIfOnLine: enclosingNonUniformIf.line,
        });
      }
    }
  }

  return findings
    .sort(
      (left, right) =>
        left._index - right._index || left.shape.localeCompare(right.shape),
    )
    .map(({ _index, ...finding }) => finding);
}

/**
 * Reports implicit-derivative calls, including calls through helper functions,
 * reached after a conditional exit or from within a non-uniform conditional.
 *
 * The legacy conditional-return fields remain stable. Hardened findings also
 * carry one of these shape names:
 *
 * - conditional-return
 * - conditional-break
 * - conditional-continue
 * - non-uniform-if
 *
 * @param {string} source WGSL source text.
 * @returns {Array<{
 *   line:number,
 *   symbol:string,
 *   shape:string,
 *   afterReturnOnLine?:number,
 *   afterBreakOnLine?:number,
 *   afterContinueOnLine?:number,
 *   insideIfOnLine?:number
 * }>} findings
 */
export function analyze(source) {
  return HARDENED_SHAPES ? analyzeHardened(source) : analyzeLegacy(source);
}
