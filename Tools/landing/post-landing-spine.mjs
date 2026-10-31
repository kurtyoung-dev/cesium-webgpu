// post-landing-spine.mjs — refresh the context spine after a landing push.
// @purpose Refresh the context spine DB incrementally after a landing, and import the graphify code graph when the landed commit touched the engine or the spine itself, so the DB the next scoping pack reads is never stale; reports the before/after meta and a verdict through its exit code.
// @status ACTIVE
//
// WHY THIS EXISTS. No landing step refreshed the spine, so the seat's DB went 30 batches stale. The seat's landing
// runbook invokes this tool after each push and reads its exit code.
//
// WHAT IT DOES.
//   1. Resolves --commit (default HEAD) and lists the paths it touched. A landing is a squash commit with one parent
//      (or the root commit): `git diff-tree --root` lists its paths. A merge commit lists the first-parent diff
//      (`git diff <sha>^1 <sha>`), which is what the merge brought onto the branch it was made on.
//   2. Always runs `query-context.mjs build --incremental --repo <repo> --json` (about 4 s unchanged, 14 s with changes).
//   3. When graphify is due, runs `build --incremental --with-graphify --repo <repo> --json` (about 2 min 12 s) and
//      requires `graphify.executed === true` in the JSON. Graphify is due when a touched path is under
//      packages/engine/Source/ or Tools/context-spine/ (exact prefixes, POSIX separators), or --graphify forces it;
//      --no-graphify skips it. The second step is not attempted when the first failed.
//   4. Prints the meta (head_sha, built_at, graphify_imported_at) before and after, each step's seconds, and a verdict.
//      Success also requires the DB head_sha after the refresh to equal the repo HEAD (the build indexes HEAD, not --commit).
//
// Usage: node Tools/landing/post-landing-spine.mjs [--repo <root>] [--commit <rev>=HEAD] [--graphify | --no-graphify]
//          [--timeout-ms <n>=600000]
// Exit: 0 refreshed (graphify imported when due); 1 a step failed (spawn error, non-zero exit, timeout, unparsable JSON,
//       graphify not executed, or the DB head_sha after the refresh differs from the repo HEAD); 2 usage error or the
//       commit does not resolve.
// Spec: node --test Tools/landing/post-landing-spine.spec.mjs   See Tools/landing/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(here, "../..");
const DB_REL = ".cache/context-spine/cesium-context.sqlite";
const DEFAULT_TIMEOUT_MS = 600000;
const ENGINE_PREFIXES = Object.freeze([
  "packages/engine/Source/",
  "Tools/context-spine/",
]);

const isEnginePath = (p) =>
  ENGINE_PREFIXES.some((prefix) => p.startsWith(prefix));

const USAGE =
  "usage: post-landing-spine.mjs [--repo <root>] [--commit <rev>] [--graphify | --no-graphify] [--timeout-ms <n>]";

export function parseArgs(argv) {
  const opts = {
    repo: DEFAULT_REPO,
    commit: "HEAD",
    graphify: false,
    noGraphify: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${a} needs a value`);
      }
      return v;
    };
    if (a === "--repo") opts.repo = path.resolve(value());
    else if (a === "--commit") opts.commit = value();
    else if (a === "--graphify") opts.graphify = true;
    else if (a === "--no-graphify") opts.noGraphify = true;
    else if (a === "--timeout-ms") {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      opts.timeoutMs = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (opts.graphify && opts.noGraphify) {
    throw new Error("--graphify and --no-graphify are mutually exclusive");
  }
  return opts;
}

// Default runner seam: node <argv> in cwd.
function defaultRun(argv, { cwd, timeoutMs }) {
  const r = spawnSync(process.execPath, argv, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

// Default meta seam. Read-only, so a live MCP server holding the DB does not matter; a missing DB reads as all-null.
async function defaultReadMeta(dbPath) {
  const meta = { head_sha: null, built_at: null, graphify_imported_at: null };
  if (!fs.existsSync(dbPath)) return meta;
  // Imported on demand so a run that never reads the DB does not load the experimental module.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT key, value FROM meta").all()) {
      if (row.key in meta) meta[row.key] = String(row.value);
    }
  } finally {
    db.close();
  }
  return meta;
}

function defaultGit(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "" };
}

// Paths the commit touched, or null when git cannot list them.
function touchedPaths(repo, sha, git) {
  const parents = git(repo, ["rev-list", "--parents", "-n", "1", sha]);
  if (parents.status !== 0) return null;
  const parentCount = parents.stdout.trim().split(/\s+/).length - 1;
  const args =
    parentCount >= 2
      ? ["diff", "--name-only", "-z", `${sha}^1`, sha]
      : [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          "--root",
          sha,
        ];
  const r = git(repo, ["-c", "core.quotepath=off", ...args]);
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

const short = (v) => (v == null ? "none" : String(v).slice(0, 10));
const fmtMeta = (m) =>
  `head_sha=${short(m.head_sha)} built_at=${m.built_at ?? "none"} graphify_imported_at=${m.graphify_imported_at ?? "none"}`;

async function readMetaSafe(readMeta, dbPath) {
  try {
    const m = await readMeta(dbPath);
    return {
      head_sha: m?.head_sha ?? null,
      built_at: m?.built_at ?? null,
      graphify_imported_at: m?.graphify_imported_at ?? null,
    };
  } catch {
    return { head_sha: null, built_at: null, graphify_imported_at: null };
  }
}

// One build step: { ok, seconds, reason? }.
function buildStep(run, repo, withGraphify, timeoutMs, nowMs) {
  const argv = [
    path.join(repo, "Tools", "query-context.mjs"),
    "build",
    "--incremental",
    ...(withGraphify ? ["--with-graphify"] : []),
    "--repo",
    repo,
    "--json",
  ];
  const t0 = nowMs();
  let r;
  try {
    r = run(argv, { cwd: repo, timeoutMs });
  } catch (e) {
    r = { status: null, stdout: "", stderr: "", error: e };
  }
  const seconds = (nowMs() - t0) / 1000;
  const fail = (reason) => ({ ok: false, seconds, reason });
  if (r.error) {
    return fail(
      r.error.code === "ETIMEDOUT"
        ? `timed out after ${timeoutMs} ms`
        : `spawn error: ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
    return fail(
      `exit ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(-300)}`,
    );
  }
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return fail("build stdout is not parsable JSON");
  }
  if (withGraphify && json?.graphify?.executed !== true) {
    return fail(
      `graphify did not run: ${json?.graphify?.reason ?? "no graphify result in the build output"}`,
    );
  }
  return { ok: true, seconds };
}

