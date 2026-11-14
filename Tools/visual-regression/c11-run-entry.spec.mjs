// c11-run-entry.spec.mjs — the c11 13 / 90 probes' run-entry origin protocol and
// output redirect, plus the c11-13 canvas decoder that now rides the kit's PNG
// decoder. Pure Node: no browser, no server, no network. The launch callback is
// a stub, every filesystem write lands under a lane temp root, and the working
// directory is moved into a lane temp root for every run so a stray default
// write cannot touch the clone's own Tools/visual-regression/output/.
// @purpose Pins KIT-5A (c): the c11 13 and 90 libraries import cleanly with PROBE_BASE unset, an unset or port-8080 PROBE_BASE refuses at run entry (probe-base-unset / port-8080-forbidden) before any directory is made or browser launched, --output redirects every file the run writes (through the library call, and through the entry script the Edge-job runner invokes, which never makes the cwd-relative default), and decodeCanvasPngDataUrl still throws STRUCTURAL errors.
// @status ACTIVE
//
// The assertions are groups over a module namespace. The live tests run each
// group over the real library; the mutant tests run the same group over a copy
// with the clause under test made unreachable and require it to fail.
//
// Run: node --test Tools/visual-regression/c11-run-entry.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  PORT_8080_REFUSAL_MESSAGE,
  PROBE_EXIT_CODES,
  ProbeRefusal,
} from "./lib/probe-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");
const DECISIONS_PATH = path.join(HERE, "lib", "probe-runtime-decisions.mjs");

const PROBES = [
  {
    id: "c11-13",
    lib: path.join(HERE, "lib", "c11-13-voxel-inside-camera-probe.mjs"),
    run: "runVoxelInsideCameraProbe",
    entry: path.join(HERE, "probe-c11-13-voxel-inside-camera.mjs"),
    runDirectory: "c11-13-voxel-inside-camera",
    canonical: "c11-13-voxel-inside-camera.json",
    firstRed: "c11-13-voxel-inside-camera.first-red.json",
  },
  {
    id: "c11-90",
    lib: path.join(HERE, "lib", "c11-90-primitive-restart-probe.mjs"),
    run: "runPrimitiveRestartProbe",
    entry: path.join(HERE, "probe-c11-90-primitive-restart-split.mjs"),
    runDirectory: "c11-90-primitive-restart",
    canonical: "c11-90-primitive-restart-split.json",
    firstRed: "c11-90-primitive-restart-split.first-red.json",
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let freshLoads = 0;

/**
 * A library's source with exactly-once anchor replacements applied. Relative
 * specifiers become absolute file URLs and bare package specifiers (the c11-13
 * library imports `sharp`) are resolved from the original file, because a
 * `data:` module can resolve neither.
 *
 * @param {string} file Absolute library path.
 * @param {Array<[string, string]>} replacements Anchor pairs.
 * @returns {string} The source.
 */
function rewriteSource(file, replacements = []) {
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(file);
  const require = createRequire(base);
  // A specifier has no whitespace; prose in a comment (from "I measured ...")
  // is not one.
  source = source.replace(/from "([^"\s]+)"/g, (match, specifier) => {
    if (specifier.startsWith(".")) {
      return `from "${new URL(specifier, base).href}"`;
    }
    if (specifier.startsWith("node:")) {
      return match;
    }
    return `from "${pathToFileURL(require.resolve(specifier)).href}"`;
  });
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    assert.equal(
      count,
      1,
      `anchor must occur exactly once (${count}): ${anchor}`,
    );
    source = source.replace(anchor, () => replacement);
  }
  return source;
}

const dataUrlOf = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

/**
 * Evaluate a fresh copy of a library (see {@link rewriteSource}).
 *
 * @param {string} file Absolute library path.
 * @param {Array<[string, string]>} replacements Anchor pairs.
 * @returns {Promise<object>} The module namespace.
 */
async function loadLib(file, replacements = []) {
  // Unique per call: identical source would be one cached module, and the
  // library binds its cwd-relative paths when it is evaluated.
  freshLoads += 1;
  return import(
    dataUrlOf(`${rewriteSource(file, replacements)}
// fresh load ${freshLoads}
`)
  );
}

