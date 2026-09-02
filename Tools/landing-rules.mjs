// landing-rules.mjs — the landing-discipline predicates, as pure functions.
// @purpose Pure landing predicates for commit discipline, push-wide Batch uniqueness, and protected remote-ref updates.
// @status ACTIVE
//
// Charter:  migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md §2.1/§2.2/§2.3
// Ruling:   migration_doc/MAINTAINER_RULINGS_2026-08-14.md R-2026-08-14-4
// Findings: SOL_WEEK_AUDIT_2026-08-14.md S9 (guard bypassed via --no-verify)
//           and S10 (24/98 commits inside quiet hours, 88 un-prefixed
//           subjects, 98 empty bodies, 0 co-author trailers).
//
// WHY A LIB AND NOT A HOOK SCRIPT. The pre-push hook and after-the-fact detector
// need identical commit-message and timestamp verdicts. The protected-ref rule
// is necessarily hook-only: a later commit-range scan cannot reconstruct a
// deletion or non-fast-forward update that bypassed the hook. Server-side branch
// protection is a separate control. Keeping the predicates here makes every
// rule testable without a repository: each verdict below is driven from literal
// records and `Date` instants in Tools/landing-rules.spec.mjs.
//
// NOTHING IN THIS FILE TOUCHES git, the filesystem, the clock, or the process
// exit code. `now` is always a parameter. That is what lets the DST cases be
// pinned against fixed UTC instants rather than against whenever the suite runs.

/** IANA zone the quiet-hours window is expressed in. */
export const QUIET_HOURS_ZONE = "America/New_York";

/** First hour (inclusive) of the prohibited weekday window, Eastern local. */
export const QUIET_HOURS_START_HOUR = 7;

/** First hour (exclusive end) after the prohibited window, Eastern local. */
export const QUIET_HOURS_END_HOUR = 19;

/** Author name whose commits the landing rules govern. */
export const AGENT_AUTHOR_NAME = "cesium-webgpu-agent";

/**
 * Subject grammar. The batch number is the spine of the evidence system, so
 * the prefix is matched exactly: capital B, a decimal number, a colon, one
 * space, then a non-empty remainder. `Batch 1043:` with nothing after it names
 * no work and does not pass.
 */
export const BATCH_SUBJECT_PATTERN = /^Batch (\d{1,6}): (\S.*)$/;

/**
 * A git trailer line. Used only to find the trailing trailer block so that a
 * message whose entire body IS the trailer is not mistaken for a record of
 * what landed.
 */
export const TRAILER_LINE_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[ \t]+\S/;

/**
 * The co-author trailer. Name and a bracketed address are both required — a
 * bare `Co-Authored-By:` key satisfies a substring search but attributes
 * nothing.
 */
export const CO_AUTHOR_PATTERN =
  /^co-authored-by:[ \t]*(\S[^<>]*?)[ \t]*<([^<>\s@]+@[^<>\s]+)>[ \t]*$/i;

const WEEKDAY_ORDER = Object.freeze([
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
]);

/** Header lines each `git log` record carries before the free-form body. */
const RECORD_HEADER_LINES = 7;

let easternFormatter;

/**
 * Build (once) the Eastern formatter.
 *
 * The offset is NEVER hardcoded. `Intl.DateTimeFormat` with an IANA zone
 * resolves the offset from the tz database for the instant being formatted, so
 * EST/EDT is handled by construction and the spec can pin a fixed UTC instant
 * either side of a transition and see the verdict flip. A build whose ICU
 * cannot resolve the zone throws here rather than silently formatting in UTC —
 * a guard that quietly measured the wrong zone would be worse than no guard.
 *
 * @returns {Intl.DateTimeFormat} Formatter pinned to the quiet-hours zone.
 */
function getEasternFormatter() {
  if (easternFormatter === undefined) {
    easternFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: QUIET_HOURS_ZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    });
    const resolved = easternFormatter.resolvedOptions().timeZone;
    if (resolved !== QUIET_HOURS_ZONE) {
      easternFormatter = undefined;
      throw new Error(
        `landing-rules: this runtime resolved "${QUIET_HOURS_ZONE}" to "${resolved}"; the quiet-hours window cannot be computed correctly.`,
      );
    }
  }
  return easternFormatter;
}