/**
 * @param {{repo: string, commit: string, graphify: boolean, noGraphify: boolean, timeoutMs: number}} opts
 * @param {{run?: Function, readMeta?: Function, git?: Function, out?: Function, err?: Function, nowMs?: Function}} [seams]
 * @returns {Promise<number>} the exit code
 */
export async function postLandingSpine(opts, seams = {}) {
  const {
    run = defaultRun,
    readMeta = defaultReadMeta,
    git = defaultGit,
    out = (line) => process.stdout.write(`${line}\n`),
    err = (line) => process.stderr.write(`${line}\n`),
    nowMs = () => Date.now(),
  } = seams;
  if (opts.graphify && opts.noGraphify) {
    err(
      `post-landing-spine: --graphify and --no-graphify are mutually exclusive\n${USAGE}`,
    );
    return 2;
  }
  const { repo } = opts;
  const resolved = git(repo, [
    "rev-parse",
    "--verify",
    `${opts.commit}^{commit}`,
  ]);
  const sha = resolved.status === 0 ? resolved.stdout.trim() : "";
  const paths = sha ? touchedPaths(repo, sha, git) : null;
  if (!sha || paths === null) {
    err(
      `post-landing-spine: commit ${opts.commit} does not resolve in ${repo}`,
    );
    return 2;
  }

  const engineTouched = paths.some(isEnginePath);
  const graphifyDue = opts.noGraphify ? false : opts.graphify || engineTouched;
  const why = opts.noGraphify
    ? "--no-graphify"
    : opts.graphify
      ? "--graphify"
      : engineTouched
        ? "engine or spine path touched"
        : "no engine or spine path touched";
  out(
    `post-landing-spine: commit ${sha.slice(0, 10)} touched ${paths.length} path(s); graphify ${graphifyDue ? "due" : "not due"} (${why})`,
  );

  const dbPath = path.join(repo, DB_REL);
  out(`before: ${fmtMeta(await readMetaSafe(readMeta, dbPath))}`);

  const timings = { refresh: null, graphify: null };
  let failure = null;
  const refresh = buildStep(run, repo, false, opts.timeoutMs, nowMs);
  timings.refresh = refresh.seconds;
  if (!refresh.ok) failure = `refresh failed: ${refresh.reason}`;
  if (!failure && graphifyDue) {
    const g = buildStep(run, repo, true, opts.timeoutMs, nowMs);
    timings.graphify = g.seconds;
    if (!g.ok) failure = `graphify import failed: ${g.reason}`;
  }

  const after = await readMetaSafe(readMeta, dbPath);
  if (!failure) {
    const head = git(repo, ["rev-parse", "HEAD"]);
    const headSha = head.status === 0 ? head.stdout.trim() : "";
    if (!headSha || after.head_sha !== headSha) {
      failure = `DB head_sha ${short(after.head_sha)} differs from repo HEAD ${short(headSha)}`;
    }
  }
  const secs = (v) => (v == null ? "skipped" : `${v.toFixed(1)}s`);
  out(
    `after: ${fmtMeta(after)} refresh=${secs(timings.refresh)} graphify=${secs(timings.graphify)}`,
  );
  if (failure) {
    out(`verdict: FAILED ${failure}`);
    return 1;
  }
  out(
    `verdict: REFRESHED head_sha=${short(after.head_sha)}${graphifyDue ? " with graphify import" : ""}`,
  );
  return 0;
}

export async function main(argv, seams) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`post-landing-spine: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  return postLandingSpine(opts, seams);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
