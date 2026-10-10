// rebase-shared.spec.mjs - behaviour spec for rebase-shared.mjs, over synthetic git repos under os.tmpdir().
// @purpose Behaviour spec for the landing-time shared-hunk rebaser: semantic union, kept-as-is pass-through and every refusal, over synthetic git repos under os.tmpdir().
// @status ACTIVE
//
// Each case cuts a lane patch from an old base, advances the base with a competing landing that edits the
// same shared files next to the lane's hunks, then asserts on what the tool PRODUCES: the output applies
// with `git apply --3way --check` into a throwaway index and the resulting file content is exactly the
// semantic union. Run: node --test Tools/landing/rebase-shared.spec.mjs   (REBASE_SHARED_TOOL=<path> aims it at a mutant).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL =
  process.env.REBASE_SHARED_TOOL ?? path.join(here, "rebase-shared.mjs");
const PARENT = path.join(os.tmpdir(), "cesium-lane", "landing");
const ROOT = path.join(PARENT, `spec-${process.pid}`);

const CENSUS = "Tools/visual-regression/rig-registry.spec.mjs";
const TAGS = "Tools/visual-regression/lib/rig-registry.mjs";
const CONTRACT =
  "Tools/visual-regression/lib/probe-fleet-contract-allowlist.mjs";
const READER = "Tools/visual-regression/lib/prohibited-reader-allowlist.mjs";
const OTHER = "Tools/visual-regression/probe-new.mjs";
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

// ---- fixture builders (shaped like the real files) -------------------------------------------------
const nl = (eol) => (s) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function censusSpec({
  total,
  byTag,
  top = "// census spec\n",
  tail = "assert.ok(true);",
  eol = "\n",
}) {
  const entries = byTag
    .map(([key, value, comments = []]) => {
      const k = /^\w+$/.test(key) ? key : `"${key}"`;
      return [
        ...comments.map((c) => `    // ${c}`),
        `    ${k}: ${value},`,
      ].join("\n");
    })
    .join("\n");
  return nl(eol)(
    `import test from "node:test";\n${top}const REGISTRY_CENSUS = {\n  total: ${total},\n  byTag: {\n${entries}\n  },\n};\n\ntest("census", () => {\n  ${tail}\n});\n`,
  );
}

function tagsFile({
  tags,
  kinds = '["settleFrames", "settleMs"]',
  eol = "\n",
}) {
  return nl(eol)(
    `/** Frozen tag vocabulary. */\nexport const RIG_TAGS = Object.freeze([\n${tags.map((t) => `  "${t}",`).join("\n")}\n]);\n\n/** readiness */\nexport const READINESS_KINDS = Object.freeze(${kinds});\n`,
  );
}

const reason = (k) =>
  `no watchdog; browser.close outside finally — added 2026-06-01 (${k})`;
function contractFile({ rows, eol = "\n" }) {
  // rows: [key, reason?]
  return nl(eol)(
    `// contract allowlist\n/**\n * Probe file name -> one-line reason it is exempt.\n */\nexport const PROBE_CONTRACT_ALLOWLIST = Object.freeze({\n${rows.map(([k, r]) => `  "${k}":\n    "${r ?? reason(k)}",`).join("\n")}\n});\n`,
  );
}

function readerFile({ rows, snapshot, eol = "\n" }) {
  return nl(eol)(
    `// prohibited readers\nconst R =\n  "copies a live canvas";\n\nexport const PROHIBITED_READER_ALLOWLIST = Object.freeze({\n${rows.map((k) => `  "${k}": R,`).join("\n")}\n});\n\nexport const PROHIBITED_READER_ALLOWLIST_SNAPSHOT = Object.freeze({\n  size: ${snapshot.length},\n  members: Object.freeze([\n${snapshot.map((k) => `    "${k}",`).join("\n")}\n  ]),\n});\n`,
  );
}

