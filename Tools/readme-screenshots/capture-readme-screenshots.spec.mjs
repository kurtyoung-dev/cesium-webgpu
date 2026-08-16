// capture-readme-screenshots.spec.mjs — AUTHORING-TIME enforcement of the
// README feature-table <-> screenshot-manifest contract, and of the capture
// script's own membership in the probe fleet's machine-safety contract.
// @purpose Browser-free enforcement of the README-table <-> scenes.json contract plus the capture script's probe-fleet safety membership; mutant-tested.
// @status ACTIVE
//
// Pure Node: no browser, no network, no GPU.
//
// THE GAP THIS CLOSES. The README's feature table promises a completion figure,
// a basis for that figure, and a WebGPU screenshot on every row, produced by one
// command. Five things can rot silently between runs, and all of them produce a
// README that LOOKS finished:
//
//   1. a row is added with no scene, so its image never exists and the reader
//      sees a broken picture;
//   2. a scene is added with no row, so capture time is spent on an image
//      nobody displays;
//   3. a scene names a demo, tileset or model that has since moved, which is
//      only discovered forty minutes into an Edge run, as a black PNG;
//   4. a demo page loses the entry point the capture script's loader calls, so
//      the page sits inert and the run spends a readiness timeout finding out;
//   5. the run's own schedule stops fitting its manifest — a watchdog sized from
//      a constant, or a re-run that repeats work already on disk.
//
// All five are decidable from source, so they are decided here.
//
// WHY THE DETECTORS ARE MUTANT-TESTED FIRST. A contract checker is exactly the
// shape of instrument this repo has repeatedly been burned by: it passes, and
// it would also have passed if the thing it checks had been deleted. Every rule
// below is therefore stated once against the real files and once against a
// deliberately broken copy, and the broken copy must fail.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Every read here goes
// through the shared parser, which normalises line endings before splitting.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  CONTENT_TYPES,
  DEFAULT_CAPTURE_SELECTOR,
  ENGINE_MODULE_URL,
  IMAGE_DIR,
  LEGACY_GALLERY_DIR,
  SCENE_AIMS,
  SCENE_KINDS,
  SCENE_TERRAINS,
  TABLE_BEGIN,
  TABLE_END,
  auditContract,
  crossCheck,
  galleryLegacyId,
  legacyDemoBootErrors,
  parseFeatureTable,
  resolveScene,
  screenshotPath,
  tableCells,
  validateManifest,
} from "./lib/readme-table.mjs";
import {
  ANCHOR_KINDS,
  decodePng,
  evaluateAnchors,
  largestBrightRegion,
  rowCoverage,
} from "./lib/image-anchors.mjs";
import {
  resolveDeadRoutes,
  scanPageReferences,
  toRootRelative,
} from "./lib/dead-routes.mjs";
import {
  isForeignNetworkFailure,
  networkFailureSubject,
} from "./lib/console-gate.mjs";
import {
  DEFAULT_SCENE_BUDGET_MS,
  DEFAULT_WATCHDOG_CAP_MS,
  MIN_WATCHDOG_MS,
  computeWatchdogMs,
  describeProgress,
  planRun,
} from "./lib/capture-plan.mjs";
import { analyzeProbeSource } from "../visual-regression/lib/probe-fleet-contract.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "../visual-regression/lib/probe-fleet-contract-allowlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "scenes.json"), "utf8"));
const CAPTURE_SOURCE = readFileSync(
  join(HERE, "capture-readme-screenshots.mjs"),
  "utf8",
);
const PLAN_SOURCE = readFileSync(join(HERE, "lib", "capture-plan.mjs"), "utf8");

/** A completion cell: `92 %` or `70-80 %`, optionally emphasised. */
const COMPLETION_CELL = /^\*{0,2}\d{1,3}(?:\s*[–-]\s*\d{1,3})?\s*%\*{0,2}$/;

// ---------------------------------------------------------------------------
// A. The parser's own primitives
// ---------------------------------------------------------------------------

test("A1: tableCells drops the pipes' phantom edge cells", () => {
  assert.deepEqual(tableCells("| a | b | c | d |"), ["a", "b", "c", "d"]);
  assert.deepEqual(tableCells("not a table row"), []);
});

test("A2: screenshotPath reads markdown image syntax only", () => {
  assert.equal(
    screenshotPath("![x](Documentation/Images/webgpu-fork/x.png)"),
    "Documentation/Images/webgpu-fork/x.png",
  );
  assert.equal(screenshotPath("(none yet)"), null);
  // `.markdownlint.json` allows only <details>/<summary>, so an <img> would
  // fail lint anyway; refusing to parse it keeps the two rules aligned.
  assert.equal(
    screenshotPath('<img src="Documentation/Images/webgpu-fork/x.png">'),
    null,
  );
});

test("A3: parseFeatureTable needs the fence", () => {
  const { errors } = parseFeatureTable("# Title\n\nno fence here\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing the/);
});

test("A4: parseFeatureTable reads groups, rows and image paths", () => {
  const doc = [
    TABLE_BEGIN,
    "",
    "### Group One",
    "",
    "| Feature | Completion | Notes & details | Screenshot |",
    "| --- | --- | --- | --- |",
    `| Widget | 80 % | because | ![widget](${IMAGE_DIR}/widget.png) |`,
    "",
    TABLE_END,
  ].join("\r\n");
  const parsed = parseFeatureTable(doc);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.groups, ["Group One"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].feature, "Widget");
  assert.equal(parsed.rows[0].group, "Group One");
  assert.equal(parsed.rows[0].screenshot, `${IMAGE_DIR}/widget.png`);
});

// ---------------------------------------------------------------------------
// B. Mutants — every rule run against the wrong input
// ---------------------------------------------------------------------------

const goodScene = {
  id: "widget",
  group: "Group One",
  row: "Widget",
  output: "widget.png",
  kind: "viewer",
  minNonBlackPct: 0.2,
  minDistinct: 8,
};

test("B1: a well-formed manifest validates clean", () => {
  const { errors } = validateManifest({ scenes: [goodScene] });
  assert.deepEqual(errors, []);
});

test("B2 mutant: output that does not match the id is rejected", () => {
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, output: "something-else.png" }],
  });
  assert.ok(errors.some((e) => /output must be/.test(e)));
});

test("B3 mutant: an unknown kind is rejected", () => {
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, kind: "iframe" }],
  });
  assert.ok(errors.some((e) => /kind must be one of/.test(e)));
});

test("B4 mutant: an unknown aim is rejected", () => {
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, aim: "look-at-mars" }],
  });
  assert.ok(errors.some((e) => /unknown aim/.test(e)));
});

