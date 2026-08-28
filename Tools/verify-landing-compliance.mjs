#!/usr/bin/env node
// verify-landing-compliance.mjs — the after-the-fact detector that makes a
// `--no-verify` bypass visible.
// @purpose After-the-fact detector that re-runs the landing rules + C16 marker gate over a landed commit range, making any --no-verify hook bypass visible.
// @status ACTIVE
//
// Ruling: migration_doc/MAINTAINER_RULINGS_2026-08-14.md R-2026-08-14-4
// Charter: EXECUTOR_LANE_CHARTER_2026-08-14.md §2.2/§2.3
// Findings: SOL_WEEK_AUDIT_2026-08-14.md S9, S10
//
// WHY THIS EXISTS. `.husky/pre-push` refuses a non-compliant push, and the
// pre-commit hook runs the C16 marker guard over staged files — but git's own
// `--no-verify` skips both, and nothing recorded that it had been used. Finding
// S9 was reconstructed by noticing that eight clean-listed marker ERRORS were
// sitting in a landed commit; that reconstruction should not have needed an
// audit. This script re-runs both checks over a range of already-landed
// commits, so the bypass produces a red on the next run instead of silence.
//
// WHAT IT CHECKS over the range, per commit authored by `cesium-webgpu-agent`:
//   (a) `Batch NNNN: ` prefix, monotonic against the highest batch reachable
//       from the range's base;
//   (b) non-empty body;
//   (c) `Co-Authored-By:` trailer;
//   (+) the commit's own timestamps against the quiet-hours window. The hook
//       can only see push time; commit time is the half finding S10 measured,
//       and it is only observable after the fact — which is here.
// Merge commits (two or more parents) skip (a)-(c) exactly as the hook does.
//
// AND for every selected commit, regardless of author: the C16 comment-marker grammar and its
// clean-list ratchet, re-run over every in-scope source path that commit
// changed. Source is read from THAT COMMIT; enforcement is the union of every
// parent's and the commit's own clean-list, and the commit's clean-list may
// only preserve or strengthen the parent union. Newly covered paths are read
// from the commit tree even when their source blob did not otherwise change.
// This is deliberately not a
// base-to-head snapshot: a later commit that removes a marker or deletes the
// path must not make the commit that shipped it read clean, and working-tree
// clean-list drift must not redefine historical severity.
//
// USAGE
//   node Tools/verify-landing-compliance.mjs            (npm run verify-landing)
//       Default range: `<upstream>..HEAD` when the branch has an upstream,
//       `origin/main..HEAD` when HEAD is detached and that ref exists, otherwise
//       the last 20 commits. A branch with no upstream keeps the last-20 form.
//   node Tools/verify-landing-compliance.mjs --range origin/main..HEAD
//   node Tools/verify-landing-compliance.mjs --last 30
//   node Tools/verify-landing-compliance.mjs --trusted-baseline-batch 1043
//   node Tools/verify-landing-compliance.mjs --json
//
// EXIT CODES
//   0  every commit and every touched file complies
//   1  at least one violation (commit rule or marker-guard error)
//   2  the verifier itself failed — bad range, git unavailable, guard crashed
//   3  STRUCTURAL: the range is empty or its required history/baseline is
//      incomplete, so the requested verification could not be performed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Executable policy files whose exact bytes and transitive local-import graph
 * define one verifier invocation. The verifier snapshots these files, imports
 * only a private tree materialized from those captured bytes, then resnapshots
 * the source immediately after load and before emitting a verdict. This binds
 * execution to the reported closure even across a source-file ABA, while a
 * persistent mid-run edit remains structural.
 */
const POLICY_DEPENDENCY_MANIFEST = Object.freeze([
  Object.freeze({
    path: "Tools/landing-rules.mjs",
    edges: Object.freeze([]),
  }),
  Object.freeze({
    path: "Tools/c16/comment-marker-guard.mjs",
    edges: Object.freeze([
      Object.freeze({ kind: "builtin", specifier: "node:fs" }),
      Object.freeze({ kind: "builtin", specifier: "node:path" }),
      Object.freeze({ kind: "builtin", specifier: "node:url" }),
      Object.freeze({
        kind: "local",
        specifier: "./lib/comment-scanner.mjs",
        target: "Tools/c16/lib/comment-scanner.mjs",
      }),
      Object.freeze({
        kind: "local",
        specifier: "./lib/marker-grammar.mjs",
        target: "Tools/c16/lib/marker-grammar.mjs",
      }),
    ]),
  }),
  Object.freeze({
    path: "Tools/c16/lib/comment-scanner.mjs",
    edges: Object.freeze([]),
  }),
  Object.freeze({
    path: "Tools/c16/lib/marker-grammar.mjs",
    edges: Object.freeze([]),
  }),
]);

/**
 * Immutable marker behavior. This baseline deliberately lives outside
 * MARKER_RULES: deleting a complete rule object together with its mutable
 * example must not make the grammar's own self-test vacuous. Every grammar
 * rule must have a control in the same add-only order; those ids, global RegExp
 * shape, exact positive matches, and registered non-matches remain required.
 * The controls pin externally meaningful behavior rather than regex source
 * text, so an equivalent refactor or a compatible widening does not fail
 * preflight.
 */
const REQUIRED_MARKER_RULE_CONTROLS = Object.freeze([
  Object.freeze({
    id: "batch-id",
    positives: Object.freeze([
      Object.freeze({ text: "landed in Batch 731", matches: ["Batch 731"] }),
      Object.freeze({ text: "Batches-42", matches: ["Batches-42"] }),
      Object.freeze({
        text: "Batch-7 and Batches 42",
        matches: ["Batch-7", "Batches 42"],
      }),
    ]),
    negatives: Object.freeze([
      "BatchSize is 731",
      "Batch queue is empty",
      "Batches of tiles",
      "Batch-abc",
    ]),
  }),
  Object.freeze({
    id: "campaign-row-id",
    positives: Object.freeze([
      Object.freeze({ text: "C13-10 owns this", matches: ["C13-10"] }),
      Object.freeze({ text: "C1-2a", matches: ["C1-2a"] }),
      Object.freeze({ text: "C15-G6", matches: ["C15-G6"] }),
      Object.freeze({ text: "C16-R2", matches: ["C16-R2"] }),
      Object.freeze({ text: "C15-G3b", matches: ["C15-G3b"] }),
      Object.freeze({
        text: "C4-CUBEMAP-PANORAMA-HDR-DECODE owns this",
        matches: ["C4-CUBEMAP-PANORAMA-HDR-DECODE"],
      }),
    ]),
    negatives: Object.freeze([
      "CC-BY-SA",
      "2026-05-02",
      "C++ bindings",
      "CesiumJS runtime",
      "C123-4",
      "C15-g6",
    ]),
  }),
  Object.freeze({
    id: "parity-report-row-id",
    positives: Object.freeze([
      Object.freeze({
        text: "Q13-PLAIN-HDR-GAMMA-CORE owns this",
        matches: ["Q13-PLAIN-HDR-GAMMA-CORE"],
      }),
      Object.freeze({
        text: "Q1-AA and Q99-Z9-CORE",
        matches: ["Q1-AA", "Q99-Z9-CORE"],
      }),
    ]),
    negatives: Object.freeze(["Q123-PLAIN", "Q13-plain", "Q13-", "XQ13-PLAIN"]),
  }),
  Object.freeze({
    id: "campaign-name",
    positives: Object.freeze([
      Object.freeze({
        text: "deferred to Campaign 14",
        matches: ["Campaign 14"],
      }),
      Object.freeze({
        text: "Campaign 1 and Campaign 18",
        matches: ["Campaign 1", "Campaign 18"],
      }),
    ]),
    negatives: Object.freeze([
      "CampaignManager schedules imagery",
      "campaign imagery",
      "Campaign imagery mode",
      "Campaign = true",
    ]),
  }),
  Object.freeze({
    id: "review-id",
    positives: Object.freeze([
      Object.freeze({ text: "raised by C-R8", matches: ["C-R8"] }),
      Object.freeze({
        text: "C-R12 followed C-R8",
        matches: ["C-R12", "C-R8"],
      }),
    ]),
    negatives: Object.freeze(["C-R", "CR8", "C-Runtime state", "MC-R8"]),
  }),
  Object.freeze({
    id: "dp-h-id",
    positives: Object.freeze([
      Object.freeze({ text: "per DP-H41", matches: ["DP-H41"] }),
      Object.freeze({
        text: "DP-H2 precedes DP-H41",
        matches: ["DP-H2", "DP-H41"],
      }),
    ]),
    negatives: Object.freeze(["DP-H", "DPH41", "DP-HDR mode", "DP-H 41"]),
  }),
  Object.freeze({
    id: "far-id",
    positives: Object.freeze([
      Object.freeze({ text: "the FAR-003 flag", matches: ["FAR-003"] }),
      Object.freeze({
        text: "FAR-999 follows FAR-003",
        matches: ["FAR-999", "FAR-003"],
      }),
    ]),
    negatives: Object.freeze([
      "the FAR plane",
      "FAR-03",
      "FAR-ABC",
      "NEAR-003",
    ]),
  }),
  Object.freeze({
    id: "takram",
    positives: Object.freeze([
      Object.freeze({ text: "the TAKRAM lane", matches: ["TAKRAM"] }),
      Object.freeze({ text: "TAKRAM-derived", matches: ["TAKRAM"] }),
    ]),
    negatives: Object.freeze([
      "Takram",
      "TAKRAMShader",
      "NOTAKRAM",
      "MY_TAKRAM",
    ]),
  }),
  Object.freeze({
    id: "upstream-sync-id",
    positives: Object.freeze([
      Object.freeze({ text: "UP144-03 reland", matches: ["UP144-"] }),
      Object.freeze({
        text: "UP001-A and UP999-9",
        matches: ["UP001-", "UP999-"],
      }),
    ]),
    negatives: Object.freeze([
      "UP144",
      "UP14-03",
      "UP144_03",
      "setup UP-144",
      "UP144/03",
    ]),
  }),
  Object.freeze({
    id: "cloud-unification-id",
    positives: Object.freeze([
      Object.freeze({ text: "CLOUD-U7 renamed it", matches: ["CLOUD-U7"] }),
      Object.freeze({
        text: "CLOUD-U0 and CLOUD-U9",
        matches: ["CLOUD-U0", "CLOUD-U9"],
      }),
    ]),
    negatives: Object.freeze([
      "CLOUD-U",
      "CLOUD-UNIT",
      "CLOUD-V7",
      "CLOUDS-U7",
    ]),
  }),
  Object.freeze({
    id: "deferred-work-id",
    positives: Object.freeze([
      Object.freeze({
        text: "NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL",
        matches: ["NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL"],
      }),
      Object.freeze({
        text: "NEW-WEBGPU BUG-CACHE EPIC-AURORA FIX-PIPELINE",
        matches: ["NEW-WEBGPU", "BUG-CACHE", "EPIC-AURORA", "FIX-PIPELINE"],
      }),
    ]),
    negatives: Object.freeze([
      "BUG-12",
      "CC-BY-SA",
      "NEW_feature",
      "PREFIX-WEBGPU",
      "FIXED-PIPELINE",
    ]),
  }),
  Object.freeze({
    id: "all-caps-fix-label",
    positives: Object.freeze([
      Object.freeze({
        text: "POINT-SPRITE-SHAPE",
        matches: ["POINT-SPRITE-SHAPE"],
      }),
      Object.freeze({
        text: "PARITY-F16-POSTPROCESS",
        matches: ["PARITY-F16-POSTPROCESS"],
      }),
      Object.freeze({
        text: "WIRE-PP-LIBRARY-BUILTINS",
        matches: ["WIRE-PP-LIBRARY-BUILTINS"],
      }),
      Object.freeze({
        text: "PARITY-RTE-ELLIPSOID-AWARE",
        matches: ["PARITY-RTE-ELLIPSOID-AWARE"],
      }),
      Object.freeze({ text: "FEAT-3DT2-03", matches: ["FEAT-3DT2-03"] }),
    ]),
    negatives: Object.freeze([
      "CC-BY-SA",
      "2026-05-02",
      "2012-08-01T00",
      "NEW-WEBGPU-PIPELINE-KEY",
      "FIX-WEBGPU-PIPELINE-KEY",
    ]),
  }),
  Object.freeze({
    id: "numbered-bug-id",
    positives: Object.freeze([
      Object.freeze({ text: "the BUG-12 clear loop", matches: ["BUG-12"] }),
      Object.freeze({
        text: "BUG-1 precedes BUG-999",
        matches: ["BUG-1", "BUG-999"],
      }),
    ]),
    negatives: Object.freeze(["BUG-WEBGPU", "DEBUG-12", "BUG-ABC", "BUG 12"]),
  }),
  Object.freeze({
    id: "session-id",
    positives: Object.freeze([
      Object.freeze({
        text: "the Session 29 pattern",
        matches: ["Session 29"],
      }),
      Object.freeze({
        text: "Session 1 and Session 314",
        matches: ["Session 1", "Session 314"],
      }),
    ]),
    negatives: Object.freeze([
      "SessionStorage 29",
      "Session token",
      "Session = 29",
      "Sessions contain tokens",
    ]),
  }),
  Object.freeze({
    id: "tracker-document",
    positives: Object.freeze([
      Object.freeze({ text: "see DEFERRED_WORK", matches: ["DEFERRED_WORK"] }),
      Object.freeze({
        text: "migration_doc/queue",
        matches: ["migration_doc/"],
      }),
      Object.freeze({
        text: "FEATURE_INVENTORY and WEBGPU_DEBUGGING_LOG",
        matches: ["FEATURE_INVENTORY", "WEBGPU_DEBUGGING_LOG"],
      }),
      Object.freeze({
        text: "WEBGPU_MIGRATION_STATUS and QUEUE_2026-08-27",
        matches: ["WEBGPU_MIGRATION_STATUS", "QUEUE_2026-08-27"],
      }),
    ]),
    negatives: Object.freeze([
      "deferred work",
      "FEATURE-INVENTORY",
      "WEBGPU_DEBUG_LOG",
      "QUEUE_DEPTH",
      "QUEUE_2026_08_27",
      "migration/docs",
    ]),
  }),
  Object.freeze({
    id: "decorative-glyph",
    positives: Object.freeze([
      Object.freeze({ text: "★ read this first", matches: ["★"] }),
      Object.freeze({ text: "⚠ caution", matches: ["⚠"] }),
      Object.freeze({
        text: "☆ ❗ ‼ ✅ ❌ ✔ ✖ ⭐ ⭕ 🔴 🟢 🚨 🔥",
        matches: [
          "☆",
          "❗",
          "‼",
          "✅",
          "❌",
          "✔",
          "✖",
          "⭐",
          "⭕",
          "🔴",
          "🟢",
          "🚨",
          "🔥",
        ],
      }),
    ]),
    negatives: Object.freeze([
      "© CC-BY-SA",
      "x * y",
      "error != null",
      "distance ± epsilon",
      "angle → radians",
    ]),
  }),
  Object.freeze({
    id: "fork-id",
    positives: Object.freeze([
      Object.freeze({
        text: "FORK-34 keeps synchronous picks on the current encoder.",
        matches: ["FORK-34"],
      }),
      Object.freeze({
        text: "FORK-99 and FORK-123",
        matches: ["FORK-99", "FORK-123"],
      }),
    ]),
    negatives: Object.freeze([
      "FORK",
      "FORK-",
      "fork-34",
      "FORK-ABC",
      "XFORK-34",
    ]),
  }),
]);

