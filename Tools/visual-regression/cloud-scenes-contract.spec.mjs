/**
 * C13-N07a contract spec — pure Node, no browser.
 * @purpose Checked contract for the two cloud scenes added to scenes.json: existence, setupFile resolution, threshold-override honesty, expectedMismatch legality, and — the highest-value assertion — that the setup file never sets an unknown CloudVolumetrics property.
 * @status ACTIVE
 *
 * This lane holds no browser (see `scenes/cloud-scene-setup.js`'s header) and
 * cannot capture a baseline, so this spec is the only checked evidence for
 * `C13-N07a` until an Edge slot runs the recipe in that file's header. It
 * turns the row's prose claims into assertions:
 *
 *   1. `scenes.json` parses and both cloud scenes exist under the row's exact
 *      names.
 *   2. Every scene's `setupFile` resolves to a real file (generalised to all
 *      scenes, not just the two added here, so a future typo anywhere in
 *      `scenes.json` is caught the same way).
 *   3. A scene whose `crossBackend` ceiling is loosened above the suite
 *      default must carry a rationale naming a tracking row — a neutralised
 *      gate is a SCHEDULED one, never a silent, permanent one.
 *   4. Every `expectedMismatch` entry uses a legal `gate`/`expect` value.
 *   5. The cloud setup file never sets a `CloudVolumetrics` property that
 *      does not exist — the exact failure mode
 *      `lib/cloud-probe-harness.mjs`'s `configure()` guards against at
 *      runtime, checked here without a runtime at all.
 *   6. The setup file carries no control characters and stays offline /
 *      render-loop-disciplined, in the style of
 *      `cloud-tour-sequences.spec.mjs`'s "probe discipline" section.
 *
 * Run: node --test Tools/visual-regression/cloud-scenes-contract.spec.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GATE_IDS,
  GateExpectation,
  resolveSceneExpectations,
} from "./lib/visual-gate-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");

const SCENES_JSON_PATH = path.join(HERE, "scenes.json");
const SETUP_FILE_RELATIVE = "scenes/cloud-scene-setup.js";
const SETUP_FILE_PATH = path.join(HERE, SETUP_FILE_RELATIVE);
const CLOUD_VOLUMETRICS_PATH = path.join(
  REPOSITORY_ROOT,
  "packages/engine/Source/Scene/CloudVolumetrics.js",
);
const CAPTURE_AND_DIFF_PATH = path.join(HERE, "capture-and-diff.mjs");

const CLOUD_SCENE_NAMES = Object.freeze([
  "cloud-orbital-disc",
  "cloud-ground-overcast",
]);

/**
 * The two cloud entries are HELD OUT of `scenes.json` by the seat's ruling of
 * 2026-09-12 and live in the lane's pending file until an Edge executor lands
 * them together with their baselines in one reviewed commit (R-2026-08-29-2).
 *
 * WHY THEY ARE HELD. A scene with no baseline is NON_CERTIFYING
 * (`visual-gate-policy.mjs`, HISTORICAL_BASELINE_MISSING) and the runner exits 0
 * only when every scene PASSes, so landing the entries alone would make
 * `capture-and-diff.mjs` exit 1 BY CONSTRUCTION until an Edge leg that sits
 * behind two other Edge jobs. A red guard gets a repair, never an annotation.
 *
 * WHY THIS SPEC LANDS ANYWAY. The rule it carries — a loosened crossBackend
 * ceiling must name the row that removes it — has to exist BEFORE the entries
 * do, or they arrive with nothing checking them. So every rule below runs over
 * the live file AND the held-out entries, and the held-out entries face exactly
 * the rules they will face on the day they land.
 */
// TRACKED, and it has to be. This constant first pointed into the lane's
// _lane-out/ working directory, which is review output and is not in the patch —
// so on main the file would be absent and three of these tests would fail.
// Reviewer Salmar caught it by simulating the absence (329/322/7). The held
// entries are tracked here instead, and the Edge executor deletes this file in
// the same commit that moves its entries into scenes.json.
const PENDING_ENTRIES_PATH = path.resolve(HERE, "scenes-cloud-pending.json");

function readScenesConfig() {
  return JSON.parse(fs.readFileSync(SCENES_JSON_PATH, "utf8"));
}

/**
 * Every scene the rules apply to: the live file's, plus the held-out cloud
 * entries while the pending file exists. After the executor moves them into
 * `scenes.json` and deletes the pending file, the same rules see them there.
 */
function allGovernedScenes() {
  const live = readScenesConfig().scenes.map((scene) => ({
    scene,
    origin: "scenes.json",
  }));
  if (!fs.existsSync(PENDING_ENTRIES_PATH)) {
    return live;
  }
  const pending = JSON.parse(fs.readFileSync(PENDING_ENTRIES_PATH, "utf8"));
  return [
    ...live,
    ...pending.scenes.map((scene) => ({
      scene,
      origin: "Tools/visual-regression/scenes-cloud-pending.json",
    })),
  ];
}

