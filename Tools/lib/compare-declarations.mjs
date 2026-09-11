function requireCompiler(typescript) {
  for (const name of [
    "createSourceFile",
    "createPrinter",
    "createScanner",
    "flattenDiagnosticMessageText",
  ]) {
    if (typeof typescript?.[name] !== "function") {
      throw new TypeError(`typescript.${name} must be a function`);
    }
  }
  if (
    !typescript.ScriptTarget ||
    !typescript.ScriptKind ||
    !typescript.SyntaxKind
  ) {
    throw new TypeError("typescript enum tables are required");
  }
}

function diagnosticRecord(typescript, diagnostic) {
  return {
    code: diagnostic.code,
    category: diagnostic.category,
    start: Number.isInteger(diagnostic.start) ? diagnostic.start : null,
    length: Number.isInteger(diagnostic.length) ? diagnostic.length : null,
    message: typescript.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    ),
  };
}

function normalizeComment(raw, jsdoc) {
  const body = jsdoc
    ? raw.slice(3, -2).replace(/^\s*\* ?/gm, " ")
    : raw.startsWith("//")
      ? raw.slice(2)
      : raw.slice(2, -2);
  return body.replace(/\s+/g, " ").trim();
}

function collectComments(typescript, text) {
  const scanner = typescript.createScanner(
    typescript.ScriptTarget.Latest,
    false,
    typescript.LanguageVariant?.Standard,
    text,
  );
  const records = [];
  for (
    let token = scanner.scan();
    token !== typescript.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== typescript.SyntaxKind.SingleLineCommentTrivia &&
      token !== typescript.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const raw = scanner.getTokenText();
    const jsdoc =
      token === typescript.SyntaxKind.MultiLineCommentTrivia &&
      raw.startsWith("/**");
    records.push({
      kind: jsdoc ? "jsdoc" : "comment",
      raw,
      normalized: normalizeComment(raw, jsdoc),
    });
  }
  return records;
}

function inspectSubject(typescript, value) {
  if (value === undefined || value === null)
    return { status: "missing", diagnostics: [] };
  if (typeof value !== "string")
    return { status: "invalid-input", diagnostics: [] };
  if (value.trim() === "") return { status: "empty", diagnostics: [] };
  const sourceFile = typescript.createSourceFile(
    "subject.d.ts",
    value,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const diagnostics = [...(sourceFile.parseDiagnostics ?? [])].map(
    (diagnostic) => diagnosticRecord(typescript, diagnostic),
  );
  if (diagnostics.length > 0) return { status: "invalid-syntax", diagnostics };
  const substantive = [...sourceFile.statements].some(
    (statement) => statement.kind !== typescript.SyntaxKind.EmptyStatement,
  );
  if (!substantive)
    return { status: "no-substantive-statements", diagnostics: [] };
  const printer = typescript.createPrinter({
    removeComments: true,
    newLine: typescript.NewLineKind?.LineFeed,
  });
  return {
    status: "valid",
    diagnostics: [],
    normalizedDeclaration: printer.printFile(sourceFile).trim(),
    comments: collectComments(typescript, value),
  };
}

function orderedComparison(baseline, candidate, comparable) {
  const rawBaseline = baseline.map((record) => record.raw);
  const rawCandidate = candidate.map((record) => record.raw);
  const normalizedBaseline = baseline.map((record) => record.normalized);
  const normalizedCandidate = candidate.map((record) => record.normalized);
  return {
    eligible: comparable,
    exactEqual:
      comparable &&
      JSON.stringify(rawBaseline) === JSON.stringify(rawCandidate),
    normalizedEqual:
      comparable &&
      JSON.stringify(normalizedBaseline) ===
        JSON.stringify(normalizedCandidate),
    baseline,
    candidate,
  };
}

export function compareDeclarations({ baseline, candidate, typescript }) {
  requireCompiler(typescript);
  const baselineSubject = inspectSubject(typescript, baseline);
  const candidateSubject = inspectSubject(typescript, candidate);
  const comparable =
    baselineSubject.status === "valid" && candidateSubject.status === "valid";
  const baselineComments = baselineSubject.comments ?? [];
  const candidateComments = candidateSubject.comments ?? [];
  return {
    comparable,
    exactText:
      typeof baseline === "string" &&
      typeof candidate === "string" &&
      baseline === candidate,
    subjects: { baseline: baselineSubject, candidate: candidateSubject },
    structural: {
      method: "TypeScript AST parse plus comment-free printer normalization",
      equal: comparable
        ? baselineSubject.normalizedDeclaration ===
          candidateSubject.normalizedDeclaration
        : false,
    },
    comments: orderedComparison(
      baselineComments,
      candidateComments,
      comparable,
    ),
    jsdoc: orderedComparison(
      baselineComments.filter((record) => record.kind === "jsdoc"),
      candidateComments.filter((record) => record.kind === "jsdoc"),
      comparable,
    ),
  };
}