/** Policy exports loaded only after the pre-import byte snapshot. */
let ACTIVE_POLICY;

/** Non-reportable exact bytes behind one captured policy dependency tuple. */
const POLICY_SOURCE_BYTES = Symbol("policySourceBytes");

/** Active private Git view; unset while repository identity is captured. */
let ACTIVE_HISTORY_VIEW;

/**
 * Every verifier-owned Git subprocess ignores replacement refs and avoids
 * optional worktree/index refresh writes. Historical identity must come from
 * the selected object ids, not from caller-controlled replacement state.
 */
const GIT_CONTEXT_ENV_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

/** Caller environment without repository-selection escape hatches. */
const BASE_GIT_ENV = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !GIT_CONTEXT_ENV_KEYS.has(key),
    ),
  ),
);

/** Source-repository commands before the private history view is activated. */
const SOURCE_GIT_ENV = Object.freeze({
  ...BASE_GIT_ENV,
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
});

/** Repo-relative home of the C16 clean-list ratchet. */
const CLEAN_LIST_PATH = "Tools/c16/comment-marker-cleanlist.txt";

/** Default depth when the branch has no upstream to diff against. */
const DEFAULT_LAST = 20;

/** A required executable policy contract is absent, drifting, or malformed. */
class PolicyStructureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PolicyStructureError";
    this.details = details;
  }
}

/** Upper-case SHA-256 used consistently in human and JSON reports. */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

/** Decode policy source strictly, then normalize only line endings. */
function canonicalPolicySource(bytes, file) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PolicyStructureError(
      "an executable policy dependency is not valid UTF-8",
      { file, decodeError: error?.message ?? String(error) },
    );
  }
  return text.replace(/\r\n?/g, "\n");
}

/** Resolve a local ESM specifier to one repo-relative slash path. */
function resolvePolicyDependency(fromFile, specifier) {
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
}

/** Fail one conservative policy-module lexical check with a stable location. */
function policyLexicalFailure(file, source, index, message) {
  const line = source.slice(0, index).split("\n").length;
  throw new PolicyStructureError(message, { file, line, offset: index });
}

/**
 * Tokenize enough JavaScript module syntax to inventory every module edge.
 *
 * Strings, comments, regular expressions, and template raw text are skipped
 * without treating their contents as executable tokens. Template expressions
 * are tokenized recursively. The scanner is intentionally conservative:
 * malformed or ambiguous source is STRUCTURAL before Node can execute it.
 */
function policyModuleTokens(file, source) {
  const tokens = [];
  let index = 0;

  const fail = (message, at = index) =>
    policyLexicalFailure(file, source, at, message);

  const scanQuotedString = (quote) => {
    const start = index;
    index += 1;
    let value = "";
    let escaped = false;
    while (index < source.length) {
      const char = source[index];
      if (char === quote) {
        index += 1;
        return { type: "string", value, escaped, start };
      }
      if (char === "\\") {
        escaped = true;
        index += 1;
        if (index >= source.length || /[\r\n]/u.test(source[index])) {
          fail("an executable policy string literal is malformed", start);
        }
        value += `\\${source[index]}`;
        index += 1;
        continue;
      }
      if (/\r|\n/u.test(char)) {
        fail("an executable policy string literal is unterminated", start);
      }
      value += char;
      index += 1;
    }
    fail("an executable policy string literal is unterminated", start);
  };

  const scanRegularExpression = () => {
    const start = index;
    index += 1;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (/\r|\n/u.test(char)) {
        fail("an executable policy regular expression is unterminated", start);
      }
      if (char === "[") {
        inClass = true;
      } else if (char === "]") {
        inClass = false;
      } else if (char === "/" && !inClass) {
        index += 1;
        while (/[A-Za-z]/u.test(source[index] ?? "")) {
          index += 1;
        }
        return;
      }
      index += 1;
    }
    fail("an executable policy regular expression is unterminated", start);
  };

  const regexPrefixKeywords = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]);

  const scanCode = (stopAtTemplateBrace = false) => {
    let templateBraceDepth = 0;
    let canStartRegex = true;
    while (index < source.length) {
      const char = source[index];
      if (/\s/u.test(char)) {
        index += 1;
        continue;
      }
      if (char === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && !/[\r\n]/u.test(source[index])) {
          index += 1;
        }
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        const start = index;
        const end = source.indexOf("*/", index + 2);
        if (end < 0) {
          fail("an executable policy block comment is unterminated", start);
        }
        index = end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        tokens.push(scanQuotedString(char));
        canStartRegex = false;
        continue;
      }
      if (char === "`") {
        const start = index;
        tokens.push({ type: "template", start });
        index += 1;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
          } else if (source[index] === "`") {
            index += 1;
            closed = true;
            break;
          } else if (source[index] === "$" && source[index + 1] === "{") {
            index += 2;
            scanCode(true);
          } else {
            index += 1;
          }
        }
        if (!closed) {
          fail("an executable policy template literal is unterminated", start);
        }
        canStartRegex = false;
        continue;
      }
      if (/[A-Za-z_$]/u.test(char)) {
        const start = index;
        index += 1;
        while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) {
          index += 1;
        }
        const value = source.slice(start, index);
        tokens.push({ type: "identifier", value, start });
        canStartRegex = regexPrefixKeywords.has(value);
        continue;
      }
      if (/[0-9]/u.test(char)) {
        const start = index;
        index += 1;
        while (/[A-Za-z0-9_.]/u.test(source[index] ?? "")) {
          index += 1;
        }
        tokens.push({ type: "number", start });
        canStartRegex = false;
        continue;
      }
      if (char === "/" && canStartRegex) {
        scanRegularExpression();
        canStartRegex = false;
        continue;
      }
      if (stopAtTemplateBrace && char === "}") {
        if (templateBraceDepth === 0) {
          index += 1;
          return;
        }
        templateBraceDepth -= 1;
      } else if (stopAtTemplateBrace && char === "{") {
        templateBraceDepth += 1;
      }
      tokens.push({ type: "punctuator", value: char, start: index });
      index += 1;
      canStartRegex = ![")", "]", "}"].includes(char);
    }
    if (stopAtTemplateBrace) {
      fail("an executable policy template expression is unterminated");
    }
  };

  scanCode();
  return tokens;
}

/** Stable identity for one declared or observed module edge. */
function policyEdgeKey(edge) {
  return JSON.stringify({
    kind: edge.kind,
    form: edge.form ?? "static",
    specifier: edge.specifier,
    ...(edge.target === undefined ? {} : { target: edge.target }),
  });
}

/** Return one direct, unescaped module specifier or fail closed. */
function policySpecifier(file, token, form) {
  if (token?.type !== "string" || token.escaped) {
    throw new PolicyStructureError(
      form === "dynamic"
        ? "an executable policy has an unknown dynamic module edge"
        : "an executable policy module edge is not a direct string literal",
      { file, offset: token?.start ?? null, form },
    );
  }
  if (token.value === "" || token.value.includes("\0")) {
    throw new PolicyStructureError(
      "an executable policy module edge has an invalid specifier",
      { file, offset: token.start, form },
    );
  }
  return token.value;
}

/** Classify one direct ESM edge without resolving through Node or packages. */
function classifyPolicyEdge(file, specifier, form) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return {
      kind: "local",
      form,
      specifier,
      target: resolvePolicyDependency(file, specifier),
    };
  }
  if (specifier.startsWith("node:")) {
    return { kind: "builtin", form, specifier };
  }
  throw new PolicyStructureError(
    "an executable policy references a forbidden external or unbound module edge",
    { file, form, specifier },
  );
}

/**
 * Inventory every static re-export/import and literal dynamic import.
 * CommonJS calls and non-literal dynamic imports are unbound execution edges
 * and therefore STRUCTURAL even if a particular branch did not execute.
 */
function policyModuleEdges(file, source) {
  const tokens = policyModuleTokens(file, source);
  const edges = [];
  const add = (specifier, form) => {
    edges.push(classifyPolicyEdge(file, specifier, form));
  };
  const statementEnd = (start) => {
    const end = tokens.findIndex(
      (token, tokenIndex) =>
        tokenIndex >= start &&
        token.type === "punctuator" &&
        token.value === ";",
    );
    return end < 0 ? tokens.length : end;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (
      token.type === "identifier" &&
      token.value === "require" &&
      tokens[index + 1]?.value === "("
    ) {
      throw new PolicyStructureError(
        "an executable policy contains an unbound CommonJS module edge",
        { file, offset: token.start },
      );
    }
    if (
      token.type === "identifier" &&
      token.value === "import" &&
      previous?.value !== "."
    ) {
      const next = tokens[index + 1];
      if (next?.value === ".") {
        continue;
      }
      if (next?.value === "(") {
        const literal = tokens[index + 2];
        if (tokens[index + 3]?.value !== ")") {
          throw new PolicyStructureError(
            "an executable policy has an unknown dynamic module edge",
            { file, offset: token.start, form: "dynamic" },
          );
        }
        add(policySpecifier(file, literal, "dynamic"), "dynamic");
        continue;
      }
      if (next?.type === "string") {
        add(policySpecifier(file, next, "static"), "static");
        continue;
      }
      const end = statementEnd(index + 1);
      const from = tokens.findIndex(
        (candidate, tokenIndex) =>
          tokenIndex > index &&
          tokenIndex < end &&
          candidate.type === "identifier" &&
          candidate.value === "from",
      );
      if (from < 0) {
        throw new PolicyStructureError(
          "an executable policy import could not be bound to a direct module edge",
          { file, offset: token.start },
        );
      }
      add(policySpecifier(file, tokens[from + 1], "static"), "static");
      continue;
    }
    if (token.type !== "identifier" || token.value !== "export") {
      continue;
    }
    const next = tokens[index + 1];
    if (next?.value !== "*" && next?.value !== "{") {
      continue;
    }
    const end = statementEnd(index + 1);
    const from = tokens.findIndex(
      (candidate, tokenIndex) =>
        tokenIndex > index &&
        tokenIndex < end &&
        candidate.type === "identifier" &&
        candidate.value === "from",
    );
    if (from >= 0) {
      add(policySpecifier(file, tokens[from + 1], "static"), "static");
    }
  }

  return [
    ...new Map(edges.map((edge) => [policyEdgeKey(edge), edge])).values(),
  ].sort((left, right) =>
    policyEdgeKey(left).localeCompare(policyEdgeKey(right)),
  );
}

/** Capture exact raw and portable LF-canonical identities for the policy. */
function capturePolicySnapshot() {
  const dependencies = [];
  const graphFailures = [];
  const sourceBytes = new Map();
  for (const expected of POLICY_DEPENDENCY_MANIFEST) {
    const absolute = path.join(ROOT, ...expected.path.split("/"));
    let bytes;
    try {
      bytes = readFileSync(absolute);
    } catch (error) {
      throw new PolicyStructureError(
        "an executable policy dependency cannot be read",
        {
          file: expected.path,
          readError: error?.message ?? String(error),
        },
      );
    }
    const canonical = canonicalPolicySource(bytes, expected.path);
    sourceBytes.set(expected.path, bytes);
    const moduleEdges = policyModuleEdges(expected.path, canonical);
    const expectedEdges = expected.edges
      .map((edge) => ({ ...edge, form: edge.form ?? "static" }))
      .sort((left, right) =>
        policyEdgeKey(left).localeCompare(policyEdgeKey(right)),
      );
    if (
      JSON.stringify(moduleEdges.map(policyEdgeKey)) !==
      JSON.stringify(expectedEdges.map(policyEdgeKey))
    ) {
      graphFailures.push({
        file: expected.path,
        expected: expectedEdges,
        actual: moduleEdges,
      });
    }
    const localDependencies = moduleEdges
      .filter((edge) => edge.kind === "local")
      .map((edge) => edge.target);
    const builtinDependencies = moduleEdges
      .filter((edge) => edge.kind === "builtin")
      .map((edge) => edge.specifier);
    dependencies.push({
      path: expected.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      canonicalBytes: Buffer.byteLength(canonical, "utf8"),
      canonicalSha256: sha256(Buffer.from(canonical, "utf8")),
      localDependencies,
      builtinDependencies,
      moduleEdges,
    });
  }
  const rawClosure = Buffer.from(
    JSON.stringify(
      dependencies.map(({ path: file, bytes, sha256: hash }) => ({
        file,
        bytes,
        sha256: hash,
      })),
    ),
    "utf8",
  );
  const canonicalClosure = Buffer.from(
    JSON.stringify(
      dependencies.map(({ path: file, canonicalBytes, canonicalSha256 }) => ({
        file,
        bytes: canonicalBytes,
        sha256: canonicalSha256,
      })),
    ),
    "utf8",
  );
  const executionClosure = Buffer.from(
    JSON.stringify(
      dependencies.map(({ path: file, bytes, sha256: hash, moduleEdges }) => ({
        file,
        bytes,
        sha256: hash,
        moduleEdges,
      })),
    ),
    "utf8",
  );
  const snapshot = {
    dependencies,
    closureSha256: sha256(rawClosure),
    canonicalClosureSha256: sha256(canonicalClosure),
    capturedExecutionClosureSha256: sha256(executionClosure),
  };
  Object.defineProperty(snapshot, POLICY_SOURCE_BYTES, {
    value: sourceBytes,
    enumerable: false,
  });
  if (graphFailures.length > 0) {
    throw new PolicyStructureError(
      "the executable policy dependency closure no longer matches its required graph",
      {
        policyDependencies: {
          ...snapshot,
          stableAtLoad: false,
          stableAtEnd: null,
        },
        policyDependencyGraphFailures: graphFailures,
      },
    );
  }
  return snapshot;
}

/** Exact per-file changes between two policy snapshots. */
function policySnapshotDrift(before, after) {
  const afterByPath = new Map(
    after.dependencies.map((dependency) => [dependency.path, dependency]),
  );
  const drift = [];
  for (const expected of before.dependencies) {
    const actual = afterByPath.get(expected.path);
    if (
      actual === undefined ||
      expected.bytes !== actual.bytes ||
      expected.sha256 !== actual.sha256 ||
      expected.canonicalBytes !== actual.canonicalBytes ||
      expected.canonicalSha256 !== actual.canonicalSha256 ||
      JSON.stringify(expected.localDependencies) !==
        JSON.stringify(actual.localDependencies) ||
      JSON.stringify(expected.builtinDependencies) !==
        JSON.stringify(actual.builtinDependencies) ||
      JSON.stringify(expected.moduleEdges) !==
        JSON.stringify(actual.moduleEdges)
    ) {
      drift.push({ path: expected.path, before: expected, after: actual });
    }
  }
  for (const actual of after.dependencies) {
    if (!before.dependencies.some((entry) => entry.path === actual.path)) {
      drift.push({ path: actual.path, before: undefined, after: actual });
    }
  }
  return drift;
}