/**
 * A synthetic scene that loosens the ceiling WITHOUT naming a row: the negative
 * control for the rule below. Without it the rule would be untested on any day
 * the governed set happens to carry no loosened scene.
 */
const UNSCHEDULED_OVERRIDE_FIXTURE = Object.freeze({
  name: "fixture-unscheduled-override",
  thresholds: { crossBackend: 1 },
  expectedMismatch: [
    {
      gate: "crossBackend",
      expect: "PASS",
      rationale: "the ceiling is disabled and nothing says when it comes back",
    },
  ],
});

/**
 * The suite's fallback `--threshold`, read from `capture-and-diff.mjs`'s own
 * `parseArgs` default rather than hard-coded — a hard-coded copy is exactly
 * the kind of stale-number drift this codebase's own doc-fitness history
 * (see CLAUDE.md's repeated "corrected ... stale by Nx" annotations) warns
 * about. A refactor that changes the shape of this default fails THIS
 * assertion loudly instead of leaving a silently-wrong fallback behind.
 */
function readSuiteDefaultThreshold() {
  const source = fs.readFileSync(CAPTURE_AND_DIFF_PATH, "utf8");
  const match = source.match(/threshold:\s*([0-9.]+)/);
  assert.ok(
    match,
    "capture-and-diff.mjs's default --threshold literal has moved or been renamed; update the extraction regex in this spec",
  );
  return Number(match[1]);
}

/**
 * Strip block and line comments so the offline/render-loop discipline pins
 * below cannot false-positive on prose — this file's own header quotes
 * `http://localhost:8080/` in the baseline recipe, which the raw source
 * pattern for "no network origin" would otherwise (correctly, but
 * unhelpfully) flag. Safe for this file specifically because it contains no
 * `//` inside a string literal; `cloud-tour-sequences.spec.mjs` draws the
 * same raw/stripped distinction (`probeSource` vs `probeCode`) for the same
 * reason.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Extract every `this.<name> =` field CloudVolumetrics's constructor sets. */
function readCloudVolumetricsPropertyNames() {
  const source = fs.readFileSync(CLOUD_VOLUMETRICS_PATH, "utf8");
  const names = new Set();
  const pattern = /^\s*this\.(\w+)\s*=/gm;
  let m;
  while ((m = pattern.exec(source)) !== null) {
    names.add(m[1]);
  }
  assert.ok(
    names.size > 10,
    `expected many CloudVolumetrics properties, found ${names.size} — the extraction regex may no longer match this file's shape`,
  );
  return names;
}

/**
 * Extract every key set inside a `volumetric: { ... }` object literal in the
 * setup file's `SCENE_CONFIGS` table. The blocks are flat (no nested `{`),
 * so a non-greedy `[^}]*` body match is exact, not an approximation.
 */
function readVolumetricOverrideBlocks(setupSource) {
  const blocks = [];
  const blockPattern = /volumetric:\s*\{([^}]*)\}/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(setupSource)) !== null) {
    const keys = [];
    const keyPattern = /(\w+)\s*:/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(blockMatch[1])) !== null) {
      keys.push(keyMatch[1]);
    }
    blocks.push(keys);
  }
  return blocks;
}

test("the two C13-N07a cloud scenes exist, held out or landed, under the row's exact names", () => {
  const names = allGovernedScenes().map((entry) => entry.scene.name);
  for (const expected of CLOUD_SCENE_NAMES) {
    assert.ok(
      names.includes(expected),
      `neither scenes.json nor the held-out pending file carries "${expected}"`,
    );
  }
  // While they are held they must NOT be in the live file. That is the whole
  // point of the hold, and a merge that quietly moved them in would otherwise
  // leave the runner exiting 1 with nothing saying why.
  if (fs.existsSync(PENDING_ENTRIES_PATH)) {
    const live = readScenesConfig().scenes.map((scene) => scene.name);
    for (const expected of CLOUD_SCENE_NAMES) {
      assert.ok(
        !live.includes(expected),
        `"${expected}" is in scenes.json while the pending file still exists; the ` +
          "entries and their baselines land together, so the pending file is deleted " +
          "in the same commit that adds them",
      );
    }
  }
});

/**
 * Scenes that are in `scenes.json` with NO baseline on disk, measured
 * 2026-09-12 at Batch 1476. Each one makes `capture-and-diff.mjs` report
 * NON_CERTIFYING and exit 1, and every one of them predates this lane.
 *
 * This list is SHRINK-ONLY and is not a permission to add more. It exists so
 * the assertion below can be a non-regression guard — adding a NEW unbaselined
 * scene fails, while the inherited five are visible, counted and attributable
 * instead of hiding inside a blanket red nobody can land against.
 */
