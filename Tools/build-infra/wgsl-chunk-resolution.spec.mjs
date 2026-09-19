// WGSL chunk-splice resolution contract.
// @purpose Prove the minify transform cannot change which csm_* calls a WGSL module leaves undeclared after the engine's real chunk splice, so a shipped shader never calls a function nothing defines.
// @status ACTIVE
//
// WHAT THIS GUARDS, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION.
//
//   `WebGPUPrimitiveShaders.getShaderSource(key)` returns the WGSL the engine
//   hands to `device.createShaderModule`. For a shader that opts into a shared
//   chunk, that text is the shader with the chunk body prepended. WGSL resolves
//   a whole module before any branch runs, so a module that calls a function no
//   declaration in the module provides fails to compile outright, and every
//   pipeline built from it is invalid.
//
//   The build rewrites every generated WGSL module through a comment strip when
//   it is minified. The splice decision is carried by a comment. So the strip
//   can decide whether a shipped module compiles, and the two build flavours
//   can disagree about it while every source file on disk stays correct.
//
// THE ASSERTION IS OVER THE OUTPUT, NOT OVER THE MARKER SPELLING. The guard
// applies the real exported transform and the real splice, then compares the
// set of undeclared `csm_*` callees between the two flavours. A shader whose
// marker stops surviving the strip changes that set and turns this red,
// whatever spelling the marker uses and whatever mechanism dropped it. A
// shader that is incomplete for an unrelated reason is equally incomplete in
// both flavours and is not this guard's business.
//
// WHY IT READS SOURCE AND NOT A BUILT BUNDLE. `test-build-infra` runs in a job
// that never builds; a guard over built artifacts there would be green because
// the artifact is absent. `wgslModuleContents` is the whole of the minify
// decision and is exported, so applying it here measures the transform itself.
//
// THE SECOND CONTRACT, AND WHY IT IS HERE. The chunk splice is not the only
// renderer decision carried by a comment: the compute shaders wrap their
// subgroup entry point in sentinel comments that the host-side preprocessor
// matches to remove it on a device that cannot declare `enable subgroups;`.
// A `csm_`-shaped guard is green on that. So the second half of this file
// takes the general form — no comment a RUNTIME consumer reads may be
// answered differently by the two build flavours — and it discovers the
// consumers by harvesting every comment-matching regex literal in
// `Renderer/WebGPU` rather than by listing the ones known today.
//
// WHAT THIS GUARD CAN REJECT WRONGLY, AND WHAT TO DO ABOUT IT.
//   * A new renderer regex that is MEANT to answer differently per flavour —
//     a comment stripper, say. One is excluded mechanically (a regex with no
//     literal word of three characters or more matches comments generically,
//     not a specific marker); anything else belongs in `PROSE_ANCHOR_MATCHES`
//     with the reason its consumer never receives that text as its subject.
//   * A shader whose PROSE happens to match an anchor. Same table. Each entry
//     is re-checked for being necessary, so the table cannot rot into a
//     blanket: an entry that stops being divergent fails the test.
//   * Neither exception is a spelling whitelist. The assertion stays a
//     comparison between two flavours of the same file.
//
// SCOPE THIS GUARD DOES NOT COVER. It never runs the `//>>ifdef`
// preprocessor, so a `csm_*` declared only inside a disabled branch counts as
// declared. Measured 2026-09-19: all 211 ifdef-gated `csm_*` declarations in
// the corpus pair the declaration and every live call inside the same block
// (the two depth-0 mentions are prose), so the gap is not live. A shader that
// separates them needs a `defaultVariant()` leg — tracked, not assumed.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stripWgslComments, wgslModuleContents } from "../../scripts/build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shaderRoot = path.resolve(
  here,
  "../../packages/engine/Source/Shaders/WebGPU",
);
const rendererRoot = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const injectorPath = path.join(rendererRoot, "WebGPUPrimitiveShaders.js");