/**
 * Normalize the `shortOffset` token ("GMT-4", "GMT-4:30", "GMT") to a signed
 * ±HH:MM string, so the printed evidence shows which offset was in force.
 *
 * @param {string|undefined} token Raw timeZoneName part.
 * @returns {string} Offset as ±HH:MM.
 */
function normalizeOffset(token) {
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(token ?? "");
  if (match === null) {
    return token ?? "";
  }
  if (match[1] === undefined) {
    return "+00:00";
  }
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

/**
 * Project an instant onto the Eastern wall clock.
 *
 * @param {Date} instant The instant to project.
 * @returns {{weekday: string, weekdayIndex: number, year: number, month: number, day: number, hour: number, minute: number, second: number, minutesOfDay: number, isWeekday: boolean, utcOffset: string, label: string}} Wall-clock reading.
 */
export function easternWallClock(instant) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new TypeError("landing-rules: easternWallClock needs a valid Date.");
  }
  const parts = getEasternFormatter().formatToParts(instant);
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = read("weekday");
  const weekdayIndex = WEEKDAY_ORDER.indexOf(weekday);
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  const second = Number(read("second"));
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const utcOffset = normalizeOffset(read("timeZoneName"));
  const pad = (value) => String(value).padStart(2, "0");
  return {
    weekday,
    weekdayIndex,
    year,
    month,
    day,
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
    isWeekday: weekdayIndex >= 1 && weekdayIndex <= 5,
    utcOffset,
    label: `${weekday} ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)} (UTC${utcOffset})`,
  };
}

/**
 * Whether an instant falls inside the prohibited window.
 *
 * @param {Date} instant The instant to test.
 * @returns {boolean} True when weekday and 07:00 <= Eastern local < 19:00.
 */
export function isQuietHours(instant) {
  const clock = easternWallClock(instant);
  return (
    clock.isWeekday &&
    clock.minutesOfDay >= QUIET_HOURS_START_HOUR * 60 &&
    clock.minutesOfDay < QUIET_HOURS_END_HOUR * 60
  );
}

/**
 * Build a verdict record.
 *
 * @param {string} rule Stable rule id.
 * @param {"pass"|"fail"|"skip"} status Outcome.
 * @param {string} detail Human-readable explanation.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
function verdict(rule, status, detail) {
  return { rule, status, detail };
}

/**
 * Rule (d) — the push must not happen inside quiet hours.
 *
 * @param {Date} instant When the push is being attempted.
 * @returns {{rule: string, status: string, detail: string, clock: object}} Verdict.
 */
export function checkQuietHours(instant) {
  const clock = easternWallClock(instant);
  const inside = isQuietHours(instant);
  const window = `weekdays ${String(QUIET_HOURS_START_HOUR).padStart(2, "0")}:00-${QUIET_HOURS_END_HOUR}:00 US Eastern (${QUIET_HOURS_ZONE})`;
  return {
    ...verdict(
      "quiet-hours",
      inside ? "fail" : "pass",
      inside
        ? `inside the prohibited window: ${window}; now = ${clock.label}`
        : `outside the prohibited window (${window}); now = ${clock.label}`,
    ),
    clock,
  };
}

/**
 * Whether the landing rules govern this commit's author.
 *
 * @param {{authorName?: string, authorEmail?: string}} commit Commit record.
 * @returns {boolean} True for commits authored by the agent identity.
 */
export function isAgentAuthored(commit) {
  const name = (commit.authorName ?? "").trim().toLowerCase();
  const email = (commit.authorEmail ?? "").trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  return name === AGENT_AUTHOR_NAME || local === AGENT_AUTHOR_NAME;
}

/**
 * Rule (e) — merge commits (which is what an upstream sync is) skip (a)-(c).
 *
 * The subject and body of a merge are generated by `git merge`, and renumbering
 * them into the batch spine would attribute upstream's work to a batch. Quiet
 * hours still applies: a merge is as visible on GitHub as anything else.
 *
 * @param {{parents?: string[]}} commit Commit record.
 * @returns {boolean} True when the commit has two or more parents.
 */
export function isExempt(commit) {
  return (commit.parents ?? []).length >= 2;
}

