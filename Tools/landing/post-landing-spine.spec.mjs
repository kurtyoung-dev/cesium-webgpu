// post-landing-spine.spec.mjs — behaviour spec for post-landing-spine.mjs over throwaway git repos and a fake build runner.
// @purpose Behaviour spec for the post-landing spine refresh: which build calls a landed commit causes (refresh always, graphify only for engine or spine paths or --graphify), the exit code of every failure class, and the before/after meta it prints.
// @status ACTIVE
//
// Each case commits real paths into a throwaway git repo under the lane temp root, drives the tool with a fake
// runner that records its argv and updates a fake DB meta the way a build would, and asserts on the calls made,
// the exit code and the printed lines. Run: node --test Tools/landing/post-landing-spine.spec.mjs
// (POST_LANDING_SPINE_TOOL=<path> aims it at a mutant copy of the tool.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { withLaneTmp } from "../lib/lane-tmp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(
  here,
  process.env.POST_LANDING_SPINE_TOOL ?? "./post-landing-spine.mjs",
);
const { postLandingSpine, main } = await import(pathToFileURL(TOOL).href);

const PRIOR = {
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  built_at: "2026-10-30T01:02:03.000Z",
  graphify_imported_at: "2026-10-29T04:05:06.000Z",
};

function git(repo, args) {
  const r = spawnSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=spec",
      "-c",
      "user.email=spec@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo, rel, text) {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Repo with a base commit and one commit touching `rels`; HEAD is the latter.
function makeRepo(dir, rels) {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, "README.md", "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  for (const rel of rels) write(repo, rel, `${rel}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "landing"]);
  return repo;
}

/**
 * Drives postLandingSpine with a fake build runner. `behave(call)` may return a replacement
 * { status, stdout, stderr, error } for a call; by default a build succeeds, writes head_sha/built_at
 * (and graphify_imported_at for a graphify call) into the fake DB, and prints build JSON.
 */
async function drive(repo, flags, behave = () => undefined) {
  const meta = { ...PRIOR };
  const calls = [];
  const lines = [];
  const errs = [];
  let tick = 0;
  const code = await postLandingSpine(
    {
      commit: "HEAD",
      graphify: false,
      noGraphify: false,
      timeoutMs: 1000,
      ...flags,
      repo,
    },
    {
      run: (argv, opts) => {
        const withGraphify = argv.includes("--with-graphify");
        const call = { argv, opts, withGraphify };
        calls.push(call);
        const override = behave(call, calls.length);
        if (override) return override;
        meta.head_sha = git(repo, ["rev-parse", "HEAD"]);
        meta.built_at = `2026-10-31T06:00:0${calls.length}.000Z`;
        if (withGraphify)
          meta.graphify_imported_at = "2026-10-31T06:10:00.000Z";
        return {
          status: 0,
          stdout: JSON.stringify({
            headSha: meta.head_sha,
            graphify: withGraphify ? { executed: true } : null,
          }),
          stderr: "",
        };
      },
      readMeta: () => ({ ...meta }),
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      nowMs: () => (tick += 1500),
    },
  );
  return { code, calls, lines, errs, meta };
}

const withRepo = (rels, fn) =>
  withLaneTmp("post-landing-spine-", (dir) => fn(makeRepo(dir, rels), dir), {
    laneName: "post-landing-spine-spec",
  });

describe("which build calls a landed commit causes", () => {
  for (const rel of [
    "packages/engine/Source/Scene/X.js",
    "Tools/context-spine/y.mjs",
  ]) {
    test(`${rel} -> refresh, then graphify import`, () =>
      withRepo([rel], async (repo) => {
        const r = await drive(repo, {});
        assert.equal(r.code, 0);
        assert.equal(r.calls.length, 2);
        assert.equal(r.calls[0].withGraphify, false);
        assert.equal(r.calls[1].withGraphify, true);
        for (const c of r.calls) {
          assert.ok(c.argv.includes("--incremental"));
          assert.ok(c.argv.includes("--json"));
          assert.equal(c.argv[c.argv.indexOf("--repo") + 1], repo);
          assert.equal(c.opts.cwd, repo);
          assert.equal(c.opts.timeoutMs, 1000);
        }
      }));
  }

  test("a docs-only commit -> refresh only", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      const r = await drive(repo, {});
      assert.equal(r.code, 0);
      assert.deepEqual(
        r.calls.map((c) => c.withGraphify),
        [false],
      );
    }));

  for (const rel of [
    "packages/engine/Specs/X.js",
    "Tools/context-spineX/a.mjs",
  ]) {
    test(`near-miss path ${rel} -> refresh only`, () =>
      withRepo([rel], async (repo) => {
        const r = await drive(repo, {});
        assert.equal(r.code, 0);
        assert.equal(r.calls.length, 1);
        assert.equal(r.calls[0].withGraphify, false);
      }));
  }

  test("--no-graphify on an engine commit -> refresh only", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, { noGraphify: true });
      assert.equal(r.code, 0);
      assert.equal(r.calls.length, 1);
      assert.equal(r.calls[0].withGraphify, false);
    }));

  test("--graphify on a docs commit -> refresh, then graphify", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      const r = await drive(repo, { graphify: true });
      assert.equal(r.code, 0);
      assert.deepEqual(
        r.calls.map((c) => c.withGraphify),
        [false, true],
      );
    }));

  test("both flags -> usage error, no build call", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, { graphify: true, noGraphify: true });
      assert.equal(r.code, 2);
      assert.equal(r.calls.length, 0);
      const cli = await main(["--repo", repo, "--graphify", "--no-graphify"], {
        run: () => assert.fail("no build may run on a usage error"),
      });
      assert.equal(cli, 2);
    }));

  test("a merge commit is judged by its first-parent diff", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      git(repo, ["checkout", "-q", "-b", "side"]);
      write(repo, "packages/engine/Source/Core/Z.js", "z\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "side"]);
      git(repo, ["checkout", "-q", "main"]);
      write(repo, "other.txt", "o\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "main work"]);
      git(repo, ["merge", "-q", "--no-ff", "-m", "merge", "side"]);
      const r = await drive(repo, {});
      assert.equal(r.code, 0);
      assert.equal(r.calls.length, 2);
    }));
});