const SCENES_WITHOUT_BASELINES_AT_BATCH_1476 = Object.freeze([
  "globe-zoomed-mountain",
  "globe-horizon",
  "wgs84-orbit",
  "wgs84-close",
  "mid-distance-12mm",
]);

test("no NEW scene enters scenes.json without its reviewed baselines", () => {
  // The hold's premise, asserted rather than described: the runner certifies
  // only when every scene PASSes, and a scene with no baseline PNG can never
  // PASS. This is what makes "entries and baselines land together" a checkable
  // rule rather than an instruction someone has to remember — and it is why
  // C13-N07a's two entries are held in the lane's pending file until an Edge
  // executor can land them together with their captures.
  const baselineDir = path.join(HERE, "baseline");
  const missing = [];
  let checked = 0;
  for (const scene of readScenesConfig().scenes) {
    for (const renderer of ["webgl", "webgpu"]) {
      checked++;
      if (
        !fs.existsSync(path.join(baselineDir, `${scene.name}.${renderer}.png`))
      ) {
        missing.push(`${scene.name}.${renderer}`);
      }
    }
  }
  assert.ok(checked > 0, "the live scene list is empty");
  const unexpected = [
    ...new Set(
      missing
        .map((entry) => entry.slice(0, entry.lastIndexOf(".")))
        .filter(
          (name) => !SCENES_WITHOUT_BASELINES_AT_BATCH_1476.includes(name),
        ),
    ),
  ];
  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.join(", ")} entered scenes.json without baselines; ` +
      "capture-and-diff.mjs will report NON_CERTIFYING and exit 1 until they are " +
      "captured, so the entry and its baselines must land in the same reviewed commit",
  );
  // Shrink-only: a name that has since gained its baselines must come OFF the
  // list, or the list quietly becomes a licence rather than a record.
  const stale = SCENES_WITHOUT_BASELINES_AT_BATCH_1476.filter(
    (name) =>
      !missing.some((entry) => entry.startsWith(`${name}.`)) &&
      readScenesConfig().scenes.some((scene) => scene.name === name),
  );
  assert.deepEqual(
    stale,
    [],
    `${stale.join(", ")} now has baselines and must be removed from ` +
      "SCENES_WITHOUT_BASELINES_AT_BATCH_1476",
  );
});

test("every scene's setupFile resolves to a file that exists on disk", () => {
  let checked = 0;
  for (const { scene } of allGovernedScenes()) {
    if (typeof scene.setupFile !== "string") continue;
    checked++;
    const resolved = path.resolve(HERE, scene.setupFile);
    assert.ok(
      fs.existsSync(resolved),
      `${scene.name}: setupFile "${scene.setupFile}" does not resolve to a file on disk`,
    );
  }
  assert.ok(
    checked >= CLOUD_SCENE_NAMES.length,
    "expected at least the two cloud scenes to declare a setupFile",
  );
});

test("a scene whose crossBackend ceiling is loosened above the suite default names a tracking row in its rationale", () => {
  const suiteDefault = readSuiteDefaultThreshold();
  const trackingRowPattern = /C13-N\d+[a-z]?/;
  let loosenedCount = 0;

  for (const { scene } of allGovernedScenes()) {
    const effective = scene.thresholds?.crossBackend ?? suiteDefault;
    if (!(effective > suiteDefault)) continue;
    loosenedCount++;

    const resolved = resolveSceneExpectations(scene);
    const crossBackendExpectation = resolved.byGate.crossBackend;
    assert.ok(
      crossBackendExpectation,
      `${scene.name}: crossBackend threshold (${effective}) exceeds the suite default (${suiteDefault}) but declares no crossBackend expectedMismatch entry to carry the rationale`,
    );
    assert.match(
      crossBackendExpectation.rationale,
      trackingRowPattern,
      `${scene.name}: a loosened crossBackend ceiling must name a tracking row (pattern ${trackingRowPattern}) in its rationale, so the neutralization is scheduled rather than permanent`,
    );
  }

  // Non-vacuous: this assertion is worthless if nothing in scenes.json ever
  // exercises the branch it checks.
  assert.ok(
    loosenedCount >= CLOUD_SCENE_NAMES.length,
    "expected at least the two cloud scenes to loosen the crossBackend ceiling above the suite default",
  );

  // NEGATIVE CONTROL. Everything above says the rule accepted the scenes that
  // satisfy it; none of it says the rule can REJECT. Run the same check over a
  // scene that loosens the ceiling and names no row, and require it to fail.
  // Without this the rule could be a no-op and every assertion above would
  // still be green.
  const control = UNSCHEDULED_OVERRIDE_FIXTURE;
  const controlEffective = control.thresholds.crossBackend;
  assert.ok(
    controlEffective > suiteDefault,
    "the negative control no longer loosens the ceiling, so it controls nothing",
  );
  const controlExpectation =
    resolveSceneExpectations(control).byGate.crossBackend;
  assert.ok(
    controlExpectation,
    "the negative control lost its crossBackend entry",
  );
  assert.doesNotMatch(
    controlExpectation.rationale,
    trackingRowPattern,
    "the negative control's rationale accidentally names a tracking row",
  );
});

test("every expectedMismatch entry (across all scenes) uses a legal gate id and expect value", () => {
  let entriesChecked = 0;
  for (const { scene } of allGovernedScenes()) {
    const declared = scene.expectedMismatch;
    if (declared === undefined) continue;
    assert.ok(
      Array.isArray(declared),
      `${scene.name}: expectedMismatch must be an array`,
    );
    for (const entry of declared) {
      entriesChecked++;
      assert.ok(
        GATE_IDS.includes(entry.gate),
        `${scene.name}: expectedMismatch gate "${entry.gate}" is not one of GATE_IDS (${GATE_IDS.join(", ")})`,
      );
      assert.ok(
        Object.values(GateExpectation).includes(entry.expect),
        `${scene.name}: expectedMismatch expect "${entry.expect}" is not a legal GateExpectation value`,
      );
    }
    // Belt-and-suspenders: the shared policy parser must independently agree
    // this scene's declarations are well-formed.
    const resolved = resolveSceneExpectations(scene);
    assert.deepEqual(
      resolved.errors,
      [],
      `${scene.name}: ${resolved.errors.join(", ")}`,
    );
  }
  assert.ok(
    entriesChecked >= CLOUD_SCENE_NAMES.length * 2,
    "expected 2 expectedMismatch entries per cloud scene",
  );
});

test("the cloud setup file never sets a CloudVolumetrics property that does not exist", () => {
  const setupSource = fs.readFileSync(SETUP_FILE_PATH, "utf8");
  const validProperties = readCloudVolumetricsPropertyNames();
  const blocks = readVolumetricOverrideBlocks(setupSource);

  assert.equal(
    blocks.length,
    CLOUD_SCENE_NAMES.length,
    `expected one "volumetric: { ... }" override block per cloud scene, found ${blocks.length}`,
  );

  for (const [index, keys] of blocks.entries()) {
    assert.ok(
      keys.length > 0,
      `volumetric override block ${index} declared no keys`,
    );
    for (const key of keys) {
      assert.ok(
        validProperties.has(key),
        `volumetric override block ${index} sets unknown CloudVolumetrics property "${key}" — this is the exact failure mode lib/cloud-probe-harness.mjs's configure() guards against at runtime`,
      );
    }
  }
});