/** Execute a global regex against one immutable behavior-control string. */
function exactMatches(pattern, text) {
  const regex = new RegExp(pattern.source, pattern.flags);
  const matches = [];
  let match;
  let guard = 0;
  while ((match = regex.exec(text)) !== null && guard++ < 10_000) {
    matches.push(match[0]);
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }
  return matches;
}

/** Small JSON-safe verdict projection for immutable behavior controls. */
function verdictShape(evaluation) {
  return {
    checked: evaluation.checked,
    violations: evaluation.violations,
    ok: evaluation.ok,
    verdicts: evaluation.commits[0]?.verdicts.map(({ rule, status }) => ({
      rule,
      status,
    })),
  };
}

/** Record one semantic mismatch without depending on a test assertion lib. */
function requirePolicyValue(failures, control, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({ control, expected, actual });
  }
}

/**
 * Validate immutable required marker semantics and both integrated consumers.
 */
function validatePolicySemantics(policy) {
  const failures = [];
  const requiredIds = REQUIRED_MARKER_RULE_CONTROLS.map(
    (control) => control.id,
  );
  const controls = {
    requiredMarkerRules: requiredIds.length,
    requiredMarkerPositiveCases: REQUIRED_MARKER_RULE_CONTROLS.reduce(
      (total, control) => total + control.positives.length,
      0,
    ),
    requiredMarkerNegativeCases: REQUIRED_MARKER_RULE_CONTROLS.reduce(
      (total, control) => total + control.negatives.length,
      0,
    ),
    markerScanCases: 2,
    landingRuleScenarios: 3,
  };
  const markerRules = policy.MARKER_RULES;
  if (!Array.isArray(markerRules)) {
    failures.push({
      control: "marker-rules-shape",
      expected: "array",
      actual: typeof markerRules,
    });
    return {
      failures,
      brokenMarkerRules: [],
      markerRuleIds: [],
      controls,
    };
  }

  const ids = markerRules.map((rule) => rule?.id);
  requirePolicyValue(failures, "required-marker-rule-order", ids, requiredIds);
  for (const id of ids) {
    if (!requiredIds.includes(id)) {
      const label = JSON.stringify(id);
      failures.push({
        control: "marker-rule-control-coverage",
        expected: `marker rule ${label} has a behavioral control`,
        actual: `marker rule ${label} is uncontrolled; a control must be added for this rule id`,
      });
    }
  }
  requirePolicyValue(
    failures,
    "marker-rule-ids-unique",
    new Set(ids).size,
    ids.length,
  );

  for (const control of REQUIRED_MARKER_RULE_CONTROLS) {
    const rule = markerRules.find((candidate) => candidate?.id === control.id);
    if (rule === undefined) {
      failures.push({
        control: `required-marker-rule:${control.id}`,
        expected: "present",
        actual: "missing",
      });
      continue;
    }
    const patternShape = {
      isRegExp: rule.pattern instanceof RegExp,
      global: rule.pattern instanceof RegExp && rule.pattern.global,
    };
    requirePolicyValue(
      failures,
      `required-marker-pattern-shape:${control.id}`,
      patternShape,
      { isRegExp: true, global: true },
    );
    if (!patternShape.isRegExp || !patternShape.global) {
      continue;
    }
    for (const [index, positive] of control.positives.entries()) {
      requirePolicyValue(
        failures,
        `required-marker-positive:${control.id}:${index}`,
        exactMatches(rule.pattern, positive.text),
        positive.matches,
      );
    }
    for (const [index, negative] of control.negatives.entries()) {
      requirePolicyValue(
        failures,
        `required-marker-negative:${control.id}:${index}`,
        exactMatches(rule.pattern, negative),
        [],
      );
    }
  }

  let advertisedBroken = [];
  try {
    advertisedBroken = policy.selfTestRules(markerRules);
  } catch (error) {
    failures.push({
      control: "marker-self-test-call",
      expected: [],
      actual: { error: error?.message ?? String(error) },
    });
  }
  requirePolicyValue(failures, "marker-self-test-result", advertisedBroken, []);
  for (const [index, rule] of markerRules.entries()) {
    const independentlyValid =
      typeof rule?.id === "string" &&
      rule.id !== "" &&
      rule.pattern instanceof RegExp &&
      rule.pattern.global &&
      typeof rule.example === "string" &&
      exactMatches(rule.pattern, rule.example).length > 0;
    if (!independentlyValid) {
      failures.push({
        control: `independent-marker-self-test:${index}`,
        expected: "global regex matches its own example",
        actual: { id: rule?.id ?? null },
      });
    }
  }

  const markerControlPath =
    "packages/engine/Source/Scene/VerifierPolicyControl.js";
  const markerControlSource = [
    'const stringMarker = "// Batch 731";',
    "const regexMarker = /\\/\\/ Batch 731/u;",
    "// Batch 731 is the one real comment marker.",
    "export const value = stringMarker.length + regexMarker.source.length;",
    "",
  ].join("\n");
  try {
    requirePolicyValue(
      failures,
      "marker-scan-scope",
      {
        inScope: policy.isInScope(markerControlPath),
        outOfScope: policy.isInScope("migration_doc/VerifierPolicyControl.js"),
      },
      { inScope: true, outOfScope: false },
    );
    requirePolicyValue(
      failures,
      "marker-scan-comment-vs-literal",
      policy
        .scanSource(markerControlPath, markerControlSource)
        .map(({ line, ruleId, match }) => ({ line, ruleId, match })),
      [{ line: 3, ruleId: "batch-id", match: "Batch 731" }],
    );
  } catch (error) {
    failures.push({
      control: "marker-scan-execution",
      expected: "exact integrated finding",
      actual: { error: error?.message ?? String(error) },
    });
  }

  const commonCommit = {
    sha: "1".repeat(40),
    parents: ["0".repeat(40)],
    authorName: "cesium-webgpu-agent",
    authorEmail: "cesium-webgpu-agent@example.test",
  };
  const goodCommit = {
    ...commonCommit,
    authorDate: "2026-08-16T00:01:00-04:00",
    commitDate: "2026-08-16T00:01:00-04:00",
    subject: "Batch 101: immutable positive control",
    body: [
      "The immutable landing-policy positive control.",
      "",
      "Co-Authored-By: Policy Reviewer <reviewer@example.test>",
    ].join("\n"),
  };
  const badCommit = {
    ...commonCommit,
    authorDate: "2026-08-17T12:00:00-04:00",
    commitDate: "2026-08-17T12:00:00-04:00",
    subject: "batch 101: deliberately malformed",
    body: "",
  };
  const reusedBatchCommit = {
    ...goodCommit,
    subject: "Batch 100: reused batch control",
  };
  try {
    requirePolicyValue(
      failures,
      "landing-rules-positive",
      verdictShape(
        policy.evaluateCommits([goodCommit], {
          highestPushedBatch: 100,
          includeCommitQuietHours: true,
        }),
      ),
      {
        checked: 1,
        violations: 0,
        ok: true,
        verdicts: [
          { rule: "batch-prefix", status: "pass" },
          { rule: "batch-monotonic", status: "pass" },
          { rule: "body", status: "pass" },
          { rule: "co-author-trailer", status: "pass" },
          { rule: "commit-quiet-hours", status: "pass" },
        ],
      },
    );
    requirePolicyValue(
      failures,
      "landing-rules-negative",
      verdictShape(
        policy.evaluateCommits([badCommit], {
          highestPushedBatch: 100,
          includeCommitQuietHours: true,
        }),
      ),
      {
        checked: 1,
        violations: 4,
        ok: false,
        verdicts: [
          { rule: "batch-prefix", status: "fail" },
          { rule: "batch-monotonic", status: "skip" },
          { rule: "body", status: "fail" },
          { rule: "co-author-trailer", status: "fail" },
          { rule: "commit-quiet-hours", status: "fail" },
        ],
      },
    );
    requirePolicyValue(
      failures,
      "landing-rules-monotonic",
      verdictShape(
        policy.evaluateCommits([reusedBatchCommit], {
          highestPushedBatch: 100,
          includeCommitQuietHours: true,
        }),
      ),
      {
        checked: 1,
        violations: 1,
        ok: false,
        verdicts: [
          { rule: "batch-prefix", status: "pass" },
          { rule: "batch-monotonic", status: "fail" },
          { rule: "body", status: "pass" },
          { rule: "co-author-trailer", status: "pass" },
          { rule: "commit-quiet-hours", status: "pass" },
        ],
      },
    );
  } catch (error) {
    failures.push({
      control: "landing-rules-execution",
      expected: "three exact behavior controls",
      actual: { error: error?.message ?? String(error) },
    });
  }

  return {
    failures,
    brokenMarkerRules: advertisedBroken,
    markerRuleIds: ids,
    controls,
  };
}

/** JSON-safe identity of the exact executable policy used by a result. */
function policyDependencyReport(binding, stableAtEnd) {
  return {
    closureSha256: binding.start.closureSha256,
    canonicalClosureSha256: binding.start.canonicalClosureSha256,
    capturedExecutionClosureSha256:
      binding.start.capturedExecutionClosureSha256,
    executionMode: "private-byte-snapshot+registered-module-hooks",
    executionClosureSha256: binding.execution.closureSha256,
    executionClosureEqual:
      binding.execution.closureSha256 ===
      binding.start.capturedExecutionClosureSha256,
    executedModules: binding.execution.modules,
    executedModuleEdges: binding.execution.edges,
    stableAtLoad: true,
    stableAtEnd,
    dependencies: binding.start.dependencies,
    markerRuleIds: binding.semantics.markerRuleIds,
    semanticControls: binding.semantics.controls,
  };
}

/**
 * Install synchronous ESM hooks that serve captured bytes and reject every
 * undeclared resolution. Static analysis closes unexecuted/unknown edges;
 * these hooks independently bind the graph Node actually executes.
 */
function registerPolicyExecutionHooks(snapshot, privateRoot) {
  const urlToPath = new Map();
  const pathToUrl = new Map();
  const expectedEdges = new Map();
  for (const dependency of snapshot.dependencies) {
    const url = pathToFileURL(
      path.join(privateRoot, ...dependency.path.split("/")),
    ).href;
    urlToPath.set(url, dependency.path);
    pathToUrl.set(dependency.path, url);
    expectedEdges.set(
      dependency.path,
      new Map(dependency.moduleEdges.map((edge) => [edge.specifier, edge])),
    );
  }
  const executedModules = new Set();
  const executedEdges = new Map();

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentPath = urlToPath.get(context.parentURL);
      if (parentPath === undefined) {
        const resolved = nextResolve(specifier, context);
        if (!urlToPath.has(resolved.url)) {
          throw new PolicyStructureError(
            "policy execution attempted to enter an uncaptured module",
            {
              parent: context.parentURL ?? null,
              specifier,
              resolved: resolved.url,
            },
          );
        }
        return resolved;
      }

      const edge = expectedEdges.get(parentPath)?.get(specifier);
      if (edge === undefined) {
        throw new PolicyStructureError(
          "policy execution attempted an undeclared module edge",
          { parent: parentPath, specifier },
        );
      }
      const resolved = nextResolve(specifier, context);
      if (
        (edge.kind === "builtin" && resolved.url !== edge.specifier) ||
        (edge.kind === "local" && resolved.url !== pathToUrl.get(edge.target))
      ) {
        throw new PolicyStructureError(
          "policy execution resolved a declared edge to a different module",
          {
            parent: parentPath,
            edge,
            resolved: resolved.url,
          },
        );
      }
      executedEdges.set(`${parentPath}\0${policyEdgeKey(edge)}`, {
        parent: parentPath,
        ...edge,
      });
      return resolved;
    },
    load(url, context, nextLoad) {
      const dependencyPath = urlToPath.get(url);
      if (dependencyPath === undefined) {
        if (url.startsWith("node:")) {
          return nextLoad(url, context);
        }
        throw new PolicyStructureError(
          "policy execution attempted to load an uncaptured module",
          { url },
        );
      }
      const bytes = snapshot[POLICY_SOURCE_BYTES].get(dependencyPath);
      if (!Buffer.isBuffer(bytes)) {
        throw new PolicyStructureError(
          "captured policy bytes became unavailable during execution",
          { file: dependencyPath },
        );
      }
      executedModules.add(dependencyPath);
      return { format: "module", source: bytes, shortCircuit: true };
    },
  });

  return {
    hooks,
    pathToUrl,
    finish() {
      const modules = snapshot.dependencies
        .map((dependency) => dependency.path)
        .filter((dependencyPath) => executedModules.has(dependencyPath));
      const edges = [...executedEdges.values()].sort((left, right) =>
        `${left.parent}\0${policyEdgeKey(left)}`.localeCompare(
          `${right.parent}\0${policyEdgeKey(right)}`,
        ),
      );
      const executionClosure = Buffer.from(
        JSON.stringify(
          snapshot.dependencies
            .filter((dependency) => executedModules.has(dependency.path))
            .map(({ path: file, bytes, sha256: hash, moduleEdges }) => ({
              file,
              bytes,
              sha256: hash,
              moduleEdges: moduleEdges.filter((edge) =>
                executedEdges.has(`${file}\0${policyEdgeKey(edge)}`),
              ),
            })),
        ),
        "utf8",
      );
      const closureSha256 = sha256(executionClosure);
      if (
        modules.length !== snapshot.dependencies.length ||
        edges.length !==
          snapshot.dependencies.reduce(
            (total, dependency) => total + dependency.moduleEdges.length,
            0,
          ) ||
        closureSha256 !== snapshot.capturedExecutionClosureSha256
      ) {
        throw new PolicyStructureError(
          "executed policy closure does not equal the captured declared closure",
          {
            capturedExecutionClosureSha256:
              snapshot.capturedExecutionClosureSha256,
            executionClosureSha256: closureSha256,
            executedModules: modules,
            executedModuleEdges: edges,
          },
        );
      }
      return { closureSha256, modules, edges };
    },
  };
}