const names = (prefix, n) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}${String(i).padStart(2, "0")}.mjs`,
  );
const without = (arr, ...drop) => arr.filter((x) => !drop.includes(x));
const R = names("probe-r", 12);
const P = names("probe-p", 8);

function baseFiles(eol = "\n") {
  return {
    [CENSUS]: censusSpec({
      total: 41,
      byTag: [
        ["wave-end", 10],
        ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
        ["aurora", 4],
      ],
      eol,
    }),
    [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora"], eol }),
    [CONTRACT]: contractFile({ rows: R.map((k) => [k]), eol }),
    [READER]: readerFile({ rows: P, snapshot: P, eol }),
  };
}

// ---- git helpers ------------------------------------------------------------------------------------
const git = (repo, args, o = {}) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "latin1",
    env: o.env ?? process.env,
    input: o.input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  });
let counter = 0;
const fresh = (label) => path.join(ROOT, `${label}-${++counter}`);

function mkRepo(label, files) {
  const dir = fresh(label);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [
    ["user.name", "spec"],
    ["user.email", "spec@example.invalid"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
  ])
    git(dir, ["config", k, v]);
  commit(dir, files, "base");
  return dir;
}
function write(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c, "utf8");
  }
}
function commit(dir, files, msg) {
  write(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}
// Cut a lane patch off the current HEAD, then put HEAD's tree back.
function cutLane(dir, files, name = "lane") {
  write(dir, files);
  git(dir, ["add", "-A"]);
  const patch = git(dir, ["diff", "--cached", "--binary"]);
  git(dir, ["reset", "-q", "--hard"]);
  const p = path.join(fresh(name), "lane.patch");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(patch, "latin1"));
  return { patch: p, md5: md5(fs.readFileSync(p)) };
}
function throwawayIndexEnv(dir) {
  const idx = path.join(fresh("idx"), "index");
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  git(dir, ["read-tree", "HEAD"], { env });
  return env;
}
function plainApplies(dir, patch) {
  try {
    git(dir, ["apply", "--cached", "--check", patch], {
      env: throwawayIndexEnv(dir),
    });
    return true;
  } catch {
    return false;
  }
}
// Apply for real into a throwaway index (3-way, as the seat does) and read back the files.
function applied(dir, patch, paths) {
  const env = throwawayIndexEnv(dir);
  git(dir, ["apply", "--cached", "--3way", "--check", patch], { env });
  git(dir, ["apply", "--cached", "--3way", patch], { env });
  return Object.fromEntries(
    paths.map((p) => [
      p,
      Buffer.from(
        git(dir, ["cat-file", "blob", `:${p}`], { env }),
        "latin1",
      ).toString("utf8"),
    ]),
  );
}
function runTool(
  dir,
  lane,
  {
    md5: m = lane.md5,
    extra = [],
    out = path.join(fresh("out"), "out.patch"),
  } = {},
) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmpRoot = path.join(fresh("toolTmp"), "t");
  const r = spawnSync(
    process.execPath,
    [
      TOOL,
      "--repo",
      dir,
      "--lane",
      lane.patch,
      "--lane-md5",
      m,
      "--out",
      out,
      "--tmp-root",
      tmpRoot,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { ...r, out, tmpRoot, wrote: fs.existsSync(out) };
}
const ok = (r) =>
  assert.equal(r.status, 0, `tool failed: ${r.stderr}${r.stdout}`);

before(() => fs.mkdirSync(ROOT, { recursive: true }));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  try {
    fs.rmdirSync(PARENT);
  } catch {
    /* another lane shares the parent */
  }
});

// ---------------------------------------------------------------------------------------------------
describe("semantic union of a lane with a competing landing", () => {
  test("census total/byTag, RIG_TAGS and both allowlists compose; the plain patch really conflicts", () => {
    const repo = mkRepo("union", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 59,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["polyline", 18, ["The polyline harvest."]],
        ],
      }),
      [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "polyline"] }),
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
      }),
      [READER]: readerFile({ rows: without(P, "probe-p02.mjs"), snapshot: P }),
    });
    commit(
      repo,
      {
        [CENSUS]: censusSpec({
          total: 44,
          byTag: [
            ["wave-end", 10],
            ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
            ["aurora", 4],
            ["wgs84", 3, ["The wgs84 harvest."]],
          ],
        }),
        [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "wgs84"] }),
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs", "probe-r07.mjs").map((k) => [k]),
        }),
        [READER]: readerFile({
          rows: without(P, "probe-p03.mjs"),
          snapshot: P,
        }),
      },
      "competing landing",
    );
    assert.equal(
      plainApplies(repo, lane.patch),
      false,
      "scenario must conflict textually, or the test proves nothing",
    );

    const r = runTool(repo, lane);
    ok(r);
    for (const p of [CENSUS, TAGS, CONTRACT, READER])
      assert.match(
        r.stdout,
        new RegExp(`shared ${p.replace(/[.]/g, "\\.")}: regenerated`),
        p,
      );
    assert.match(r.stdout, /total \+18 \(44 -> 62\)/);
    assert.match(r.stdout, /byTag \+polyline:18/);

    const got = applied(repo, r.out, [CENSUS, TAGS, CONTRACT, READER]);
    assert.equal(
      got[CENSUS],
      censusSpec({
        total: 62,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["wgs84", 3, ["The wgs84 harvest."]],
          ["polyline", 18, ["The polyline harvest."]],
        ],
      }),
    );
    assert.equal(
      got[TAGS],
      tagsFile({ tags: ["wave-end", "cloud", "aurora", "wgs84", "polyline"] }),
    );
    assert.equal(
      got[CONTRACT],
      contractFile({
        rows: without(
          R,
          "probe-r04.mjs",
          "probe-r05.mjs",
          "probe-r06.mjs",
          "probe-r07.mjs",
        ).map((k) => [k]),
      }),
    );
    assert.equal(
      got[READER],
      readerFile({
        rows: without(P, "probe-p02.mjs", "probe-p03.mjs"),
        snapshot: P,
      }),
    );
    assert.equal(
      fs.readFileSync(`${r.out}.md5`, "utf8"),
      `${md5(fs.readFileSync(r.out))}\n`,
    );
  });

  test("a section that already applies is kept byte-for-byte (the whole output is the input)", () => {
    const repo = mkRepo("asis", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 59,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["polyline", 18],
        ],
      }),
      [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "polyline"] }),
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
      }),
    });
    // The competing landing is far from every lane hunk.
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r11.mjs").map((k) => [k]),
        }),
        [CENSUS]: censusSpec({
          total: 41,
          byTag: [
            ["wave-end", 10],
            ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
            ["aurora", 4],
          ],
          tail: "assert.ok(!false);",
        }),
      },
      "far away",
    );
    assert.equal(plainApplies(repo, lane.patch), true);
    const r = runTool(repo, lane);
    ok(r);
    assert.match(
      r.stdout,
      new RegExp(`shared ${CENSUS.replace(/[.]/g, "\\.")}: kept as-is`),
    );
    assert.match(
      r.stdout,
      new RegExp(`shared ${CONTRACT.replace(/[.]/g, "\\.")}: kept as-is`),
    );
    assert.match(r.stdout, /byte-identical to the input/);
    assert.equal(md5(fs.readFileSync(r.out)), lane.md5);
  });

  test("a lane that touches no shared file passes through untouched", () => {
    const repo = mkRepo("noshared", baseFiles());
    const lane = cutLane(repo, { [OTHER]: "export const x = 1;\n" });
    const r = runTool(repo, lane);
    ok(r);
    assert.match(r.stdout, /lane touches none of the owned shared files/);
    assert.equal(md5(fs.readFileSync(r.out)), lane.md5);
  });

  test("a lane edit of an EXISTING byTag count and its comment lands as a delta, beside a competing census edit", () => {
    const repo = mkRepo("cloud", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 63,
        byTag: [
          ["wave-end", 10],
          [
            "cloud",
            39,
            [
              "The seeded set had 15 cloud rigs.",
              "It is 39 because the harvest added 22.",
            ],
          ],
          ["aurora", 4],
        ],
      }),
    });
    commit(
      repo,
      {
        [CENSUS]: censusSpec({
          total: 44,
          byTag: [
            ["wave-end", 10],
            ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
            ["aurora", 4],
            ["wgs84", 3],
          ],
        }),
      },
      "competing",
    );
    assert.equal(plainApplies(repo, lane.patch), false);
    const r = runTool(repo, lane);
    ok(r);
    assert.match(r.stdout, /total \+22 \(44 -> 66\); byTag ~cloud\+22/);
    const got = applied(repo, r.out, [CENSUS]);
    assert.equal(
      got[CENSUS],
      censusSpec({
        total: 66,
        byTag: [
          ["wave-end", 10],
          [
            "cloud",
            39,
            [
              "The seeded set had 15 cloud rigs.",
              "It is 39 because the harvest added 22.",
            ],
          ],
          ["aurora", 4],
          ["wgs84", 3],
        ],
      }),
    );
  });

  test("the same tag landed by both sides is added once; a change the base already carries drops the section", () => {
    const repo = mkRepo("duptag", baseFiles());
    const lane = cutLane(repo, {
      [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "x"] }),
    });
    commit(
      repo,
      { [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "x"] }) },
      "same tag",
    );
    const r = runTool(repo, lane);
    ok(r);
    assert.match(r.stdout, /no-op/);
    assert.equal(fs.readFileSync(r.out, "latin1"), "");
  });
});

describe("allowlist rows", () => {
  const laneAdds = (repo, base = R) =>
    cutLane(repo, {
      [CONTRACT]: contractFile({
        rows: [
          ...base.slice(0, 6).map((k) => [k]),
          ["probe-new.mjs", "added by the lane, reviewed"],
          ...base.slice(6).map((k) => [k]),
        ],
      }),
    });

  test("a lane + row is inserted after the same preceding key and reported", () => {
    const repo = mkRepo("addrow", baseFiles());
    const lane = laneAdds(repo);
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs", "probe-r07.mjs").map((k) => [k]),
        }),
      },
      "competing",
    );
    assert.equal(plainApplies(repo, lane.patch), false);
    const r = runTool(repo, lane);
    ok(r);
    assert.match(r.stdout, /\+1 ROWS ADDED \(probe-new\.mjs\)/);
    const got = applied(repo, r.out, [CONTRACT]);
    const expected = [
      ...without(R, "probe-r06.mjs", "probe-r07.mjs")
        .slice(0, 6)
        .map((k) => [k]),
      ["probe-new.mjs", "added by the lane, reviewed"],
      ...without(R, "probe-r06.mjs", "probe-r07.mjs")
        .slice(6)
        .map((k) => [k]),
    ];
    assert.equal(got[CONTRACT], contractFile({ rows: expected }));
  });

  test("a lane + row whose predecessor is gone goes to the end of the object", () => {
    const repo = mkRepo("addrow-end", baseFiles());
    const lane = laneAdds(repo);
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r05.mjs", "probe-r06.mjs").map((k) => [k]),
        }),
      },
      "competing removes the predecessor",
    );
    const r = runTool(repo, lane);
    ok(r);
    const got = applied(repo, r.out, [CONTRACT]);
    assert.equal(
      got[CONTRACT],
      contractFile({
        rows: [
          ...without(R, "probe-r05.mjs", "probe-r06.mjs").map((k) => [k]),
          ["probe-new.mjs", "added by the lane, reviewed"],
        ],
      }),
    );
  });

  test("a lane edit of an existing row's text lands on that row; a base row that drifted refuses", () => {
    const edited = (rows) =>
      contractFile({
        rows: rows.map((k) =>
          k === "probe-r03.mjs" ? [k, "reworded by the lane"] : [k],
        ),
      });
    const repo = mkRepo("changed", baseFiles());
    const lane = cutLane(repo, { [CONTRACT]: edited(R) });
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r04.mjs").map((k) => [k]),
        }),
      },
      "competing",
    );
    assert.equal(plainApplies(repo, lane.patch), false);
    const r = runTool(repo, lane);
    ok(r);
    assert.match(r.stdout, /~1 rows changed/);
    assert.equal(
      applied(repo, r.out, [CONTRACT])[CONTRACT],
      edited(without(R, "probe-r04.mjs")),
    );

    const repo2 = mkRepo("changed-drift", baseFiles());
    const lane2 = cutLane(repo2, { [CONTRACT]: edited(R) });
    commit(
      repo2,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r04.mjs").map((k) =>
            k === "probe-r03.mjs" ? [k, "reworded by someone else"] : [k],
          ),
        }),
      },
      "competing rewords it",
    );
    const r2 = runTool(repo2, lane2);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /REFUSED: .*probe-r03\.mjs.*drifted/);
  });

  test("REFUSES when a lane - row is absent from the base (family landed twice, or the row moved)", () => {
    const repo = mkRepo("absent", baseFiles());
    const lane = cutLane(repo, {
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
      }),
    });
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r04.mjs").map((k) => [k]),
        }),
      },
      "someone removed r04 already",
    );
    const r = runTool(repo, lane);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^REFUSED: .*probe-r04\.mjs.*no longer has it/m);
    assert.equal(r.wrote, false, "a refusal must not leave an output behind");
  });

  test("REFUSES a lane edit outside RIG_TAGS in lib/rig-registry.mjs", () => {
    const repo = mkRepo("outside", baseFiles());
    const lane = cutLane(repo, {
      [TAGS]: tagsFile({
        tags: ["wave-end", "cloud", "aurora", "polyline"],
        kinds: '["settleFrames", "settleMs", "settleNever"]',
      }),
    });
    commit(
      repo,
      { [TAGS]: tagsFile({ tags: ["wave-end", "cloud", "aurora", "wgs84"] }) },
      "competing tag",
    );
    assert.equal(plainApplies(repo, lane.patch), false);
    const r = runTool(repo, lane);
    assert.equal(r.status, 2);
    assert.match(
      r.stderr,
      /REFUSED: Tools\/visual-regression\/lib\/rig-registry\.mjs: lane edits the file outside its rows/,
    );
    assert.equal(r.wrote, false);
  });

  test("REFUSES a lane edit of the census spec outside total/byTag", () => {
    const repo = mkRepo("census-outside", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 59,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["polyline", 18],
        ],
      }).replace("assert.ok(true);", "assert.ok(1 + 1 === 2);"),
    });
    commit(
      repo,
      {
        [CENSUS]: censusSpec({
          total: 44,
          byTag: [
            ["wave-end", 10],
            ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
            ["aurora", 4],
            ["wgs84", 3],
          ],
        }),
      },
      "competing",
    );
    const r = runTool(repo, lane);
    assert.equal(r.status, 2);
    assert.match(
      r.stderr,
      /REFUSED: .*lane edits the census spec outside total\/byTag/,
    );
    assert.equal(r.wrote, false);
  });

  test("REFUSES a lane that adds a byTag key the base already carries", () => {
    const repo = mkRepo("census-twice", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 59,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["polyline", 18],
        ],
      }),
    });
    commit(
      repo,
      {
        [CENSUS]: censusSpec({
          total: 59,
          byTag: [
            ["wave-end", 10],
            ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
            ["aurora", 4],
            ["polyline", 18],
            ["wgs84", 0],
          ],
        }),
      },
      "polyline landed already",
    );
    const r = runTool(repo, lane);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /REFUSED: .*byTag key polyline already exists/);
  });
});

describe("guards", () => {
  test("REFUSES on a lane md5 mismatch, before reading anything else", () => {
    const repo = mkRepo("md5", baseFiles());
    const lane = cutLane(repo, { [OTHER]: "export const x = 1;\n" });
    const r = runTool(repo, lane, { md5: "0".repeat(32) });
    assert.equal(r.status, 2);
    assert.match(
      r.stderr,
      /REFUSED: lane patch md5 [0-9a-f]{32} != frozen 0{32}/,
    );
    assert.equal(r.wrote, false);
  });

  test("a refused run leaves no <out> or <out>.md5 behind, even when an earlier run left them", () => {
    const repo = mkRepo("stale", baseFiles());
    const good = cutLane(repo, { [OTHER]: "export const x = 1;\n" }, "good");
    const late = cutLane(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r04.mjs").map((k) => [k]),
        }),
      },
      "late",
    );
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r04.mjs").map((k) => [k]),
        }),
      },
      "someone removed r04 already",
    );
    const out = path.join(fresh("staleOut"), "out.patch");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const both = (want, why) => {
      assert.equal(fs.existsSync(out), want, `<out> ${why}`);
      assert.equal(fs.existsSync(`${out}.md5`), want, `<out>.md5 ${why}`);
    };

    ok(runTool(repo, good, { out }));
    both(true, "written by the first, successful run");

    // early refusal: the md5 check
    const bad = runTool(repo, good, { md5: "0".repeat(32), out });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /^REFUSED: /m);
    assert.equal(bad.stdout, "");
    both(false, "must not survive an md5 refusal");

    // late refusal: past the md5 check, into the transforms
    ok(runTool(repo, good, { out }));
    both(true, "rewritten by a successful run after a refusal");
    const absent = runTool(repo, late, { out });
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /^REFUSED: .*probe-r04.mjs/m);
    both(false, "must not survive an absent - row refusal");

    ok(runTool(repo, good, { out }));
    both(true, "written again by a run that succeeds after a refusal");
  });

  test("--out equal to --lane is never deleted", () => {
    const repo = mkRepo("selfout", baseFiles());
    const lane = cutLane(repo, { [OTHER]: "export const x = 1;\n" });
    const before = fs.readFileSync(lane.patch);
    const r = runTool(repo, lane, { md5: "0".repeat(32), out: lane.patch });
    assert.equal(r.status, 2);
    assert.deepEqual(fs.readFileSync(lane.patch), before);
  });

  test("--out spelled with its case flipped is the same file: the lane is never deleted (case-insensitive filesystems only)", (t) => {
    const repo = mkRepo("caseout", baseFiles());
    const lane = cutLane(repo, { [OTHER]: "export const x = 1;\n" });
    const flipped = path.join(
      path.dirname(lane.patch),
      path.basename(lane.patch).toUpperCase(),
    );
    // The filesystem decides: a second spelling that reaches the lane is the precondition of this case.
    if (!fs.existsSync(flipped))
      return t.skip(
        "case-sensitive filesystem: no second spelling of a path reaches the same file",
      );
    const before = fs.readFileSync(lane.patch);
    const r = runTool(repo, lane, { md5: "0".repeat(32), out: flipped });
    assert.equal(r.status, 2, `expected a refusal: ${r.stderr}`);
    assert.match(r.stderr, /^REFUSED: lane patch md5 /m);
    assert.ok(fs.existsSync(lane.patch), "the lane patch must still exist");
    assert.deepEqual(fs.readFileSync(lane.patch), before);
  });

  test("an <out>.md5 that IS the lane patch is never deleted either", () => {
    const repo = mkRepo("md5out", baseFiles());
    const made = cutLane(repo, { [OTHER]: "export const x = 1;\n" });
    const dir = fresh("md5outLane");
    fs.mkdirSync(dir, { recursive: true });
    const laneAsMd5 = path.join(dir, "o.patch.md5");
    fs.copyFileSync(made.patch, laneAsMd5);
    const before = fs.readFileSync(laneAsMd5);
    const r = runTool(
      repo,
      { patch: laneAsMd5, md5: made.md5 },
      { md5: "0".repeat(32), out: path.join(dir, "o.patch") },
    );
    assert.equal(r.status, 2, `expected a refusal: ${r.stderr}`);
    assert.match(r.stderr, /^REFUSED: lane patch md5 /m);
    assert.ok(fs.existsSync(laneAsMd5), "the lane patch must still exist");
    assert.deepEqual(fs.readFileSync(laneAsMd5), before);
  });

  test("never modifies the repo: index, status, object store and the temp root are all as they were", () => {
    const repo = mkRepo("readonly", baseFiles());
    const lane = cutLane(repo, {
      [CENSUS]: censusSpec({
        total: 59,
        byTag: [
          ["wave-end", 10],
          ["cloud", 17, ["The seeded set had 15 cloud rigs."]],
          ["aurora", 4],
          ["polyline", 18],
        ],
      }),
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
      }),
    });
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs").map((k) => [k]),
        }),
      },
      "competing",
    );
    const listObjects = () => {
      const out = [];
      const walk = (d) =>
        fs
          .readdirSync(d, { withFileTypes: true })
          .forEach((e) =>
            e.isDirectory()
              ? walk(path.join(d, e.name))
              : out.push(path.join(d, e.name)),
          );
      walk(path.join(repo, ".git", "objects"));
      return out.sort();
    };
    const snap = () => ({
      index: md5(fs.readFileSync(path.join(repo, ".git", "index"))),
      status: git(repo, ["status", "--porcelain"]),
      objects: listObjects(),
      head: git(repo, ["rev-parse", "HEAD"]),
    });
    const before = snap();
    const r = runTool(repo, lane);
    ok(r);
    assert.deepEqual(snap(), before);
    assert.equal(fs.existsSync(r.tmpRoot), false, "temp root must be removed");
  });

  test("--base cuts the hunks against the named rev, not against HEAD", () => {
    const repo = mkRepo("base-flag", baseFiles());
    const lane = cutLane(repo, {
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
      }),
    });
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs").map((k) => [k]),
        }),
      },
      "competing",
    );
    const mid = git(repo, ["rev-parse", "HEAD"]).trim();
    commit(
      repo,
      {
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs", "probe-r08.mjs").map((k) => [k]),
        }),
      },
      "a later landing",
    );
    const r = runTool(repo, lane, { extra: ["--base", mid] });
    ok(r);
    assert.match(r.stdout, new RegExp(`base: ${mid} = ${mid}`));
    git(repo, ["checkout", "-q", "--detach", mid]);
    assert.equal(
      applied(repo, r.out, [CONTRACT])[CONTRACT],
      contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs", "probe-r06.mjs").map(
          (k) => [k],
        ),
      }),
    );
  });

  test("CRLF base files keep their line endings through a regenerated hunk", () => {
    const eol = "\r\n";
    const repo = mkRepo("crlf", baseFiles(eol));
    const lane = cutLane(repo, {
      [TAGS]: tagsFile({
        tags: ["wave-end", "cloud", "aurora", "polyline"],
        eol,
      }),
      [CONTRACT]: contractFile({
        rows: without(R, "probe-r04.mjs", "probe-r05.mjs").map((k) => [k]),
        eol,
      }),
    });
    commit(
      repo,
      {
        [TAGS]: tagsFile({
          tags: ["wave-end", "cloud", "aurora", "wgs84"],
          eol,
        }),
        [CONTRACT]: contractFile({
          rows: without(R, "probe-r06.mjs", "probe-r07.mjs").map((k) => [k]),
          eol,
        }),
      },
      "competing",
    );
    const r = runTool(repo, lane);
    ok(r);
    const got = applied(repo, r.out, [TAGS, CONTRACT]);
    assert.equal(
      got[TAGS],
      tagsFile({
        tags: ["wave-end", "cloud", "aurora", "wgs84", "polyline"],
        eol,
      }),
    );
    assert.equal(
      got[CONTRACT],
      contractFile({
        rows: without(
          R,
          "probe-r04.mjs",
          "probe-r05.mjs",
          "probe-r06.mjs",
          "probe-r07.mjs",
        ).map((k) => [k]),
        eol,
      }),
    );
  });

  test("any lib/*-allowlist.mjs the lane touches is handled row by row, not just the two named ones", () => {
    const OTHER_LIST =
      "Tools/visual-regression/lib/probe-fleet-behaviour-allowlist.mjs";
    const rows = names("probe-b", 10);
    const repo = mkRepo("other-list", {
      ...baseFiles(),
      [OTHER_LIST]: contractFile({ rows: rows.map((k) => [k]) }).replace(
        "PROBE_CONTRACT_ALLOWLIST",
        "BEHAVIOUR_FLEET_ALLOWLIST",
      ),
    });
    const wrap = (rs) =>
      contractFile({ rows: rs.map((k) => [k]) }).replace(
        "PROBE_CONTRACT_ALLOWLIST",
        "BEHAVIOUR_FLEET_ALLOWLIST",
      );
    const lane = cutLane(repo, {
      [OTHER_LIST]: wrap(without(rows, "probe-b03.mjs", "probe-b04.mjs")),
    });
    commit(
      repo,
      { [OTHER_LIST]: wrap(without(rows, "probe-b05.mjs")) },
      "competing",
    );
    const r = runTool(repo, lane);
    ok(r);
    const got = applied(repo, r.out, [OTHER_LIST]);
    assert.equal(
      got[OTHER_LIST],
      wrap(without(rows, "probe-b03.mjs", "probe-b04.mjs", "probe-b05.mjs")),
    );
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the manifest and the whole-patch line", () => {
  const LEDGER = "migration_doc/WEBGPU_DEBUGGING_LOG.md";
  const ARCHIVE_README = "Tools/visual-regression/archive/README.md";
  const ledger = (...rows) =>
    `# log\n\n${rows.join("\n")}${rows.length ? "\n" : ""}`;

  test("every unowned end-of-file file the lane touches is named, the output stays byte-identical, and no seat script is named", () => {
    const repo = mkRepo("unowned", {
      ...baseFiles(),
      [LEDGER]: ledger("row 1"),
      [ARCHIVE_README]: "# archive\n\n- one\n",
      "package.json": '{\n  "scripts": {\n    "a": "b"\n  }\n}\n',
    });
    const lane = cutLane(repo, {
      [LEDGER]: ledger("row 1", "lane row"),
      [ARCHIVE_README]: "# archive\n\n- one\n- lane\n",
      "package.json":
        '{\n  "scripts": {\n    "a": "b",\n    "c": "d"\n  }\n}\n',
    });
    const r = runTool(repo, lane);
    ok(r);
    const line = r.stdout.split("\n").find((l) => l.startsWith("not owned"));
    assert.ok(line, "a 'not owned' line");
    for (const p of [LEDGER, ARCHIVE_README, "package.json"])
      assert.ok(line.includes(p), `${p} is named on: ${line}`);
    assert.match(line, /landing script's union resolver/);
    assert.doesNotMatch(r.stdout, /land-w1/);
    assert.equal(
      md5(fs.readFileSync(r.out)),
      lane.md5,
      "output bytes unchanged",
    );
  });

  test("a lane whose unowned ledger append conflicts at the base reads FAILS (all covered); a clean lane reads clean", () => {
    const repo = mkRepo("wholeconflict", {
      ...baseFiles(),
      [LEDGER]: ledger("row 1"),
    });
    const lane = cutLane(repo, { [LEDGER]: ledger("row 1", "lane row") });
    const clean = runTool(repo, lane);
    ok(clean);
    assert.match(
      clean.stdout,
      /whole-patch .*: clean$/m,
      "before anything else lands, the lane reads clean",
    );
    commit(
      repo,
      { [LEDGER]: ledger("row 1", "competing row") },
      "competing ledger append",
    );
    const r = runTool(repo, lane);
    ok(r);
    assert.match(
      r.stdout,
      /FAILS in 1 file\(s\): migration_doc\/WEBGPU_DEBUGGING_LOG\.md/,
    );
    assert.match(
      r.stdout,
      /all covered by the landing script's union resolver/,
    );
    assert.doesNotMatch(r.stdout, /NOT covered/);
    assert.equal(
      md5(fs.readFileSync(r.out)),
      lane.md5,
      "output bytes unchanged",
    );
  });
});
