// c11-rigs.spec.mjs — the C11 family's rig records agree with the probes they
// describe. Pure Node: no browser, no GPU.
//
// @purpose Pins every c11-tagged rig in rigs/ to the constants of the probe it describes (waypoint and topology ladders, fixture url, camera-track id, viewport, page query, asset and settle), so a rig cannot drift from the scene the probe actually loads.
// @status ACTIVE
//
// WHY THIS EXISTS. The probe-kit harvest (DX-108) wrote the c11 rigs as records
// of scenes that ten kept acceptance probes still load themselves: the probes
// were not rewired to read the rigs, because each is the acceptance oracle of
// an open Campaign 11 row and its evidence protocol was left byte-stable. A
// rig that restates a probe's scene and is not tied back to it drifts the
// first time the probe changes. Where a probe EXPORTS the constant (C11-13's
// `WAYPOINTS`, C11-90's `TOPOLOGY_EXPECTATIONS`, C11-205's fixture, the
// camera track's id) this spec compares values; where the constant is a
// literal inside the probe, it reads the probe's own source for that literal.
// The second form is a drift alarm on declared constants, not a behaviour
// test, and is labelled as such.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WAYPOINTS } from "./lib/c11-13-voxel-inside-camera-probe.mjs";
import { C11_205_MULTIPLE_CONTENT_FIXTURE } from "./lib/c11-205-evidence.mjs";
import { TOPOLOGY_EXPECTATIONS } from "./lib/c11-90-primitive-restart-probe.mjs";
import { GLOBE_CAMERA_TRACK_ID } from "./lib/globe-camera-track.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (relative) =>
  fs.readFileSync(path.join(here, relative), "utf8").replaceAll("\r\n", "\n");

const C11_RIG_IDS = Object.freeze([
  "c11-batchtable-hierarchy",
  "c11-dynamic-ibl-khr-specular",
  "c11-globe-camera-track",
  "c11-multiple-contents-1-1",
  "c11-primitive-restart",
  "c11-viewer-offline-webgpu",
  "c11-voxel-inside-camera",
]);

async function c11Rigs() {
  const rigs = await loadRigs();
  return rigs.filter((rig) => rig.tags.includes("c11"));
}

test("the c11 rigs are exactly the seven declared, each valid and tagged c11 only", async () => {
  const rigs = await c11Rigs();
  assert.deepEqual(
    rigs.map((rig) => rig.id),
    C11_RIG_IDS,
  );
  for (const rig of rigs) {
    assert.deepEqual(validateRig(rig), [], rig.id);
    assert.deepEqual(rig.tags, ["c11"], rig.id);
    // The contact-sheet page guard refuses paths and verdict words in a
    // description; keep both out at the source.
    assert.doesNotMatch(
      rig.description,
      /\.(mjs|html|json|gltf|glb|js)\b|\b(Tools|Apps|Specs|packages)\//,
      rig.id,
    );
    assert.doesNotMatch(rig.description, /\b(PASS|FAIL|pass|fail)\b/, rig.id);
    assert.doesNotMatch(rig.description, /regression/i, rig.id);
  }
});

test("C11-13 and C11-90 rigs carry the probes' own state ladders and harness pages", async () => {
  const rigs = await c11Rigs();
  const voxel = rigById(rigs, "c11-voxel-inside-camera");
  assert.deepEqual(
    [...voxel.states],
    WAYPOINTS.map((waypoint) => waypoint.id),
  );
  const restart = rigById(rigs, "c11-primitive-restart");
  assert.deepEqual([...restart.states], Object.keys(TOPOLOGY_EXPECTATIONS));
  for (const rig of [voxel, restart]) {
    assert.equal(rig.page, null, `${rig.id} is driven in-page by its probe`);
    assert.ok(
      fs.existsSync(path.join(here, "..", "..", rig.harness)),
      `${rig.id} harness exists`,
    );
  }
  // Drift alarm on declared literals (source text, not behaviour).
  const voxelLib = source("lib/c11-13-voxel-inside-camera-probe.mjs");
  assert.match(
    voxelLib,
    new RegExp(
      `const VIEWPORT = Object\\.freeze\\(\\{ width: ${voxel.viewport.width}, height: ${voxel.viewport.height} \\}\\)`,
    ),
  );
  assert.match(
    voxelLib,
    new RegExp(`const STABILITY_FRAMES = ${voxel.readiness.frames};`),
  );
  assert.match(
    voxelLib,
    /const HARNESS_ROUTE =\n\s+"\/Tools\/visual-regression\/c11-13-voxel-inside-camera-harness\.html";/,
  );
  const restartLib = source("lib/c11-90-primitive-restart-probe.mjs");
  assert.match(
    restartLib,
    new RegExp(
      `const VIEWPORT = Object\\.freeze\\(\\{ width: ${restart.viewport.width}, height: ${restart.viewport.height} \\}\\)`,
    ),
  );
  assert.match(
    restartLib,
    new RegExp(
      `C11_90_SETTLE_MS \\?\\? ${restart.readiness.ms.toLocaleString("en-US").replace(",", "_")}\\)`,
    ),
  );
  for (const asset of restart.asset) {
    assert.ok(restartLib.includes(`"/${asset}"`), asset);
  }
});