/** Materialize only the already-captured policy bytes in a private module tree. */
function materializePolicySnapshot(snapshot) {
  const directory = mkdtempSync(path.join(tmpdir(), "verify-landing-policy-"));
  try {
    for (const dependency of snapshot.dependencies) {
      const bytes = snapshot[POLICY_SOURCE_BYTES].get(dependency.path);
      if (!Buffer.isBuffer(bytes)) {
        throw new Error(
          `captured policy bytes are unavailable for ${dependency.path}`,
        );
      }
      const destination = path.join(directory, ...dependency.path.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new PolicyStructureError(
      "the captured executable policy could not be materialized privately",
      {
        policyDependencies: {
          ...snapshot,
          executionMode: "private-byte-snapshot+registered-module-hooks",
          executionClosureSha256: null,
          executionClosureEqual: false,
          stableAtLoad: false,
          stableAtEnd: null,
        },
        policyMaterializationError: error?.message ?? String(error),
      },
    );
  }
}

/** Render a policy boundary without conflating an unattempted check with drift. */
function formatPolicyStability(stability) {
  if (stability === true) {
    return "stable";
  }
  if (stability === false) {
    return "DRIFT";
  }
  return "not-reached";
}

/** Human-readable exact dependency tuple carried by text reports. */
function formatPolicyDependencyLines(report) {
  if (report === undefined || !Array.isArray(report.dependencies)) {
    return [];
  }
  const lines = [
    `  policy closure: raw ${report.closureSha256}; canonical-LF ${report.canonicalClosureSha256}; exec=${report.executionMode ?? "unbound"}; load=${formatPolicyStability(report.stableAtLoad)}; end=${formatPolicyStability(report.stableAtEnd)}`,
  ];
  for (const dependency of report.dependencies) {
    lines.push(
      `    ${dependency.path}  ${dependency.bytes} bytes ${dependency.sha256}; canonical-LF ${dependency.canonicalBytes} bytes ${dependency.canonicalSha256}`,
    );
  }
  return lines;
}

/** Snapshot, load, resnapshot, and behavior-test the executable policy. */
async function loadPolicyBinding() {
  const start = capturePolicySnapshot();
  const privateRoot = materializePolicySnapshot(start);
  const execution = registerPolicyExecutionHooks(start, privateRoot);
  let landingRules;
  let markerGuard;
  let markerGrammar;
  let executedClosure;
  try {
    [landingRules, markerGuard, markerGrammar] = await Promise.all([
      import(execution.pathToUrl.get("Tools/landing-rules.mjs")),
      import(execution.pathToUrl.get("Tools/c16/comment-marker-guard.mjs")),
      import(execution.pathToUrl.get("Tools/c16/lib/marker-grammar.mjs")),
    ]);
    executedClosure = execution.finish();
  } catch (error) {
    const cause =
      error instanceof PolicyStructureError ? error.details : undefined;
    throw new PolicyStructureError(
      "the snapshotted executable policy could not be loaded",
      {
        policyDependencies: {
          ...start,
          stableAtLoad: false,
          stableAtEnd: null,
        },
        policyLoadError: error?.message ?? String(error),
        ...(cause === undefined ? {} : { policyLoadCause: cause }),
      },
    );
  } finally {
    execution.hooks.deregister();
    rmSync(privateRoot, { recursive: true, force: true });
  }
  const loaded = capturePolicySnapshot();
  const loadDrift = policySnapshotDrift(start, loaded);
  if (loadDrift.length > 0) {
    throw new PolicyStructureError(
      "executable policy dependencies changed while they were being loaded",
      {
        policyDependencies: {
          ...start,
          stableAtLoad: false,
          stableAtEnd: null,
        },
        policyDependencyDrift: loadDrift,
      },
    );
  }
  const policy = Object.freeze({
    SCOPE_ROOTS: markerGuard.SCOPE_ROOTS,
    isCleanListed: markerGuard.isCleanListed,
    isInScope: markerGuard.isInScope,
    scanSource: markerGuard.scanSource,
    MARKER_RULES: markerGrammar.MARKER_RULES,
    selfTestRules: markerGrammar.selfTestRules,
    evaluateCommits: landingRules.evaluateCommits,
    highestBatchIn: landingRules.highestBatchIn,
    parseCommitRecords: landingRules.parseCommitRecords,
  });
  const semantics = validatePolicySemantics(policy);
  if (semantics.failures.length > 0) {
    throw new PolicyStructureError(
      semantics.brokenMarkerRules.length > 0
        ? "marker rules no longer match their own examples or immutable semantic controls"
        : "executable policy failed its immutable semantic controls",
      {
        policyDependencies: {
          ...start,
          stableAtLoad: true,
          stableAtEnd: null,
        },
        policySemanticFailures: semantics.failures,
        brokenMarkerRules: semantics.brokenMarkerRules,
        markerRuleIds: semantics.markerRuleIds,
      },
    );
  }
  return { start, execution: executedClosure, policy, semantics };
}

/** Final policy resnapshot; any byte or closure change invalidates the run. */
function terminalPolicyFailure(binding) {
  let end;
  try {
    end = capturePolicySnapshot();
  } catch (error) {
    if (error instanceof PolicyStructureError) {
      return {
        reason:
          "executable policy dependencies became unavailable or changed shape during verification",
        details: {
          ...error.details,
          terminalPolicyError: error.message,
          policyDependencies: policyDependencyReport(binding, false),
        },
      };
    }
    throw error;
  }
  const drift = policySnapshotDrift(binding.start, end);
  if (drift.length === 0) {
    return null;
  }
  return {
    reason: "executable policy dependencies changed during verification",
    details: {
      policyDependencies: policyDependencyReport(binding, false),
      terminalPolicyClosure: {
        closureSha256: end.closureSha256,
        canonicalClosureSha256: end.canonicalClosureSha256,
      },
      policyDependencyDrift: drift,
    },
  };
}

/** Read the already-loaded policy or fail as a verifier implementation error. */
function activePolicy() {
  if (ACTIVE_POLICY === undefined) {
    throw new Error("executable policy was used before its bound preflight");
  }
  return ACTIVE_POLICY;
}

/** Human-readable binding for the immutable private history subject. */
function formatHistorySubjectLines(report) {
  if (report === undefined) {
    return [];
  }
  return [
    `  history subject: ${report.subjectSha256} (${report.mode}; refs ${report.refs}; shallow=${report.shallow}; ignored replacements=${report.replacementRefsIgnored})`,
  ];
}

/** Execute Git in one explicitly selected repository context. */
function runGit(
  args,
  { cwd = ROOT, encoding = "utf8", env = SOURCE_GIT_ENV, input } = {},
) {
  return execFileSync("git", args, {
    cwd,
    encoding,
    env,
    input,
    maxBuffer: 1 << 28,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

/** Git against the caller's repository before any private view is active. */
function sourceGit(args) {
  return runGit(args);
}

/** Resolve one source-repository Git path to an absolute filesystem path. */
function sourceGitPath(name) {
  const value = sourceGit(["rev-parse", "--git-path", name]).trim();
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

/** Read one optional repository-state file exactly once. */
function readOptionalRepositoryFile(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Non-comment graft records captured in one exact source-state read. */
function activeGraftRecords(bytes) {
  if (bytes === null) {
    return [];
  }
  return canonicalPolicySource(bytes, "info/grafts")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Validate and return the captured shallow boundary object ids. */
function shallowBoundaries(bytes) {
  if (bytes === null) {
    return [];
  }
  const boundaries = canonicalPolicySource(bytes, "shallow")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    boundaries.some((boundary) => !FULL_OBJECT_ID.test(boundary)) ||
    new Set(boundaries).size !== boundaries.length
  ) {
    throw new HistoricalStructureError(
      "the captured shallow-history boundary is malformed",
      { shallowBoundaries: boundaries },
    );
  }
  return boundaries;
}

/** Capture all ordinary ref tips without importing replacement refs. */
function captureSourceRefs() {
  const raw = sourceGit([
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
  ]);
  const refs = [];
  const replacementRefs = [];
  for (const line of raw.split(/\r?\n/u).filter((entry) => entry !== "")) {
    const separator = line.indexOf("\t");
    const name = separator < 0 ? "" : line.slice(0, separator);
    const oid = separator < 0 ? "" : line.slice(separator + 1);
    if (!name.startsWith("refs/") || !FULL_OBJECT_ID.test(oid)) {
      throw new Error(`Git returned a malformed ref snapshot entry: ${line}`);
    }
    (name.startsWith("refs/replace/") ? replacementRefs : refs).push({
      name,
      oid,
    });
  }
  const byName = (left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  refs.sort(byName);
  replacementRefs.sort(byName);
  return { refs, replacementRefs };
}

/**
 * Create the only Git repository used for ancestry and historical reads.
 *
 * The view has its own refs, HEAD, graft namespace, and shallow file. Objects
 * remain content-addressed through a read-only alternate to avoid copying a
 * large repository, but mutable source graft/shallow/replacement state is no
 * longer in Git's repository context after this point.
 */
function createPrivateHistoryView() {
  const objectFormat = sourceGit(["rev-parse", "--show-object-format"]).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(
      `Git returned an unsupported object format: ${JSON.stringify(objectFormat)}`,
    );
  }
  const objectDirectory = sourceGitPath("objects");
  const sourceHead = sourceGit([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    "HEAD^{commit}",
  ]).trim();
  if (!FULL_OBJECT_ID.test(sourceHead)) {
    throw new HistoricalStructureError(
      "the source repository HEAD commit is unavailable",
      { sourceHead },
    );
  }
  const shallowBytes = readOptionalRepositoryFile(sourceGitPath("shallow"));
  const boundaries = shallowBoundaries(shallowBytes);
  const graftBytes = readOptionalRepositoryFile(sourceGitPath("info/grafts"));
  const graftRecords = activeGraftRecords(graftBytes);
  const { refs, replacementRefs } = captureSourceRefs();

  const directory = mkdtempSync(path.join(tmpdir(), "verify-landing-history-"));
  const gitDirectory = path.join(directory, "subject.git");
  const templateDirectory = path.join(directory, "empty-template");
  mkdirSync(templateDirectory);
  try {
    runGit(
      [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objectFormat}`,
        `--template=${templateDirectory}`,
        gitDirectory,
      ],
      { env: SOURCE_GIT_ENV },
    );
    const env = Object.freeze({
      ...SOURCE_GIT_ENV,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory,
      GIT_DIR: gitDirectory,
    });
    if (shallowBytes !== null) {
      writeFileSync(path.join(gitDirectory, "shallow"), shallowBytes);
    }
    if (refs.length > 0) {
      writeFileSync(
        path.join(gitDirectory, "packed-refs"),
        `# pack-refs with: sorted\n${refs
          .map(({ name, oid }) => `${oid} ${name}`)
          .join("\n")}\n`,
        "utf8",
      );
    }
    writeFileSync(path.join(gitDirectory, "HEAD"), `${sourceHead}\n`, "utf8");

    const emptyTree = runGit(["mktree"], {
      env,
      input: Buffer.alloc(0),
    }).trim();
    if (!FULL_OBJECT_ID.test(emptyTree)) {
      throw new Error(
        `Git returned a malformed empty-tree identity: ${JSON.stringify(emptyTree)}`,
      );
    }

    const privateShallow =
      runGit(["rev-parse", "--is-shallow-repository"], { env }).trim() ===
      "true";
    const expectedShallow = boundaries.length > 0;
    if (privateShallow !== expectedShallow) {
      throw new Error(
        "private history view did not reproduce its captured shallow boundary",
      );
    }

    const refSnapshot = Buffer.from(JSON.stringify(refs), "utf8");
    const replacementSnapshot = Buffer.from(
      JSON.stringify(replacementRefs),
      "utf8",
    );
    const identity = {
      schema: 1,
      mode: "private-bare-alternate+content-addressed-dag-snapshot",
      objectFormat,
      sourceHead,
      refs: refs.length,
      refsSha256: sha256(refSnapshot),
      shallow: privateShallow,
      shallowBoundaries: boundaries,
      shallowSha256: shallowBytes === null ? null : sha256(shallowBytes),
      legacyGrafts: graftRecords.length,
      legacyGraftsSha256: graftBytes === null ? null : sha256(graftBytes),
      replacementRefsIgnored: replacementRefs.length,
      replacementRefsSha256: sha256(replacementSnapshot),
    };
    const view = {
      directory,
      emptyTree,
      env,
      identity,
      refs: new Map(refs.map(({ name, oid }) => [name, oid])),
      snapshot: null,
    };
    let cleaned = false;
    view.cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    };
    process.once("exit", view.cleanup);
    return view;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Remove the active private view before the verifier promise settles. */
function cleanupActiveHistoryView() {
  const view = ACTIVE_HISTORY_VIEW;
  ACTIVE_HISTORY_VIEW = undefined;
  view?.cleanup?.();
}

/** Exact immutable subject identity carried by every post-snapshot result. */
function historySubjectReport(view, range) {
  const binding = {
    ...view.identity,
    rangeBase: range?.base ?? null,
    rangeHead: range?.head ?? null,
  };
  return {
    ...binding,
    subjectSha256: sha256(Buffer.from(JSON.stringify(binding), "utf8")),
  };
}

/**
 * Run git and return stdout.
 *
 * @param {string[]} args Arguments.
 * @returns {string} stdout.
 */
function git(args) {
  return runGit(args, {
    env: ACTIVE_HISTORY_VIEW?.env ?? SOURCE_GIT_ENV,
  });
}

/**
 * Run git with binary stdin/stdout for a length-framed batch protocol.
 *
 * @param {string[]} args Arguments.
 * @param {Buffer} input stdin.
 * @returns {Buffer} stdout.
 */
function gitBinary(args, input) {
  return runGit(args, {
    encoding: null,
    env: ACTIVE_HISTORY_VIEW?.env ?? SOURCE_GIT_ENV,
    input,
  });
}

/**
 * Split an exact two-dot revision range.
 *
 * Git accepts several range syntaxes and ignores additional positional
 * revisions in some command shapes. This verifier owns only A..B: exactly one
 * two-dot separator, no three-dot form, and two non-empty endpoints.
 *
 * @param {unknown} value Candidate range.
 * @returns {{base: string, head: string}} Endpoints.
 */
function splitExactRange(value) {
  if (typeof value !== "string") {
    throw new Error("--range needs a value");
  }
  const separator = value.indexOf("..");
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf("..") ||
    separator + 2 >= value.length ||
    value.includes("...")
  ) {
    throw new Error(
      `--range needs exactly one two-dot separator with non-empty endpoints (got ${JSON.stringify(value)})`,
    );
  }
  return {
    base: value.slice(0, separator),
    head: value.slice(separator + 2),
  };
}

/**
 * Parse argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{range: string|null, last: number|null, trustedBaselineBatch: number|null, json: boolean, help: boolean}} Options.
 */
export function parseArgs(argv) {
  const options = {
    range: null,
    last: null,
    trustedBaselineBatch: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--range") {
      if (argv[i + 1] === undefined) {
        throw new Error("--range needs a value");
      }
      options.range = argv[i + 1];
      i += 1;
    } else if (arg === "--last") {
      options.last = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--trusted-baseline-batch") {
      options.trustedBaselineBatch = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--range=")) {
      options.range = arg.slice("--range=".length);
    } else if (arg.startsWith("--last=")) {
      options.last = Number(arg.slice("--last=".length));
    } else if (arg.startsWith("--trusted-baseline-batch=")) {
      options.trustedBaselineBatch = Number(
        arg.slice("--trusted-baseline-batch=".length),
      );
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.range !== null) {
    splitExactRange(options.range);
  }
  if (options.range !== null && options.last !== null) {
    throw new Error("--range and --last are mutually exclusive");
  }
  if (
    options.last !== null &&
    (!Number.isInteger(options.last) || options.last <= 0)
  ) {
    throw new Error("--last needs a positive integer");
  }
  if (
    options.trustedBaselineBatch !== null &&
    (!Number.isInteger(options.trustedBaselineBatch) ||
      options.trustedBaselineBatch <= 0 ||
      options.trustedBaselineBatch > 999_999)
  ) {
    throw new Error(
      "--trusted-baseline-batch needs a positive batch integer of at most six digits",
    );
  }
  return options;
}

/**
 * Select the requested range before resolving either endpoint.
 *
 * @param {{range: string|null, last: number|null}} options Parsed options.
 * @returns {{baseRevision: string, headRevision: string, requested: string, kind: "range"|"last"|"default-upstream"|"default-last"|"default-detached-origin-main"|"default-detached-last", count?: number}} Requested range.
 */
function selectRange(options) {
  if (options.range !== null) {
    const { base, head } = splitExactRange(options.range);
    return {
      baseRevision: base,
      headRevision: head,
      requested: options.range,
      kind: "range",
    };
  }
  if (options.last !== null) {
    return {
      baseRevision: `HEAD~${options.last}`,
      headRevision: "HEAD",
      requested: `last ${options.last} commit(s)`,
      kind: "last",
      count: options.last,
    };
  }
  try {
    const upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]).trim();
    if (upstream === "") {
      throw new Error("Git returned an empty upstream name");
    }
    return {
      baseRevision: upstream,
      headRevision: "HEAD",
      requested: `${upstream}..HEAD`,
      kind: "default-upstream",
    };
  } catch (error) {
    const detachedHead = isDetachedHeadUpstreamFailure(error);
    if (!detachedHead && !isMissingUpstreamFailure(error)) {
      throw error;
    }
    const upstreamObject = resolveQuietObject("@{u}^{commit}");
    if (upstreamObject !== null) {
      throw error;
    }
    if (detachedHead) {
      const originMain = "refs/remotes/origin/main";
      const originMainObject = resolveQuietObject(`${originMain}^{commit}`);
      if (originMainObject !== null) {
        return {
          baseRevision: originMain,
          headRevision: "HEAD",
          requested: `${originMain}..HEAD (detached HEAD; using origin/main fallback)`,
          kind: "default-detached-origin-main",
        };
      }
      return {
        baseRevision: `HEAD~${DEFAULT_LAST}`,
        headRevision: "HEAD",
        requested: `last ${DEFAULT_LAST} commit(s) (detached HEAD; origin/main fallback unavailable)`,
        kind: "default-detached-last",
        count: DEFAULT_LAST,
      };
    }
    return {
      baseRevision: `HEAD~${DEFAULT_LAST}`,
      headRevision: "HEAD",
      requested: `last ${DEFAULT_LAST} commit(s) (no upstream configured)`,
      kind: "default-last",
      count: DEFAULT_LAST,
    };
  }
}

/** Peel one already captured object id to a commit without consulting refs. */
function peelImmutableCommit(oid) {
  try {
    const resolved = git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${oid}^{commit}`,
    ]).trim();
    if (!FULL_OBJECT_ID.test(resolved)) {
      throw new Error(
        `Git returned a malformed commit identity for ${oid}: ${JSON.stringify(resolved)}`,
      );
    }
    return resolved;
  } catch (error) {
    if (!isQuietRevisionAbsence(error)) {
      throw error;
    }
    if (!catFileRevisionMissing(`${oid}^{commit}`)) {
      throw error;
    }
    return null;
  }
}

/** Resolve a ref name only against the captured ordinary-ref snapshot. */
function capturedRefObject(revision) {
  const view = ACTIVE_HISTORY_VIEW;
  if (view === undefined) {
    throw new Error(
      "captured refs were used before private history activation",
    );
  }
  if (revision === "HEAD" || revision === "@") {
    return view.identity.sourceHead;
  }
  if (revision.startsWith("refs/")) {
    return view.refs.get(revision) ?? null;
  }
  const candidates = [
    `refs/heads/${revision}`,
    `refs/tags/${revision}`,
    `refs/remotes/${revision}`,
  ]
    .map((name) => view.refs.get(name))
    .filter((oid) => oid !== undefined);
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error(
      `captured revision name is ambiguous: ${JSON.stringify(revision)}`,
    );
  }
  return unique[0] ?? null;
}

/** Resolve one hex prefix from the object database, never from refs. */
function resolveAbbreviatedObject(prefix) {
  const raw = git(["rev-parse", `--disambiguate=${prefix}`]);
  const candidates = raw
    .split(/\r?\n/u)
    .filter((oid) => oid !== "")
    .map((oid) => {
      if (!FULL_OBJECT_ID.test(oid)) {
        throw new Error(
          `Git returned a malformed disambiguated object id: ${JSON.stringify(oid)}`,
        );
      }
      return peelImmutableCommit(oid);
    })
    .filter((oid) => oid !== null);
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error(
      `abbreviated commit identity is ambiguous: ${JSON.stringify(prefix)}`,
    );
  }
  return unique[0] ?? null;
}

/** Parse the intentionally supported immutable ancestry suffixes. */
function capturedRevisionExpression(revision) {
  let base = revision;
  if (base.endsWith("^{commit}")) {
    base = base.slice(0, -"^{commit}".length);
  }
  const operations = [];
  for (;;) {
    const match = /([~^])(\d*)$/u.exec(base);
    if (match === null) {
      break;
    }
    operations.unshift({
      kind: match[1],
      count: match[2] === "" ? 1 : Number(match[2]),
    });
    base = base.slice(0, -match[0].length);
  }
  if (
    base === "" ||
    base.includes("^") ||
    base.includes("~") ||
    operations.some(
      (operation) =>
        !Number.isSafeInteger(operation.count) || operation.count < 0,
    )
  ) {
    throw new Error(
      `unsupported captured revision expression: ${JSON.stringify(revision)}`,
    );
  }
  return { base, operations };
}

/** Resolve one revision using captured refs and raw immutable parent headers. */
function resolveCommitRevision(revision) {
  const expression = capturedRevisionExpression(revision);
  let oid;
  if (/^[0-9a-f]{4,64}$/iu.test(expression.base)) {
    oid = FULL_OBJECT_ID.test(expression.base)
      ? peelImmutableCommit(expression.base.toLowerCase())
      : resolveAbbreviatedObject(expression.base.toLowerCase());
  } else {
    const captured = capturedRefObject(expression.base);
    oid = captured === null ? null : peelImmutableCommit(captured);
  }
  if (oid === null) {
    return null;
  }
  const boundaries = new Set(ACTIVE_HISTORY_VIEW.identity.shallowBoundaries);
  for (const operation of expression.operations) {
    if (operation.kind === "^" && operation.count === 0) {
      continue;
    }
    const steps = operation.kind === "~" ? operation.count : 1;
    for (let step = 0; step < steps; step += 1) {
      if (boundaries.has(oid)) {
        return null;
      }
      let record;
      try {
        record = readHistoricalCommitObjects([oid]).get(oid);
      } catch (error) {
        if (
          error instanceof HistoricalStructureError &&
          /unavailable/u.test(error.message)
        ) {
          return null;
        }
        throw error;
      }
      const parentIndex = operation.kind === "~" ? 0 : operation.count - 1;
      oid = record?.parents[parentIndex] ?? null;
      if (oid === null) {
        return null;
      }
    }
  }
  return oid;
}

/**
 * Resolve both selected endpoints before using them in any history command.
 *
 * @param {{baseRevision: string, headRevision: string, requested: string, kind: string, count?: number}} selection Requested range.
 * @returns {{range?: {base: string, head: string, label: string, requested: string}, unavailable: string[], reason?: string}} Resolution.
 */
function resolveRangeEndpoints(selection) {
  const base = resolveCommitRevision(selection.baseRevision);
  const head = resolveCommitRevision(selection.headRevision);
  const unavailable = [];
  if (base === null) {
    unavailable.push(selection.baseRevision);
  }
  if (head === null) {
    unavailable.push(selection.headRevision);
  }
  if (unavailable.length > 0) {
    const reason =
      selection.kind === "last" ||
      selection.kind === "default-last" ||
      selection.kind === "default-detached-last"
        ? `${selection.requested} exceeds the locally available commit history`
        : `selected revision endpoint(s) are unavailable: ${unavailable.join(", ")}`;
    return { unavailable, reason };
  }
  return {
    unavailable,
    range: {
      base,
      head,
      label: `${base}..${head}`,
      requested: selection.requested,
    },
  };
}

/** Machine-readable range identity without presenting a symbolic label as bound. */
function rangeFields(range) {
  const fields = { requestedRange: range.requested };
  if (range.base !== undefined && range.head !== undefined) {
    return {
      ...fields,
      range: range.label,
      rangeBase: range.base,
      rangeHead: range.head,
    };
  }
  return fields;
}

/**
 * Emit a fail-closed STRUCTURAL result.
 *
 * @param {{json: boolean}} options Parsed options.
 * @param {{requested: string, label?: string, base?: string, head?: string}} range Selected range.
 * @param {string} reason Why verification is structurally incomplete.
 * @param {object} [details] Machine-readable details.
 * @returns {number} STRUCTURAL exit code.
 */
function emitStructural(options, range, reason, details = {}) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          structural: true,
          ...rangeFields(range),
          reason,
          ...details,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [
      `verify-landing: STRUCTURAL — ${range.label ?? `requested ${range.requested}`}: ${reason}`,
      ...formatPolicyDependencyLines(details.policyDependencies),
      ...formatHistorySubjectLines(details.historySubject),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return 3;
}

/**
 * Read raw parents from the commit object, bypassing shallow traversal grafts.
 *
 * @param {string} revision Commit revision.
 * @returns {string[]} Parent object ids.
 */
function rawCommitParents(revision) {
  const raw = git(["cat-file", "commit", revision]);
  const headerEnd = raw.indexOf("\n\n");
  const header = headerEnd < 0 ? raw : raw.slice(0, headerEnd);
  return header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length).trim());
}

/** Whether a parent commit object is locally available. */
function commitObjectAvailable(revision) {
  try {
    git(["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch (error) {
    if (!isCatFileAbsence(error)) {
      throw error;
    }
    if (resolveQuietObject(`${revision}^{commit}`) !== null) {
      throw error;
    }
    return false;
  }
}

/**
 * Bind evaluated commits to their raw parent objects and detect missing edges.
 *
 * @param {object[]} reports Evaluated commit reports.
 * @returns {{commits: object[], missingParents: Array<{commit: string, parent: string}>, unavailableCommits: string[]}} Bound commits.
 */
function bindCommitParents(reports) {
  const missingParents = [];
  const unavailableCommits = [];
  const commits = reports.map((report) => {
    if (!commitObjectAvailable(report.sha)) {
      unavailableCommits.push(report.sha);
      return { ...report, parents: [] };
    }
    let parents;
    try {
      parents = rawCommitParents(report.sha);
    } catch (error) {
      if (
        !isCatFileAbsence(error) ||
        resolveQuietObject(`${report.sha}^{commit}`) !== null
      ) {
        throw error;
      }
      unavailableCommits.push(report.sha);
      return { ...report, parents: [] };
    }
    for (const parent of parents) {
      if (!commitObjectAvailable(parent)) {
        missingParents.push({ commit: report.sha, parent });
      }
    }
    return { ...report, parents };
  });
  return { commits, missingParents, unavailableCommits };
}

/**
 * Resolve the monotonic-batch baseline without silently trusting shallow data.
 *
 * @param {{trustedBaselineBatch: number|null}} options Parsed options.
 * @param {{base: string}} range Selected range.
 * @param {boolean} shallow Whether shallow state was detected before enumeration.
 * @returns {{highest: number|null, source: "complete-history"|"trusted-contract", visibleHighest: number|null, structuralReason?: string}} Baseline result.
 */
function resolveBaselineBatch(options, range, shallow, snapshot) {
  if (shallow && options.trustedBaselineBatch === null) {
    return {
      highest: null,
      source: "complete-history",
      visibleHighest: null,
      structuralReason:
        "repository ancestry is shallow, so the monotonic-batch baseline is incomplete; rerun in a complete clone or supply --trusted-baseline-batch only from a trusted complete-history contract",
    };
  }
  const baseSubjects = [...snapshot.baseReachable]
    .map((revision) => snapshot.records.get(revision))
    .filter((record) => record.parents.length < 2)
    .map((record) => record.subject);
  const visibleHighest = activePolicy().highestBatchIn(baseSubjects);
  if (options.trustedBaselineBatch !== null) {
    if (
      visibleHighest !== null &&
      options.trustedBaselineBatch < visibleHighest
    ) {
      return {
        highest: options.trustedBaselineBatch,
        source: "trusted-contract",
        visibleHighest,
        structuralReason: `trusted baseline batch ${options.trustedBaselineBatch} contradicts visible batch ${visibleHighest}`,
      };
    }
    return {
      highest: options.trustedBaselineBatch,
      source: "trusted-contract",
      visibleHighest,
    };
  }
  return {
    highest: visibleHighest,
    source: "complete-history",
    visibleHighest,
  };
}

/**
 * A selected historical path/blob prerequisite is absent or malformed.
 */
class HistoricalStructureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HistoricalStructureError";
    this.details = details;
  }
}

/** Strictly decode one commit object's policy-bearing text. */
function historicalUtf8(bytes, details) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new HistoricalStructureError(
      "a historical commit object contains non-UTF-8 policy text",
      { ...details, decodeError: error?.message ?? String(error) },
    );
  }
}