/**
 * Split a commit body into narrative and its trailing trailer block.
 *
 * @param {string} body Raw `%b` output.
 * @returns {{narrative: string, trailers: string[]}} Split body.
 */
export function splitTrailers(body) {
  const lines = (body ?? "").replace(/\s+$/, "").split("\n");
  let start = lines.length;
  while (start > 0 && TRAILER_LINE_PATTERN.test(lines[start - 1])) {
    start -= 1;
  }
  return {
    narrative: lines.slice(0, start).join("\n").trim(),
    trailers: lines.slice(start),
  };
}

/**
 * Rule (a), first half — the subject carries a well-formed batch prefix.
 *
 * @param {{subject?: string}} commit Commit record.
 * @returns {{rule: string, status: string, detail: string, batch: number|null}} Verdict.
 */
export function checkBatchPrefix(commit) {
  const subject = commit.subject ?? "";
  const match = BATCH_SUBJECT_PATTERN.exec(subject);
  if (match === null) {
    return {
      ...verdict(
        "batch-prefix",
        "fail",
        `subject must start with "Batch NNNN: " and name the work; got ${JSON.stringify(subject)}`,
      ),
      batch: null,
    };
  }
  return {
    ...verdict("batch-prefix", "pass", `batch ${match[1]}`),
    batch: Number(match[1]),
  };
}

/**
 * Rule (a), second half — batch numbers only ever go up.
 *
 * `previousBatch` is seeded from the highest batch already on the remote and
 * then advanced across the pushed set, so both "reuses a landed number" and
 * "goes backwards inside one push" are caught by the same comparison.
 *
 * @param {number|null} batch This commit's number, or null when unparsed.
 * @param {number|null} previousBatch Highest number seen so far, or null.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
export function checkBatchMonotonic(batch, previousBatch) {
  if (batch === null) {
    return verdict(
      "batch-monotonic",
      "skip",
      "no batch number to compare (see batch-prefix)",
    );
  }
  if (previousBatch === null) {
    return verdict(
      "batch-monotonic",
      "pass",
      `no pushed baseline available; accepting ${batch}`,
    );
  }
  if (batch > previousBatch) {
    return verdict("batch-monotonic", "pass", `${batch} > ${previousBatch}`);
  }
  return verdict(
    "batch-monotonic",
    "fail",
    `batch ${batch} is not greater than the highest already-landed batch ${previousBatch}; numbers are global, monotonic and never reused`,
  );
}

/**
 * Rule (b) — the body says what landed.
 *
 * A body consisting solely of the co-author trailer is not a record, so the
 * trailer block is removed before the emptiness test. This is the same reading
 * the charter states in §2.2: "the subject line alone is not a record".
 *
 * @param {{body?: string}} commit Commit record.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
export function checkBody(commit) {
  const { narrative } = splitTrailers(commit.body ?? "");
  if (narrative === "") {
    return verdict(
      "body",
      "fail",
      "commit body is empty (trailers alone do not state what landed or what it discharges)",
    );
  }
  const lineCount = narrative.split("\n").length;
  return verdict(
    "body",
    "pass",
    `${narrative.length} chars over ${lineCount} line(s)`,
  );
}

/**
 * Rule (c) — the co-author trailer is present and attributes someone.
 *
 * @param {{body?: string}} commit Commit record.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
export function checkCoAuthorTrailer(commit) {
  const { trailers } = splitTrailers(commit.body ?? "");
  const match = trailers
    .map((line) => CO_AUTHOR_PATTERN.exec(line.trimEnd()))
    .find((result) => result !== null);
  if (match === undefined || match === null) {
    return verdict(
      "co-author-trailer",
      "fail",
      "no `Co-Authored-By: Name <email>` trailer",
    );
  }
  return verdict("co-author-trailer", "pass", `${match[1]} <${match[2]}>`);
}

/**
 * Rule (d) applied to a commit's own timestamps.
 *
 * Both the hook and the after-the-fact detector inspect these timestamps.
 * This is distinct from the push-instant window: commits carry visible dates
 * whenever they are pushed, and either the author or committer date is what a
 * reader can see.
 *
 * @param {{authorDate?: string, commitDate?: string}} commit Commit record.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
export function checkCommitQuietHours(commit) {
  const stamps = [
    ["author", commit.authorDate],
    ["committer", commit.commitDate],
  ].filter(([, value]) => typeof value === "string" && value !== "");
  if (stamps.length === 0) {
    return verdict("commit-quiet-hours", "skip", "no timestamps on the record");
  }
  const readings = stamps.map(([kind, value]) => {
    const instant = new Date(value);
    return { kind, instant, inside: isQuietHours(instant) };
  });
  const offending = readings.filter((reading) => reading.inside);
  if (offending.length === 0) {
    return verdict(
      "commit-quiet-hours",
      "pass",
      readings
        .map(
          (reading) =>
            `${reading.kind} ${easternWallClock(reading.instant).label}`,
        )
        .join("; "),
    );
  }
  return verdict(
    "commit-quiet-hours",
    "fail",
    `${offending
      .map(
        (reading) =>
          `${reading.kind} date ${easternWallClock(reading.instant).label}`,
      )
      .join(
        "; ",
      )} falls inside weekdays ${String(QUIET_HOURS_START_HOUR).padStart(2, "0")}:00-${QUIET_HOURS_END_HOUR}:00 US Eastern`,
  );
}

/**
 * Remote branches a lane must never delete and never force-rewrite.
 *
 * The trunk-only working model means main is the only long-lived ref; safety
 * and worker branches come and go under maintainer housekeeping, so only the
 * trunk is protected here.
 */