test("B5 mutant: a settings entry with no value is rejected", () => {
  const { errors } = validateManifest({
    scenes: [
      { ...goodScene, settings: [{ path: "scene.globe.enableLighting" }] },
    ],
  });
  assert.ok(errors.some((e) => /value is required/.test(e)));
});

test("B6 mutant: a pixel threshold outside (0, 1] is rejected", () => {
  for (const bad of [0, -0.1, 42]) {
    const { errors } = validateManifest({
      scenes: [{ ...goodScene, minNonBlackPct: bad }],
    });
    assert.ok(
      errors.some((e) => /minNonBlackPct/.test(e)),
      `threshold ${bad} escaped`,
    );
  }
});

test("B7 mutant: a README row with no scene FAILS the cross-check", () => {
  // A row whose image nobody produces renders as a broken picture, which is
  // worse than an absent row.
  const rows = [
    { group: "G", feature: "Widget", screenshot: `${IMAGE_DIR}/widget.png` },
    { group: "G", feature: "Orphan", screenshot: `${IMAGE_DIR}/orphan.png` },
  ];
  const errors = crossCheck(rows, [goodScene]);
  assert.ok(
    errors.some((e) => /Orphan.*no manifest scene produces it/.test(e)),
  );
});

test("B8 mutant: a scene with no README row FAILS the cross-check", () => {
  const rows = [
    {
      group: "Group One",
      feature: "Widget",
      screenshot: `${IMAGE_DIR}/widget.png`,
    },
  ];
  const errors = crossCheck(rows, [
    goodScene,
    { ...goodScene, id: "spare", output: "spare.png", row: "Spare" },
  ]);
  assert.ok(errors.some((e) => /"spare" has no README row/.test(e)));
});

test("B9 mutant: a row with no image at all FAILS", () => {
  const errors = crossCheck(
    [{ group: "Group One", feature: "Widget", screenshot: null }],
    [],
  );
  assert.ok(errors.some((e) => /has no screenshot image/.test(e)));
});

test("B10 mutant: a row/scene label disagreement FAILS", () => {
  const errors = crossCheck(
    [
      {
        group: "Group One",
        feature: "Renamed",
        screenshot: `${IMAGE_DIR}/widget.png`,
      },
    ],
    [goodScene],
  );
  assert.ok(errors.some((e) => /records row "Widget"/.test(e)));
});

test("B11 mutant: a scene naming a file that is not on disk FAILS", () => {
  const { errors } = resolveScene(
    {
      ...goodScene,
      content: [
        { type: "tileset", url: "/Apps/SampleData/NoSuchThing/tileset.json" },
      ],
    },
    REPO_ROOT,
  );
  assert.ok(errors.some((e) => /required file is missing/.test(e)));
});

// ---------------------------------------------------------------------------
// C. The real README and the real manifest
// ---------------------------------------------------------------------------

test("C1: the real README and the real manifest satisfy the whole contract", () => {
  const audit = auditContract(README, MANIFEST, REPO_ROOT);
  assert.deepEqual(
    audit.errors,
    [],
    `README <-> scenes.json contract violations:\n  ${audit.errors.join("\n  ")}`,
  );
  assert.ok(
    audit.rows.length >= 25 && audit.rows.length <= 45,
    `the table has ${audit.rows.length} rows; a presentable table is ~25-40`,
  );
  assert.equal(audit.rows.length, audit.scenes.length);
});