/** Convert Git's epoch/offset identity timestamp to the ISO form policy uses. */
function gitIdentityDate(epochText, offsetText, details) {
  const epoch = Number(epochText);
  const match = /^([+-])(\d{2})(\d{2})$/u.exec(offsetText);
  if (!Number.isSafeInteger(epoch) || match === null) {
    throw new HistoricalStructureError(
      "a historical commit has a malformed identity timestamp",
      details,
    );
  }
  const offsetMinutes =
    (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
  const local = new Date((epoch + offsetMinutes * 60) * 1000);
  if (Number.isNaN(local.getTime())) {
    throw new HistoricalStructureError(
      "a historical commit identity timestamp is out of range",
      details,
    );
  }
  return `${local.toISOString().slice(0, 19)}${match[1]}${match[2]}:${match[3]}`;
}

/** Parse one author/committer header without consulting Git history state. */
function parseCommitIdentity(value, role, revision) {
  const match = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/u.exec(value);
  if (match === null) {
    throw new HistoricalStructureError(
      `a historical commit has a malformed ${role} identity`,
      { revision, role },
    );
  }
  return {
    name: match[1],
    email: match[2],
    epoch: Number(match[3]),
    date: gitIdentityDate(match[3], match[4], { revision, role }),
  };
}

/** Parse immutable raw commit bytes into the exact policy record and DAG edge. */
function parseRawCommitObject(revision, bytes) {
  const separator = bytes.indexOf(Buffer.from("\n\n"));
  if (separator < 0) {
    throw new HistoricalStructureError(
      "a historical commit object has no header/message boundary",
      { revision },
    );
  }
  const header = historicalUtf8(bytes.subarray(0, separator), { revision });
  const message = historicalUtf8(bytes.subarray(separator + 2), { revision });
  const headerLines = header.split("\n");
  const treeLines = headerLines.filter((line) => line.startsWith("tree "));
  const parentLines = headerLines.filter((line) => line.startsWith("parent "));
  const authorLines = headerLines.filter((line) => line.startsWith("author "));
  const committerLines = headerLines.filter((line) =>
    line.startsWith("committer "),
  );
  const tree = treeLines.length === 1 ? treeLines[0].slice(5) : "";
  const parents = parentLines.map((line) => line.slice(7));
  if (
    !FULL_OBJECT_ID.test(tree) ||
    parents.some((parent) => !FULL_OBJECT_ID.test(parent)) ||
    authorLines.length !== 1 ||
    committerLines.length !== 1
  ) {
    throw new HistoricalStructureError(
      "a historical commit object has malformed required headers",
      { revision, tree, parents },
    );
  }
  const author = parseCommitIdentity(
    authorLines[0].slice("author ".length),
    "author",
    revision,
  );
  const committer = parseCommitIdentity(
    committerLines[0].slice("committer ".length),
    "committer",
    revision,
  );
  const messageLines = message.replace(/\r\n?/gu, "\n").split("\n");
  const subject = messageLines.shift() ?? "";
  while (messageLines[0] === "") {
    messageLines.shift();
  }
  return {
    sha: revision,
    parents,
    tree,
    authorName: author.name,
    authorEmail: author.email,
    authorDate: author.date,
    commitDate: committer.date,
    committerEpoch: committer.epoch,
    subject,
    body: messageLines.join("\n").replace(/\n+$/u, ""),
    rawSha256: sha256(bytes),
  };
}

/** Read exact commit objects in one length-framed batch. */
function readHistoricalCommitObjects(revisions) {
  const unique = [...new Set(revisions)];
  if (unique.length === 0) {
    return new Map();
  }
  let output;
  try {
    output = gitBinary(
      ["cat-file", "--batch"],
      Buffer.from(`${unique.join("\n")}\n`, "ascii"),
    );
  } catch (error) {
    rethrowHistoricalGitFailure(
      error,
      "historical commit objects could not be captured",
      { revisions: unique },
      unique,
    );
  }
  const records = new Map();
  let offset = 0;
  for (const revision of unique) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new Error(`truncated cat-file commit header for ${revision}`);
    }
    const header = output.subarray(offset, newline).toString("ascii");
    offset = newline + 1;
    if (header.endsWith(" missing")) {
      throw new HistoricalStructureError(
        "a required historical commit object is unavailable",
        { revision },
      );
    }
    const match = /^([0-9a-f]+) ([^ ]+) (\d+)$/u.exec(header);
    if (match === null || match[1] !== revision) {
      throw new Error(
        `unexpected cat-file commit header for ${revision}: ${header}`,
      );
    }
    if (match[2] !== "commit") {
      throw new HistoricalStructureError(
        "a required historical revision is not a commit object",
        { revision, objectType: match[2] },
      );
    }
    const length = Number(match[3]);
    const end = offset + length;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`truncated cat-file commit body for ${revision}`);
    }
    records.set(
      revision,
      parseRawCommitObject(revision, output.subarray(offset, end)),
    );
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new Error("cat-file returned trailing commit-object bytes");
  }
  return records;
}