export const PROTECTED_REMOTE_BRANCHES = Object.freeze(["main"]);

/**
 * Whether a ref name (qualified or bare) is a protected branch.
 *
 * @param {string} refName Ref name as git reports it (`refs/heads/main`) or bare.
 * @returns {boolean} True when the ref is protected.
 */
export function isProtectedRef(refName) {
  const name = (refName ?? "").replace(/^refs\/heads\//, "");
  return PROTECTED_REMOTE_BRANCHES.includes(name);
}

/**
 * Rule (f) — a protected branch is never deleted and never force-rewritten.
 *
 * The fast-forward state is established by the git-aware driver (this module
 * never runs git): "new-ref" when the remote has no such branch yet,
 * "fast-forward" when the remote tip is an ancestor of what is being pushed,
 * "rewrite" when it is not, and "unverifiable" when the remote tip is not
 * present locally. Unverifiable fails closed: git itself refuses such a push
 * without --force, so the only push this refusal can stop is a forced one.
 *
 * The documented upstream sync stays legal: after `git merge upstream/main`,
 * main still has origin/main as an ancestor, so its `--force-with-lease` push
 * is a fast-forward — the lease is a safety latch there, not a rewrite.
 *
 * @param {{remoteRef?: string, isDeletion?: boolean, fastForward?: string}} update Ref update.
 * @returns {{rule: string, status: string, detail: string}} Verdict.
 */
export function checkRefUpdate(update) {
  const refName = update.remoteRef ?? "(ref)";
  if (!isProtectedRef(refName)) {
    return verdict(
      "protected-ref",
      "skip",
      `${refName} is not a protected branch; deletion and rewrite rules do not apply`,
    );
  }
  if (update.isDeletion === true) {
    return verdict(
      "protected-ref",
      "fail",
      `deleting ${refName} from the remote is refused — protected branches are never deleted by a lane`,
    );
  }
  switch (update.fastForward) {
    case "new-ref":
      return verdict(
        "protected-ref",
        "pass",
        `${refName} does not exist on the remote yet; nothing can be rewritten`,
      );
    case "fast-forward":
      return verdict(
        "protected-ref",
        "pass",
        `${refName} update is fast-forward; no remote history is discarded`,
      );
    case "rewrite":
      return verdict(
        "protected-ref",
        "fail",
        `non-fast-forward update of ${refName}: commits already on the remote would be discarded (history rewrite)`,
      );
    default:
      return verdict(
        "protected-ref",
        "fail",
        `the remote tip of ${refName} is not present locally, so fast-forward cannot be verified — fetch first (fail-closed)`,
      );
  }
}

/**
 * Push-wide rule — distinct commits may not reuse one Batch number.
 *
 * One commit can appear in several ref updates. It is identified by its object
 * ID and counted once; two different object IDs carrying the same governed
 * Batch number are a collision regardless of ref order. Prefix failures remain
 * owned by the per-commit rule and therefore do not create a second red here.
 *
 * @param {object[]} commits Commit records collected across every pushed ref.
 * @returns {{rule: string, status: string, detail: string}[]} One pass verdict or one failure per colliding Batch number.
 */
export function checkPushedBatchUniqueness(commits) {
  const uniqueCommits = new Map();
  for (const commit of commits) {
    const sha = (commit.sha ?? "").trim();
    if (sha === "") {
      throw new Error(
        "landing-rules: a pushed commit record is missing its object ID.",
      );
    }
    if (!uniqueCommits.has(sha)) {
      uniqueCommits.set(sha, commit);
    }
  }

  const ownersByBatch = new Map();
  for (const [sha, commit] of uniqueCommits) {
    if (!isAgentAuthored(commit) || isExempt(commit)) {
      continue;
    }
    const { batch } = checkBatchPrefix(commit);
    if (batch === null) {
      continue;
    }
    const owners = ownersByBatch.get(batch) ?? [];
    owners.push(sha);
    ownersByBatch.set(batch, owners);
  }

  const collisions = [...ownersByBatch]
    .filter(([, owners]) => owners.length > 1)
    .sort(([left], [right]) => left - right);
  if (collisions.length === 0) {
    return [
      verdict(
        "batch-unique",
        "pass",
        `${uniqueCommits.size} distinct pushed commit(s); no governed Batch number is reused`,
      ),
    ];
  }
  return collisions.map(([batch, owners]) =>
    verdict(
      "batch-unique",
      "fail",
      `batch ${batch} is used by distinct pushed commits ${owners
        .map((sha) => sha.slice(0, 10))
        .sort()
        .join(", ")}; Batch numbers are global and never reused`,
    ),
  );
}

/**
 * Evaluate an ordered (oldest first) set of commits.
 *
 * @param {object[]} commits Commit records.
 * @param {{highestPushedBatch?: number|null, includeCommitQuietHours?: boolean}} [options] Evaluation options.
 * @returns {{commits: object[], violations: number, checked: number, ok: boolean}} Evaluation.
 */
export function evaluateCommits(commits, options = {}) {
  const includeCommitQuietHours = options.includeCommitQuietHours === true;
  let previousBatch = options.highestPushedBatch ?? null;
  const reports = commits.map((commit) => {
    const governed = isAgentAuthored(commit);
    const exempt = isExempt(commit);
    const report = {
      sha: commit.sha,
      shortSha: (commit.sha ?? "").slice(0, 10),
      subject: commit.subject ?? "",
      author: `${commit.authorName ?? ""} <${commit.authorEmail ?? ""}>`,
      governed,
      exempt,
      verdicts: [],
    };
    if (!governed) {
      report.verdicts.push(
        verdict(
          "scope",
          "skip",
          `not authored by ${AGENT_AUTHOR_NAME}; landing rules do not apply`,
        ),
      );
      return report;
    }
    if (exempt) {
      report.verdicts.push(
        verdict(
          "merge-exemption",
          "skip",
          `${commit.parents.length} parents — merge / upstream sync; rules (a)-(c) do not apply`,
        ),
      );
      if (includeCommitQuietHours) {
        report.verdicts.push(checkCommitQuietHours(commit));
      }
      return report;
    }
    const prefix = checkBatchPrefix(commit);
    const monotonic = checkBatchMonotonic(prefix.batch, previousBatch);
    if (prefix.batch !== null && monotonic.status !== "fail") {
      previousBatch = prefix.batch;
    }
    report.verdicts.push(
      { rule: prefix.rule, status: prefix.status, detail: prefix.detail },
      monotonic,
      checkBody(commit),
      checkCoAuthorTrailer(commit),
    );
    if (includeCommitQuietHours) {
      report.verdicts.push(checkCommitQuietHours(commit));
    }
    return report;
  });
  const violations = reports.reduce(
    (total, report) =>
      total + report.verdicts.filter((entry) => entry.status === "fail").length,
    0,
  );
  return {
    commits: reports,
    violations,
    checked: reports.filter((report) => report.governed && !report.exempt)
      .length,
    ok: violations === 0,
  };
}

/**
 * Parse `git log -z --format='%H%n%P%n%an%n%ae%n%aI%n%cI%n%s%n%b'` output.
 *
 * Kept here (rather than in the git-aware drivers) because it is pure text
 * handling and both drivers need exactly one parser.
 *
 * @param {string} raw Raw stdout.
 * @returns {object[]} Commit records in the order git emitted them.
 */
export function parseCommitRecords(raw) {
  return (raw ?? "")
    .split("\0")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const lines = record.split("\n");
      if (lines.length < RECORD_HEADER_LINES) {
        throw new Error(
          `landing-rules: malformed git log record (${lines.length} lines): ${JSON.stringify(record.slice(0, 120))}`,
        );
      }
      const parents = lines[1].trim();
      return {
        sha: lines[0].trim(),
        parents: parents === "" ? [] : parents.split(/\s+/),
        authorName: lines[2],
        authorEmail: lines[3],
        authorDate: lines[4],
        commitDate: lines[5],
        subject: lines[6],
        body: lines.slice(RECORD_HEADER_LINES).join("\n"),
      };
    });
}

