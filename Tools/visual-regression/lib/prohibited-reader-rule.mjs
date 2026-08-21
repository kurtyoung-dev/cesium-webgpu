// @purpose Detect drawImage calls that copy a live scene canvas into a scratch context.
// @status ACTIVE

const LIVE_CANVAS = 1;
const SCENE_OR_VIEWER = 2;
const DOM_LIVE_CANVAS_METHODS = new Set([
  "getElementById",
  "getElementsByTagName",
  "querySelector",
]);
const MULTI_CHARACTER_PUNCTUATORS = [
  ">>>=",
  "&&=",
  "**=",
  "...",
  "??=",
  "||=",
  "===",
  "!==",
  ">>>",
  "<<=",
  ">>=",
  "**",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "&&",
  "||",
  "??",
  "?.",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
];

export function analyzeProhibitedReader(sourceText) {
  const tokens = [];
  const templateBodies = [];
  let index = 0;
  let line = 1;

  const advanceLine = () => {
    if (sourceText[index] === "\r" && sourceText[index + 1] === "\n") {
      index++;
    }
    index++;
    line++;
  };

  const isIdentifierStart = (character) =>
    character !== undefined && /[$A-Z_a-z\u0080-\uFFFF]/u.test(character);
  const isIdentifierPart = (character) =>
    character !== undefined && /[$0-9A-Z_a-z\u0080-\uFFFF]/u.test(character);
  const regexCanFollow = (previous) =>
    previous === undefined ||
    [
      "!",
      "!=",
      "!==",
      "%",
      "%=",
      "&",
      "&&",
      "&&=",
      "(",
      "*",
      "**",
      "**=",
      "*=",
      "+",
      "+=",
      ",",
      "-",
      "-=",
      "/",
      "/=",
      ":",
      ";",
      "<",
      "<<",
      "<<=",
      "<=",
      "=",
      "==",
      "===",
      "=>",
      ">",
      ">=",
      ">>",
      ">>=",
      ">>>",
      ">>>=",
      "?",
      "??",
      "??=",
      "[",
      "^",
      "^=",
      "{",
      "|",
      "|=",
      "||",
      "||=",
      "~",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ].includes(previous.value);

  const pushToken = (type, value, tokenLine) => {
    tokens.push({ line: tokenLine, type, value });
  };

  try {
    while (index < sourceText.length) {
      const character = sourceText[index];
      if (character === "\r" || character === "\n") {
        advanceLine();
        continue;
      }
      if (/\s/u.test(character)) {
        index++;
        continue;
      }
      if (sourceText.startsWith("//", index)) {
        index += 2;
        while (
          index < sourceText.length &&
          sourceText[index] !== "\r" &&
          sourceText[index] !== "\n"
        ) {
          index++;
        }
        continue;
      }
      if (sourceText.startsWith("/*", index)) {
        index += 2;
        while (
          index < sourceText.length &&
          !sourceText.startsWith("*/", index)
        ) {
          if (sourceText[index] === "\r" || sourceText[index] === "\n") {
            advanceLine();
          } else {
            index++;
          }
        }
        if (index >= sourceText.length) {
          throw new SyntaxError("unterminated block comment");
        }
        index += 2;
        continue;
      }
      if (character === '"' || character === "'") {
        const tokenLine = line;
        const quote = character;
        let value = "";
        index++;
        let closed = false;
        while (index < sourceText.length) {
          const current = sourceText[index];
          if (current === quote) {
            index++;
            closed = true;
            break;
          }
          if (current === "\\") {
            index++;
            if (index < sourceText.length) {
              value += sourceText[index];
              index++;
            }
            continue;
          }
          if (current === "\r" || current === "\n") {
            throw new SyntaxError("unterminated string literal");
          }
          value += current;
          index++;
        }
        if (!closed) {
          throw new SyntaxError("unterminated string literal");
        }
        pushToken("string", value, tokenLine);
        continue;
      }
      if (character === "`") {
        const tokenLine = line;
        index++;
        const bodyStart = index;
        let bodyEnd;
        let closed = false;
        while (index < sourceText.length) {
          if (sourceText[index] === "\\") {
            index += Math.min(2, sourceText.length - index);
          } else if (sourceText[index] === "`") {
            bodyEnd = index;
            index++;
            closed = true;
            break;
          } else if (sourceText[index] === "\r" || sourceText[index] === "\n") {
            advanceLine();
          } else {
            index++;
          }
        }
        if (!closed) {
          throw new SyntaxError("unterminated template literal");
        }
        pushToken("template", "template", tokenLine);
        templateBodies.push({
          line: tokenLine,
          sourceText: sourceText.slice(bodyStart, bodyEnd),
        });
        continue;
      }
      if (isIdentifierStart(character)) {
        const tokenLine = line;
        const start = index++;
        while (isIdentifierPart(sourceText[index])) {
          index++;
        }
        pushToken("identifier", sourceText.slice(start, index), tokenLine);
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const tokenLine = line;
        const start = index++;
        while (/[0-9A-FX_a-fx.]/u.test(sourceText[index] ?? "")) {
          index++;
        }
        pushToken("number", sourceText.slice(start, index), tokenLine);
        continue;
      }
      if (character === "/" && regexCanFollow(tokens.at(-1))) {
        const tokenLine = line;
        index++;
        let inCharacterClass = false;
        let closed = false;
        while (index < sourceText.length) {
          const current = sourceText[index];
          if (current === "\\") {
            index += Math.min(2, sourceText.length - index);
          } else if (current === "\r" || current === "\n") {
            throw new SyntaxError("unterminated regular expression");
          } else {
            index++;
            if (current === "[") {
              inCharacterClass = true;
            } else if (current === "]") {
              inCharacterClass = false;
            } else if (current === "/" && !inCharacterClass) {
              closed = true;
              break;
            }
          }
        }
        if (!closed) {
          throw new SyntaxError("unterminated regular expression");
        }
        while (/[A-Z_a-z]/u.test(sourceText[index] ?? "")) {
          index++;
        }
        pushToken("regex", "regex", tokenLine);
        continue;
      }

      let punctuator;
      for (const candidate of MULTI_CHARACTER_PUNCTUATORS) {
        if (sourceText.startsWith(candidate, index)) {
          punctuator = candidate;
          break;
        }
      }
      pushToken("punctuator", punctuator ?? character, line);
      index += (punctuator ?? character).length;
    }
  } catch {
    return { violations: [{ kind: "parse-error", line }] };
  }

  const matchingToken = (start) => {
    const pairs = { "(": ")", "[": "]", "{": "}" };
    const expected = pairs[tokens[start]?.value];
    if (!expected) {
      return undefined;
    }
    const stack = [expected];
    for (let cursor = start + 1; cursor < tokens.length; cursor++) {
      const value = tokens[cursor].value;
      if (pairs[value]) {
        stack.push(pairs[value]);
      } else if (value === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          return cursor;
        }
      }
    }
    return undefined;
  };

  const aliases = new Map();
  const kindsForProperty = (baseKinds, property) => {
    if (property === "scene" || property === "viewer") {
      return SCENE_OR_VIEWER;
    }
    return property === "canvas" && (baseKinds & SCENE_OR_VIEWER) !== 0
      ? LIVE_CANVAS
      : 0;
  };

  const kindsOfExpression = (initialStart, initialEnd) => {
    let start = initialStart;
    let end = initialEnd;
    while (tokens[start]?.value === "(" && matchingToken(start) === end - 1) {
      start++;
      end--;
    }
    while (["await", "yield"].includes(tokens[start]?.value)) {
      start++;
    }
    if (start >= end) {
      return 0;
    }

    let roundDepth = 0;
    let squareDepth = 0;
    let braceDepth = 0;
    let lastComma;
    let assignment;
    const logical = [];
    let question;
    let colon;
    for (let cursor = start; cursor < end; cursor++) {
      const value = tokens[cursor].value;
      if (value === "(") roundDepth++;
      else if (value === ")") roundDepth--;
      else if (value === "[") squareDepth++;
      else if (value === "]") squareDepth--;
      else if (value === "{") braceDepth++;
      else if (value === "}") braceDepth--;
      else if (roundDepth === 0 && squareDepth === 0 && braceDepth === 0) {
        if (value === ",") lastComma = cursor;
        else if (value === "=") assignment = cursor;
        else if (["&&", "||", "??"].includes(value)) logical.push(cursor);
        else if (value === "?" && question === undefined) question = cursor;
        else if (value === ":" && question !== undefined) colon = cursor;
      }
    }
    if (lastComma !== undefined) {
      return kindsOfExpression(lastComma + 1, end);
    }
    if (assignment !== undefined) {
      return kindsOfExpression(assignment + 1, end);
    }
    if (question !== undefined && colon !== undefined) {
      return (
        kindsOfExpression(question + 1, colon) |
        kindsOfExpression(colon + 1, end)
      );
    }
    if (logical.length > 0) {
      let kinds = 0;
      let segmentStart = start;
      for (const operator of logical) {
        kinds |= kindsOfExpression(segmentStart, operator);
        segmentStart = operator + 1;
      }
      return kinds | kindsOfExpression(segmentStart, end);
    }

    const first = tokens[start];
    if (first.type !== "identifier") {
      return 0;
    }
    const domCallOpen = start + 3;
    const domCallClose = matchingToken(domCallOpen);
    const isDomLiveCanvasCall =
      first.value === "document" &&
      [".", "?."].includes(tokens[start + 1]?.value) &&
      DOM_LIVE_CANVAS_METHODS.has(tokens[start + 2]?.value) &&
      tokens[domCallOpen]?.value === "(" &&
      domCallClose !== undefined &&
      domCallClose < end;
    let kinds = isDomLiveCanvasCall
      ? LIVE_CANVAS
      : ["scene", "viewer"].includes(first.value)
        ? SCENE_OR_VIEWER
        : (aliases.get(first.value) ?? 0);
    let cursor = isDomLiveCanvasCall ? domCallClose + 1 : start + 1;
    while (cursor < end) {
      if ([".", "?."].includes(tokens[cursor].value)) {
        const property = tokens[cursor + 1];
        if (property?.type !== "identifier") {
          return 0;
        }
        const callOpen = cursor + 2;
        const callClose = matchingToken(callOpen);
        if (
          property.value === "querySelector" &&
          (kinds & LIVE_CANVAS) !== 0 &&
          tokens[callOpen]?.value === "(" &&
          callClose !== undefined &&
          callClose < end
        ) {
          kinds = LIVE_CANVAS;
          cursor = callClose + 1;
          continue;
        }
        kinds = kindsForProperty(kinds, property.value);
        cursor += 2;
      } else if (tokens[cursor].value === "[") {
        const close = matchingToken(cursor);
        const property = tokens[cursor + 1];
        if (
          close !== cursor + 2 ||
          !["string", "number"].includes(property?.type)
        ) {
          return 0;
        }
        kinds =
          property.type === "number" && (kinds & LIVE_CANVAS) !== 0
            ? LIVE_CANVAS
            : kindsForProperty(kinds, property.value);
        cursor = close + 1;
      } else {
        return 0;
      }
    }
    return kinds;
  };

  const assignmentEnd = (start) => {
    const stack = [];
    const pairs = { "(": ")", "[": "]", "{": "}" };
    for (let cursor = start; cursor < tokens.length; cursor++) {
      const value = tokens[cursor].value;
      if (pairs[value]) {
        stack.push(pairs[value]);
      } else if (value === stack.at(-1)) {
        stack.pop();
      } else if (
        stack.length === 0 &&
        [",", ";", ")", "]", "}"].includes(value)
      ) {
        return cursor;
      }
    }
    return tokens.length;
  };

  const assignments = [];
  for (let cursor = 0; cursor + 2 < tokens.length; cursor++) {
    if (
      tokens[cursor].type === "identifier" &&
      tokens[cursor + 1].value === "=" &&
      ![".", "?."].includes(tokens[cursor - 1]?.value)
    ) {
      assignments.push({
        end: assignmentEnd(cursor + 2),
        name: tokens[cursor].value,
        start: cursor + 2,
      });
    }
  }

  let changed = true;
  for (let pass = 0; changed && pass <= assignments.length * 2; pass++) {
    changed = false;
    for (const assignment of assignments) {
      const previous = aliases.get(assignment.name) ?? 0;
      const next =
        previous | kindsOfExpression(assignment.start, assignment.end);
      if (next !== previous) {
        aliases.set(assignment.name, next);
        changed = true;
      }
    }
  }

  const violations = [];
  for (let cursor = 0; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    const dottedCall =
      token.type === "identifier" &&
      token.value === "drawImage" &&
      [".", "?."].includes(tokens[cursor - 1]?.value) &&
      tokens[cursor + 1]?.value === "(";
    const computedCall =
      token.type === "string" &&
      token.value === "drawImage" &&
      tokens[cursor - 1]?.value === "[" &&
      tokens[cursor + 1]?.value === "]" &&
      tokens[cursor + 2]?.value === "(";
    if (!dottedCall && !computedCall) {
      continue;
    }
    const open = cursor + (dottedCall ? 1 : 2);
    const close = matchingToken(open);
    if (close === undefined || open + 1 === close) {
      continue;
    }
    let argumentEnd = close;
    const stack = [];
    const pairs = { "(": ")", "[": "]", "{": "}" };
    for (let argument = open + 1; argument < close; argument++) {
      const value = tokens[argument].value;
      if (pairs[value]) {
        stack.push(pairs[value]);
      } else if (value === stack.at(-1)) {
        stack.pop();
      } else if (value === "," && stack.length === 0) {
        argumentEnd = argument;
        break;
      }
    }
    if ((kindsOfExpression(open + 1, argumentEnd) & LIVE_CANVAS) !== 0) {
      violations.push({
        kind: "prohibited-live-canvas-reader",
        line: token.line,
      });
    }
  }

  // A template body may be arbitrary text rather than standalone JavaScript.
  // Reuse the source analysis, but promote only the prohibited-reader finding.
  for (const templateBody of templateBodies) {
    const nested = analyzeProhibitedReader(templateBody.sourceText);
    for (const violation of nested.violations) {
      if (violation.kind === "prohibited-live-canvas-reader") {
        violations.push({
          kind: violation.kind,
          line: templateBody.line + violation.line - 1,
        });
      }
    }
  }

  violations.sort((left, right) => left.line - right.line);

  return { violations };
}