/** Run `fn(dir)` with the working directory moved into a lane temp root. */
function inSentinelCwd(fn) {
  return withLaneTmp("c11-entry-cwd-", async (dir) => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return await fn(dir);
    } finally {
      process.chdir(previous);
    }
  });
}

/**
 * Make the sentinel cwd look enough like a checkout for a run to get past its
 * provenance reads: every cwd-relative file the library resolves is created
 * empty (the c11-90 library throws on a missing built demo, which a clone that
 * was never built does not have). The output default is not one of them.
 *
 * @param {object} probe The probe table row.
 * @param {string} cwd The sentinel directory.
 * @returns {string[]} The relative files created.
 */
function materializeLocalPaths(probe, cwd) {
  const source = fs.readFileSync(probe.lib, "utf8");
  const created = [];
  for (const match of source.matchAll(/path\.resolve\(\s*"([^"]+)"/g)) {
    const relative = match[1];
    if (relative.endsWith("/output") || relative.endsWith("/")) {
      continue;
    }
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    created.push(relative);
  }
  return created.sort();
}

/** Silence the probes' console.log and restore the process exit code. */
async function quiet(fn) {
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
}

/** Every entry under `directory`, relative, directories marked with `/`. */
function listTree(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        found.push(`${relative}/`);
        walk(full);
      } else {
        found.push(relative);
      }
    }
  };
  walk(directory);
  return found.sort();
}

const GOVERNED = { PROBE_BASE: "http://localhost:8094" };
const SENTINEL = "stop-before-any-browser";

/** A launch callback that records the call and stops the run there. */
function stoppingLauncher() {
  const calls = [];
  const launch = async () => {
    calls.push("launch");
    throw new Error(SENTINEL);
  };
  return { launch, calls };
}

// ---------------------------------------------------------------------------
// Groups (each a function of (probe, namespace))
// ---------------------------------------------------------------------------

/** The refusal happens at run entry, naming the runtime's id, before anything. */
async function refusalGroup(probe, replacements) {
  const api =
    replacements === undefined
      ? await import(pathToUrl(probe.lib))
      : await loadLib(probe.lib, replacements);
  const cases = [
    ["PROBE_BASE unset", {}, "probe-base-unset"],
    ["PROBE_BASE empty", { PROBE_BASE: "" }, "probe-base-unset"],
    ["PROBE_BASE blank", { PROBE_BASE: "   " }, "probe-base-unset"],
    [
      "port 8080 on localhost",
      { PROBE_BASE: "http://localhost:8080" },
      "port-8080-forbidden",
    ],
    [
      "port 8080 on 127.0.0.1 with a slash",
      { PROBE_BASE: "http://127.0.0.1:8080/" },
      "port-8080-forbidden",
    ],
  ];
  for (const [label, env, reason] of cases) {
    for (const redirected of [false, true]) {
      await inSentinelCwd(async (cwd) => {
        const outputDirectory = redirected
          ? path.join(cwd, "redirect-here")
          : null;
        const { launch, calls } = stoppingLauncher();
        let thrown = null;
        try {
          await quiet(() => api[probe.run](launch, { env, outputDirectory }));
        } catch (error) {
          thrown = error;
        }
        const where = `${probe.id} / ${label} / ${redirected ? "redirected" : "default"}`;
        assert.ok(
          thrown instanceof ProbeRefusal,
          `${where}: a ProbeRefusal, got ${thrown}`,
        );
        assert.equal(thrown.reason, reason, where);
        assert.equal(thrown.exitCode, PROBE_EXIT_CODES.REFUSAL, where);
        if (reason === "port-8080-forbidden") {
          assert.equal(
            thrown.message,
            PORT_8080_REFUSAL_MESSAGE,
            `${where}: the runtime's words`,
          );
        }
        assert.deepEqual(calls, [], `${where}: the browser was never launched`);
        assert.deepEqual(
          fs.readdirSync(cwd),
          [],
          `${where}: no directory or file was made before the refusal`,
        );
      });
    }
  }
}

