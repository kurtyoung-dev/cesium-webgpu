// marker-grammar.mjs — the machine-readable half of the fork comment standard.
// @purpose Machine-decidable half of the fork comment standard: the banned tracker-vocabulary regex rules (add-only ids) driven by the marker guard.
// @status ACTIVE
//
// WHAT THIS ENCODES. `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`
// says a comment in `packages/engine/Source` or `packages/widgets/Source`
// describes what the code does and the constraints it obeys, and never the
// development history that produced it. Most of that standard is a judgement
// call a reviewer makes. This file is the part a machine can decide: the
// literal tracker vocabulary and decorative glyphs that only ever appear in
// history-flavoured comments.
//
// WHAT IT DELIBERATELY DOES NOT ENCODE. Narrative voice, first-person, comment
// placement, ALL-CAPS emphasis and JSDoc completeness are all part of the
// standard and none of them are in here. Regexes for those produce false
// positives at a rate that trains reviewers to ignore the tool, which costs
// more than the checks are worth. They are enforced in review; the rules below
// are enforced mechanically because they can be decided without context.
//
// ADD-ONLY DISCIPLINE. Rule ids appear in the clean-list ratchet and in batch
// reports. Add rules freely; do not rename or renumber an existing id, or the
// ratchet's history stops lining up with its own records.

/**
 * One mechanically-decidable marker family.
 *
 * `pattern` must carry the `g` flag: the guard counts every occurrence, not
 * just the first. `example` must match `pattern` — the guard's self-test
 * asserts it does before it scans anything, so a rule that has been broken by
 * an edit reports itself instead of silently matching nothing.
 *
 * @typedef {object} MarkerRule
 * @property {string} id Stable identifier used in reports and the clean list.
 * @property {RegExp} pattern Global regex applied to comment text.
 * @property {string} description What the family is and why it is banned.
 * @property {string} example A string the pattern must match.
 */

/** @type {MarkerRule[]} */
export const MARKER_RULES = Object.freeze([
  {
    id: "batch-id",
    pattern: /\bBatch(?:es)?[ -]\d+/g,
    description: "Batch numbers name a commit, not a constraint on the code.",
    example: "landed in Batch 731",
  },
  {
    id: "campaign-row-id",
    pattern: /\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b/g,
    description: "Campaign queue row ids belong in the queue, not the source.",
    example: "C15-G3b owns this",
  },
  {
    id: "parity-report-row-id",
    pattern: /\bQ\d{1,2}-[A-Z][A-Z0-9-]+\b/g,
    description: "Parity-report row ids belong in the report, not the source.",
    example: "Q13-PLAIN-HDR-GAMMA-CORE owns this",
  },
  {
    id: "campaign-name",
    pattern: /\bCampaign \d+/g,
    description: "Campaign names date the comment to a work programme.",
    example: "deferred to Campaign 14",
  },
  {
    id: "review-id",
    pattern: /\bC-R\d+/g,
    description: "Audit-round ids are review history.",
    example: "raised by C-R8",
  },
  {
    id: "dp-h-id",
    pattern: /\bDP-H\d+/g,
    description: "Design-point ids are planning history.",
    example: "per DP-H41",
  },
  {
    id: "far-id",
    pattern: /\bFAR-\d{3}/g,
    description: "Containment-flag ids are tracker identifiers.",
    example: "the FAR-003 flag",
  },
  {
    id: "takram",
    pattern: /\bTAKRAM\b/g,
    description: "A reference-implementation codename used as a tracker tag.",
    example: "the TAKRAM lane",
  },
  {
    id: "upstream-sync-id",
    pattern: /\bUP\d{3}-/g,
    description: "Upstream-sync work-item ids are tracker identifiers.",
    example: "UP144-03 reland",
  },
  {
    id: "cloud-unification-id",
    pattern: /\bCLOUD-U\d/g,
    description: "Cloud-unification work-item ids are tracker identifiers.",
    example: "CLOUD-U7 renamed it",
  },
  {
    id: "deferred-work-id",
    pattern: /\b(?:NEW|BUG|EPIC|FIX)-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*/g,
    description:
      "DEFERRED_WORK entry ids point at a backlog row, not at the code.",
    example: "NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL",
  },
  {
    id: "all-caps-fix-label",
    pattern:
      /(?<![A-Z0-9_-])(?!(?:NEW|BUG|EPIC|FIX)-)[A-Z]{3,}(?:-[A-Z]{3,}){2,}(?![A-Z0-9_-])/g,
    description:
      "Bare fix labels are development-history tags, not code constraints.",
    example: "POINT-SPRITE-SHAPE",
  },
  {
    id: "numbered-bug-id",
    pattern: /\bBUG-\d+/g,
    description: "Debugging-log bug numbers are history.",
    example: "the BUG-12 clear loop",
  },
  {
    id: "session-id",
    pattern: /\bSession \d+/g,
    description: "Session numbers date the comment to a working session.",
    example: "the Session 29 pattern",
  },
  {
    id: "tracker-document",
    pattern:
      /\b(?:DEFERRED_WORK|FEATURE_INVENTORY|WEBGPU_DEBUGGING_LOG|WEBGPU_MIGRATION_[A-Z]+|QUEUE_\d{4}-\d{2}-\d{2}|migration_doc\/)/g,
    description:
      "Pointers into the campaign paper trail; the code must stand alone.",
    example: "see DEFERRED_WORK",
  },
  {
    id: "decorative-glyph",
    pattern: /[★☆⚠❗‼✅❌✔✖⭐⭕\u{1F534}\u{1F7E2}\u{1F6A8}\u{1F525}]/gu,
    description:
      "Decorative emphasis glyphs (star, warning sign, tick, cross) do not " +
      "appear anywhere in upstream Cesium and identify a comment as ours.",
    example: "★ read this first",
  },
]);

/**
 * Confirm every rule still matches its own example.
 *
 * A detector that cannot detect is the failure mode this repository has paid
 * for repeatedly: a broken regex matches nothing, the scan reports zero
 * findings, and zero findings reads exactly like a clean tree. Callers run
 * this BEFORE scanning and treat a failure as a structural error, not a pass.
 *
 * @param {MarkerRule[]} [rules] Rules to check; defaults to the real grammar.
 *   The parameter exists so the spec can drive a deliberately broken rule
 *   through this function — a self-test nobody has ever seen fail is not
 *   evidence that it can.
 * @returns {string[]} Ids of rules that failed to match their own example.
 */
export function selfTestRules(rules = MARKER_RULES) {
  const broken = [];
  for (const rule of rules) {
    if (!(rule.pattern instanceof RegExp) || !rule.pattern.global) {
      broken.push(rule.id);
      continue;
    }
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(rule.example)) {
      broken.push(rule.id);
    }
    rule.pattern.lastIndex = 0;
  }
  return broken;
}

/**
 * Every marker occurrence in a block of comment text.
 *
 * @param {string} text Comment text, delimiters included.
 * @returns {Array<{ruleId: string, match: string, offset: number}>} Findings in
 *   rule order, each with its offset within `text`.
 */
export function findMarkers(text) {
  const found = [];
  for (const rule of MARKER_RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = rule.pattern.exec(text)) !== null && guard++ < 10000) {
      found.push({ ruleId: rule.id, match: match[0], offset: match.index });
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
      }
    }
    rule.pattern.lastIndex = 0;
  }
  return found.sort((a, b) => a.offset - b.offset);
}