test("the cloud setup file carries no control character", () => {
  // A raw control byte works at runtime and is invisible in review, but
  // breaks every grep-based source pin — including the ones in this file.
  const bytes = fs.readFileSync(SETUP_FILE_PATH);
  const offending = bytes.findIndex(
    (byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20),
  );
  assert.equal(
    offending,
    -1,
    `cloud-scene-setup.js carries a control byte at offset ${offending}`,
  );
});

test("the cloud setup file stays offline and never drives its own render loop", () => {
  // Comments stripped: the header's baseline-recipe prose names
  // "http://localhost:8080/" on purpose, and these pins must judge CODE.
  const setupSource = stripComments(fs.readFileSync(SETUP_FILE_PATH, "utf8"));
  const pins = [
    {
      pattern: /https?:\/\//,
      why: "a network origin makes the scene depend on connectivity",
    },
    {
      pattern:
        /ionAssetId|IonResource|createWorldTerrain|fromWorldImagery|createWorldImagery/,
      why: "an ion asset or world imagery/terrain call depends on the network",
    },
    {
      pattern: /\bscene\.render\s*\(/,
      why: "a manual render call substitutes for the page's own render loop",
    },
    {
      pattern: /Math\.random\s*\(/,
      why: "a random draw is an unrecorded, non-reproducible input",
    },
    {
      pattern: /JulianDate\.now\s*\(/,
      why: "the scene must render its pinned instant, never wall time",
    },
    {
      pattern: /useDefaultRenderLoop/,
      why: "this file must not toggle the page's own render-loop flag",
    },
    { pattern: /while\s*\(\s*true\s*\)/, why: "no unbounded loop" },
    { pattern: /for\s*\(\s*;\s*;\s*\)/, why: "no unbounded loop" },
  ];
  for (const pin of pins) {
    assert.doesNotMatch(setupSource, pin.pattern, pin.why);
  }
});