/** A governed origin runs; --output redirects every file; no redirect = today. */
async function redirectGroup(probe, replacements = []) {
  // Redirected: every written path is under the directory, mirroring the layout.
  await inSentinelCwd(async (cwd) => {
    const outputDirectory = path.join(cwd, "job", probe.id);
    materializeLocalPaths(probe, cwd);
    // A fresh evaluation INSIDE the sentinel, so the library's import-time
    // cwd-relative paths resolve against it.
    const api = await loadLib(probe.lib, replacements);
    const before = listTree(cwd);
    const { launch, calls } = stoppingLauncher();
    await quiet(() =>
      api[probe.run](launch, { env: GOVERNED, outputDirectory }),
    );
    assert.deepEqual(
      calls,
      ["launch"],
      `${probe.id}: the governed run reached the launch`,
    );
    assert.deepEqual(
      listTree(cwd).filter(
        (entry) => entry !== "job/" && !entry.startsWith("job/"),
      ),
      before,
      `${probe.id}: nothing was written outside the redirect`,
    );
    const tree = listTree(outputDirectory);
    assert.ok(
      tree.includes("performance/"),
      `${probe.id}: evidence directory mirrored`,
    );
    assert.ok(
      tree.some(
        (entry) =>
          /^[^/]+\/$/.test(entry) && entry === `${probe.runDirectory}/`,
      ),
      `${probe.id}: run root mirrored`,
    );
    assert.ok(
      tree.some(
        (entry) =>
          /^[^/]+\/[0-9a-f-]{36}\/$/.test(entry) &&
          entry.startsWith(`${probe.runDirectory}/`),
      ),
      `${probe.id}: a run directory exists under the run root`,
    );
    assert.ok(
      tree.includes(`performance/${probe.canonical}`),
      `${probe.id}: canonical artifact redirected`,
    );
    assert.ok(
      tree.includes(`performance/${probe.firstRed}`),
      `${probe.id}: first-red redirected`,
    );
    assert.ok(
      tree.some((entry) =>
        /^performance\/.*\.run-[0-9a-f-]{36}\.json$/.test(entry),
      ),
      `${probe.id}: run archive redirected`,
    );
    const canonical = JSON.parse(
      fs.readFileSync(
        path.join(outputDirectory, "performance", probe.canonical),
        "utf8",
      ),
    );
    assert.equal(
      canonical.baseUrl,
      GOVERNED.PROBE_BASE,
      `${probe.id}: the artifact names the governed origin`,
    );
  });

  // No redirect: exactly today's cwd-relative layout.
  await inSentinelCwd(async (cwd) => {
    materializeLocalPaths(probe, cwd);
    const api = await loadLib(probe.lib, replacements);
    const { launch, calls } = stoppingLauncher();
    await quiet(() =>
      api[probe.run](launch, { env: GOVERNED, outputDirectory: null }),
    );
    assert.deepEqual(calls, ["launch"]);
    const tree = listTree(cwd);
    assert.ok(
      tree.includes(
        `Tools/visual-regression/output/performance/${probe.canonical}`,
      ),
      `${probe.id}: default canonical path unchanged`,
    );
    assert.ok(
      tree.includes(`Tools/visual-regression/output/${probe.runDirectory}/`),
    );
  });
}

/** The library imports cleanly with PROBE_BASE unset (a fresh evaluation). */
async function cleanImportGroup(probe, replacements = []) {
  const saved = process.env.PROBE_BASE;
  delete process.env.PROBE_BASE;
  try {
    const fresh = await loadLib(probe.lib, replacements);
    assert.equal(
      typeof fresh[probe.run],
      "function",
      `${probe.id}: imported with PROBE_BASE unset`,
    );
    assert.equal(
      typeof fresh.bindRunEntry,
      "function",
      `${probe.id}: bindRunEntry exported`,
    );
  } finally {
    if (saved !== undefined) {
      process.env.PROBE_BASE = saved;
    }
  }
}