// Lifted verbatim from the injector; "the marker regexes match the injector's
// own literals" below fails if either copy drifts from the source of truth.
const POINT_SHADOW_MARKER_REGEX = /^\s*\/\/.*@chunk\s+csm_samplePointShadow\b/m;
const POLYLINE_COMMON_MARKER_REGEX =
  /^\s*\/\/.*@chunk\s+functions\/csm_polylineCommon\b/m;

const POINT_SHADOW_CHUNK = "chunks/functions/csm_samplePointShadow.wgsl";
const POLYLINE_COMMON_CHUNK = "chunks/functions/csm_polylineCommon.wgsl";

function shaderRelativePaths() {
  return readdirSync(shaderRoot, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".wgsl"))
    .sort();
}

function readShader(relativePath) {
  return readFileSync(path.join(shaderRoot, relativePath), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

/**
 * The engine's splice, over a table of sources already in one build flavour: a
 * minified shader receives the minified chunk and an unminified one the
 * unminified chunk, exactly as the generated modules pair up at runtime.
 */
function injectChunks(source, flavour) {
  let out = source;
  if (POINT_SHADOW_MARKER_REGEX.test(out)) {
    out = `${flavour.get(POINT_SHADOW_CHUNK)}\n${out}`;
  }
  if (POLYLINE_COMMON_MARKER_REGEX.test(out)) {
    out = `${flavour.get(POLYLINE_COMMON_CHUNK)}\n${out}`;
  }
  return out;
}

/** Callees of the form `csm_*(` that no `fn csm_*` in the same text declares. */
function undeclaredCallees(code) {
  const declared = new Set();
  for (const match of code.matchAll(/\bfn\s+(csm_[A-Za-z0-9_]*)/g)) {
    declared.add(match[1]);
  }
  // Blank the declaration keyword so `fn csm_x(` is not counted as a call.
  const callsOnly = code.replace(/\bfn\s+csm_[A-Za-z0-9_]*/g, "fn ");
  const missing = new Set();
  for (const match of callsOnly.matchAll(/\b(csm_[A-Za-z0-9_]*)\s*\(/g)) {
    if (!declared.has(match[1])) {
      missing.add(match[1]);
    }
  }
  return [...missing].sort();
}

function buildCorpus() {
  const relativePaths = shaderRelativePaths();
  const unminified = new Map();
  const minified = new Map();
  for (const relativePath of relativePaths) {
    const source = readShader(relativePath);
    unminified.set(relativePath, source);
    minified.set(relativePath, wgslModuleContents(source, true));
  }
  return { relativePaths, unminified, minified };
}

/**
 * What the compiler cannot resolve in each flavour. Comments are removed from
 * the unminified side too, so a callee named in prose cannot masquerade as a
 * call on one side only.
 */
function undeclaredByFlavour(relativePath, corpus) {
  const spliced = injectChunks(
    corpus.unminified.get(relativePath),
    corpus.unminified,
  );
  return {
    unminified: undeclaredCallees(stripWgslComments(spliced)),
    minified: undeclaredCallees(
      injectChunks(corpus.minified.get(relativePath), corpus.minified),
    ),
  };
}

// Keyed by the injector's own constant names. The drift test below enumerates
// the injector rather than reading this table, so a THIRD marker family added
// there is reported as unguarded instead of silently escaping.
const MARKER_REGEXES_BY_NAME = new Map([
  ["POINT_SHADOW_MARKER_REGEX", POINT_SHADOW_MARKER_REGEX],
  ["POLYLINE_COMMON_MARKER_REGEX", POLYLINE_COMMON_MARKER_REGEX],
]);

/** Every `const <NAME>_MARKER_REGEX = <literal>;` the injector declares. */
function injectorMarkerLiterals() {
  const injector = readFileSync(injectorPath, "utf8");
  const declaration = /^const\s+(\w*MARKER_REGEX)\s*=\s*(\/[^\n]+\/[a-z]*);/gmu;
  return new Map(
    [...injector.matchAll(declaration)].map((match) => [match[1], match[2]]),
  );
}

test("the marker regexes match the injector's own literals", () => {
  const declared = injectorMarkerLiterals();
  assert.ok(
    declared.size > 0,
    "no *_MARKER_REGEX literal found in the injector; the enumeration below would be vacuous",
  );
  assert.deepEqual(
    [...declared.keys()].sort(),
    [...MARKER_REGEXES_BY_NAME.keys()].sort(),
    "the injector's marker families and this guard's copies disagree; a family added there is unguarded until it is copied here",
  );
  for (const [name, literal] of declared) {
    assert.equal(literal, String(MARKER_REGEXES_BY_NAME.get(name)), name);
  }
});

test("both chunk markers are carried by shaders that ship", () => {
  const corpus = buildCorpus();
  const carriers = (marker) =>
    corpus.relativePaths.filter((relativePath) =>
      marker.test(corpus.unminified.get(relativePath)),
    );
  const pointShadow = carriers(POINT_SHADOW_MARKER_REGEX);
  const polyline = carriers(POLYLINE_COMMON_MARKER_REGEX);
  assert.ok(
    pointShadow.length > 0,
    "no shader carries the point-shadow marker; the resolution test below would be vacuous",
  );
  assert.ok(
    polyline.length > 0,
    "no shader carries the polyline-common marker; the resolution test below would be vacuous",
  );
  // The polyline chunk names itself in its own header, so it appears here too.
  assert.ok(polyline.includes(POLYLINE_COMMON_CHUNK));
});

test("every chunk-marker carrier resolves its csm_ calls in the minified flavour", () => {
  const corpus = buildCorpus();
  const carriers = corpus.relativePaths.filter((relativePath) => {
    const source = corpus.unminified.get(relativePath);
    return (
      POINT_SHADOW_MARKER_REGEX.test(source) ||
      POLYLINE_COMMON_MARKER_REGEX.test(source)
    );
  });
  const broken = carriers
    .map((relativePath) => ({
      relativePath,
      missing: undeclaredByFlavour(relativePath, corpus).minified,
    }))
    .filter((row) => row.missing.length > 0);
  assert.deepEqual(
    broken.map((row) => `${row.relativePath}: ${row.missing.join(", ")}`),
    [],
  );
});

test("minification changes no module's set of undeclared csm_ callees", () => {
  const corpus = buildCorpus();
  const divergent = corpus.relativePaths
    .map((relativePath) => ({
      relativePath,
      ...undeclaredByFlavour(relativePath, corpus),
    }))
    .filter((row) => row.unminified.join("|") !== row.minified.join("|"));
  assert.deepEqual(
    divergent.map(
      (row) =>
        `${row.relativePath}: [${row.unminified.join(", ")}] -> [${row.minified.join(", ")}]`,
    ),
    [],
  );
});

test("the analysis detects a marker the strip removes and clears one it keeps", () => {
  const chunkText = "fn csm_samplePointShadow() -> f32 {\n  return 1.0;\n}\n";
  const flavourOf = (markerLine) => {
    const source = `${markerLine}\nfn main() {\n  let v = csm_samplePointShadow();\n}\n`;
    const unminified = new Map([
      [POINT_SHADOW_CHUNK, chunkText],
      ["synthetic.wgsl", source],
    ]);
    const minified = new Map(
      [...unminified].map(([key, value]) => [
        key,
        wgslModuleContents(value, true),
      ]),
    );
    return undeclaredByFlavour("synthetic.wgsl", {
      relativePaths: ["synthetic.wgsl"],
      unminified,
      minified,
    });
  };

  const dropped = flavourOf("// @chunk csm_samplePointShadow");
  assert.deepEqual(dropped.unminified, []);
  assert.deepEqual(dropped.minified, ["csm_samplePointShadow"]);

  const kept = flavourOf("//>> @chunk csm_samplePointShadow");
  assert.deepEqual(kept.unminified, []);
  assert.deepEqual(kept.minified, []);
});

// ===========================================================================
// Contract (C) — no comment a runtime consumer reads may be answered
// differently by the two build flavours.
//
// The chunk splice is one instance. The consumers are discovered, not listed:
// a renderer module that keys on a comment has to say so in a regex literal
// that escapes the comment slashes, and there is no other way to express it
// (verified 2026-09-19: `Renderer/WebGPU` contains no string-literal form).
// ===========================================================================

/** `/body/flags` → its two halves, without evaluating it. */
function splitRegexLiteral(literal) {
  const closing = literal.lastIndexOf("/");
  return { body: literal.slice(1, closing), flags: literal.slice(closing + 1) };
}

/**
 * Words a regex requires literally, ignoring character classes and escapes.
 * A comment-matching regex with none of these matches comments generically —
 * a stripper, not an anchor — and is excluded from contract (C) because it is
 * SUPPOSED to answer differently once the comments are gone.
 */
function literalWords(regexBody) {
  const flattened = regexBody
    .replace(/\[(?:\\.|[^\]\\])*\]/g, " ")
    .replace(/\\[dDsSwWbBnrtfv0]/g, " ")
    .replace(/\\(.)/g, "$1");
  return [...flattened.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map(
    (match) => match[0],
  );
}

/** Every comment-matching regex literal declared under `Renderer/WebGPU`. */
function harvestCommentRegexLiterals() {
  const literalPattern =
    /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*/g;
  const commentSlashes = "\\/\\/";
  const found = [];
  for (const entry of readdirSync(rendererRoot, { recursive: true })) {
    const relativePath = String(entry).split(path.sep).join("/");
    if (!/\.(?:ts|js)$/.test(relativePath)) {
      continue;
    }
    const text = readFileSync(path.join(rendererRoot, relativePath), "utf8");
    text.split("\n").forEach((line, index) => {
      if (!line.includes(commentSlashes)) {
        return;
      }
      for (const match of line.matchAll(literalPattern)) {
        if (match[0].includes(commentSlashes)) {
          found.push({
            where: `${relativePath}:${index + 1}`,
            literal: match[0],
          });
        }
      }
    });
  }
  return found;
}

/** The harvested literals that name something specific, deduped by body. */
function commentAnchors() {
  const byBody = new Map();
  for (const { where, literal } of harvestCommentRegexLiterals()) {
    const { body, flags } = splitRegexLiteral(literal);
    if (literalWords(body).length === 0) {
      continue;
    }
    const existing = byBody.get(body);
    if (existing) {
      existing.wheres.push(where);
      continue;
    }
    byBody.set(body, {
      body,
      literal,
      wheres: [where],
      // Normalized to a non-sticky global so `matchAll` is safe and counting
      // is well defined; `m`/`s`/`i`/`u` are the ones that change meaning.
      pattern: new RegExp(body, `${flags.replace(/[gy]/gu, "")}g`),
    });
  }
  return [...byBody.values()];
}

function anchorMatchCount(anchor, text) {
  let count = 0;
  for (const _match of text.matchAll(anchor.pattern)) {
    count += 1;
  }
  return count;
}

/**
 * Anchor matches a build flavour may change, each because the consumer never
 * receives that module as the SUBJECT of that regex. Not a spelling
 * whitelist: the pair still has to be justified, and "every excused match is
 * still divergent" below deletes the table's right to exist once it is not.
 */
const PROSE_ANCHOR_MATCHES = [
  {
    shader: "chunks/functions/csm_polylineCommon.wgsl",
    anchorContains: "csm_polylineCommon",
    why: "the chunk names itself in its own header; `injectChunks` only ever receives a _shaderCache carrier, never the chunk it prepends (WebGPUPrimitiveShaders.js:129-141, :243-258)",
  },
  {
    shader: "chunks/functions/csm_distributionGGX.wgsl",
    anchorContains: "#import",
    why: "the shader library is registered from the inline copy in WGSLBuiltins.ts:129/:515, not from this file's generated module, so `parseImports` never sees this text",
  },
];

function isExcused(relativePath, anchor) {
  return PROSE_ANCHOR_MATCHES.some(
    (row) =>
      row.shader === relativePath && anchor.body.includes(row.anchorContains),
  );
}

test("the comment-anchor harvest finds the consumers it is supposed to find", () => {
  const anchors = commentAnchors();
  assert.ok(
    anchors.length > 0,
    "no comment anchor harvested from the renderer",
  );
  const missing = ["@chunk", "__SUBGROUP_BLOCK_START__", "#import"].filter(
    (needle) => !anchors.some((anchor) => anchor.body.includes(needle)),
  );
  assert.deepEqual(
    missing,
    [],
    "the harvest stopped seeing a consumer it saw on 2026-09-19; contract (C) is only as wide as this list",
  );
  // The generic comment stripper must NOT be harvested, or every commented
  // shader in the corpus is reported as divergent.
  assert.ok(
    !anchors.some((anchor) => literalWords(anchor.body).length === 0),
    "a generic comment matcher was harvested as an anchor",
  );
});

test("minification changes no comment a renderer consumer reads", () => {
  const corpus = buildCorpus();
  const anchors = commentAnchors();
  const divergent = [];
  for (const relativePath of corpus.relativePaths) {
    const unminified = corpus.unminified.get(relativePath);
    const minified = corpus.minified.get(relativePath);
    for (const anchor of anchors) {
      const before = anchorMatchCount(anchor, unminified);
      const after = anchorMatchCount(anchor, minified);
      if (before === after || isExcused(relativePath, anchor)) {
        continue;
      }
      divergent.push(
        `${relativePath}: ${anchor.wheres[0]} matched ${before}x -> ${after}x`,
      );
    }
  }
  assert.deepEqual(divergent, []);
});

test("every excused anchor match is still one the strip really changes", () => {
  const corpus = buildCorpus();
  const anchors = commentAnchors();
  const stale = PROSE_ANCHOR_MATCHES.filter((row) => {
    const unminified = corpus.unminified.get(row.shader);
    const minified = corpus.minified.get(row.shader);
    if (unminified === undefined) {
      return true;
    }
    return !anchors.some(
      (anchor) =>
        anchor.body.includes(row.anchorContains) &&
        anchorMatchCount(anchor, unminified) !==
          anchorMatchCount(anchor, minified),
    );
  });
  assert.deepEqual(
    stale.map((row) => `${row.shader} / ${row.anchorContains}`),
    [],
    "an exception no longer excuses anything — delete the row rather than leave a standing permission",
  );
});

test("contract (C) accepts a directive-spelled sentinel and rejects a plain one", () => {
  // The real consumer regex, from WebGPUGPUCuller.ts / WebGPUPerformanceManager
  // / WebGPUPointCloudLODProcessor; `commentAnchors` must be harvesting this
  // exact body for the corpus test above to be checking anything.
  const consumerBody =
    "\\/\\/ __SUBGROUP_BLOCK_START__[\\s\\S]*?\\/\\/ __SUBGROUP_BLOCK_END__";
  const anchor = commentAnchors().find(
    (candidate) => candidate.body === consumerBody,
  );
  assert.ok(anchor, "the subgroup sentinel regex is no longer harvested");

  const bodyText = "@compute fn mainSubgroups() { let b = subgroupBallot(); }";
  const moduleWith = (marker) =>
    `fn main() {}\n${marker}START__\n${bodyText}\n${marker}END__\n`;

  const plain = moduleWith("// __SUBGROUP_BLOCK_");
  assert.equal(anchorMatchCount(anchor, plain), 1);
  assert.equal(anchorMatchCount(anchor, wgslModuleContents(plain, true)), 0);

  const directive = moduleWith("//>>// __SUBGROUP_BLOCK_");
  assert.equal(anchorMatchCount(anchor, directive), 1);
  assert.equal(
    anchorMatchCount(anchor, wgslModuleContents(directive, true)),
    1,
  );
});