/**
 * Ask Git only for candidate commit ids. Raw parent headers below are the
 * authority, so a transient shallow/graft boundary can at most omit a
 * candidate that the closure-repair loop immediately discovers and captures.
 */
function candidateCommitIds(roots, phase) {
  const ordering = phase === "baseline-log" ? "--topo-order" : "--date-order";
  let raw;
  try {
    raw = git(["rev-list", "--parents", ordering, ...roots]);
  } catch (error) {
    rethrowHistoricalTraversalFailure(
      error,
      "a selected ancestry has unavailable commit or parent objects and could not be captured into the immutable snapshot",
      { phase, roots },
      ["--parents", ...roots],
    );
  }
  const ids = [];
  for (const line of raw.split(/\r?\n/u).filter((entry) => entry !== "")) {
    const fields = line.split(" ");
    if (fields.some((field) => !FULL_OBJECT_ID.test(field))) {
      throw new Error(`Git returned a malformed rev-list record: ${line}`);
    }
    ids.push(fields[0]);
  }
  return [...new Set([...roots, ...ids])];
}

/** Capture and repair one raw-parent closure, independent of traversal state. */
function captureReachableCommits(root, phase, boundaries, records) {
  let candidates = candidateCommitIds([root], phase);
  let rounds = 0;
  for (;;) {
    const uncaptured = candidates.filter((oid) => !records.has(oid));
    for (const [oid, record] of readHistoricalCommitObjects(uncaptured)) {
      records.set(oid, record);
    }

    const reachable = new Set();
    const missing = new Set();
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (reachable.has(oid)) {
        continue;
      }
      reachable.add(oid);
      const record = records.get(oid);
      if (record === undefined) {
        missing.add(oid);
        continue;
      }
      if (boundaries.has(oid)) {
        continue;
      }
      for (const parent of record.parents) {
        if (records.has(parent)) {
          stack.push(parent);
        } else {
          missing.add(parent);
        }
      }
    }
    if (missing.size === 0) {
      return reachable;
    }
    rounds += 1;
    if (rounds > 10_000) {
      throw new HistoricalStructureError(
        "historical ancestry closure could not be bounded",
        { root, phase, missing: [...missing] },
      );
    }
    candidates = candidateCommitIds([...missing], phase);
  }
}

/** Stable parent-before-child order derived only from captured commit bytes. */
function orderSelectedCommits(selected, records) {
  const indegree = new Map();
  const children = new Map();
  for (const oid of selected) {
    const record = records.get(oid);
    if (record === undefined) {
      throw new Error(`selected commit was not captured: ${oid}`);
    }
    const selectedParents = record.parents.filter((parent) =>
      selected.has(parent),
    );
    indegree.set(oid, selectedParents.length);
    for (const parent of selectedParents) {
      const entries = children.get(parent) ?? [];
      entries.push(oid);
      children.set(parent, entries);
    }
  }
  const compare = (left, right) => {
    const leftRecord = records.get(left);
    const rightRecord = records.get(right);
    return (
      leftRecord.committerEpoch - rightRecord.committerEpoch ||
      left.localeCompare(right)
    );
  };
  const ready = [...selected]
    .filter((oid) => indegree.get(oid) === 0)
    .sort(compare);
  const ordered = [];
  while (ready.length > 0) {
    const oid = ready.shift();
    ordered.push(records.get(oid));
    for (const child of children.get(oid) ?? []) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== selected.size) {
    throw new HistoricalStructureError(
      "captured historical commit graph is cyclic or incomplete",
      { selected: selected.size, ordered: ordered.length },
    );
  }
  return ordered;
}

/** Capture the exact content-addressed DAG used for baseline and range reads. */
function captureHistorySnapshot(view, range) {
  const boundaries = new Set(view.identity.shallowBoundaries);
  const records = new Map();
  const baseReachable = captureReachableCommits(
    range.base,
    "baseline-log",
    boundaries,
    records,
  );
  const headReachable = captureReachableCommits(
    range.head,
    "selected-range-log",
    boundaries,
    records,
  );
  const selected = new Set(
    [...headReachable].filter((oid) => !baseReachable.has(oid)),
  );
  const commits = orderSelectedCommits(selected, records);
  const captured = [...new Set([...baseReachable, ...headReachable])]
    .sort()
    .map((oid) => {
      const record = records.get(oid);
      return {
        oid,
        rawSha256: record.rawSha256,
        tree: record.tree,
        parents: record.parents,
      };
    });
  const closureSha256 = sha256(
    Buffer.from(
      JSON.stringify({
        base: range.base,
        head: range.head,
        shallowBoundaries: [...boundaries].sort(),
        commits: captured,
      }),
      "utf8",
    ),
  );
  const snapshot = {
    records,
    baseReachable,
    headReachable,
    commits,
    closureSha256,
  };
  view.snapshot = snapshot;
  view.identity = {
    ...view.identity,
    ancestryClosureSha256: closureSha256,
    ancestryCommits: captured.length,
    selectedCommits: commits.length,
  };
  return snapshot;
}

/** Full SHA-1/SHA-256 object ids carried by Git traversal diagnostics. */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const OBJECT_ID_IN_DIAGNOSTIC = /\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/giu;

/** Object types Git may truthfully return from cat-file -t. */
const GIT_OBJECT_TYPES = new Set(["blob", "tree", "commit", "tag"]);

/** Diagnostics that can name an absent object, pending an independent probe. */
const MISSING_OBJECT_DIAGNOSTIC =
  /(?:bad (?:object|tree)|not a valid object|not a tree object|unable to read (?:object|tree)|could not (?:get object info|read object)|could not read|failed to traverse parents of commit|missing (?:blob|tree))/iu;

/** The narrowly defined no-upstream states owned by default range selection. */
const MISSING_UPSTREAM_DIAGNOSTIC =
  /(?:no upstream configured|no such branch|unknown revision.*@\{u\}|ambiguous argument ['"]?@\{u\})/iu;

/** The detached-HEAD no-upstream diagnostic, which selects its own fallback. */
const DETACHED_HEAD_UPSTREAM_DIAGNOSTIC = /HEAD does not point to a branch/iu;

/** Return a Git subprocess's stderr as text without assuming its encoding. */
function gitFailureText(error) {
  if (Buffer.isBuffer(error?.stderr)) {
    return error.stderr.toString("utf8");
  }
  return typeof error?.stderr === "string" ? error.stderr : "";
}

/** Return a Git subprocess's stdout as text without assuming its encoding. */
function gitFailureOutput(error) {
  if (Buffer.isBuffer(error?.stdout)) {
    return error.stdout.toString("utf8");
  }
  return typeof error?.stdout === "string" ? error.stdout : "";
}

/** The exact quiet-rev-parse absence shape, not an arbitrary Git failure. */
function isQuietRevisionAbsence(error) {
  return (
    error?.status === 1 &&
    gitFailureText(error).trim() === "" &&
    gitFailureOutput(error).trim() === ""
  );
}

/** The exact cat-file absence diagnostics used by independent object probes. */
function isCatFileAbsence(error) {
  return (
    error?.status === 128 &&
    /(?:not a valid object name|git cat-file: could not get object info)/iu.test(
      gitFailureText(error),
    )
  );
}

/** Whether upstream selection failed specifically because no target exists. */
function isMissingUpstreamFailure(error) {
  return (
    Number.isInteger(error?.status) &&
    MISSING_UPSTREAM_DIAGNOSTIC.test(gitFailureText(error))
  );
}

/** Resolve one symbolic ref with the exact quiet-absence classification. */
function resolveQuietSymbolicRef(name) {
  try {
    const resolved = git(["symbolic-ref", "--quiet", name]).trim();
    if (resolved === "") {
      throw new Error(`Git returned an empty symbolic ref target for ${name}`);
    }
    return resolved;
  } catch (error) {
    if (isQuietRevisionAbsence(error)) {
      return null;
    }
    throw error;
  }
}

/** Whether the upstream diagnostic is backed by a positively detached HEAD. */
function isDetachedHeadUpstreamFailure(error) {
  return (
    Number.isInteger(error?.status) &&
    DETACHED_HEAD_UPSTREAM_DIAGNOSTIC.test(gitFailureText(error)) &&
    resolveQuietSymbolicRef("HEAD") === null
  );
}

/** Resolve a revision/object with a quiet, independently classifiable probe. */
function resolveQuietObject(specification) {
  try {
    const resolved = git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      specification,
    ]).trim();
    if (!FULL_OBJECT_ID.test(resolved)) {
      throw new Error(
        `Git returned a malformed object identity for ${specification}: ${JSON.stringify(resolved)}`,
      );
    }
    return resolved;
  } catch (error) {
    if (isQuietRevisionAbsence(error)) {
      return null;
    }
    throw error;
  }
}

/** Independently confirm that cat-file cannot resolve a revision. */
function catFileRevisionMissing(specification) {
  try {
    git(["cat-file", "-e", specification]);
    return false;
  } catch (error) {
    if (isCatFileAbsence(error)) {
      return true;
    }
    throw error;
  }
}

/** Object ids named by one Git diagnostic plus explicit immutable candidates. */
function diagnosticObjectIds(error, candidates = []) {
  return [
    ...new Set([
      ...candidates.filter((candidate) => FULL_OBJECT_ID.test(candidate)),
      ...(gitFailureText(error).match(OBJECT_ID_IN_DIAGNOSTIC) ?? []).map(
        (oid) => oid.toLowerCase(),
      ),
    ]),
  ];
}

/**
 * Return only objects whose absence is confirmed by a different plumbing
 * command. Unrecognized Git failures and present candidates remain ERRORs.
 */
function independentlyMissingObjects(error, candidates = []) {
  if (
    !Number.isInteger(error?.status) ||
    !MISSING_OBJECT_DIAGNOSTIC.test(gitFailureText(error))
  ) {
    throw error;
  }
  const missing = diagnosticObjectIds(error, candidates).filter(
    (oid) => resolveQuietObject(`${oid}^{object}`) === null,
  );
  if (missing.length === 0) {
    throw error;
  }
  return missing;
}

/**
 * Convert only independently confirmed object absence to STRUCTURAL; preserve
 * tool, invocation, and contradictory failures as verifier ERRORs.
 *
 * @returns {never}
 */
function rethrowHistoricalGitFailure(
  error,
  message,
  details = {},
  candidates = [],
) {
  const unavailableObjects = independentlyMissingObjects(error, candidates);
  throw new HistoricalStructureError(message, {
    ...details,
    unavailableObjects,
    gitFailure: gitFailureText(error).trim(),
  });
}

/**
 * Confirm a failed log with an independent rev-list traversal and object
 * probes before calling the selected history structurally incomplete.
 *
 * @returns {never}
 */
function rethrowHistoricalTraversalFailure(
  error,
  message,
  details,
  revListArgs,
) {
  if (
    !Number.isInteger(error?.status) ||
    !MISSING_OBJECT_DIAGNOSTIC.test(gitFailureText(error))
  ) {
    throw error;
  }
  let traversalError;
  try {
    git(["rev-list", ...revListArgs]);
  } catch (probeError) {
    traversalError = probeError;
  }
  if (traversalError === undefined) {
    throw error;
  }
  const unavailableObjects = independentlyMissingObjects(traversalError, [
    ...diagnosticObjectIds(error),
  ]);
  throw new HistoricalStructureError(message, {
    ...details,
    unavailableObjects,
    gitFailure: gitFailureText(error).trim(),
    traversalFailure: gitFailureText(traversalError).trim(),
  });
}

/** Read the tree object id recorded in an immutable commit object. */
function historicalCommitTree(revision) {
  const record = ACTIVE_HISTORY_VIEW?.snapshot?.records.get(revision);
  if (record === undefined) {
    throw new HistoricalStructureError(
      "a selected historical commit is absent from the immutable DAG snapshot",
      { revision },
    );
  }
  return record.tree;
}