/** c11-13: the canvas decoder rides the kit decoder and still throws STRUCTURAL. */
async function decoderGroup(api) {
  const png = Buffer.from(
    encodeRgbaPng(new Uint8Array(4 * 4 * 4).fill(77), 4, 4),
  );
  const url = `data:image/png;base64,${png.toString("base64")}`;
  assert.ok(
    api.decodeCanvasPngDataUrl(url).equals(png),
    "a signature-bearing payload returns the PNG bytes",
  );
  const invalid = [
    ["undefined", undefined],
    ["a non-string", 12],
    ["an empty string", ""],
    ["a JPEG data URL", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    ["an empty PNG payload", "data:image/png;base64,"],
    ["non-base64 text", "data:image/png;base64,@@@@@@@@"],
    [
      "base64 of something that is not a PNG",
      `data:image/png;base64,${Buffer.from("this is certainly not a png file").toString("base64")}`,
    ],
    ["a truncated payload", url.slice(0, url.length - 1)],
  ];
  for (const [label, value] of invalid) {
    assert.throws(
      () => api.decodeCanvasPngDataUrl(value),
      (error) => {
        assert.ok(error instanceof Error, label);
        assert.match(
          error.message,
          /^STRUCTURAL:/,
          `${label}: a STRUCTURAL error`,
        );
        return true;
      },
      label,
    );
  }
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

for (const probe of PROBES) {
  test(`${probe.id}: imports cleanly with PROBE_BASE unset`, () =>
    cleanImportGroup(probe));

  test(`${probe.id}: an unset or port-8080 PROBE_BASE refuses at run entry, before any directory or browser`, async () => {
    await refusalGroup(probe);
  });

  test(`${probe.id}: --output redirects every file the run writes; without it the layout is today's`, async () => {
    await redirectGroup(probe);
  });
}

test("c11-13: decodeCanvasPngDataUrl returns the PNG bytes and throws STRUCTURAL for each invalid input", async () => {
  await decoderGroup(await import(pathToUrl(PROBES[0].lib)));
});

function pathToUrl(file) {
  return new URL(`file:///${file.replaceAll("\\", "/")}`).href;
}

// ---------------------------------------------------------------------------
// The entry scripts (child processes; the refusal comes before any Edge launch)
// ---------------------------------------------------------------------------

// The child must stay hermetic even when the refusal under test has regressed:
// a regressed entry would otherwise launch Edge against the default origin and
// write its canonical artifact and first-red cwd-relative, i.e. into whatever
// repository runs this spec (the seat's banked evidence included). So the
// child runs in a lane temp directory, and a preload resolves `playwright` to a
// stub whose launch throws, so a regression fails the assertions without ever
// reaching a browser.
const BLOCKED_PLAYWRIGHT = `data:text/javascript,${encodeURIComponent(
  [
    "const block = () => {",
    '  throw new Error("c11-run-entry.spec: browser launch blocked (the run-entry refusal did not fire)");',
    "};",
    "const browserType = { launch: block, launchPersistentContext: block, connect: block };",
    "export const chromium = browserType;",
    "export const firefox = browserType;",
    "export const webkit = browserType;",
    "export default { chromium, firefox, webkit };",
  ].join("\n"),
)}`;
const BLOCK_PLAYWRIGHT_HOOKS = `data:text/javascript,${encodeURIComponent(
  [
    "export async function resolve(specifier, context, next) {",
    '  if (specifier === "playwright" || specifier === "playwright-core") {',
    `    return { url: ${JSON.stringify(BLOCKED_PLAYWRIGHT)}, shortCircuit: true };`,
    "  }",
    "  return next(specifier, context);",
    "}",
  ].join("\n"),
)}`;
const BLOCK_PLAYWRIGHT_PRELOAD = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(BLOCK_PLAYWRIGHT_HOOKS)});`,
)}`;

