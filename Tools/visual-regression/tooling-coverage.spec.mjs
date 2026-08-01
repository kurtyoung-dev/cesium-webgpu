// tooling-coverage.spec.mjs — the repository tooling-coverage contract
// (REPO-TRACKED-MJS-PRETTIER-COVERAGE + REPO-TOOLS-ESLINT-COVERAGE).
//
// WHY THIS EXISTS
// ───────────────
// Both defects this pins were INVISIBLE while they were live. Prettier's
// ignore file listed the extensions it covered (`.js`, `.cjs`, `.ts`, ...) and
// simply never named `.mjs`, so 700+ tracked probe files sat outside
// `npm run prettier-check` while the check reported green. ESLint's flat
// config carried `"Tools/**/*"` in its global `ignores`, so `npm run eslint`
// walked the whole fleet, skipped every file, and also reported green. In both
// cases the tool exited 0 — the absence of coverage looked exactly like
// passing coverage.
//
// A green lane is therefore not evidence. The only thing that distinguishes
// "the fleet is clean" from "the fleet is not being checked" is a file that
// MUST fail: this spec writes deliberately broken fixtures into the real
// `Tools/` tree, runs the REAL configured commands against them, and asserts
// the tools reject them. It pairs each negative with a positive control, so a
// fixture that fails for the wrong reason (bad path, unresolvable config,
// syntax error) cannot masquerade as coverage.
//
// The fixtures are written and deleted inside the test; nothing broken is left
// on disk. They live under `Tools/visual-regression/` rather than a temp
// directory precisely because the config's `Tools/**` glob is the thing under
// test — a fixture outside the tree would prove nothing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/**
 * Locate a package's CLI entry by walking up for `node_modules`. The engine
 * and the tooling can be installed at the repository root or above it (git
 * worktrees resolve upward), so a hard-coded path would be brittle.
 *
 * @param {string} relative Path under `node_modules`.
 * @returns {string} Absolute path to the CLI entry.
 */
function resolveCli(relative) {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", relative);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`could not locate node_modules/${relative} from ${root}`);
}

const ESLINT_CLI = resolveCli(path.join("eslint", "bin", "eslint.js"));
const PRETTIER_CLI = resolveCli(path.join("prettier", "bin", "prettier.cjs"));

/**
 * Run a CLI from the repository root and capture its exit status and output.
 *
 * @param {string} cli Absolute path to the CLI entry.
 * @param {string[]} args CLI arguments.
 * @returns {{status: number, output: string}}
 */
function run(cli, args) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1e8,
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * Write fixtures into the real Tools tree, run `body`, then always remove
 * them. Nothing broken survives a failure or a crash mid-assertion.
 *
 * @param {Record<string, string>} files Basename -> contents.
 * @param {(paths: Record<string, string>) => void} body
 */