test("C11-205 and C11-169 rigs name the fixture and the camera track the probes import", async () => {
  const rigs = await c11Rigs();
  const contents = rigById(rigs, "c11-multiple-contents-1-1");
  assert.equal(contents.asset, C11_205_MULTIPLE_CONTENT_FIXTURE.repositoryPath);
  assert.equal(`/${contents.asset}`, C11_205_MULTIPLE_CONTENT_FIXTURE.url);
  const lifecycle = source("probe-c11-205-lifecycle-v2.mjs");
  assert.match(
    lifecycle,
    new RegExp(
      `viewport: \\{ width: ${contents.viewport.width}, height: ${contents.viewport.height} \\}`,
    ),
  );
  assert.match(
    lifecycle,
    new RegExp(`const stableFramesRequired = ${contents.readiness.frames};`),
  );
  const track = rigById(rigs, "c11-globe-camera-track");
  assert.equal(track.cameraTrack, GLOBE_CAMERA_TRACK_ID);
  const breakdown = source("probe-c11-169-primitive-breakdown.mjs");
  assert.match(
    breakdown,
    new RegExp(
      `const VIEWPORT = Object\\.freeze\\(\\{ width: ${track.viewport.width}, height: ${track.viewport.height} \\}\\)`,
    ),
  );
  assert.match(
    breakdown,
    new RegExp(`const ROUTE_START_PRIME_FRAMES = ${track.readiness.frames};`),
  );
});

test("the viewer, dynamic-IBL and pick-demand rigs match the probes that boot them", async () => {
  const rigs = await c11Rigs();
  const viewer = rigById(rigs, "c11-viewer-offline-webgpu");
  assert.equal(viewer.page, "Apps/CesiumViewer/index.html?offline=true");
  const booting = [
    "probe-c11-193b-shared-submit.mjs",
    "probe-c11-193c-demand-priority.mjs",
    "archive/probe-c11-209-effects-placeholder-startup.mjs",
    "probe-c11-210-compute-command-list.mjs",
  ];
  for (const file of booting) {
    const text = source(file);
    assert.match(
      text,
      /new URL\("\/Apps\/CesiumViewer\/index\.html", \w+\);\n\s+viewerUrl\.searchParams\.set\("renderer", "webgpu"\);\n\s+viewerUrl\.searchParams\.set\("offline", "true"\);/,
      file,
    );
    assert.match(
      text,
      new RegExp(
        `viewport: \\{ width: ${viewer.viewport.width}, height: ${viewer.viewport.height} \\}`,
      ),
      file,
    );
  }
  assert.match(
    source("archive/probe-c11-209-effects-placeholder-startup.mjs"),
    new RegExp(`const STEADY_FRAMES = ${viewer.readiness.frames};`),
  );

  const ibl = rigById(rigs, "c11-dynamic-ibl-khr-specular");
  assert.equal(ibl.basePage, viewer.id);
  assert.ok(source(booting[0]).includes(`"/${ibl.asset}"`));
  assert.match(
    source(booting[0]),
    new RegExp(`const idleWarmFramesRequired = ${ibl.readiness.frames};`),
  );
  assert.match(
    source(booting[1]),
    new RegExp(`const IDLE_WARM_FRAMES_REQUIRED = ${ibl.readiness.frames};`),
  );

  const pick = rigById(rigs, "c11-batchtable-hierarchy");
  for (const file of [
    "probe-c11-196-lazy-pick-demand.mjs",
    "probe-c11-202-batchtexture-pick-demand.mjs",
  ]) {
    const text = source(file);
    assert.ok(text.includes(`"/${pick.asset}"`), file);
    assert.match(
      text,
      new RegExp(
        `viewport: \\{ width: ${pick.viewport.width}, height: ${pick.viewport.height} \\}`,
      ),
      file,
    );
    assert.match(
      text,
      new RegExp(`if \\(readyStreak >= ${pick.readiness.frames}\\) break;`),
      file,
    );
  }
});

test("a pixel score on the viewer rig's page is taken with the widgets removed", async () => {
  // Drift alarm on source order (not behaviour): an element capture of the
  // CesiumViewer canvas composites the widgets stacked over it, so the one c11
  // probe that scores a frame on this page (the archived C11-209 probe) must
  // remove them first, refuse on leftovers and record the count removed.
  const rigs = await c11Rigs();
  assert.equal(
    rigById(rigs, "c11-viewer-offline-webgpu").page,
    "Apps/CesiumViewer/index.html?offline=true",
  );
  const text = source("archive/probe-c11-209-effects-placeholder-startup.mjs");
  const strip = text.indexOf(
    "const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);",
  );
  const refuse = text.indexOf(
    "if (chrome.leftovers.length > 0) {\n    throw new ProbeRefusal(",
  );
  const capture = text.indexOf(
    "const screenshot = await canvas.screenshot({ timeout: 30_000 });",
  );
  assert.ok(strip > 0, "the widgets are removed");
  assert.ok(refuse > strip, "a leftover over the canvas is refused");
  assert.ok(capture > refuse, "the capture follows the removal");
  assert.match(text, /chromeRemoved: chrome\.removed,/);
  assert.match(
    text,
    /import \{ STRIP_WIDGETS_SOURCE \} from "\.\.\/lib\/strip-viewer-widgets\.mjs";/,
  );
});