function runEntry(probe, args, env, cwd) {
  const childEnv = { ...process.env };
  delete childEnv.PROBE_BASE;
  Object.assign(childEnv, env);
  return spawnSync(
    process.execPath,
    ["--import", BLOCK_PLAYWRIGHT_PRELOAD, probe.entry, ...args],
    {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
}

for (const probe of PROBES) {
  test(`${probe.id}: the entry script refuses (exit 3, REFUSED on stderr) before launching Edge, and takes only --output`, () =>
    withLaneTmp("c11-entry-script-", (dir) => {
      const cwd = path.join(dir, "cwd");
      fs.mkdirSync(cwd);
      const unset = runEntry(probe, [], {}, cwd);
      assert.equal(unset.status, PROBE_EXIT_CODES.REFUSAL, unset.stderr);
      assert.match(unset.stderr, /REFUSED \(probe-base-unset\)/);

      const redirect = path.join(dir, "never-made");
      const forbidden = runEntry(
        probe,
        ["--output", redirect],
        { PROBE_BASE: "http://localhost:8080" },
        cwd,
      );
      assert.equal(
        forbidden.status,
        PROBE_EXIT_CODES.REFUSAL,
        forbidden.stderr,
      );
      assert.match(forbidden.stderr, /REFUSED \(port-8080-forbidden\)/);
      assert.equal(
        fs.existsSync(redirect),
        false,
        "no directory made by a refused run",
      );

      const unknown = runEntry(probe, ["--port", "8094"], GOVERNED, cwd);
      assert.equal(
        unknown.status,
        PROBE_EXIT_CODES.ERROR,
        "any other argument exits 2",
      );
    }));
}

/**
 * The ENTRY passes its parsed --output through: a governed run of the entry
 * script (the command the Edge-job runner issues) writes under the redirect and
 * never makes the cwd-relative default. The browser launch is blocked by the
 * preload, and the run still creates its run root before it reaches the launch.
 *
 * @param {object} probe The probe table row.
 * @param {string} [entryFile] The entry script (a mutated copy in a mutant).
 */
function entryRedirectGroup(probe, entryFile = probe.entry) {
  return withLaneTmp("c11-entry-redirect-", async (dir) => {
    const cwd = path.join(dir, "cwd");
    fs.mkdirSync(cwd);
    materializeLocalPaths(probe, cwd);
    const out = path.join(dir, "out");
    const run = runEntry(
      { ...probe, entry: entryFile },
      ["--output", out],
      GOVERNED,
      cwd,
    );
    assert.notEqual(
      run.status,
      PROBE_EXIT_CODES.REFUSAL,
      `${probe.id}: a governed origin does not refuse: ${run.stderr}`,
    );
    assert.ok(
      fs.existsSync(path.join(out, probe.runDirectory)) &&
        fs.statSync(path.join(out, probe.runDirectory)).isDirectory(),
      `${probe.id}: the run root was made under --output: ${run.stderr}`,
    );
    assert.equal(
      fs.existsSync(path.join(cwd, "Tools", "visual-regression", "output")),
      false,
      `${probe.id}: the cwd-relative default output was never made`,
    );
  });
}

for (const probe of PROBES) {
  test(`${probe.id}: the entry script passes --output through (a governed run writes under it, never the cwd default)`, () =>
    entryRedirectGroup(probe));
}

/**
 * A copy of an entry script with anchors applied, written under `dir`. Its
 * relative imports point at the original files; `playwright` stays bare so the
 * blocking preload still resolves it.
 */
function mutatedEntry(probe, replacements, dir) {
  let source = fs.readFileSync(probe.entry, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(probe.entry);
  source = source.replace(
    /from "(\.[^"]*)"/g,
    (match, specifier) => `from "${new URL(specifier, base).href}"`,
  );
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    assert.equal(count, 1, `anchor must occur exactly once (${count})`);
    source = source.replace(anchor, () => replacement);
  }
  const file = path.join(dir, `mutated-${path.basename(probe.entry)}`);
  fs.writeFileSync(file, source);
  return file;
}

for (const probe of PROBES) {
  test(`mutant (${probe.id}): the entry passing { outputDirectory: null } turns the entry-redirect group RED`, () =>
    withLaneTmp("c11-entry-mutant-", async (dir) => {
      const file = mutatedEntry(
        probe,
        [["    { outputDirectory },\n", "    { outputDirectory: null },\n"]],
        dir,
      );
      await assert.rejects(
        () => entryRedirectGroup(probe, file),
        (error) => error instanceof assert.AssertionError,
        `${probe.id}: the group still passed over the mutant`,
      );
    }));
}

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