function withFixtures(files, body) {
  const dir = path.join(here, "lint-coverage-fixtures");
  // Clear first: a hard-killed earlier run could have left a broken fixture
  // behind, and a stale file would fail the NEXT run for the wrong reason.
  // The directory is deliberately NOT in .gitignore — Prettier 3 uses
  // `.gitignore` as a default ignore path, so gitignoring the fixtures would
  // silently exempt them from the very check this spec exists to prove.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const paths = {};
  try {
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.writeFileSync(full, contents);
      paths[name] = path.relative(root, full).split(path.sep).join("/");
    }
    body(paths);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A probe with five INDEPENDENT defects, each from a different rule family, so
// one over-broad config relaxation cannot silence the whole fixture.
const INVALID_PROBE = `// Deliberately invalid probe fixture. Written and deleted by
// tooling-coverage.spec.mjs; never committed.
export function brokenProbe(pixels) {
  const neverRead = pixels.length;
  const options = { mode: "webgpu", mode: "webgl" };
  if (pixels.length == "0") {
    return totallyUndefinedHelper(options);
  }
  return options;
  const unreachable = 1;
}
`;

// The same shape with every defect removed. If this one also failed, the
// negative control above would prove nothing about the rules.
const VALID_PROBE = `// Valid probe fixture. Written and deleted by
// tooling-coverage.spec.mjs; never committed.
export function workingProbe(pixels) {
  const options = { mode: "webgpu" };
  if (pixels.length === 0) {
    return null;
  }
  return options;
}
`;

test("an intentionally invalid Tools probe FAILS the configured ESLint lane", () => {
  withFixtures(
    { "invalid-probe.mjs": INVALID_PROBE, "valid-probe.mjs": VALID_PROBE },
    (paths) => {
      const bad = run(ESLINT_CLI, [
        "--no-cache",
        "--format",
        "json",
        paths["invalid-probe.mjs"],
      ]);
      assert.notEqual(
        bad.status,
        0,
        "ESLint accepted an invalid Tools probe — the fleet is not in the lane",
      );

      const [report] = JSON.parse(bad.output);
      const rules = new Set(report.messages.map((m) => m.ruleId));
      for (const rule of [
        "no-undef",
        "no-unused-vars",
        "no-dupe-keys",
        "eqeqeq",
        "no-unreachable",
      ]) {
        assert.ok(
          rules.has(rule),
          `expected ${rule} to fire on the invalid fixture; got ${[...rules].join(", ")}`,
        );
      }

      // POSITIVE CONTROL: the same file shape, defects removed, must pass.
      // Without this, a fixture that failed to resolve the config (or failed
      // to parse) would read as "coverage works".
      const good = run(ESLINT_CLI, ["--no-cache", paths["valid-probe.mjs"]]);
      assert.equal(
        good.status,
        0,
        `a clean Tools probe must pass the lane:\n${good.output}`,
      );
    },
  );
});

test("Tools probes get BOTH the browser and the Node global sets", () => {
  // Probes are Node scripts that carry in-page code for `page.evaluate`, so
  // `window`/`document` and `process`/`Buffer` legitimately appear in the same
  // file. If either set were missing, `no-undef` would flood the fleet and the
  // pragmatic response would be to switch `no-undef` off entirely — which is
  // how the rule stops catching real typos.
  const fixture = `// Fixture. Written and deleted by tooling-coverage.spec.mjs.
export async function mixedScopeProbe(page) {
  const inPage = await page.evaluate(() => {
    return { w: window.innerWidth, d: document.title };
  });
  return Buffer.from(JSON.stringify(inPage) + process.pid).toString("base64");
}
`;
  withFixtures({ "mixed-scope-probe.mjs": fixture }, (paths) => {
    const result = run(ESLINT_CLI, [
      "--no-cache",
      paths["mixed-scope-probe.mjs"],
    ]);
    assert.equal(
      result.status,
      0,
      `browser+node globals must both be in scope:\n${result.output}`,
    );
  });

  // ...and an identifier neither environment defines is still an error, so
  // the two global sets have not been widened into a blanket exemption.
  const typo = `export function typoProbe() {
  return windwo.innerWidth;
}
`;
  withFixtures({ "typo-probe.mjs": typo }, (paths) => {
    const result = run(ESLINT_CLI, [
      "--no-cache",
      "--format",
      "json",
      paths["typo-probe.mjs"],
    ]);
    assert.notEqual(result.status, 0, "a typo'd global must still be caught");
    const [report] = JSON.parse(result.output);
    assert.ok(report.messages.some((m) => m.ruleId === "no-undef"));
  });
});

test("tracked .mjs files participate in the repository Prettier check", () => {
  const misformatted = `export const probeConfig = {mode:"webgpu",   frames:8,
      settle   : true};
`;
  withFixtures({ "misformatted.mjs": misformatted }, (paths) => {
    const result = run(PRETTIER_CLI, ["--check", paths["misformatted.mjs"]]);
    assert.notEqual(
      result.status,
      0,
      "Prettier accepted a misformatted .mjs — .mjs is still outside the check",
    );
  });

  // POSITIVE CONTROL: an already-formatted .mjs passes, so the failure above
  // is about formatting and not about the path being unreadable.
  withFixtures({ "formatted.mjs": VALID_PROBE }, (paths) => {
    const result = run(PRETTIER_CLI, ["--check", paths["formatted.mjs"]]);
    assert.equal(
      result.status,
      0,
      `a formatted .mjs must pass the check:\n${result.output}`,
    );
  });
});

test("the real Tools fleet resolves the Tools lint policy, not the ignore list", () => {
  // `--print-config` answers the question the fixtures cannot: does a file
  // that ALREADY EXISTS in the repository resolve the intended rules? A
  // fixture proves the glob matches; this proves the shipped fleet does.
  const result = run(ESLINT_CLI, [
    "--print-config",
    "Tools/visual-regression/capture-and-diff.mjs",
  ]);
  assert.equal(result.status, 0, result.output);
  const config = JSON.parse(result.output);

  // `--print-config` normalises severities to numbers (2 === "error").
  const severity = (rule) => {
    const entry = config.rules?.[rule];
    return Array.isArray(entry) ? entry[0] : entry;
  };
  for (const rule of [
    "no-undef",
    "no-unused-vars",
    "no-dupe-keys",
    "no-unreachable",
    "eqeqeq",
    "no-redeclare",
  ]) {
    assert.ok(
      severity(rule) === 2 || severity(rule) === "error",
      `${rule} must be an error for Tools probes (got ${JSON.stringify(severity(rule))})`,
    );
  }

  // `globals` maps a name to its writability (`false` === read-only), so
  // membership is the question, not truthiness.
  const declared = config.languageOptions.globals ?? {};
  assert.ok("window" in declared, "browser globals missing");
  assert.ok("document" in declared, "browser globals missing");
  assert.ok("process" in declared, "node globals missing");
  assert.ok("Buffer" in declared, "node globals missing");
  assert.equal(
    config.languageOptions.sourceType,
    "module",
    "Tools probes are ESM",
  );
});

test("CI and lint-staged invoke the same effective coverage", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );

  // The eslint script's own glob must reach `.mjs`; `*.*js` does, `*.js`
  // would not. This is the second half of the ESLint gap: fixing the config's
  // ignores is useless if the command never names the files.
  assert.match(pkg.scripts.eslint, /\.\*js/);
  assert.match(pkg.scripts["prettier-check"], /prettier --check/);

  for (const workflow of ["dev.yml", "prod.yml"]) {
    const text = fs.readFileSync(
      path.join(root, ".github", "workflows", workflow),
      "utf8",
    );
    assert.match(
      text,
      /run: npm run eslint/,
      `${workflow} must run the same eslint script`,
    );
    assert.match(
      text,
      /run: npm run prettier-check/,
      `${workflow} must run the same prettier check`,
    );
  }

  const lintStaged = fs.readFileSync(
    path.join(root, "lint-staged.config.js"),
    "utf8",
  );
  assert.match(
    lintStaged,
    /"\*\.\{[^}]*\bmjs\b[^}]*\}":/,
    "lint-staged must name .mjs, or the hook lets through what CI rejects",
  );
  assert.match(lintStaged, /eslint --cache --quiet/);
  assert.match(lintStaged, /prettier --write/);
});

