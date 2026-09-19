/**
 * DX-101 — the rig registry: one declarative record per capture, generalised
 * from `lib/cloud-tour-fixtures.mjs`'s fixture shape.
 * @purpose Load, validate and hash the rig records under rigs/, and regenerate scenes.json byte-identically from the rigs tagged wave-end.
 * @status ACTIVE
 *
 * WHY A REGISTRY RATHER THAN A GROWING scenes.json. Five probe families each
 * define scenes their own way today: `scenes.json` (consumed by
 * `capture-and-diff.mjs`), `lib/cloud-tour-fixtures.mjs`'s 15 fixtures,
 * `lib/cloud-orbital-ladder-model.mjs`'s four altitude rungs,
 * `probe-saved-view.mjs`'s three saved views, and `sandcastle-smoke.mjs`'s
 * three gallery demos. `DX-104`'s `capture(rig, origin, options)` needs ONE
 * shape to drive, not five. This module is that shape's loader and the one
 * place that reconciles it with the file `capture-and-diff.mjs` still reads.
 *
 * `capture-and-diff.mjs` IS NOT MODIFIED BY THIS ROW. `scenes.json` continues
 * to exist on disk exactly as it does today; `generateScenesJson` below
 * produces the same text FROM the wave-end-tagged rigs, and the regeneration
 * being byte-identical is what proves the rigs are a faithful restatement
 * rather than a second, drifting copy. The wave-end gate keeps reading the
 * file it reads today.
 *
 * A RIG FILE IS DATA, NOT CODE. Every `rigs/<id>.mjs` default-exports one
 * frozen plain object — no functions, no imports of this module or of the
 * runtime, no I/O. That is what makes `loadRigs()` safe to call from a spec
 * with no browser and what makes `replayKeyFor` meaningful: a hash over a
 * plain object is a hash over the rig's actual content, not over whatever a
 * function happened to compute this run.
 *
 * SOME WAVE-END RIGS CARRY A `legacyOrder` / `legacyExtraOrder` PAIR that
 * `generateScenesJson` does not use for any OTHER tag. `scenes.json`'s scene
 * array order is authored, not alphabetical (`wgs84-orbit` precedes
 * `wgs84-close`; `high-density-5k-spheres` puts `setupParams` before
 * `setupFile` where the three `subsystem-parity-setup.js` scenes put
 * `setupFile` first) — reproducing that byte-for-byte needs the original
 * order recorded somewhere, and a rig file recording its own position is
 * simpler than teaching the generator a rule it would have to special-case
 * per scene anyway.
 *
 * @module rig-registry
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replayKeyFor as hashStableValue } from "./cloud-tour-fixtures.mjs";
import { resolveSceneExpectations } from "./visual-gate-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RIGS_DIR = path.join(__dirname, "..", "rigs");
const SCENES_JSON_PATH = path.join(__dirname, "..", "scenes.json");

/**
 * Frozen tag vocabulary. `validateRig` rejects any tag outside this set —
 * add-only, the same discipline `ShaderDefine` uses for its bit registry:
 * a rig tagged with a typo silently stops counting toward the group it was
 * meant to join, and this is how that fails loudly instead.
 */
export const RIG_TAGS = Object.freeze([
  "wave-end",
  "cloud",
  "orbital-ladder",
  "saved-view",
  "sandcastle",
  "aurora",
]);

/** `readiness.kind` vocabulary a rig may declare. */
export const READINESS_KINDS = Object.freeze(["settleFrames", "settleMs"]);

/** Renderer identifiers a rig's `renderers` array may contain. */
const RENDERER_IDS = Object.freeze(["webgl", "webgpu"]);

/** The suite's own long-form schema description, copied verbatim from the
 * `scenes.json` this module regenerates — schema-level documentation, not
 * per-scene data, so it lives here rather than being repeated on every rig. */
