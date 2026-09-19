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
  // 3 saved-view, 3 sandcastle, 4 aurora.
  assert.deepEqual(countsByTag, {
    "wave-end": 10,
    cloud: 15,
    "orbital-ladder": 4,
    "saved-view": 3,
    sandcastle: 3,
    aurora: 4,
  });
  assert.equal(rigs.length, 39);
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