/**
 * @param {string} label What the mutant does.
 * @param {object} probe The probe.
 * @param {Array<[string, string]>} replacements Anchors.
 * @param {Function} group `(probe, replacements) => Promise`.
 */
function mutant(label, probe, replacements, group) {
  test(`mutant (${probe.id}): ${label} turns the group RED`, async () => {
    // A function is resolved here, inside the named test, so an anchor that
    // drifted fails this test (an assertion outside the rejects check) rather
    // than the whole file at load.
    const resolved =
      typeof replacements === "function" ? replacements() : replacements;
    await assert.rejects(
      () => group(probe, resolved),
      (error) =>
        !(
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ),
      `${label}: the group still passed over the mutant`,
    );
  });
}

const REFUSE_CALL = "throwIfProbeBaseRefused(env.PROBE_BASE);";
for (const probe of PROBES) {
  mutant(
    "the run-entry refusal call removed (port refusal inert)",
    probe,
    [[REFUSE_CALL, ""]],
    refusalGroup,
  );
  mutant(
    'the "http://localhost:8080" default restored',
    probe,
    [
      [
        REFUSE_CALL,
        'throwIfProbeBaseRefused(env.PROBE_BASE ?? "http://localhost:8080");',
      ],
    ],
    refusalGroup,
  );
  test(`mutant (${probe.id}): the refusal moved to module evaluation turns the clean-import group RED`, async () => {
    await assert.rejects(
      () =>
        cleanImportGroup(probe, [
          [
            "bindOutputLayout(null);\n",
            "bindOutputLayout(null);\nthrowIfProbeBaseRefused(process.env.PROBE_BASE);\n",
          ],
        ]),
      (error) =>
        error instanceof ProbeRefusal && error.reason === "probe-base-unset",
    );
  });
  mutant(
    "a directory made before the refusal",
    probe,
    [
      [
        "  bindRunEntry({ env, outputDirectory });\n  const runId = randomUUID();",
        '  fs.mkdirSync(path.resolve("Tools/visual-regression/output"), { recursive: true });\n  bindRunEntry({ env, outputDirectory });\n  const runId = randomUUID();',
      ],
    ],
    refusalGroup,
  );
  mutant(
    "--output ignored (every path stays cwd-relative)",
    probe,
    [
      [
        "    outputDirectory === null || outputDirectory === undefined\n",
        "    true ||\n    outputDirectory === null || outputDirectory === undefined\n",
      ],
    ],
    redirectGroup,
  );
}

// The port refusal lives in the runtime's one decision (the decisions
// companion the runtime re-exports); make THAT inert under the c11 library and
// the port-8080 cases go RED.
function portDecisionInert() {
  const runtimeUrl = pathToFileURL(RUNTIME_PATH).href;
  const decisionsUrl = pathToFileURL(DECISIONS_PATH).href;
  const decisionsInert = dataUrlOf(
    rewriteSource(DECISIONS_PATH, [
      ["  if (port === 8080) {", "  if (false && port === 8080) {"],
    ]),
  );
  const portInert = dataUrlOf(
    rewriteSource(RUNTIME_PATH, [
      [`from "${decisionsUrl}"`, `from "${decisionsInert}"`],
    ]),
  );
  return [[`from "${runtimeUrl}"`, `from "${portInert}"`]];
}
for (const probe of PROBES) {
  mutant(
    "the runtime's port-8080 decision inert",
    probe,
    portDecisionInert,
    refusalGroup,
  );
}

test("mutant (c11-13): the decoder reverted to a lenient base64 slice turns the group RED", async () => {
  const api = await loadLib(PROBES[0].lib, [
    [
      'return decodePngDataUrl(value, { name: "c11-13 canvas capture" });',
      'return Buffer.from(String(value).slice("data:image/png;base64,".length), "base64");',
    ],
  ]);
  await assert.rejects(
    () => decoderGroup(api),
    (error) =>
      !(error instanceof ReferenceError || error instanceof SyntaxError),
  );
});