const SCENES_JSON_DESCRIPTION =
  "Visual regression scene definitions for the WebGL ↔ WebGPU split-screen comparison page. Each entry sets up a camera + flags via window.viewerSetupHelpers (defined in split-screen-comparison.html), waits a settle frame count, then captures both canvases for pixel-diff. The optional `setup` field is a JS source string evaluated in the page context before the camera is positioned — used for synthetic high-density scenes (Batch 224). Optional `thresholds` overrides the per-gate mismatch ceiling; optional `expectedMismatch` pre-registers what a gate is expected to do and why, is folded into report.json, and never changes a gate's status or the exit code (see README, 'Pre-registered expectations').";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isVector3(value) {
  return (
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
  );
}

/**
 * Read every rig record under `rigs/`.
 *
 * Each file is dynamically imported (a rig is a module, not a JSON blob) and
 * its `default` export is taken verbatim — a rig file that exports anything
 * else is the loader's own bug, not a rig-authoring error, so it throws
 * rather than silently skipping the file.
 *
 * @returns {Promise<object[]>} Rigs, sorted by `id` for a deterministic
 *   iteration order independent of the filesystem's own directory order.
 */
export async function loadRigs() {
  const files = fs
    .readdirSync(RIGS_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const rigs = [];
  for (const name of files) {
    const mod = await import(pathToFileURL(path.join(RIGS_DIR, name)).href);
    if (mod.default === undefined || typeof mod.default !== "object") {
      throw new TypeError(
        `rigs/${name} must default-export a plain object rig record`,
      );
    }
    rigs.push(mod.default);
  }
  return rigs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Validate one rig record. Fails CLOSED: an unrecognised shape is a
 * violation rather than a silent pass, matching `validateFixture`'s
 * discipline in `cloud-tour-fixtures.mjs`.
 *
 * @param {object} rig
 * @returns {string[]} Violations; empty when the rig is sound.
 */
export function validateRig(rig) {
  const failures = [];
  const id = rig?.id ?? "(unnamed)";
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${id}: ${message}`);
    }
  };

  need(typeof rig?.id === "string" && rig.id.length > 0, "missing id");

  need(
    Array.isArray(rig?.tags) && rig.tags.length > 0,
    "needs at least one tag",
  );
  if (Array.isArray(rig?.tags)) {
    for (const tag of rig.tags) {
      need(RIG_TAGS.includes(tag), `unknown tag ${String(tag)}`);
    }
  }

  need(
    Array.isArray(rig?.renderers) && rig.renderers.length > 0,
    "needs at least one renderer",
  );
  if (Array.isArray(rig?.renderers)) {
    for (const renderer of rig.renderers) {
      need(
        RENDERER_IDS.includes(renderer),
        `unknown renderer ${String(renderer)}`,
      );
    }
  }

  const hasPage = Object.hasOwn(rig ?? {}, "page");
  const hasUrl = Object.hasOwn(rig ?? {}, "url");
  need(hasPage !== hasUrl, "declare exactly one of page or url");
  const pageValue = hasPage ? rig.page : rig.url;
  need(
    pageValue === null ||
      (typeof pageValue === "string" && pageValue.length > 0),
    "page/url must be a non-empty string or null (page not yet implemented)",
  );

  need("camera" in (rig ?? {}), "missing camera (null is a valid value)");
  const camera = rig?.camera;
  if (camera !== null && camera !== undefined) {
    const isDegreesForm =
      isFiniteNumber(camera.lon) &&
      isFiniteNumber(camera.lat) &&
      isFiniteNumber(camera.height);
    const isEcefForm =
      isVector3(camera.position) &&
      isVector3(camera.direction) &&
      isVector3(camera.up);
    need(
      isDegreesForm || isEcefForm,
      "camera must be null, {lon,lat,height,...} or {position,direction,up}",
    );
    if (isDegreesForm) {
      need(camera.lat >= -90 && camera.lat <= 90, "camera.lat out of range");
      for (const key of ["heading", "pitch", "roll"]) {
        need(
          camera[key] === undefined || isFiniteNumber(camera[key]),
          `camera.${key} must be a finite number when present`,
        );
      }
    }
  }

  need(
    rig?.clock === null ||
      (typeof rig?.clock === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(rig.clock)),
    "clock must be null or an ISO-8601 UTC instant",
  );

  need(
    isFiniteNumber(rig?.viewport?.width) && rig.viewport.width > 0,
    "viewport.width must be a positive number",
  );
  need(
    isFiniteNumber(rig?.viewport?.height) && rig.viewport.height > 0,
    "viewport.height must be a positive number",
  );

  const readiness = rig?.readiness;
  need(
    READINESS_KINDS.includes(readiness?.kind),
    `readiness.kind must be one of ${READINESS_KINDS.join(", ")}`,
  );
  if (readiness?.kind === "settleFrames") {
    need(
      isFiniteNumber(readiness.frames) && readiness.frames > 0,
      "readiness.frames must be a positive number",
    );
  }
  if (readiness?.kind === "settleMs") {
    need(
      isFiniteNumber(readiness.ms) && readiness.ms > 0,
      "readiness.ms must be a positive number",
    );
  }

  if (rig?.gate !== undefined) {
    const gate = rig.gate;
    const hasFloor = isFiniteNumber(gate?.minChangedFraction);
    const hasCeiling = isFiniteNumber(gate?.maxChangedFraction);
    need(
      hasFloor !== hasCeiling,
      "gate must declare exactly one of minChangedFraction or maxChangedFraction",
    );
    need(
      typeof gate?.why === "string" && gate.why.length > 20,
      "gate.why must justify the threshold",
    );
  }

  if (rig?.expectedMismatch !== undefined) {
    const { errors } = resolveSceneExpectations({
      name: rig.id,
      expectedMismatch: rig.expectedMismatch,
    });
    for (const error of errors) {
      failures.push(`${id}: expectedMismatch ${error}`);
    }
  }

  return failures;
}

/**
 * The determinism-relevant subset of a rig — what `replayKeyFor` hashes.
 *
 * Deliberately excludes `description`, `tags`, `gate`, `expectedMismatch`,
 * `climate`/`region`/`formation`/`cloudGenus`/`stations`/`covers` and any
 * other purely-documentary field: those describe the rig to a reader, they
 * do not change what gets rendered. Two rigs that render identically but are
 * annotated differently must hash the same, or the key stops answering "did
 * this replay the same definition" and starts answering "was this edited".
 *
 * @param {object} rig
 * @returns {object}
 */
function replaySubset(rig) {
  return {
    id: rig.id,
    renderers: rig.renderers,
    camera: rig.camera ?? null,
    clock: rig.clock ?? null,
    dials: rig.dials ?? null,
    asset: rig.asset ?? rig.tileset ?? null,
    setupFile: rig.setupFile ?? null,
    setupParams: rig.setupParams ?? null,
    viewport: rig.viewport,
    readiness: rig.readiness,
  };
}

/**
 * A rig's replay key: stable across two calls and across a key-reordered
 * deep clone (the underlying `stableStringify` sorts object keys), and
 * sensitive to any determinism-relevant field. Hashing goes through
 * `cloud-tour-fixtures.mjs`'s own `replayKeyFor`/`stableStringify` rather
 * than a second implementation, so the two registries can never disagree
 * about what "the same definition" means.
 *
 * @param {object} rig
 * @returns {string} Eight lowercase hex digits.
 */
export function replayKeyFor(rig) {
  return hashStableValue(replaySubset(rig));
}

/**
 * Find a rig by id in an already-loaded set.
 *
 * @param {object[]} rigs Result of {@link loadRigs}.
 * @param {string} id
 * @returns {object|undefined}
 */
export function rigById(rigs, id) {
  return rigs.find((rig) => rig.id === id);
}

/**
 * The legacy `scenes.json` camera shape for a rig's `camera` field.
 *
 * Only the degrees form (`{lon, lat, height, ...}`) round-trips: an ECEF-pose
 * camera or an absent one both legitimately mean "this scene has no static
 * `destination`/`orientation` in `scenes.json`" — `voxel-box-procedural`'s
 * pose lives in its setup file precisely because this JSON shape cannot hold
 * an ECEF pose, and `pointcloud-timedynamic-edl` / `gsplat-sh-unit-cube`
 * frame themselves at runtime from a bounding sphere. All three are `null`
 * in `scenes.json` today, and this function reproduces that rather than
 * inventing a shape the file has never had.
 *
 * @param {object|null} camera
 * @returns {{destination:number[], orientation:object}|null}
 */
function legacyCameraShape(camera) {
  if (
    camera &&
    isFiniteNumber(camera.lon) &&
    isFiniteNumber(camera.lat) &&
    isFiniteNumber(camera.height)
  ) {
    return {
      destination: [camera.lon, camera.lat, camera.height],
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? 0,
        roll: camera.roll ?? 0,
      },
    };
  }
  return null;
}

/** Build one `scenes.json` scene entry, in its rig's own recorded order. */
function legacySceneEntry(rig) {
  const entry = { name: rig.id, description: rig.description };
  for (const key of rig.legacyExtraOrder ?? []) {
    if (key === "setupFile" && rig.setupFile !== undefined) {
      entry.setupFile = rig.setupFile;
    } else if (key === "setupParams" && rig.setupParams !== undefined) {
      entry.setupParams = rig.setupParams;
    }
  }
  entry.camera = legacyCameraShape(rig.camera);
  if (rig.expectedMismatch !== undefined) {
    entry.expectedMismatch = rig.expectedMismatch;
  }
  return entry;
}

/**
 * Regenerate `scenes.json`'s exact text from the rigs tagged `wave-end`.
 *
 * `capture-and-diff.mjs` is not modified by this row and keeps reading the
 * file on disk; this function is what proves the rigs are a faithful
 * restatement of it rather than a second copy that can drift — the spec
 * asserts the return value is byte-identical to `readFileSync(scenes.json)`.
 *
 * HOW THE FORMATTING SURVIVES `JSON.stringify`. `scenes.json`'s only two
 * inlined structures are a camera's `destination` array and its `orientation`
 * object — every other array/object in the file is one key per line. Rather
 * than hand-rolling a second JSON printer, this stringifies normally (which
 * over-expands those two shapes) and then collapses exactly those two known,
 * fixed patterns back to one line; every other line is untouched. `scenes.json`
 * is CRLF (this repository's Windows checkout convention, `core.autocrlf`),
 * so the LF `JSON.stringify` produces is converted at the end, once.
 *
 * @param {object[]} rigs Result of {@link loadRigs} (or any subset containing
 *   the `wave-end`-tagged rigs).
 * @returns {string} The regenerated `scenes.json` text.
 */
export function generateScenesJson(rigs) {
  const waveEnd = rigs
    .filter((rig) => rig.tags.includes("wave-end"))
    .slice()
    .sort((a, b) => a.legacyOrder - b.legacyOrder);
  if (waveEnd.length === 0) {
    throw new Error("generateScenesJson: no rig is tagged wave-end");
  }

  const urls = new Set(waveEnd.map((rig) => rig.url));
  if (urls.size !== 1) {
    throw new Error(
      `wave-end rigs disagree on url: ${JSON.stringify([...urls])}`,
    );
  }
  const settleFrameSet = new Set(waveEnd.map((rig) => rig.readiness?.frames));
  if (settleFrameSet.size !== 1) {
    throw new Error(
      `wave-end rigs disagree on readiness.frames: ${JSON.stringify([...settleFrameSet])}`,
    );
  }

  const top = {
    $schema: "./scenes.schema.json",
    description: SCENES_JSON_DESCRIPTION,
    baseUrl: [...urls][0],
    settleFrames: [...settleFrameSet][0],
    scenes: waveEnd.map(legacySceneEntry),
  };

  let text = JSON.stringify(top, null, 2);

  text = text.replace(
    /"destination": \[\n\s+([^\n]+),\n\s+([^\n]+),\n\s+([^\n]+)\n\s+\]/g,
    '"destination": [$1, $2, $3]',
  );
  text = text.replace(
    /"orientation": \{\n\s+"heading": ([^\n,]+),\n\s+"pitch": ([^\n,]+),\n\s+"roll": ([^\n]+)\n\s+\}/g,
    '"orientation": { "heading": $1, "pitch": $2, "roll": $3 }',
  );

  return (text + "\n").replace(/\n/g, "\r\n");
}

/** Absolute path to `scenes.json`, for a caller that wants to compare against disk. */
export function scenesJsonPath() {
  return SCENES_JSON_PATH;
}