test("C2: every row states a completion figure AND a basis for it", () => {
  const { rows } = parseFeatureTable(README);
  const offenders = [];
  for (const row of rows) {
    if (!COMPLETION_CELL.test(row.status)) {
      offenders.push(
        `${row.feature}: completion cell "${row.status}" is not a % or a % range`,
      );
    }
    // A figure with no stated basis is invented precision. The word "Basis" is
    // the marker the table uses to carry the evidence behind the number.
    if (!/\bBasis:/.test(row.notes)) {
      offenders.push(
        `${row.feature}: notes cell states no "Basis:" for its figure`,
      );
    }
    if (row.notes.length < 80) {
      offenders.push(`${row.feature}: notes cell is too thin to carry a basis`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("C3: every row's image file name equals its scene id", () => {
  const { rows } = parseFeatureTable(README);
  for (const row of rows) {
    const file = row.screenshot.slice(`${IMAGE_DIR}/`.length);
    const scene = MANIFEST.scenes.find((s) => s.output === file);
    assert.ok(scene, `${row.feature}: no scene writes ${file}`);
    assert.equal(file, `${scene.id}.png`);
  }
});

test("C4: every group in the manifest is a group in the README, in order", () => {
  const { rows, groups } = parseFeatureTable(README);
  const manifestGroups = [...new Set(MANIFEST.scenes.map((s) => s.group))];
  assert.deepEqual(manifestGroups, groups);
  // Every subsystem bucket the table divides the fork into is represented.
  assert.ok(groups.length >= 10, `only ${groups.length} subsystem groups`);
  assert.ok(rows.length > groups.length);
});

test("C5: every sandcastle scene resolves to a standalone demo that exists", () => {
  const sandcastle = MANIFEST.scenes.filter((s) => s.kind === "sandcastle");
  assert.ok(
    sandcastle.length >= 10,
    "the table barely uses the fork's own demos",
  );
  for (const scene of sandcastle) {
    const legacyId = galleryLegacyId(REPO_ROOT, scene.gallery);
    assert.ok(
      legacyId,
      `${scene.id}: packages/sandcastle/gallery/${scene.gallery} has no legacyId`,
    );
    const page = join(REPO_ROOT, "Apps", "Sandcastle", "gallery", legacyId);
    assert.ok(
      existsSync(page),
      `${scene.id}: ${legacyId} is not in Apps/Sandcastle/gallery`,
    );
    // The three catalogue demos read `?renderer=` rather than pinning WebGPU in
    // source, so the resolver must always append it.
    assert.match(resolveScene(scene, REPO_ROOT).url, /\?renderer=webgpu$/);
  }
});

test("C6: no scene points at a remote resource", () => {
  // A screenshot set that depends on a third-party host is not reproducible,
  // and a silent 404 there produces an empty scene rather than an error.
  for (const scene of MANIFEST.scenes) {
    for (const item of scene.content ?? []) {
      assert.ok(
        item.url.startsWith("/"),
        `${scene.id}: content url ${item.url} is not local`,
      );
    }
    if (scene.kind === "page") {
      assert.ok(
        scene.url.startsWith("/"),
        `${scene.id}: page url is not local`,
      );
    }
  }
});

test("C7: viewer scenes are pinned in time and reach a camera", () => {
  for (const scene of MANIFEST.scenes.filter((s) => s.kind === "viewer")) {
    assert.ok(
      typeof scene.timeIso === "string",
      `${scene.id}: a viewer scene without a pinned clock is not reproducible`,
    );
    const framed =
      scene.view !== undefined ||
      scene.aim !== undefined ||
      (scene.content ?? []).some((c) => c.zoomTo === true);
    assert.ok(
      framed,
      `${scene.id}: no view, no aim and nothing to zoom to — the camera is wherever the app left it`,
    );
  }
});

// ---------------------------------------------------------------------------
// D. The capture script itself
// ---------------------------------------------------------------------------

test("D1: the capture script satisfies the probe fleet's machine-safety contract", () => {
  const analysis = analyzeProbeSource(CAPTURE_SOURCE);
  assert.equal(analysis.launchesBrowser, true);
  assert.deepEqual(
    analysis.violations,
    [],
    `capture-readme-screenshots.mjs violates the fleet contract: ${analysis.violations.join("; ")}`,
  );
  assert.equal(analysis.hasWatchdog, true);
  assert.equal(analysis.closeInFinally, true);
  assert.equal(
    analysis.declaresStructuralExit,
    true,
    "the capture script must reach exit 3 when it cannot see its subject",
  );
});

test("D2: the capture script is NOT allowlisted anywhere", () => {
  // Fleet-contract compliant, no allowlisting. The allowlist is closed and
  // shrink-only; a new tool appearing in it would be a regression in the
  // ratchet, not an exemption.
  const listed = Object.keys(PROBE_CONTRACT_ALLOWLIST).filter((name) =>
    /capture-readme-screenshots/.test(name),
  );
  assert.deepEqual(listed, [], `allowlisted: ${listed.join(", ")}`);
});

test("D3 MUTATION control: stripping the watchdog brings the violation back", () => {
  // D1 passes trivially if the analyzer cannot see a violation in this file.
  const mutated = CAPTURE_SOURCE.replaceAll("\r\n", "\n").replace(
    /setTimeout\(/,
    "queueMicrotask(",
  );
  assert.notEqual(mutated, CAPTURE_SOURCE.replaceAll("\r\n", "\n"));
  const analysis = analyzeProbeSource(mutated);
  assert.equal(analysis.hasWatchdog, false);
  assert.ok(analysis.violations.includes("no watchdog"));
});

test("D4 MUTATION control: moving the close out of finally is detected", () => {
  const mutated = CAPTURE_SOURCE.replaceAll("\r\n", "\n").replaceAll(
    /\bfinally\b/g,
    "catch (mutantError)",
  );
  const analysis = analyzeProbeSource(mutated);
  assert.equal(analysis.closeInFinally, false);
});

test("D5: every aim the manifest may request is implemented by the script", () => {
  // A manifest naming an aim the script silently ignores is the exact shape of
  // a screenshot that looks fine and shows the wrong thing.
  for (const aim of SCENE_AIMS) {
    if (aim === "none") {
      continue;
    }
    assert.ok(
      CAPTURE_SOURCE.includes(`"${aim}"`),
      `capture-readme-screenshots.mjs never mentions the "${aim}" aim`,
    );
  }
  for (const scene of MANIFEST.scenes) {
    if (scene.aim !== undefined) {
      assert.ok(SCENE_AIMS.includes(scene.aim), `${scene.id}: unknown aim`);
    }
  }
});

test("D6: the script writes into the directory the README reads from", () => {
  assert.ok(CAPTURE_SOURCE.includes("IMAGE_DIR"));
  assert.equal(IMAGE_DIR, "Documentation/Images/webgpu-fork");
  assert.ok(
    README.includes(`(${IMAGE_DIR}/`),
    "the README references no image under the shared IMAGE_DIR",
  );
});

test("D7: the script reads back every setting it writes", () => {
  // The anti-vacuity guard, anchored. A capture script that writes
  // `scene.globe.enhancedOcean = true` into a property that does not exist
  // produces a screenshot of the feature OFF and files it as evidence.
  assert.ok(
    /did not stick/.test(CAPTURE_SOURCE),
    "the write-then-read-back check is gone from the capture script",
  );
  assert.ok(
    /no WebGPU device was created/.test(CAPTURE_SOURCE),
    "the WebGPU-device assertion is gone; a WebGL fallback would be filed as a WebGPU screenshot",
  );
});

test("D8: the script offers the --only, --list and resume controls", () => {
  assert.ok(CAPTURE_SOURCE.includes("--only"));
  assert.ok(CAPTURE_SOURCE.includes("--list"));
  // Resuming is the default, so the flag that turns it OFF is the one the
  // script has to expose; a run with no way back to a full re-capture would
  // quietly refuse to refresh images that are already on disk.
  assert.ok(
    CAPTURE_SOURCE.includes("--force"),
    "no way to re-capture images that already exist",
  );
  assert.ok(
    /skipExisting\s*=\s*!\(/.test(CAPTURE_SOURCE),
    "skip-existing is not the default; an interrupted run cannot be resumed",
  );
});

test("D9: the manifest exercises every scene kind the script implements", () => {
  const used = new Set(MANIFEST.scenes.map((s) => s.kind));
  for (const kind of SCENE_KINDS) {
    assert.ok(
      used.has(kind),
      `no scene uses kind "${kind}" — dead code in the driver`,
    );
  }
  const contentTypes = new Set(
    MANIFEST.scenes.flatMap((s) => (s.content ?? []).map((c) => c.type)),
  );
  for (const type of CONTENT_TYPES) {
    assert.ok(contentTypes.has(type), `no scene loads content type "${type}"`);
  }
});

// ---------------------------------------------------------------------------
// F. Booting the standalone demo pages
// ---------------------------------------------------------------------------

test("F1: every demo page still defines the entry point the loader calls", () => {
  // The two loader scripts these pages reference were deleted with the legacy
  // Sandcastle app, so the capture script supplies both. The one thing it
  // cannot supply is the demo's own `window.startup`, and a page that lost it
  // would present as a readiness timeout rather than as a missing function.
  const sandcastle = MANIFEST.scenes.filter((s) => s.kind === "sandcastle");
  const offenders = [];
  for (const scene of sandcastle) {
    const legacyId = galleryLegacyId(REPO_ROOT, scene.gallery);
    const errors = legacyDemoBootErrors(REPO_ROOT, legacyId ?? "");
    if (errors.length > 0) {
      offenders.push(`${scene.id}: ${errors.join("; ")}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("F2 mutant: a page with no window.startup is rejected", () => {
  const errors = legacyDemoBootErrors(REPO_ROOT, "no-such-demo.html");
  assert.ok(errors.some((e) => /is not on disk/.test(e)));
});

test("F3: resolveScene carries the boot contract into the run's own audit", () => {
  // The check has to fire from the SAME resolver the capture script calls,
  // or the spec proves a rule the run does not apply.
  const { errors } = resolveScene(
    { ...goodScene, kind: "sandcastle", gallery: "no-such-gallery" },
    REPO_ROOT,
  );
  assert.ok(errors.some((e) => /no sandcastle\.yaml legacyId/.test(e)));
});

test("F4: the script re-creates both deleted loaders, and imports the bundle", () => {
  // Named individually because either half alone leaves the page inert: the
  // Sandcastle global without the module import has nothing to run, and the
  // module import without the global throws the moment a demo builds a button.
  assert.ok(
    /window\.Sandcastle\s*=/.test(CAPTURE_SOURCE),
    "no Sandcastle global is installed; every demo would throw at finishedLoading",
  );
  assert.ok(
    /addToolbarMenu/.test(CAPTURE_SOURCE),
    "the menu helper is missing; demos that build content in a menu handler would photograph empty",
  );
  assert.ok(
    /defaultAction/.test(CAPTURE_SOURCE),
    "the default action is never invoked; a menu's first entry is the state the demo means to show",
  );
  assert.ok(
    CAPTURE_SOURCE.includes("window.startup("),
    "the demo entry point is never called",
  );
  assert.ok(
    CAPTURE_SOURCE.includes("ENGINE_MODULE_URL"),
    "the engine bundle is never imported into the demo page",
  );
  assert.equal(ENGINE_MODULE_URL, "/Build/CesiumUnminified/index.js");
  assert.equal(LEGACY_GALLERY_DIR, "Apps/Sandcastle/gallery");
});

test("F5: a dead route is decided by a pre-flight, not by a readiness timeout", () => {
  assert.ok(
    /urlAnswers/.test(CAPTURE_SOURCE),
    "no HTTP pre-flight; an unserved URL would cost a full readiness timeout",
  );
  assert.ok(
    /does not serve/.test(CAPTURE_SOURCE),
    "a URL that does not answer is not reported as a structural note",
  );
  assert.ok(
    /AbortSignal\.timeout/.test(CAPTURE_SOURCE),
    "the pre-flight itself can hang",
  );
});

// ---------------------------------------------------------------------------
// G. The run's schedule — budget, resume, watchdog
// ---------------------------------------------------------------------------

test("G1: the watchdog scales with the scene count and stops at the cap", () => {
  const one = computeWatchdogMs({ sceneCount: 1 });
  const forty = computeWatchdogMs({ sceneCount: 40 });
  assert.ok(forty > one, "a longer manifest does not buy a longer watchdog");
  assert.ok(
    forty >= 40 * DEFAULT_SCENE_BUDGET_MS,
    "the watchdog is shorter than the per-scene budgets it has to contain",
  );
  assert.equal(
    computeWatchdogMs({ sceneCount: 100000 }),
    DEFAULT_WATCHDOG_CAP_MS,
    "an unbounded manifest buys an unbounded run",
  );
  assert.equal(computeWatchdogMs({ sceneCount: 0 }), MIN_WATCHDOG_MS);
});

test("G2 mutant: nonsense sizing inputs fall back rather than disarm", () => {
  // A watchdog computed as NaN is a watchdog that never fires.
  for (const bad of [Number.NaN, -1, undefined, "90000"]) {
    const ms = computeWatchdogMs({ sceneCount: 5, sceneBudgetMs: bad });
    assert.ok(
      Number.isFinite(ms) && ms >= MIN_WATCHDOG_MS,
      `sceneBudgetMs=${String(bad)} produced ${String(ms)}`,
    );
  }
  assert.ok(Number.isFinite(computeWatchdogMs({ sceneCount: Number.NaN })));
});

test("G3: the run resumes by skipping images already on disk", () => {
  const scenes = [
    { ...goodScene, id: "alpha", output: "alpha.png" },
    { ...goodScene, id: "beta", output: "beta.png" },
    { ...goodScene, id: "gamma", output: "gamma.png" },
  ];
  const sizes = { "alpha.png": 4096, "beta.png": 0 };
  const sizeOf = (path) => sizes[path.split(/[\\/]/).pop()] ?? 0;
  const plan = planRun({ scenes, skipExisting: true, outDir: "out", sizeOf });
  assert.deepEqual(
    plan.run.map((s) => s.id),
    ["beta", "gamma"],
    "a zero-byte PNG must be re-captured, not treated as done",
  );
  assert.deepEqual(
    plan.skipped.map((s) => s.id),
    ["alpha"],
  );
});

test("G3b: a scene the last run failed is re-captured, PNG or no PNG", () => {
  // The capture script writes a PNG on every attempt, including attempts that
  // miss their pixel thresholds. Skipping on file presence alone would pin a
  // known-bad image in the README for as long as nobody deleted it by hand.
  const scenes = [
    { ...goodScene, id: "alpha", output: "alpha.png" },
    { ...goodScene, id: "beta", output: "beta.png" },
  ];
  const plan = planRun({
    scenes,
    skipExisting: true,
    outDir: "out",
    priorFailures: new Set(["beta"]),
    sizeOf: () => 4096,
  });
  assert.deepEqual(
    plan.run.map((s) => s.id),
    ["beta"],
  );
  assert.deepEqual(
    plan.skipped.map((s) => s.id),
    ["alpha"],
  );
});

test("G4: --only always re-captures, and an unknown id is structural", () => {
  const scenes = [{ ...goodScene, id: "alpha", output: "alpha.png" }];
  const sizeOf = () => 9999;
  const plan = planRun({
    scenes,
    only: "alpha",
    skipExisting: true,
    outDir: "out",
    sizeOf,
  });
  assert.deepEqual(
    plan.run.map((s) => s.id),
    ["alpha"],
    "asking for one scene by name must not be answered with a skip",
  );
  const missing = planRun({ scenes, only: "nope", sizeOf });
  assert.equal(missing.run.length, 0);
  assert.ok(missing.errors.some((e) => /matches no scene/.test(e)));
});

test("G5: a cut-short run names what it captured AND what it never reached", () => {
  // The defect this replaces: a force-exit that said only that it had fired,
  // leaving the next invocation to re-derive the remainder by hand.
  const planned = [
    { id: "alpha" },
    { id: "beta" },
    { id: "gamma" },
    { id: "delta" },
  ];
  const lines = describeProgress({
    planned,
    results: [
      { id: "alpha", ok: true },
      { id: "beta", ok: false },
    ],
    skipped: [{ id: "zeta" }],
  }).join("\n");
  assert.match(lines, /captured 1\/4/);
  assert.match(lines, /\+1 skipped/);
  assert.match(lines, /attempted but not OK: beta/);
  assert.match(lines, /NEVER ATTEMPTED \(2\): gamma, delta/);
});

test("G6: the watchdog the script arms is computed, and reports progress", () => {
  assert.ok(
    /computeWatchdogMs\(\{[\s\S]{0,200}sceneCount: planned\.length/.test(
      CAPTURE_SOURCE,
    ),
    "the watchdog is not sized from the scenes actually scheduled",
  );
  assert.ok(
    /describeProgress\(/.test(CAPTURE_SOURCE),
    "the force-exit path prints no per-scene accounting",
  );
  assert.ok(
    /SCENE_BUDGET_MS/.test(CAPTURE_SOURCE),
    "there is no per-scene time budget",
  );
  assert.ok(
    /budgetLeft\(\)/.test(CAPTURE_SOURCE),
    "waits are not clamped to what the scene has left",
  );
});

test("G7: exactly one watchdog exists, and it is the one the mutants target", () => {
  // Two watchdogs would make D3's mutation control vacuous: stripping the first
  // would leave the second, and the analyzer would keep reporting compliance.
  const armings = CAPTURE_SOURCE.match(/setTimeout\(/g) ?? [];
  assert.equal(
    armings.length,
    1,
    `expected one setTimeout arming site, found ${armings.length}`,
  );
});

// ---------------------------------------------------------------------------
// H. Dead routes — the 404s that rejected eighteen correct captures
// ---------------------------------------------------------------------------

/** Every page the manifest actually opens, repo-relative. */
function manifestPages() {
  const pages = new Set(["Apps/CesiumViewer/index.html"]);
  for (const scene of MANIFEST.scenes) {
    for (const file of resolveScene(scene, REPO_ROOT).requiredFiles) {
      if (file.endsWith(".html")) {
        pages.add(file);
      }
    }
  }
  return [...pages];
}

test("H1: the routed URLs are DERIVED from the pages and the disk", () => {
  // The list is not written down anywhere. A loader that comes back must stop
  // being routed with no edit, and a route must never be installed for a file
  // that exists — that would mask a real regression in it.
  const references = scanPageReferences(REPO_ROOT, manifestPages());
  assert.ok(
    references.length >= 8,
    `the scan found only ${references.length} references; it is not reading the pages`,
  );
  const routes = resolveDeadRoutes(REPO_ROOT, references);
  for (const route of routes) {
    assert.ok(
      !existsSync(join(REPO_ROOT, route.url.replace(/^\//, ""))),
      `${route.url} is ON DISK and must not be routed`,
    );
    assert.match(route.contentType, /^(text|application)\//);
  }
  // The two loader scripts every gallery page still references are exactly the
  // pair the round-2 run's 404s came from.
  const referenced = new Set(references);
  assert.ok(referenced.has("/Apps/Sandcastle/Sandcastle-header.js"));
  assert.ok(referenced.has("/Apps/Sandcastle/load-cesium-es6.js"));
});

test("H2: the scan follows stylesheet imports, not just the page's own tags", () => {
  // The demo layout arrives through two levels of `@import`, and a break at the
  // second level is invisible from the page — which is how a 1024x1 capture
  // happened once already.
  const references = scanPageReferences(REPO_ROOT, manifestPages());
  assert.ok(references.includes("/Apps/Sandcastle/templates/bucket.css"));
  assert.ok(
    references.some((url) => /Widgets\/widgets\.css$/.test(url)),
    "the scan stopped at bucket.css and never read what it imports",
  );
});

test("H3 mutant: a reference that exists is NOT routed; a missing one is", () => {
  const routes = resolveDeadRoutes(REPO_ROOT, [
    "/Apps/Sandcastle/templates/bucket.css",
    "/Apps/Sandcastle/no-such-loader.js",
  ]);
  assert.deepEqual(
    routes.map((r) => r.url),
    ["/Apps/Sandcastle/no-such-loader.js"],
  );
});

test("H4: toRootRelative resolves page-relative paths and refuses foreign ones", () => {
  const dir = "Apps/Sandcastle/gallery";
  assert.equal(
    toRootRelative(dir, "../Sandcastle-header.js"),
    "/Apps/Sandcastle/Sandcastle-header.js",
  );
  assert.equal(
    toRootRelative(dir, "../../../Build/CesiumUnminified/Cesium.js"),
    "/Build/CesiumUnminified/Cesium.js",
  );
  assert.equal(toRootRelative(dir, "/Build/x.js?v=2"), "/Build/x.js");
  for (const foreign of ["https://example.com/a.js", "//cdn/a.js", "#anchor"]) {
    assert.equal(toRootRelative(dir, foreign), null);
  }
});

test("H5: the console gate did NOT get a 404 escape hatch", () => {
  // The fix is that the 404 never happens. If the gate had instead been taught
  // to ignore "Failed to load resource", a missing tileset, model or bundle
  // would go unreported — the failures a screenshot run most needs to see.
  const suppressed = /const SUPPRESSED_CONSOLE = \[([\s\S]*?)\n\];/.exec(
    CAPTURE_SOURCE,
  );
  assert.ok(suppressed, "the suppression list is gone from the capture script");
  assert.ok(
    !/Failed to load resource|404/i.test(suppressed[1]),
    `the suppression list swallows 404s: ${suppressed[1]}`,
  );
  assert.ok(
    !/Sandcastle-header|load-cesium-es6/.test(suppressed[1]),
    "the dead loaders are suppressed by NAME again; they are routed, not ignored",
  );
  assert.ok(
    /page\.route\(/.test(CAPTURE_SOURCE),
    "nothing is routed; the dead references would 404 again",
  );
  assert.ok(
    /DEAD_ROUTES/.test(CAPTURE_SOURCE) &&
      /resolveDeadRoutes/.test(CAPTURE_SOURCE),
    "the routes are not derived from the shared resolver",
  );
});

test("H6: only foreign hosts are forgiven their network errors", () => {
  // Stated against the exact strings a real run produced. A demo that layers
  // third-party tiles reports whatever those servers do; what this fork serves
  // stays fatal, 404 included, because that is how a missing tileset, model or
  // bundle announces itself.
  const base = "http://localhost:8080";
  const cors =
    "Access to XMLHttpRequest at 'https://tile.openstreetmap.fr/openriverboatmap/1/1/0.png' from origin 'http://localhost:8080' has been blocked by CORS policy: The 'Access-Control-Allow-Origin' header has a value";
  // The message names the run's own origin too, as the ORIGIN of the request.
  // The subject is the resource, which comes first.
  assert.equal(isForeignNetworkFailure(cors, undefined, base), true);
  assert.equal(
    networkFailureSubject(cors, undefined),
    "https://tile.openstreetmap.fr/openriverboatmap/1/1/0.png",
  );
  // The mirror image: a CORS refusal for something this fork serves stays fatal.
  assert.equal(
    isForeignNetworkFailure(
      "Access to fetch at 'http://localhost:8080/Build/CesiumUnminified/index.js' from origin 'https://example.com' has been blocked by CORS policy",
      undefined,
      base,
    ),
    false,
  );
  assert.equal(
    isForeignNetworkFailure(
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
      "https://tile.openstreetmap.fr/openriverboatmap/1/1/0.png",
      base,
    ),
    true,
  );
  // The failure this fork owns, in both of Chromium's shapes.
  assert.equal(
    isForeignNetworkFailure(
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
      `${base}/Apps/SampleData/models/Missing.glb`,
      base,
    ),
    false,
  );
  assert.equal(
    isForeignNetworkFailure(
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
      undefined,
      base,
    ),
    false,
    "a 404 that names no host must not be forgiven",
  );
  // Not a network error at all.
  assert.equal(
    isForeignNetworkFailure(
      "Uncaught TypeError at https://example.com/x.js",
      undefined,
      base,
    ),
    false,
  );
  assert.ok(
    /isForeignNetworkFailure\(text, message\.location\(\)\?\.url, BASE\)/.test(
      CAPTURE_SOURCE,
    ),
    "the capture script does not route its console errors through the shared rule",
  );
});

// ---------------------------------------------------------------------------
// I. The offline image reader and the content anchors
// ---------------------------------------------------------------------------

/** CRC-32, so the spec can build PNGs a decoder will accept. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode an RGB image as a PNG using ONE filter type for every scanline.
 *
 * Filters are the half of PNG that an "approximate" decoder skips, so each of
 * the five is written and read back below.
 *
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {(x: number, y: number) => number[]} pixel RGB at a coordinate.
 * @param {number} filter Filter type 0-4.
 * @returns {Buffer} PNG bytes.
 */
function encodePng(width, height, pixel, filter = 0) {
  const stride = width * 3;
  const rows = [];
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const raw = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[x * 3] = r;
      raw[x * 3 + 1] = g;
      raw[x * 3 + 2] = b;
    }
    const encoded = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? raw[i - 3] : 0;
      const b = previous[i];
      const c = i >= 3 ? previous[i - 3] : 0;
      let value;
      if (filter === 0) {
        value = raw[i];
      } else if (filter === 1) {
        value = raw[i] - a;
      } else if (filter === 2) {
        value = raw[i] - b;
      } else if (filter === 3) {
        value = raw[i] - ((a + b) >> 1);
      } else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        value = raw[i] - predictor;
      }
      encoded[i] = value & 0xff;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), Buffer.from(encoded)]));
    previous.set(raw);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("I1: the decoder reconstructs every PNG scanline filter", () => {
  // A decoder that ignores filter bytes reads plausible garbage for filters
  // 1-4 — worse than failing, because the anchors would then be measuring an
  // image nobody produced.
  const pattern = (x, y) => [(x * 7 + y * 3) % 256, (x * 13) % 256, y % 256];
  for (let filter = 0; filter <= 4; filter++) {
    const image = decodePng(encodePng(23, 11, pattern, filter));
    assert.equal(image.width, 23);
    assert.equal(image.height, 11);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 23; x++) {
        const i = (y * 23 + x) * 3;
        assert.deepEqual(
          [image.rgb[i], image.rgb[i + 1], image.rgb[i + 2]],
          pattern(x, y),
          `filter ${filter} at (${x}, ${y})`,
        );
      }
    }
  }
});

test("I2: brightSpot measures a CONNECTED region, not a bright-pixel count", () => {
  // The failure mode this exists for: a black sky whose only bright pixels are
  // scattered stars, or a UI panel that has been cropped away.
  const disc = (x, y) =>
    (x - 30) ** 2 + (y - 20) ** 2 < 64 ? [255, 255, 255] : [0, 0, 0];
  const speckle = (x, y) =>
    (x * 7 + y * 11) % 97 === 0 ? [255, 255, 255] : [0, 0, 0];
  const withDisc = decodePng(encodePng(60, 40, disc));
  const withSpeckle = decodePng(encodePng(60, 40, speckle));
  const discRegion = largestBrightRegion(withDisc, 170);
  const speckleRegion = largestBrightRegion(withSpeckle, 170);
  assert.ok(discRegion.pixels > 150, `disc measured ${discRegion.pixels}`);
  assert.ok(
    speckleRegion.brightTotal > 20,
    "the speckle control has no bright pixels at all",
  );
  assert.equal(
    speckleRegion.pixels,
    1,
    "scattered pixels were merged into a region",
  );
  assert.ok(Math.abs(discRegion.centerX - 30) < 1);
  assert.ok(Math.abs(discRegion.centerY - 20) < 1);
});

test("I3: horizonCoverage fails the half-black composition a percentage passes", () => {
  const topHalf = (x, y) => (y < 20 ? [200, 200, 200] : [0, 0, 0]);
  const everywhere = () => [200, 200, 200];
  const half = rowCoverage(decodePng(encodePng(60, 40, topHalf)), 8, 16);
  const full = rowCoverage(decodePng(encodePng(60, 40, everywhere)), 8, 16);
  assert.equal(half.fraction, 0.5);
  assert.equal(full.fraction, 1);
});

test("I4: a declared anchor that is not met is reported, and one that is is silent", () => {
  const black = () => [0, 0, 0];
  const disc = (x, y) =>
    (x - 30) ** 2 + (y - 20) ** 2 < 100 ? [255, 255, 255] : [0, 0, 0];
  const anchor = { brightSpot: { luminance: 170, minPixels: 150 } };
  const missing = evaluateAnchors(encodePng(60, 40, black), anchor);
  assert.equal(missing.failures.length, 1);
  assert.match(missing.failures[0], /brightSpot/);
  assert.equal(missing.measured.brightSpot.largestRegionPixels, 0);
  const present = evaluateAnchors(encodePng(60, 40, disc), anchor);
  assert.deepEqual(present.failures, []);
  assert.ok(present.measured.brightSpot.largestRegionPixels >= 150);
  // No anchor declared is not the same as an anchor that passed.
  assert.deepEqual(evaluateAnchors(encodePng(4, 4, black), undefined), {
    failures: [],
    measured: {},
  });
});

test("I5: an undecodable capture fails its anchor rather than passing it", () => {
  const result = evaluateAnchors(Buffer.from("not a png at all"), {
    brightSpot: {},
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /could not be decoded/);
});

// ---------------------------------------------------------------------------
// J. The capture is of the SCENE, not of the application around it
// ---------------------------------------------------------------------------

test("J1: the run hides the viewer's UI before it photographs", () => {
  // An element screenshot is a crop of the PAGE: the navigation help, timeline,
  // animation dial and credit bar sit on top of the canvas and were inside
  // every round-2 crop — both spoiling the picture and answering thresholds the
  // scene did not.
  assert.ok(
    /SCREENSHOT_CHROME_CSS/.test(CAPTURE_SOURCE),
    "no chrome is hidden; the shots carry the application's UI",
  );
  for (const selector of [
    ".cesium-viewer-toolbar",
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-animationContainer",
    ".cesium-widget-credits",
    ".cesium-navigation-help",
  ]) {
    assert.ok(
      CAPTURE_SOURCE.includes(selector),
      `${selector} is still in the picture`,
    );
  }
  assert.ok(
    /addStyleTag\(\{ content: SCREENSHOT_CHROME_CSS \}\)/.test(CAPTURE_SOURCE),
    "the chrome stylesheet is defined but never installed",
  );
});

test("J2: every capture is an ELEMENT screenshot", () => {
  assert.equal(DEFAULT_CAPTURE_SELECTOR, ".cesium-widget canvas");
  assert.ok(
    /element\.screenshot\(\{ type: "png" \}\)/.test(CAPTURE_SOURCE),
    "the capture is not taken from an element",
  );
  assert.ok(
    !/page\.screenshot\(/.test(CAPTURE_SOURCE),
    "a full-page screenshot path is back; it photographs the whole application",
  );
  // The split-screen page holds two canvases side by side, so it names its own
  // element rather than one of them.
  const split = MANIFEST.scenes.find((s) => s.kind === "page");
  assert.ok(split.captureSelector && split.captureSelector !== "canvas");
  assert.ok(
    split.expectCanvases >= 2,
    "the two-viewer page does not require both canvases before capturing",
  );
});

test("J3: the celestial scenes declare content anchors", () => {
  // These are the scenes a percentage cannot adjudicate: a disc on black is a
  // few per cent of the frame, and the chrome that used to be in shot was 18 %.
  for (const id of ["celestial-sun", "celestial-moon", "celestial-eclipse"]) {
    const scene = MANIFEST.scenes.find((s) => s.id === id);
    assert.ok(scene.anchor?.brightSpot, `${id} declares no brightSpot anchor`);
    assert.ok(scene.anchor.brightSpot.minPixels > 0);
  }
  for (const scene of MANIFEST.scenes) {
    for (const kind of Object.keys(scene.anchor ?? {})) {
      assert.ok(
        ANCHOR_KINDS.includes(kind),
        `${scene.id}: anchor "${kind}" is not implemented`,
      );
    }
  }
  assert.ok(
    /evaluateAnchors\(/.test(CAPTURE_SOURCE),
    "the manifest declares anchors the run never evaluates",
  );
});

test("J4 mutant: an unknown anchor kind is rejected by the validator", () => {
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, anchor: { looksNice: {} } }],
  });
  assert.ok(errors.some((e) => /is not an anchor/.test(e)));
  const empty = validateManifest({ scenes: [{ ...goodScene, anchor: {} }] });
  assert.ok(empty.errors.some((e) => /anchor is empty/.test(e)));
});

// ---------------------------------------------------------------------------
// K. Recipes the round-2 run proved wrong
// ---------------------------------------------------------------------------

test("K1: the sun aim stands in sunlight, not behind the planet", () => {
  // Round 2 parked the camera on the ANTI-sun side and looked back through the
  // Earth: the sun command is culled against the occluder and the glare veil
  // resolves a visible fraction of zero. The capture was a black sky whose only
  // non-black pixels were the UI.
  const aim =
    /aim === "sun-disc"\s*\?\s*C\.Cartesian3\.multiplyByScalar\(\s*direction,\s*(-?)standoff/.exec(
      CAPTURE_SOURCE,
    );
  assert.ok(aim, "the sun aim's standoff is no longer expressed here");
  assert.equal(aim[1], "", "the sun camera is behind the Earth again");
});

test("K2: the aim writes its basis back after setView", () => {
  // `setView` converts direction/up into heading/pitch/roll and rebuilds from
  // them, and `getHeading` has a gimbal-lock branch that fires for exactly the
  // geometry these aims use. The celestial gate probe measured 0.174 degrees of
  // displacement; on the sun scene's 6-degree frustum that is ~30 px.
  assert.ok(
    /aimResidualDeg/.test(CAPTURE_SOURCE),
    "the round-trip residual is not measured, so a regression cannot be seen",
  );
  assert.ok(
    /C\.Cartesian3\.clone\(direction, scene\.camera\.direction\)/.test(
      CAPTURE_SOURCE,
    ),
    "the requested basis is not written back",
  );
});

test("K3: a scene that needs ground under its subject pins the ellipsoid", () => {
  // The application's default is Cesium World Terrain. A model at height 0 is
  // then BURIED — the framing camera ends up under the surface, every terrain
  // face is back-facing and culled, and the capture is the model on black with
  // no ground and no shadow. That is what round 2 photographed for shadows-csm.
  const shadows = MANIFEST.scenes.find((s) => s.id === "shadows-csm");
  assert.equal(shadows.terrain, "ellipsoid");
  assert.ok(SCENE_TERRAINS.includes("ellipsoid"));
  assert.ok(
    /EllipsoidTerrainProvider/.test(CAPTURE_SOURCE),
    "the manifest pins a terrain the script cannot apply",
  );
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, terrain: "flat-earth" }],
  });
  assert.ok(errors.some((e) => /terrain must be one of/.test(e)));
});

test("K4: the moon scene asks for a LIT near side", () => {
  // Round 2 pinned an instant at which the near side was unlit and photographed
  // a black disc for the row about albedo, relief and phase.
  const moon = MANIFEST.scenes.find((s) => s.id === "celestial-moon");
  assert.ok(
    moon.phaseTarget >= 0.9,
    `celestial-moon asks for ${moon.phaseTarget} illumination`,
  );
  assert.ok(
    /computeMoonPositionInEarthInertialFrame/.test(CAPTURE_SOURCE) &&
      /phaseTarget/.test(CAPTURE_SOURCE),
    "the manifest asks for a phase the script never solves for",
  );
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, aim: "sun-disc", phaseTarget: 1 }],
  });
  assert.ok(
    errors.some((e) => /phaseTarget requires the moon-disc aim/.test(e)),
  );
});

test("K5: a disc scene narrows its frustum enough to show a disc", () => {
  // The sun is half a degree across: nine pixels at the application's default
  // 60-degree frustum, which is present and invisible to a reader and to a
  // threshold alike.
  for (const id of ["celestial-sun", "celestial-moon"]) {
    const scene = MANIFEST.scenes.find((s) => s.id === id);
    assert.ok(scene.fovDeg > 0 && scene.fovDeg <= 30, `${id}: fovDeg`);
  }
  assert.ok(
    /fovDeg/.test(CAPTURE_SOURCE),
    "the manifest narrows a frustum the script never touches",
  );
  const { errors } = validateManifest({
    scenes: [{ ...goodScene, fovDeg: 400 }],
  });
  assert.ok(errors.some((e) => /fovDeg/.test(e)));
});

test("K6: a page scene reaches its subject the way the page really works", () => {
  // The split-screen harness builds NOTHING until its launch button is pressed,
  // and then builds two viewers on two backends in series. Round 2 waited 30 s
  // for a canvas on a page that was, correctly, still at its placeholder.
  const split = MANIFEST.scenes.find((s) => s.id === "tooling-split-screen");
  assert.deepEqual(split.clicks, ["#btnLaunch"]);
  assert.deepEqual(split.readyGlobals, ["webglViewer", "webgpuViewer"]);
  const page = readFileSync(
    join(REPO_ROOT, "Apps", "WebGPUTest", "split-screen-comparison.html"),
    "utf8",
  );
  for (const selector of split.clicks) {
    assert.ok(
      page.includes(`id="${selector.slice(1)}"`),
      `${selector} is not on the page`,
    );
  }
  for (const name of split.readyGlobals) {
    assert.ok(
      new RegExp(`window\\.${name}\\s*=`).test(page),
      `the page never sets window.${name}, so the wait could only time out`,
    );
  }
  assert.ok(
    page.includes(`id="${split.captureSelector.slice(1)}"`),
    "the capture selector names an element the page does not have",
  );
});

test("K7: a page scene's readiness ceiling spans two cold starts, inside the budget", () => {
  const ceiling = /const PAGE_READY_TIMEOUT_MS = ([0-9_]+);/.exec(
    CAPTURE_SOURCE,
  );
  assert.ok(ceiling, "page scenes have no readiness ceiling of their own");
  const ms = Number.parseInt(ceiling[1].replaceAll("_", ""), 10);
  assert.ok(ms >= 60_000, `${ms} ms is one cold start, not two`);
  assert.ok(
    ms < DEFAULT_SCENE_BUDGET_MS,
    "the ceiling outlives the scene budget that is supposed to contain it",
  );
});

test("K8: the demo pages the round-2 run could not start are fixed at source", () => {
  const dof = readFileSync(
    join(REPO_ROOT, LEGACY_GALLERY_DIR, "WebGPU Depth of Field.html"),
    "utf8",
  );
  // `new Viewer` with an explicit WebGPU request throws from
  // `getSynchronousRendererType` before any Viewer state exists: adapter and
  // device acquisition are asynchronous.
  assert.ok(
    /Viewer\.createAsync\(/.test(dof),
    "the depth-of-field demo still constructs its Viewer synchronously",
  );
  assert.ok(
    !/new Cesium\.Viewer\(/.test(dof),
    "a synchronous Viewer construction is back in the depth-of-field demo",
  );
  const monitor = readFileSync(
    join(REPO_ROOT, LEGACY_GALLERY_DIR, "WebGPU Async Resource Monitor.html"),
    "utf8",
  );
  // Without the shared stylesheet `.fullSize` is undefined, the container has
  // no height, and the widget sizes its canvas to a one-pixel-tall box.
  assert.ok(
    /@import url\(\.\.\/templates\/bucket\.css\)/.test(monitor),
    "the resource-monitor demo still has no layout stylesheet; its canvas collapses to 1 px",
  );
  // And the run refuses a collapsed canvas rather than photographing a strip.
  assert.ok(
    /canvas\.height > 1/.test(CAPTURE_SOURCE),
    "a one-pixel-tall canvas would still be accepted as ready",
  );
});

test("K9: no scene keeps a threshold that only the hidden chrome could pass", () => {
  // The chrome was worth ~18 % non-black in 8+ colour buckets. Any scene still
  // asking for more than the scene alone can supply would now fail for a reason
  // that has nothing to do with the scene. These two measured 0.0 % with the
  // chrome masked out of the round-2 PNGs, so their floors are deliberately at
  // the "is anything there at all" level, with an anchor doing the real work
  // where one applies.
  const floors = new Map([
    ["celestial-sun", 0.01],
    ["tiles-point-cloud-edl", 0.05],
    ["renderer-webgpu-backend", 0.05],
    ["celestial-eclipse", 0.05],
    ["globe-night-lighting", 0.02],
    ["model-pbr", 0.2],
    ["shadows-csm", 0.2],
    ["model-khr-extensions", 0.25],
  ]);
  for (const [id, ceiling] of floors) {
    const scene = MANIFEST.scenes.find((s) => s.id === id);
    assert.ok(scene, `${id} is no longer in the manifest`);
    assert.ok(
      scene.minNonBlackPct <= ceiling,
      `${id}: minNonBlackPct ${scene.minNonBlackPct} is above what the scene measured without the chrome (${ceiling})`,
    );
  }
});

// ---------------------------------------------------------------------------
// E. Offline isolation — this spec must never reach for a browser
// ---------------------------------------------------------------------------

test("E1: this spec and the shared library are browser-free", () => {
  const specSource = readFileSync(
    join(HERE, "capture-readme-screenshots.spec.mjs"),
    "utf8",
  );
  const librarySource = readFileSync(
    join(HERE, "lib", "readme-table.mjs"),
    "utf8",
  );
  for (const [name, source] of [
    ["the spec", specSource],
    ["readme-table.mjs", librarySource],
    ["capture-plan.mjs", PLAN_SOURCE],
    [
      "dead-routes.mjs",
      readFileSync(join(HERE, "lib", "dead-routes.mjs"), "utf8"),
    ],
    [
      "image-anchors.mjs",
      readFileSync(join(HERE, "lib", "image-anchors.mjs"), "utf8"),
    ],
    [
      "console-gate.mjs",
      readFileSync(join(HERE, "lib", "console-gate.mjs"), "utf8"),
    ],
  ]) {
    assert.ok(
      !/from\s*["']playwright["']/.test(source),
      `${name} imports playwright; it must stay runnable under plain node --test`,
    );
  }
});