/**
 * Highest batch number appearing in a list of subjects.
 *
 * @param {string[]} subjects Commit subjects.
 * @returns {number|null} Highest number, or null when none parse.
 */
export function highestBatchIn(subjects) {
  let highest = null;
  for (const subject of subjects) {
    const match = BATCH_SUBJECT_PATTERN.exec(subject);
    if (match !== null) {
      const value = Number(match[1]);
      if (highest === null || value > highest) {
        highest = value;
      }
    }
  }
  return highest;
}

const STATUS_GLYPH = Object.freeze({
  pass: "ok  ",
  fail: "FAIL",
  skip: "--  ",
});

/**
 * Render a push evaluation as text.
 *
 * @param {{quietHours: object, pushVerdicts?: object[], refs: {name?: string, sourceRef?: string, destinationRef?: string, evaluation: object, highestPushedBatch: number|null, refVerdict?: object}[]}} result Push evaluation.
 * @param {{explain?: boolean}} [options] Rendering options.
 * @returns {string} Report.
 */
export function formatPushReport(result, options = {}) {
  const explain = options.explain === true;
  const lines = [];
  const quiet = result.quietHours;
  if (explain || quiet.status === "fail") {
    lines.push(`  ${STATUS_GLYPH[quiet.status]} quiet-hours  ${quiet.detail}`);
  }
  for (const entry of result.pushVerdicts ?? []) {
    if (explain || entry.status === "fail") {
      lines.push(
        `  ${STATUS_GLYPH[entry.status]} ${entry.rule.padEnd(18)} ${entry.detail}`,
      );
    }
  }
  for (const ref of result.refs) {
    const evaluation = ref.evaluation;
    const baseline =
      ref.highestPushedBatch === null ? "none" : String(ref.highestPushedBatch);
    if (explain) {
      const mapping =
        ref.sourceRef !== undefined && ref.destinationRef !== undefined
          ? `${ref.sourceRef} -> ${ref.destinationRef}`
          : (ref.name ?? "(ref)");
      lines.push(
        `  ${mapping}: ${evaluation.commits.length} distinct commit(s), ${evaluation.checked} governed, highest landed batch = ${baseline}`,
      );
    }
    const refVerdict = ref.refVerdict;
    if (refVerdict !== undefined && (explain || refVerdict.status === "fail")) {
      lines.push(
        `  ${STATUS_GLYPH[refVerdict.status]} ${refVerdict.rule.padEnd(18)} ${refVerdict.detail}`,
      );
    }
    for (const commit of evaluation.commits) {
      const failed = commit.verdicts.filter((entry) => entry.status === "fail");
      if (!explain && failed.length === 0) {
        continue;
      }
      lines.push(`  ${commit.shortSha}  ${commit.subject}`);
      const shown = explain ? commit.verdicts : failed;
      for (const entry of shown) {
        lines.push(
          `    ${STATUS_GLYPH[entry.status]} ${entry.rule.padEnd(18)} ${entry.detail}`,
        );
      }
    }
  }
  return lines.join("\n");
}
