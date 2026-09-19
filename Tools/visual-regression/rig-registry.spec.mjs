// rig-registry.spec.mjs — DX-101. Pure Node: no browser, no GPU.
//
// @purpose Drives the real rig-registry.mjs over the real rigs/ directory: every rig validates, ids are unique, tags are in vocabulary, replayKeyFor is stable and sensitive, and generateScenesJson reproduces scenes.json byte-for-byte.
// @status ACTIVE
//
// EVERY ASSERTION HERE READS OUTPUT FROM THE REAL MODULES — `loadRigs()`
// dynamically imports the actual files under `rigs/`, `validateRig` is the
// actual validator, and `generateScenesJson` is compared against the actual
// `scenes.json` bytes on disk. A grep of rig source text would only prove a
// string was written somewhere, not that the loader, the validator or the
// generator agree with it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RIG_TAGS,
  generateScenesJson,
  loadRigs,
  replayKeyFor,
  scenesJsonPath,
  validateRig,
} from "./lib/rig-registry.mjs";

test("every rig loads and validates with zero violations", async () => {
  const rigs = await loadRigs();
  const violationsByRig = rigs.map((rig) => [rig.id, validateRig(rig)]);
  const failing = violationsByRig.filter(([, v]) => v.length > 0);
  assert.deepEqual(
    failing,
    [],
    `expected zero violations, got: ${JSON.stringify(failing, null, 2)}`,
  );

  const countsByTag = {};
  for (const rig of rigs) {
    for (const tag of rig.tags) {
      countsByTag[tag] = (countsByTag[tag] ?? 0) + 1;
    }
  }
  // The seeded set DX-101 names: 10 wave-end, 15 cloud, 4 orbital-ladder,
  // 3 saved-view, 3 sandcastle, 4 aurora. The cloud count is 17 because
  // `orbital-fulldisc-6608km` and its `-imagery` sibling joined it: the
  // orbital full-disc recipe camera every banded orbital capture on record was
  // taken at, and the same camera with the globe left alone. Neither carries
  // the `wave-end` tag, so `generateScenesJson` does not see them — the
  // byte-identity case below is what proves that rather than this sentence.
  assert.deepEqual(countsByTag, {
    "wave-end": 10,
    cloud: 17,
    "orbital-ladder": 4,
    "saved-view": 3,
    sandcastle: 3,
    aurora: 4,
  });
  assert.equal(rigs.length, 41);
});

test("the orbital full-disc pair differs only in how the globe is drawn", async () => {
  const rigs = await loadRigs();
  const black = rigs.find((rig) => rig.id === "orbital-fulldisc-6608km");
  const imagery = rigs.find(
    (rig) => rig.id === "orbital-fulldisc-6608km-imagery",
  );
  assert.ok(
    black && imagery,
    "the orbital full-disc pair is not in the registry",
  );

  // Same camera, same clock, same viewport, same optics: a single-variable pair.
  assert.deepEqual(black.camera, imagery.camera);
  assert.equal(black.clock, imagery.clock);
  assert.deepEqual(black.viewport, imagery.viewport);
  assert.deepEqual(black.readiness, imagery.readiness);
  for (const key of [
    "focalPixels",
    "planetRadiusMetres",
    "nadirMetresPerPixel",
    "limbInFrame",
  ]) {
    assert.equal(black.disc[key], imagery.disc[key], `disc.${key} differs`);
  }

  // THE ONE DISC FIELD THAT DIFFERS, AND IT IS DERIVED HERE RATHER THAN
  // TRANSCRIBED. WGS84 is oblate, so the silhouette at this camera is an
  // ellipse: the blacked-out rig may state the equatorial radius because a
  // black globe puts no luminance step at either edge, but the imagery rig
  // draws a planet, and a hard edge INSIDE the measured disc is what the
  // banding metric's detrend cannot remove. Its radius must therefore be the
  // POLAR silhouette — the smallest one.
  const cameraDistance = black.disc.planetRadiusMetres + black.altitudeMetres;
  const silhouette = (radiusMetres) =>
    Math.tan(Math.asin(radiusMetres / cameraDistance)) * black.disc.focalPixels;
  const WGS84_POLAR_RADIUS_METRES = 6356752.314245179;
  assert.ok(
    Math.abs(silhouette(black.disc.planetRadiusMetres) - 1000) < 1e-6,
    "the equatorial silhouette is no longer 1,000 px at this camera",
  );
  assert.ok(
    Math.abs(
      imagery.disc.discRadiusPixels - silhouette(WGS84_POLAR_RADIUS_METRES),
    ) < 1e-6,
    `the imagery rig states ${imagery.disc.discRadiusPixels} px, not the polar silhouette ${silhouette(WGS84_POLAR_RADIUS_METRES)} px`,
  );
  assert.ok(
    imagery.disc.discRadiusPixels < black.disc.discRadiusPixels,
    "the drawn-globe rig must measure inside the smallest silhouette",
  );

  // And the cloud dials agree, so the only difference is the globe treatment.
  const cloudDials = (rig) =>
    Object.fromEntries(
      Object.entries(rig.dials).filter(([key]) => key.startsWith("cloud")),
    );
  assert.deepEqual(cloudDials(black), cloudDials(imagery));
  assert.equal(black.dials.removeImageryLayers, true);
  assert.equal(imagery.dials.removeImageryLayers, false);

  // A different globe treatment is a different render, so the replay keys must
  // not collide — that is what makes two receipts distinguishable.
  assert.notEqual(replayKeyFor(black), replayKeyFor(imagery));

  // The disc fits the frame, which is what the banding metric requires of it.
  for (const rig of [black, imagery]) {
    assert.ok(rig.disc.discRadiusPixels * 2 <= rig.viewport.width);
    assert.ok(rig.disc.discRadiusPixels * 2 <= rig.viewport.height);
  }
});