test("lint-staged chunks wide batches so a repo-scale commit can spawn", () => {
  // A repository-wide mechanical batch stages 700+ paths. Concatenated and
  // quoted they blow past Windows' ~32 KB command-line cap, and one eslint
  // process holding that many ASTs is what OOM-killed the pre-commit hook on
  // earlier large merges.
  const configUrl = new URL("../../lint-staged.config.js", import.meta.url);
  return import(configUrl).then((mod) => {
    const files = Array.from(
      { length: 700 },
      (_, i) => `Tools/visual-regression/probe-generated-${i}.mjs`,
    );
    const commands = mod.default["*.{js,cjs,mjs,ts,tsx,css,html}"](files);
    assert.ok(commands.length > 2, "wide batches must be split across spawns");
    for (const command of commands) {
      assert.ok(
        command.length < 30000,
        `a single spawn's command line is ${command.length} chars`,
      );
    }
    // Tool-major ordering: every eslint spawn precedes every prettier spawn.
    const lastEslint = commands.findLastIndex((c) => c.startsWith("eslint"));
    const firstPrettier = commands.findIndex((c) => c.startsWith("prettier"));
    assert.ok(lastEslint < firstPrettier, "tool ordering must be preserved");

    // Vendored paths stay excluded no matter how the batch is chunked.
    const vendored = mod.default["*.{js,cjs,mjs,ts,tsx,css,html}"]([
      "Tools/shader-pipeline/naga-wasm-tools/naga_wasm_tools.js",
    ]);
    assert.deepEqual(vendored, []);
  });
});
