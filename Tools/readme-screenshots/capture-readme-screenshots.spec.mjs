// capture-readme-screenshots.spec.mjs — AUTHORING-TIME enforcement of the
// README feature-table <-> screenshot-manifest contract, and of the capture
// script's own membership in the probe fleet's machine-safety contract.
// Pure Node: no browser, no network, no GPU.
//
// THE GAP THIS CLOSES. DOC-01 asks for a table whose every row carries a
// completion figure, a basis for that figure, and a WebGPU screenshot — and for
// one command that produces every image. Three things can rot silently between
// runs, and all three produce a README that LOOKS finished:
//
//   1. a row is added with no scene, so its image never exists and the reader
//      sees a broken picture;
//   2. a scene is added with no row, so capture time is spent on an image
//      nobody displays;
//   3. a scene names a demo, tileset or model that has since moved, which is
//      only discovered forty minutes into an Edge run, as a black PNG.
//
// All three are decidable from source, so they are decided here.
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

import {
  CONTENT_TYPES,
  IMAGE_DIR,
  SCENE_AIMS,
  SCENE_KINDS,
  TABLE_BEGIN,
  TABLE_END,
  auditContract,
  crossCheck,
  galleryLegacyId,
  parseFeatureTable,
  resolveScene,
  screenshotPath,
  tableCells,
  validateManifest,
} from "./lib/readme-table.mjs";
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
  // DOC-01's hard rule. A row whose image nobody produces renders as a broken
  // picture, which is worse than an absent row.
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
    `the table has ${audit.rows.length} rows; DOC-01 asks for a presentable ~25-40`,
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
    // A figure with no stated basis is the thing DOC-01 forbids: invented
    // precision. The word "Basis" is the marker the table uses for it.
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
  // Every DOC-01 subsystem bucket is represented.
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
  // DOC-01: fleet-contract compliant, no allowlisting. The allowlist is closed
  // and shrink-only; a new tool appearing in it would be a regression in the
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

test("D8: the script offers the --only re-capture mode DOC-01 asks for", () => {
  assert.ok(CAPTURE_SOURCE.includes("--only"));
  assert.ok(CAPTURE_SOURCE.includes("--list"));
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
  ]) {
    assert.ok(
      !/from\s*["']playwright["']/.test(source),
      `${name} imports playwright; it must stay runnable under plain node --test`,
    );
  }
});