describe("failures and their exit codes", () => {
  test("refresh fails -> exit 1 and graphify is never attempted", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, {}, () => ({
        status: 1,
        stdout: "",
        stderr: "boom",
      }));
      assert.equal(r.code, 1);
      assert.equal(r.calls.length, 1);
      assert.match(r.lines.at(-1), /^verdict: FAILED .*refresh failed.*boom/);
    }));

  test("a spawn error, a timeout and unparsable JSON are failures", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      const spawnErr = await drive(repo, {}, () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn node ENOENT"), {
          code: "ENOENT",
        }),
      }));
      assert.equal(spawnErr.code, 1);
      assert.match(spawnErr.lines.at(-1), /spawn error/);

      const timedOut = await drive(repo, {}, () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      }));
      assert.equal(timedOut.code, 1);
      assert.match(timedOut.lines.at(-1), /timed out after 1000 ms/);

      const garbage = await drive(repo, {}, () => ({
        status: 0,
        stdout: "Built something in 3ms",
        stderr: "",
      }));
      assert.equal(garbage.code, 1);
      assert.match(garbage.lines.at(-1), /not parsable JSON/);
    }));

  test("graphify reports executed:false -> exit 1 naming the reason", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, {}, (call) =>
        call.withGraphify
          ? {
              status: 0,
              stdout: JSON.stringify({
                graphify: {
                  executed: false,
                  reason: "graphify binary not found",
                },
              }),
              stderr: "",
            }
          : undefined,
      );
      assert.equal(r.code, 1);
      assert.equal(r.calls.length, 2);
      assert.match(
        r.lines.at(-1),
        /^verdict: FAILED .*graphify binary not found/,
      );
    }));

  test("graphify exits non-zero -> exit 1", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, {}, (call) =>
        call.withGraphify
          ? { status: 3, stdout: "", stderr: "nope" }
          : undefined,
      );
      assert.equal(r.code, 1);
      assert.match(r.lines.at(-1), /graphify import failed/);
    }));

  test("DB head_sha differing from the repo HEAD after the refresh -> exit 1", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      // The build reports success but leaves the DB carrying another sha.
      const r = await drive(repo, {}, () => ({
        status: 0,
        stdout: JSON.stringify({ graphify: null }),
        stderr: "",
      }));
      // The fake DB keeps PRIOR.head_sha (the override skipped the meta update), which is not HEAD.
      assert.notEqual(PRIOR.head_sha, git(repo, ["rev-parse", "HEAD"]));
      assert.equal(r.code, 1);
      assert.match(
        r.lines.at(-1),
        /^verdict: FAILED DB head_sha 0123456789 differs from repo HEAD/,
      );
    }));

  test("an unresolvable --commit -> exit 2 and no build call", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      const r = await drive(repo, { commit: "no-such-rev" });
      assert.equal(r.code, 2);
      assert.equal(r.calls.length, 0);
      assert.match(r.errs.join("\n"), /does not resolve/);
    }));
});

describe("printed report", () => {
  test("before and after lines carry head_sha, built_at and graphify_imported_at", () =>
    withRepo(["packages/engine/Source/Scene/X.js"], async (repo) => {
      const r = await drive(repo, {});
      const head = git(repo, ["rev-parse", "HEAD"]);
      const before = r.lines.find((l) => l.startsWith("before:"));
      assert.ok(before.includes(`head_sha=${PRIOR.head_sha.slice(0, 10)}`));
      assert.ok(before.includes(`built_at=${PRIOR.built_at}`));
      assert.ok(
        before.includes(`graphify_imported_at=${PRIOR.graphify_imported_at}`),
      );
      const after = r.lines.find((l) => l.startsWith("after:"));
      assert.ok(after.includes(`head_sha=${head.slice(0, 10)}`));
      assert.ok(after.includes("built_at=2026-10-31T06:00:02.000Z"));
      assert.ok(
        after.includes("graphify_imported_at=2026-10-31T06:10:00.000Z"),
      );
      assert.match(after, /refresh=1\.5s graphify=1\.5s/);
      assert.match(
        r.lines.at(-1),
        /^verdict: REFRESHED .*with graphify import/,
      );
    }));

  test("a missing DB prints none for every field and the skipped graphify step", () =>
    withRepo(["migration_doc/A.md"], async (repo) => {
      const lines = [];
      const code = await postLandingSpine(
        {
          repo,
          commit: "HEAD",
          graphify: false,
          noGraphify: false,
          timeoutMs: 1000,
        },
        {
          run: () => ({ status: 0, stdout: "{}", stderr: "" }),
          readMeta: () => ({
            head_sha: null,
            built_at: null,
            graphify_imported_at: null,
          }),
          out: (l) => lines.push(l),
        },
      );
      assert.equal(code, 1);
      assert.equal(
        lines.find((l) => l.startsWith("before:")),
        "before: head_sha=none built_at=none graphify_imported_at=none",
      );
      assert.match(
        lines.find((l) => l.startsWith("after:")),
        /graphify=skipped/,
      );
    }));
});