/**
 * Prove the root trees needed by the selected range, commits, and parents are
 * locally readable before any recursive diff/path traversal.
 */
function assertHistoricalTreesAvailable(commits, range) {
  const revisionRoles = new Map();
  const addRevision = (revision, role) => {
    const roles = revisionRoles.get(revision) ?? new Set();
    roles.add(role);
    revisionRoles.set(revision, roles);
  };
  addRevision(range.base, "range-base");
  addRevision(range.head, "range-head");
  for (const commit of commits) {
    addRevision(commit.sha, "selected-commit");
    for (const parent of commit.parents ?? []) {
      addRevision(parent, "parent");
    }
  }

  const unavailableTrees = [];
  for (const [revision, roles] of revisionRoles) {
    const object = historicalCommitTree(revision);
    let type;
    try {
      type = git(["cat-file", "-t", object]).trim();
    } catch (error) {
      const unavailableObjects = independentlyMissingObjects(error, [object]);
      unavailableTrees.push({
        revision,
        object,
        roles: [...roles],
        unavailableObjects,
        gitFailure: gitFailureText(error).trim(),
      });
      continue;
    }
    if (!GIT_OBJECT_TYPES.has(type)) {
      throw new Error(
        `Git returned a malformed object type for ${object}: ${JSON.stringify(type)}`,
      );
    }
    if (type !== "tree") {
      throw new HistoricalStructureError(
        "a selected historical commit references a non-tree root object",
        { revision, object, objectType: type, roles: [...roles] },
      );
    }
  }
  if (unavailableTrees.length > 0) {
    throw new HistoricalStructureError(
      "selected historical commit or parent tree objects are unavailable",
      { unavailableTrees },
    );
  }
}

/** Git diff statuses whose after-commit path must resolve to a blob. */
const PRESENT_AFTER_STATUSES = new Set(["A", "C", "M", "T"]);

/** Split a NUL-framed Git response without decoding path bytes. */
function splitNulBytes(bytes) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) {
      continue;
    }
    fields.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) {
    throw new Error("Git returned a non-NUL-terminated path record");
  }
  return fields;
}

/** Exact raw-byte Git path plus reversible report and policy projections. */
function gitPathIdentity(value) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  const bytesBase64 = bytes.toString("base64");
  return {
    bytes,
    key: bytes.toString("hex"),
    text,
    policyPath: text ?? bytes.toString("utf8"),
    display: text ?? `git-path-base64:${bytesBase64}`,
    bytesBase64,
  };
}

/** JSON-safe raw identity fields for one historical path. */
function gitPathReport(identity) {
  return identity.text === null
    ? {
        file: identity.display,
        fileEncoding: "base64",
        fileBytesBase64: identity.bytesBase64,
      }
    : { file: identity.text };
}

/** Policy scope classification never supplies the lossy string as identity. */
function gitPathIsInScope(identity) {
  return activePolicy().isInScope(identity.policyPath);
}

const CLEAN_LIST_GIT_PATH = gitPathIdentity(CLEAN_LIST_PATH);

/**
 * Source paths one commit changed that the comment standard applies to.
 *
 * Anything outside the engine/widgets source roots is dropped using the
 * guard's own scope predicate rather than a second copy of the glob. The
 * NUL-framed status is retained: only D may legitimately have no after-commit
 * path, while A/C/M/T require an available blob object.
 *
 * @param {{sha: string, parents: string[]}} commit Commit record.
 * @returns {Array<{path: object, statuses: string[]}>} Exact paths and statuses.
 */
function changedScopeFiles(commit) {
  const revision = commit.sha;
  const currentTree = historicalCommitTree(revision);
  const parentTrees =
    commit.parents.length === 0
      ? [ACTIVE_HISTORY_VIEW.emptyTree]
      : commit.parents.map(historicalCommitTree);
  const byPath = new Map();
  for (const parentTree of parentTrees) {
    let raw;
    try {
      raw = gitBinary([
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "--no-ext-diff",
        "--no-renames",
        "--diff-filter=ACMDT",
        "-z",
        parentTree,
        currentTree,
        "--",
      ]);
    } catch (error) {
      rethrowHistoricalGitFailure(
        error,
        "a selected historical diff tree has unavailable prerequisite objects",
        { revision, parentTree, currentTree },
        [parentTree, currentTree],
      );
    }
    const fields = splitNulBytes(raw);
    for (let index = 0; index < fields.length;) {
      const statusToken = fields[index];
      index += 1;
      const statusText = statusToken?.toString("ascii");
      const status = statusText?.[0];
      if (
        status === undefined ||
        !/^[ACMDT][0-9]*$/u.test(statusText) ||
        !(PRESENT_AFTER_STATUSES.has(status) || status === "D")
      ) {
        throw new Error(
          `unexpected diff-tree status ${JSON.stringify(statusText)} for ${revision}`,
        );
      }
      if (status === "C") {
        index += 1;
      }
      const rawFile = fields[index];
      index += 1;
      if (rawFile === undefined) {
        throw new Error(
          `truncated diff-tree name-status record for ${revision}`,
        );
      }
      const pathIdentity = gitPathIdentity(rawFile);
      if (!gitPathIsInScope(pathIdentity)) {
        continue;
      }
      const entry = byPath.get(pathIdentity.key) ?? {
        path: pathIdentity,
        statuses: [],
      };
      if (!entry.statuses.includes(status)) {
        entry.statuses.push(status);
      }
      byPath.set(pathIdentity.key, entry);
    }
  }
  return [...byPath.values()];
}

/**
 * Select a fixed slash-separated tree root without interpreting the remaining
 * Git path bytes as host-platform separators.
 */
function historicalTreeSliceRoot(pathIdentity) {
  if (pathIdentity.key === CLEAN_LIST_GIT_PATH.key) {
    return "Tools/c16";
  }
  const root = activePolicy().SCOPE_ROOTS.find((candidate) =>
    pathIdentity.bytes
      .subarray(0, Buffer.byteLength(`${candidate}/`))
      .equals(Buffer.from(`${candidate}/`, "utf8")),
  );
  if (root === undefined || !gitPathIsInScope(pathIdentity)) {
    throw new Error(
      `historical tree lookup escaped owned scope: ${pathIdentity.display}`,
    );
  }
  return root;
}

/**
 * Enumerate one fixed tree slice without conflating Git path identities or
 * passing attacker-controlled separators through Git's platform-sensitive
 * pathspec parser.
 *
 * @param {string} revision Immutable commit id.
 * @param {string} sliceRoot Trusted repo-relative tree root.
 * @param {Map<string, Map<string, {path: object, mode: string, type: string, oid: string}>>} cache Per-scan tree-slice cache.
 * @param {string} contextFile Path to include in structural diagnostics.
 * @returns {Map<string, {path: object, mode: string, type: string, oid: string}>} Raw-path-key-to-entry map.
 */
function historicalTreeSliceEntries(
  revision,
  sliceRoot,
  cache,
  contextFile = sliceRoot,
) {
  const cacheKey = `${revision}\0${sliceRoot}`;
  let entries = cache.get(cacheKey);
  if (entries === undefined) {
    let raw;
    try {
      const tree = historicalCommitTree(revision);
      raw = gitBinary([
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        tree,
        "--",
        `:(top,literal)${sliceRoot}`,
      ]);
    } catch (error) {
      rethrowHistoricalGitFailure(
        error,
        "a selected historical tree or path has unavailable prerequisite objects",
        { revision, file: contextFile, sliceRoot },
        [historicalCommitTree(revision)],
      );
    }
    const records = splitNulBytes(raw);
    entries = new Map();
    for (const record of records) {
      const separator = record.indexOf(0x09);
      if (separator < 0) {
        throw new Error(
          `malformed ls-tree record for ${revision}:${sliceRoot}`,
        );
      }
      const [mode, type, oid, ...extra] = record
        .subarray(0, separator)
        .toString("ascii")
        .split(" ");
      const returnedPath = gitPathIdentity(record.subarray(separator + 1));
      if (
        mode === undefined ||
        !GIT_OBJECT_TYPES.has(type) ||
        !FULL_OBJECT_ID.test(oid) ||
        extra.length > 0 ||
        entries.has(returnedPath.key)
      ) {
        throw new Error(
          `malformed ls-tree identity for ${revision}:${returnedPath.display}`,
        );
      }
      entries.set(returnedPath.key, {
        path: returnedPath,
        mode,
        type,
        oid,
      });
    }
    cache.set(cacheKey, entries);
  }
  return entries;
}

/**
 * Resolve one exact path in one commit tree without conflating absence with a
 * missing referenced object.
 *
 * @param {string} revision Immutable commit id.
 * @param {object} pathIdentity Exact Git path identity.
 * @param {Map<string, Map<string, {mode: string, type: string, oid: string}>>} cache Per-scan tree-slice cache.
 * @returns {{present: false}|{present: true, mode: string, type: string, oid: string}} Tree entry.
 */
function historicalTreeEntry(revision, pathIdentity, cache) {
  const entries = historicalTreeSliceEntries(
    revision,
    historicalTreeSliceRoot(pathIdentity),
    cache,
    pathIdentity.display,
  );
  const entry = entries.get(pathIdentity.key);
  return entry === undefined ? { present: false } : { present: true, ...entry };
}

/**
 * Enumerate every exact in-scope source identity from one historical tree.
 * Tree and gitlink entries are retained so a newly clean-listed non-blob path
 * fails structurally instead of disappearing from the subject.
 *
 * @param {string} revision Immutable commit id.
 * @param {Map<string, Map<string, {mode: string, type: string, oid: string}>>} cache Per-scan tree-slice cache.
 * @returns {Map<string, {path: object, mode: string, type: string, oid: string}>} In-scope entries.
 */
function historicalSourceTreeEntries(revision, cache) {
  const sources = new Map();
  for (const scopeRoot of activePolicy().SCOPE_ROOTS) {
    const entries = historicalTreeSliceEntries(
      revision,
      scopeRoot,
      cache,
      scopeRoot,
    );
    for (const [pathKey, entry] of entries) {
      if (!gitPathIsInScope(entry.path)) {
        continue;
      }
      if (sources.has(pathKey)) {
        throw new Error(
          `historical source identity was enumerated twice for ${revision}:${entry.path.display}`,
        );
      }
      sources.set(pathKey, entry);
    }
  }
  return sources;
}

/**
 * Parse the historical clean-list text with the guard's contract.
 *
 * @param {string} text Blob text.
 * @returns {string[]} Clean-list entries.
 */
function parseHistoricalCleanList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\/+$/, ""));
}

/**
 * Read many already-resolved historical blob objects in one batch process.
 *
 * The batch protocol is parsed by declared byte length rather than by lines,
 * so source newlines and marker text cannot desynchronize the response. Tree
 * absence is resolved before this function; a missing or non-blob object here
 * is therefore STRUCTURAL, never a deletion.
 *
 * @param {Array<{oid: string, role: "source"|"clean-list", revision: string, file: string, statuses?: string[]}>} references Blob references.
 * @returns {Map<string, string>} Object-id-to-blob map.
 */
function readHistoricalBlobs(references) {
  const uniqueOids = [...new Set(references.map((reference) => reference.oid))];
  if (uniqueOids.length === 0) {
    return new Map();
  }
  for (const oid of uniqueOids) {
    if (!/^[0-9a-f]+$/u.test(oid)) {
      throw new Error(`historical blob object id is malformed: ${oid}`);
    }
  }
  let output;
  try {
    output = gitBinary(
      ["cat-file", "--batch"],
      Buffer.from(`${uniqueOids.join("\n")}\n`, "utf8"),
    );
  } catch (error) {
    rethrowHistoricalGitFailure(
      error,
      "referenced historical blob objects could not be read",
      { references },
      uniqueOids,
    );
  }
  const blobs = new Map();
  let offset = 0;
  for (const oid of uniqueOids) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new Error(`truncated cat-file header for ${oid}`);
    }
    const header = output.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    if (header.endsWith(" missing")) {
      if (resolveQuietObject(`${oid}^{object}`) !== null) {
        throw new Error(
          `cat-file reported a present historical blob as missing: ${oid}`,
        );
      }
      throw new HistoricalStructureError(
        "a referenced historical blob object is unavailable",
        {
          object: oid,
          references: references.filter((reference) => reference.oid === oid),
        },
      );
    }
    const match = /^([0-9a-f]+) ([^ ]+) (\d+)$/u.exec(header);
    if (match === null) {
      throw new Error(`unexpected cat-file header for ${oid}: ${header}`);
    }
    if (match[1] !== oid || match[2] !== "blob") {
      throw new HistoricalStructureError(
        "a referenced historical path does not resolve to the required blob object",
        {
          object: oid,
          objectType: match[2],
          references: references.filter((reference) => reference.oid === oid),
        },
      );
    }
    const byteLength = Number(match[3]);
    const end = offset + byteLength;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`truncated cat-file blob for ${oid}`);
    }
    blobs.set(oid, output.subarray(offset, end).toString("utf8"));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new Error("cat-file returned unexpected trailing bytes");
  }
  return blobs;
}

/**
 * Re-run the author-agnostic marker guard over every selected commit.
 *
 * Commit-local source blobs are enforced against the union of the parent and
 * current clean lists, matching the staged C16 contract. A clean-list addition
 * therefore takes effect in the same commit, and every newly covered source is
 * scanned from that commit's tree even when the source blob itself did not
 * change. Range-head and working-tree snapshots answer a different question
 * and can both erase a transient violation.
 *
 * @param {Array<{sha: string, governed: boolean}>} commits Evaluated commits.
 * @param {{base: string, head: string}} range Immutable range boundaries.
 * @returns {{errors: object[], warnings: object[], scanned: number, uniqueFiles: number, commits: number, pathsConsidered: number, deleted: number, policyAbsent: number, ratchetErrors: number}} Findings.
 */