test("rig ids are unique across the whole registry", async () => {
  const rigs = await loadRigs();
  assert.equal(new Set(rigs.map((rig) => rig.id)).size, rigs.length);
});

test("every tag of every rig is drawn from RIG_TAGS", async () => {
  const rigs = await loadRigs();
  for (const rig of rigs) {
    for (const tag of rig.tags) {
      assert.ok(
        RIG_TAGS.includes(tag),
        `${rig.id} carries unknown tag ${String(tag)}`,
      );
    }
  }
});

test("replayKeyFor is stable across calls and key order, sensitive to determinism-relevant fields, insensitive to description", async () => {
  const rigs = await loadRigs();
  const rig = rigs.find((r) => r.id === "plains-fairweather-cumulus");
  assert.ok(rig, "fixture rig plains-fairweather-cumulus must exist");

  // Stable: two independent calls agree.
  assert.equal(replayKeyFor(rig), replayKeyFor(rig));

  // Stable: a key-reordered deep clone hashes the same (stableStringify
  // sorts object keys before hashing).
  function reorderKeysDeep(value) {
    if (Array.isArray(value)) {
      return value.map(reorderKeysDeep);
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).reverse()) {
        out[key] = reorderKeysDeep(value[key]);
      }
      return out;
    }
    return value;
  }
  assert.equal(replayKeyFor(rig), replayKeyFor(reorderKeysDeep(rig)));

  // Sensitive: camera height (determinism-relevant) changes the key.
  const cameraChanged = {
    ...rig,
    camera: { ...rig.camera, height: rig.camera.height + 1 },
  };
  assert.notEqual(replayKeyFor(rig), replayKeyFor(cameraChanged));

  // Sensitive: clock (determinism-relevant) changes the key.
  const clockChanged = { ...rig, clock: "2099-01-01T00:00:00Z" };
  assert.notEqual(replayKeyFor(rig), replayKeyFor(clockChanged));

  // Insensitive: description (non-determinism, purely documentary) does not.
  const descriptionChanged = { ...rig, description: "unrelated text" };
  assert.equal(replayKeyFor(rig), replayKeyFor(descriptionChanged));
});

test("generateScenesJson(loadRigs()) is byte-identical to scenes.json on disk", async () => {
  const rigs = await loadRigs();
  const generated = generateScenesJson(rigs);
  const onDisk = readFileSync(scenesJsonPath(), "utf8");
  assert.equal(
    generated,
    onDisk,
    "regenerated scenes.json text must equal the file byte-for-byte",
  );
});