function scanHistoricalMarkers(commits, range) {
  const policy = activePolicy();
  assertHistoricalTreesAvailable(commits, range);
  const treeEntryCache = new Map();
  const snapshots = commits.flatMap((commit) =>
    changedScopeFiles(commit).map(({ path: pathIdentity, statuses }) => ({
      commit: commit.sha,
      shortSha: commit.sha.slice(0, 10),
      path: pathIdentity,
      statuses,
    })),
  );
  const cleanListRevisions = [
    ...new Set(
      commits.flatMap((commit) => [commit.sha, ...(commit.parents ?? [])]),
    ),
  ];
  const references = [];
  const resolvedSnapshots = snapshots.map((snapshot) => {
    const entry = historicalTreeEntry(
      snapshot.commit,
      snapshot.path,
      treeEntryCache,
    );
    const deletionOnly = snapshot.statuses.every((status) => status === "D");
    if (!entry.present) {
      if (deletionOnly) {
        return { ...snapshot, deleted: true };
      }
      throw new HistoricalStructureError(
        "an A/C/M/T historical source path has no after-commit tree entry",
        {
          role: "source",
          revision: snapshot.commit,
          ...gitPathReport(snapshot.path),
          statuses: snapshot.statuses,
        },
      );
    }
    if (deletionOnly) {
      throw new HistoricalStructureError(
        "a D historical source path is still present after the commit",
        {
          role: "source",
          revision: snapshot.commit,
          ...gitPathReport(snapshot.path),
          statuses: snapshot.statuses,
          object: entry.oid,
          objectType: entry.type,
        },
      );
    }
    if (entry.type !== "blob") {
      throw new HistoricalStructureError(
        "an A/C/M/T historical source path resolves to a non-blob object",
        {
          role: "source",
          revision: snapshot.commit,
          ...gitPathReport(snapshot.path),
          statuses: snapshot.statuses,
          object: entry.oid,
          objectType: entry.type,
          mode: entry.mode,
        },
      );
    }
    const reference = {
      oid: entry.oid,
      role: "source",
      revision: snapshot.commit,
      ...gitPathReport(snapshot.path),
      statuses: snapshot.statuses,
    };
    references.push(reference);
    return { ...snapshot, deleted: false, oid: entry.oid };
  });
  const cleanListStates = new Map(
    cleanListRevisions.map((revision) => {
      const entry = historicalTreeEntry(
        revision,
        CLEAN_LIST_GIT_PATH,
        treeEntryCache,
      );
      if (!entry.present) {
        return [revision, { present: false }];
      }
      if (entry.type !== "blob") {
        throw new HistoricalStructureError(
          "a historical clean-list path resolves to a non-blob object",
          {
            role: "clean-list",
            revision,
            file: CLEAN_LIST_PATH,
            object: entry.oid,
            objectType: entry.type,
            mode: entry.mode,
          },
        );
      }
      references.push({
        oid: entry.oid,
        role: "clean-list",
        revision,
        file: CLEAN_LIST_PATH,
      });
      return [revision, { present: true, oid: entry.oid }];
    }),
  );
  const blobs = readHistoricalBlobs(references);
  const errors = [];
  const warnings = [];
  let scanned = 0;
  let ratchetErrors = 0;
  const uniqueFiles = new Set();
  const cleanLists = new Map(
    cleanListRevisions.map((revision) => {
      const state = cleanListStates.get(revision);
      if (state?.present !== true) {
        return [revision, []];
      }
      const text = blobs.get(state.oid);
      if (text === undefined) {
        throw new Error(
          `historical clean-list blob was not returned for ${revision}`,
        );
      }
      return [revision, parseHistoricalCleanList(text)];
    }),
  );
  const enforcedCleanLists = new Map();
  const snapshotKeys = new Set(
    resolvedSnapshots.map(
      (snapshot) => `${snapshot.commit}\0${snapshot.path.key}`,
    ),
  );
  const addedReferences = [];
  for (const commit of commits) {
    const parentEnforced = [
      ...new Set(
        (commit.parents ?? []).flatMap(
          (parent) => cleanLists.get(parent) ?? [],
        ),
      ),
    ];
    const current = cleanLists.get(commit.sha) ?? [];
    const enforced = [...new Set([...parentEnforced, ...current])];
    enforcedCleanLists.set(commit.sha, enforced);
    for (const priorEntry of parentEnforced) {
      if (policy.isCleanListed(priorEntry, current)) {
        continue;
      }
      ratchetErrors += 1;
      errors.push({
        file: CLEAN_LIST_PATH,
        line: 1,
        ruleId: "clean-list-ratchet-removal",
        match: priorEntry,
        text: `selected commit removed or narrowed parent-enforced clean-list entry ${priorEntry}`,
        commit: commit.sha,
        shortSha: commit.sha.slice(0, 10),
        cleanListed: true,
      });
    }

    const newEntries = current.filter(
      (entry) => !policy.isCleanListed(entry, parentEnforced),
    );
    if (newEntries.length === 0) {
      continue;
    }
    const currentSources = historicalSourceTreeEntries(
      commit.sha,
      treeEntryCache,
    );
    for (const cleanEntry of newEntries) {
      if (
        [...currentSources.values()].some((entry) =>
          policy.isCleanListed(entry.path.policyPath, [cleanEntry]),
        )
      ) {
        continue;
      }
      ratchetErrors += 1;
      errors.push({
        file: CLEAN_LIST_PATH,
        line: 1,
        ruleId: "clean-list-entry-unmatched",
        match: cleanEntry,
        text: `new clean-list entry does not cover an in-scope source in the selected commit: ${cleanEntry}`,
        commit: commit.sha,
        shortSha: commit.sha.slice(0, 10),
        cleanListed: true,
      });
    }
    for (const [pathKey, entry] of currentSources) {
      const pathIdentity = entry.path;
      if (
        !policy.isCleanListed(pathIdentity.policyPath, current) ||
        policy.isCleanListed(pathIdentity.policyPath, parentEnforced)
      ) {
        continue;
      }
      if (entry.type !== "blob") {
        throw new HistoricalStructureError(
          "a newly clean-listed historical source path resolves to a non-blob object",
          {
            role: "source",
            revision: commit.sha,
            ...gitPathReport(pathIdentity),
            object: entry.oid,
            objectType: entry.type,
            mode: entry.mode,
          },
        );
      }
      const snapshotKey = `${commit.sha}\0${pathKey}`;
      if (snapshotKeys.has(snapshotKey)) {
        continue;
      }
      snapshotKeys.add(snapshotKey);
      const reference = {
        oid: entry.oid,
        role: "source",
        revision: commit.sha,
        ...gitPathReport(pathIdentity),
        statuses: ["CLEAN_LIST_ADD"],
      };
      addedReferences.push(reference);
      resolvedSnapshots.push({
        commit: commit.sha,
        shortSha: commit.sha.slice(0, 10),
        path: pathIdentity,
        statuses: reference.statuses,
        deleted: false,
        oid: entry.oid,
      });
    }
  }
  for (const [oid, source] of readHistoricalBlobs(addedReferences)) {
    blobs.set(oid, source);
  }
  for (const snapshot of resolvedSnapshots) {
    if (snapshot.deleted) {
      continue;
    }
    const source = blobs.get(snapshot.oid);
    if (source === undefined) {
      throw new Error(
        `historical source blob was not returned for ${snapshot.commit}:${snapshot.path.display}`,
      );
    }
    scanned += 1;
    uniqueFiles.add(snapshot.path.key);
    const strict = policy.isCleanListed(
      snapshot.path.policyPath,
      enforcedCleanLists.get(snapshot.commit) ?? [],
    );
    for (const finding of policy.scanSource(snapshot.path.policyPath, source)) {
      (strict ? errors : warnings).push({
        ...finding,
        ...gitPathReport(snapshot.path),
        commit: snapshot.commit,
        shortSha: snapshot.shortSha,
        cleanListed: strict,
        gitStatuses: snapshot.statuses,
      });
    }
  }
  return {
    errors,
    warnings,
    scanned,
    uniqueFiles: uniqueFiles.size,
    commits: commits.length,
    pathsConsidered: resolvedSnapshots.length,
    deleted: resolvedSnapshots.filter((snapshot) => snapshot.deleted).length,
    policyAbsent: [...cleanListStates.values()].filter(
      (state) => !state.present,
    ).length,
    ratchetErrors,
  };
}

const STATUS_GLYPH = Object.freeze({
  pass: "ok  ",
  fail: "FAIL",
  skip: "--  ",
});

/**
 * Entry point.
 *
 * @returns {number} Process exit code.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        "verify-landing-compliance — re-check landed commits against the landing rules.",
        "",
        "  --range <A..B>   verify this range",
        "                    default: <upstream>..HEAD; detached HEAD prefers",
        "                    origin/main..HEAD, then the last 20 commits",
        "  --last <N>       verify the last N commits",
        "  --trusted-baseline-batch <N>",
        "                    use an externally trusted complete-history batch baseline",
        "  --json           machine-readable report",
        "",
        "Exit: 0 clean, 1 violations, 2 verifier failure, 3 structurally incomplete range/history.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const policyPreflightRange = {
    requested:
      options.range ??
      (options.last === null
        ? "default selected range"
        : `last ${options.last} commit(s)`),
    label: "executable policy preflight",
  };
  let policyBinding;
  try {
    policyBinding = await loadPolicyBinding();
  } catch (error) {
    if (error instanceof PolicyStructureError) {
      return emitStructural(
        options,
        policyPreflightRange,
        error.message,
        error.details,
      );
    }
    throw error;
  }
  ACTIVE_POLICY = policyBinding.policy;

  let historyView;
  const emitBoundStructural = (range, reason, details = {}) => {
    const terminalFailure = terminalPolicyFailure(policyBinding);
    const historyDetails =
      historyView === undefined
        ? {}
        : { historySubject: historySubjectReport(historyView, range) };
    if (terminalFailure !== null) {
      return emitStructural(options, range, terminalFailure.reason, {
        ...terminalFailure.details,
        ...historyDetails,
        interruptedStructuralResult: { reason, ...details },
      });
    }
    return emitStructural(options, range, reason, {
      ...details,
      ...historyDetails,
      policyDependencies: policyDependencyReport(policyBinding, true),
    });
  };

  const selection = selectRange(options);
  try {
    historyView = createPrivateHistoryView();
  } catch (error) {
    if (
      error instanceof HistoricalStructureError ||
      error instanceof PolicyStructureError
    ) {
      return emitBoundStructural(selection, error.message, error.details);
    }
    throw error;
  }
  ACTIVE_HISTORY_VIEW = historyView;

  // Endpoint resolution and every ancestry/log operation below now execute in
  // the private view. An overlong --last still reports STRUCTURAL, while later
  // source-repository shallow/graft/replacement ABA cannot change the subject.
  let resolution;
  try {
    resolution = resolveRangeEndpoints(selection);
  } catch (error) {
    if (error instanceof HistoricalStructureError) {
      return emitBoundStructural(selection, error.message, error.details);
    }
    throw error;
  }
  if (resolution.range === undefined) {
    return emitBoundStructural(selection, resolution.reason, {
      unavailableRevisions: resolution.unavailable,
    });
  }
  const range = resolution.range;
  if (historyView.identity.legacyGrafts > 0) {
    return emitBoundStructural(
      range,
      "repository has active legacy Git graft state; immutable ancestry cannot be established",
    );
  }
  const shallow = historyView.identity.shallow;

  let baseline;
  let highestPushedBatch;
  let commits;
  let evaluation;
  let markers;
  try {
    const historySnapshot = captureHistorySnapshot(historyView, range);
    baseline = resolveBaselineBatch(options, range, shallow, historySnapshot);
    if (baseline.structuralReason !== undefined) {
      return emitBoundStructural(range, baseline.structuralReason, {
        visibleBaselineBatch: baseline.visibleHighest,
        trustedBaselineBatch: options.trustedBaselineBatch,
      });
    }
    highestPushedBatch = baseline.highest;

    commits = historySnapshot.commits;

    if (commits.length === 0) {
      return emitBoundStructural(
        range,
        "contains no commits; nothing was verified",
      );
    }

    evaluation = activePolicy().evaluateCommits(commits, {
      highestPushedBatch,
      includeCommitQuietHours: true,
    });
    const bound = bindCommitParents(evaluation.commits);
    if (
      bound.unavailableCommits.length > 0 ||
      bound.missingParents.length > 0
    ) {
      throw new HistoricalStructureError(
        "selected history has unavailable commit or parent objects; historical marker policy cannot be reconstructed",
        {
          unavailableCommits: bound.unavailableCommits,
          missingParents: bound.missingParents,
        },
      );
    }
    markers = scanHistoricalMarkers(bound.commits, range);
  } catch (error) {
    if (error instanceof HistoricalStructureError) {
      return emitBoundStructural(range, error.message, {
        ...error.details,
        ...(evaluation === undefined
          ? {}
          : { measuredCommitViolations: evaluation.violations }),
      });
    }
    throw error;
  }
  const ok = evaluation.ok && markers.errors.length === 0;
  const terminalFailure = terminalPolicyFailure(policyBinding);
  if (terminalFailure !== null) {
    return emitStructural(options, range, terminalFailure.reason, {
      ...terminalFailure.details,
      historySubject: historySubjectReport(historyView, range),
      measuredCommitViolations: evaluation.violations,
      measuredMarkerErrors: markers.errors.length,
      measuredMarkerWarnings: markers.warnings.length,
    });
  }
  const policyDependencies = policyDependencyReport(policyBinding, true);
  const historySubject = historySubjectReport(historyView, range);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          ...rangeFields(range),
          highestPushedBatch,
          visibleBaselineBatch: baseline.visibleHighest,
          baselineSource: baseline.source,
          commits: evaluation.commits,
          violations: evaluation.violations,
          markerGuard: markers,
          policyDependencies,
          historySubject,
        },
        null,
        2,
      )}\n`,
    );
    return ok ? 0 : 1;
  }

  const lines = [
    `verify-landing: ${range.label} — ${commits.length} commit(s), ${evaluation.checked} governed, baseline batch ${highestPushedBatch ?? "none"}${baseline.source === "trusted-contract" ? " (trusted complete-history contract)" : ""}`,
    ...formatPolicyDependencyLines(policyDependencies),
    ...formatHistorySubjectLines(historySubject),
  ];
  for (const commit of evaluation.commits) {
    const failed = commit.verdicts.filter((entry) => entry.status === "fail");
    if (failed.length === 0) {
      continue;
    }
    lines.push(`  ${commit.shortSha}  ${commit.subject}`);
    for (const entry of failed) {
      lines.push(
        `    ${STATUS_GLYPH[entry.status]} ${entry.rule.padEnd(20)} ${entry.detail}`,
      );
    }
  }
  lines.push(
    `  marker guard: ${markers.scanned} in-scope historical snapshot(s) (${markers.uniqueFiles} unique file(s), ${markers.deleted} deleted state(s)) across ${markers.commits} selected commit(s) — ${markers.errors.length} error(s), ${markers.warnings.length} warning(s)`,
  );
  for (const finding of markers.errors) {
    lines.push(
      `    FAIL marker-guard        ${finding.shortSha} ${finding.file}:${finding.line} [${finding.ruleId}] ${finding.match}`,
    );
  }
  lines.push(
    ok
      ? "verify-landing: PASS"
      : `verify-landing: FAIL — ${evaluation.violations} commit rule violation(s)${markers.errors.length > 0 ? ` + ${markers.errors.length} marker-guard error(s)` : ""}`,
  );
  if (!ok) {
    lines.push(
      "  These commits are already landed; history is not rewritten (R-2026-08-14-4).",
      "  Record the violation honestly and fix the process, not the history.",
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `verify-landing: FAILED TO RUN — ${error?.message ?? error}\n`,
      );
      process.exitCode = 2;
    })
    .finally(() => {
      try {
        cleanupActiveHistoryView();
      } catch (error) {
        process.stderr.write(
          `verify-landing: FAILED TO CLEAN PRIVATE HISTORY — ${error?.message ?? error}\n`,
        );
        process.exitCode = 2;
      }
    });
}
