// @purpose Executes finite cloud air columns and observer sky-view domain admission.
// @status ACTIVE
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compileFunction,
  readConstants,
  stripComments,
  vec,
} from "./lib/wgsl-mini-eval.mjs";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = "packages/engine/Source/Shaders/WebGPU/Environment/";
const source = stripComments(
  fs.readFileSync(
    path.join(root, directory + "CloudAerialTransport.wgsl"),
    "utf8",
  ),
);
const march = stripComments(
  fs.readFileSync(path.join(root, directory + "ProceduralClouds.wgsl"), "utf8"),
);
const constants = readConstants(source);
const cloud = {
  planetRadius: 6378137,
  planetPolarRadius: 6356752.314245179,
  cameraPosition: vec(6378437, 0, 0),
  cameraGeodeticHeight: 300,
};
const functions = { exp: Math.exp, sqrt: Math.sqrt };
const globals = { ...constants, cloud, __functions: functions };
for (const name of [
  "cloudAirColumnMeters",
  "cloudAirCurvatureRadius",
  "cloudCurvedAirInterval",
  "cloudCurvedAirDensity",
  "cloudCurvedAirPair",
  "cloudCurvedAirColumnMeters",
  "cloudAerialFraction",
  "cloudAerialSkyViewWeight",
  "cloudAmbientSkyViewWeight",
]) {
  functions[name] = compileFunction(source, name, globals);
}
const radius = 6371000;
const top = constants.CLOUD_AIR_TOP_M;
const scaleHeight = constants.CLOUD_AIR_SCALE_HEIGHT_M;

function referenceColumn(height, mu, length) {
  const r0 = radius + height;
  const b = r0 * mu;
  const topDiscriminant = b * b + (radius + top) ** 2 - r0 * r0;
  if (topDiscriminant < 0) return 0;
  const a = Math.max(0, -b - Math.sqrt(topDiscriminant));
  let z = Math.min(length, -b + Math.sqrt(topDiscriminant));
  const groundDiscriminant = b * b + radius * radius - r0 * r0;
  if (mu < 0 && groundDiscriminant >= 0) {
    z = Math.min(z, -b - Math.sqrt(groundDiscriminant));
  }
  if (z <= a) return 0;
  const count = 8192;
  const step = (z - a) / count;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const distance = a + (i + 0.5) * step;
    const altitude = Math.max(
      Math.hypot(r0 + mu * distance, Math.sqrt(1 - mu * mu) * distance) -
        radius,
      0,
    );
    sum += Math.exp(-altitude / scaleHeight) * step;
  }
  return sum;
}

test("curved air columns agree with independent numerical sphere integration", () => {
  for (const height of [0, 2750, 12000, 85000, 160000]) {
    for (const mu of [-1, -0.2, -0.02, 0, 0.02, 0.2, 1]) {
      for (const length of [100, 60000, 2e6, 30e6]) {
        const expected = referenceColumn(height, mu, length);
        const actual = functions.cloudCurvedAirColumnMeters(
          height,
          mu,
          length,
          radius,
        );
        assert.ok(Number.isFinite(actual) && actual >= 0);
        assert.ok(
          Math.abs(actual - expected) <= Math.max(0.5, expected * 0.005),
          JSON.stringify({ height, mu, length, actual, expected }),
        );
      }
    }
  }
});

test("grazing paths escape the dense air while descending paths stop at ground", () => {
  const curved = functions.cloudCurvedAirColumnMeters(0, 0, 1e6, radius);
  const flat = functions.cloudAirColumnMeters(0, 0, 1e6);
  assert.ok(curved < 0.5 * flat && curved > 200000);
  const interval = functions.cloudCurvedAirInterval(2000, -0.04, 1e6, radius);
  assert.equal(interval.x, 0);
  assert.ok(interval.y > 50000 && interval.y < 100000);
  const r0 = radius + 2000;
  const endHeight =
    Math.sqrt(r0 * r0 + interval.y * (interval.y - 0.08 * r0)) - radius;
  assert.ok(Math.abs(endHeight) < 1e-6);
  assert.equal(functions.cloudCurvedAirColumnMeters(0, -1, 1000, radius), 0);
  assert.equal(functions.cloudCurvedAirColumnMeters(2750, 0, -1000, radius), 0);
});

test("vacuum extension adds no air and short-path curvature stays continuous", () => {
  for (const mu of [0, 0.02, 0.2, 1]) {
    const near = functions.cloudCurvedAirColumnMeters(2750, mu, 2e6, radius);
    const far = functions.cloudCurvedAirColumnMeters(2750, mu, 30e6, radius);
    assert.equal(near, far);
  }
  for (const mu of [-0.2, 0, 0.2, 1]) {
    const curved = functions.cloudCurvedAirColumnMeters(2750, mu, 100, radius);
    const flat = functions.cloudAirColumnMeters(2750, mu, 100);
    assert.ok(Math.abs(curved - flat) < 0.001);
  }
});

test("oblate normal-section curvature matches equatorial and polar radii", () => {
  const a = cloud.planetRadius;
  const b = cloud.planetPolarRadius;
  for (const [up, direction, expected] of [
    [vec(1, 0, 0), vec(0, 1, 0), a],
    [vec(1, 0, 0), vec(0, 0, 1), (b * b) / a],
    [vec(0, 0, 1), vec(1, 0, 0), (a * a) / b],
  ]) {
    const actual = functions.cloudAirCurvatureRadius(up, direction);
    assert.ok(Math.abs(actual - expected) < 1e-6);
  }
});

test("sky-view air light admits the observer frame and rejects orbital and ground-directed rays", () => {
  cloud.cameraGeodeticHeight = 300;
  assert.equal(functions.cloudAerialSkyViewWeight(vec(1, 0, 0)), 1);
  assert.equal(functions.cloudAerialSkyViewWeight(vec(-1, 0, 0)), 0);
  const samples = [-0.02, -0.01, 0, 0.01, 0.02].map((mu) =>
    functions.cloudAerialSkyViewWeight(vec(mu, Math.sqrt(1 - mu * mu), 0)),
  );
  assert.deepEqual(
    samples,
    [...samples].sort((a, b) => a - b),
  );
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 1);
  cloud.cameraGeodeticHeight = 100000;
  assert.equal(functions.cloudAerialSkyViewWeight(vec(1, 0, 0)), 0);
  cloud.cameraGeodeticHeight = 300;
  assert.equal(
    functions.cloudAmbientSkyViewWeight(vec(1, 0, 0), vec(1, 0, 0)),
    1,
  );
  assert.equal(
    functions.cloudAmbientSkyViewWeight(vec(0, 1, 0), vec(1, 0, 0)),
    0,
  );
});

test("observer-relative sun elevation invalidates stale sky-view data and retries unpublished bakes", async () => {
  const sky = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    ),
    "utf8",
  );
  const start = sky.indexOf("function updateSkyViewObserver(");
  const end = sky.indexOf("\nfunction ensureLutBindGroup(", start);
  assert.ok(start >= 0 && end > start);
  const module = await import(
    "data:text/javascript;base64," +
      Buffer.from("export " + sky.slice(start, end)).toString("base64")
  );
  const cache = {};
  let invalidations = 0;
  const manager = {
    invalidateAtmosphereLUT() {
      invalidations++;
    },
  };
  const sun = { x: 1, y: 0, z: 0 };
  const frame = { camera: { positionWC: { x: radius, y: 0, z: 0 } } };
  const update = () => module.updateSkyViewObserver(cache, frame, sun, manager);
  assert.equal(update(), 1);
  assert.equal(invalidations, 1);
  assert.equal(cache.lastSkyViewSunCosZenith, undefined);
  update();
  assert.equal(invalidations, 2);
  cache.lastSkyViewSunCosZenith = 1;
  update();
  assert.equal(invalidations, 2);
  frame.camera.positionWC.x += 10000;
  update();
  assert.equal(invalidations, 2);
  frame.camera.positionWC = { x: 0, y: radius, z: 0 };
  assert.equal(update(), 0);
  assert.equal(invalidations, 3);
  cache.lastSkyViewSunCosZenith = 0;
  update();
  assert.equal(invalidations, 3);
  // The bake-ready condition is pinned by behaviour, below: R-12 replaced the
  // source-shape assertion of this unit's own form with the contract that
  // follows (R-2026-10-22-14).
});

// ── R-14: the sky-view observer path applies only while clouds are active ──
//
// The behaviour contract that replaces the old source-shape assertion on
// R-12's terms. It drives the real `ensureLutBindGroup` with a fake device and
// a performance manager that counts invalidations and bakes. With clouds off a
// Sun-only change gives the base's single bake, observer motion past the 0.002
// threshold invalidates nothing, and the base ready condition holds (a later
// moon-only bake publishes). With clouds on the observer motion re-bakes, a
// failed sun bake is retried, and the sky view becomes ready only under
// `sunDirty && sunOk`, recording the elevation it was baked for. The mutants
// make the clouds-active gate unreachable, and always true; each must turn one
// half of the contract red.
//
// Clouds on holds for both decks. The globe-managed deck is published into the
// atmospheric conditions before the sky updates. A user collection is driven
// in the real frame order (review B-1): the sky's `ensureLutBindGroup` runs in
// Scene.updateEnvironment, then CloudCollection.update publishes its request
// through the real `WebGPUContext.requestVolumetricClouds`, then the
// environmental pass's real `resolveCloudFramePlan` consumes it. The request is
// therefore never pending when the sky runs, and the next frame's sky must see
// the deck through the record that pass leaves on the context. Two mutants make
// that record unreachable (its write, and its read); each must turn the
// user-deck half red while the managed-deck half stays green.

const skyRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
);

async function loadSkyLut(mutate, label) {
  const text = fs
    .readFileSync(skyRendererPath, "utf8")
    .replaceAll("\r\n", "\n");
  const engine = await bundle({
    path: skyRendererPath,
    source: `${text}\nexport { ensureLutBindGroup as __ensureLutBindGroup };\n`,
    real: [],
    realDir: path.join(root, "packages/engine/Source/Core"),
    mutate,
    label,
  });
  return engine.__ensureLutBindGroup;
}

const contextPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
);
const environmentPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnvironmentalEffects.ts",
);

/**
 * The real frame-order pieces: the sky's ensure, the context's request seam
 * (WebGPUContext over the real GraphicsContext) and the environmental pass's
 * plan resolution. Each mutation names the file it rewrites.
 */
async function loadFrameOrder({ sky, environment } = {}) {
  const read = (file) => fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const ensure = await loadSkyLut(sky?.mutate, sky?.label);
  const contextModule = await bundle({
    path: contextPath,
    source: read(contextPath),
    real: ["GraphicsContext"],
  });
  const environmentModule = await bundle({
    path: environmentPath,
    source: read(environmentPath),
    real: [],
    mutate: environment?.mutate,
    label: environment?.label,
  });
  return {
    ensure,
    WebGPUContext: contextModule.WebGPUContext,
    resolveCloudFramePlan: environmentModule.resolveCloudFramePlan,
  };
}

function skyRig({ cloudsOn = false, sunOk = true, context: realContext } = {}) {
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  };
  const views = {
    transmittanceView: {},
    inscatterView: {},
    moonTransmittanceView: {},
    moonInscatterView: {},
    multipleScatterView: {},
    skyViewView: {},
  };
  const manager = {
    sunDirty: false,
    moonDirty: false,
    invalidations: 0,
    sunBakes: 0,
    moonBakes: 0,
    sunOk,
    zenith: [],
    invalidateAtmosphereLUT() {
      this.invalidations++;
      this.sunDirty = true;
    },
    shouldRecomputeAtmosphereLUT() {
      const dirty = this.sunDirty;
      this.sunDirty = false;
      return dirty;
    },
    invalidateMoonAtmosphereLUT() {
      this.moonDirty = true;
    },
    shouldRecomputeMoonAtmosphereLUT() {
      const dirty = this.moonDirty;
      this.moonDirty = false;
      return dirty;
    },
    ensureAtmosphereLUTResources() {
      return views;
    },
    dispatchAtmosphereLUT(encoder, device, params, which) {
      if (which === "moon") {
        this.moonBakes++;
        return true;
      }
      this.sunBakes++;
      this.zenith.push(params.sunCosZenith);
      return this.sunOk;
    },
  };
  const device = {
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: { submit() {} },
  };
  // A real WebGPUContext (frame order) keeps its own request seam; only the
  // two capabilities the sky reads are given.
  const context = realContext ?? {};
  Object.defineProperty(context, "performanceManager", { value: manager });
  Object.defineProperty(context, "supportsComputeShaders", { value: true });
  const frameState = {
    frameNumber: 0,
    sunDirectionWC: { x: 1, y: 0, z: 0 },
    moonDirectionWC: { x: 0, y: 1, z: 0 },
    camera: { positionWC: { x: radius, y: 0, z: 0 } },
    atmosphericConditions: {
      lighting: {},
      weather: {},
      clouds: { enableVolumetric: cloudsOn },
    },
  };
  const skyAtmosphere = {
    _ellipsoid: { radii: { x: radius, y: radius, z: radius } },
    atmosphereLightIntensity: 50,
  };
  const cache = { lutBindGroupLayout: {} };
  return {
    manager,
    frameState,
    cache,
    context,
    frame: (ensure) =>
      ensure(cache, context, device, frameState, skyAtmosphere),
  };
}

/**
 * One real frame for a user collection: the sky (Scene.updateEnvironment),
 * then the primitive update that publishes the collection's request when it is
 * shown, then the environmental pass that consumes it.
 */
function frameOrderRig(harness, { sunOk }) {
  const rig = skyRig({
    sunOk,
    context: Object.create(harness.WebGPUContext.prototype),
  });
  const scene = { _frameState: rig.frameState, globe: undefined };
  rig.realFrame = (published) => {
    rig.frameState.frameNumber += 1;
    rig.frame(harness.ensure);
    if (published) {
      rig.context.requestVolumetricClouds({ enabled: true });
    }
    const pending = rig.context.hasVolumetricCloudRequest;
    const plan = harness.resolveCloudFramePlan(
      { scene, context: rig.context },
      false,
    );
    return { pending, plan, after: rig.context.hasVolumetricCloudRequest };
  };
  return rig;
}

/** Clouds on for a user collection, driven in the real frame order. */
function assertUserDeckFrameOrder(harness) {
  const rig = frameOrderRig(harness, { sunOk: false });
  // Frame 1, the deck's first: the sky ran before the collection published.
  const first = rig.realFrame(true);
  assert.equal(first.pending, true, "the request is pending after primitives");
  assert.equal(first.plan.active, true, "the environmental pass resolves it");
  assert.equal(
    first.after,
    false,
    "and consumes it before the next sky update",
  );
  assert.equal(rig.manager.sunBakes, 1);
  assert.equal(
    rig.cache.lastSkyViewSunCosZenith,
    undefined,
    "frame 1's sky ran before the deck existed",
  );
  // Frame 2: a moon-only change, with the request consumed a frame ago.
  rig.frameState.moonDirectionWC = { x: 0, y: 0, z: 1 };
  rig.realFrame(true);
  assert.equal(rig.manager.sunBakes, 2, "the unpublished sun bake is retried");
  assert.notEqual(
    rig.cache.lutReady,
    true,
    "a moon-only success does not publish",
  );
  // Frame 3: a successful sun bake publishes and records its elevation.
  rig.manager.sunOk = true;
  rig.realFrame(true);
  assert.equal(rig.manager.sunBakes, 3);
  assert.equal(rig.cache.lutReady, true, "a successful sun bake publishes");
  assert.equal(rig.cache.lastSkyViewSunCosZenith, rig.manager.zenith.at(-1));
  assert.equal(rig.manager.zenith.at(-1), 1, "baked for the observer's own up");
  // Frame 4: observer motion past 0.002 re-bakes; the collection is hidden
  // from this frame on and publishes nothing.
  const invalidations = rig.manager.invalidations;
  rig.frameState.camera.positionWC = { x: 0, y: radius, z: 0 };
  const hidden = rig.realFrame(false);
  assert.equal(
    rig.manager.invalidations,
    invalidations + 1,
    "observer motion invalidates",
  );
  assert.equal(rig.manager.sunBakes, 4, "and re-bakes");
  assert.ok(Math.abs(rig.manager.zenith.at(-1)) < 1e-12);
  assert.equal(
    hidden.plan.active,
    false,
    "a hidden collection resolves no deck",
  );
  // Frame 5: two frames after the last resolved deck the sky is back on the
  // base path, where observer motion invalidates nothing.
  rig.frameState.camera.positionWC = { x: radius, y: 0, z: 0 };
  rig.realFrame(false);
  assert.equal(
    rig.manager.invalidations,
    invalidations + 1,
    "clouds off again: observer motion invalidates nothing",
  );
  assert.equal(rig.manager.sunBakes, 4, "and bakes nothing");
}

/** Clouds off: the base cadence and the base ready condition. */
function assertSkyPathCloudsOff(ensure) {
  const rig = skyRig();
  rig.frame(ensure);
  assert.equal(rig.manager.sunBakes, 1, "the first frame bakes once");
  assert.equal(rig.cache.lutReady, true);
  const invalidations = rig.manager.invalidations;
  // A quarter turn of the observer moves the observer-relative sun cosine from
  // 1 to 0, far past the 0.002 threshold.
  rig.frameState.camera.positionWC = { x: 0, y: radius, z: 0 };
  rig.frame(ensure);
  assert.equal(
    rig.manager.invalidations,
    invalidations,
    "observer motion invalidates nothing",
  );
  assert.equal(rig.manager.sunBakes, 1, "and bakes nothing");
  assert.equal(rig.cache.lastSkyViewSunCosZenith, undefined);
  rig.frameState.sunDirectionWC = { x: 0, y: 0, z: 1 };
  rig.frame(ensure);
  assert.equal(rig.manager.sunBakes, 2, "a Sun-only change gives one bake");

  // The base ready condition: after a failed first sun bake, a moon-only bake
  // publishes the LUT.
  const failed = skyRig({ sunOk: false });
  failed.frame(ensure);
  assert.equal(failed.manager.sunBakes, 1);
  assert.notEqual(
    failed.cache.lutReady,
    true,
    "a failed sun bake is not ready",
  );
  failed.frameState.moonDirectionWC = { x: 0, y: 0, z: 1 };
  failed.frame(ensure);
  assert.equal(failed.manager.sunBakes, 1, "clouds off: no retry");
  assert.equal(failed.manager.moonBakes, 2);
  assert.equal(
    failed.cache.lutReady,
    true,
    "the base publishes on the moon-only bake",
  );
}

/** Clouds on: observer re-bakes, retried sun bakes, `sunDirty && sunOk`. */
function assertSkyPathCloudsOn(ensure, signal = { cloudsOn: true }) {
  const rig = skyRig({ ...signal, sunOk: false });
  rig.frame(ensure);
  assert.equal(rig.manager.sunBakes, 1);
  assert.notEqual(rig.cache.lutReady, true, "a failed sun bake is not ready");
  rig.frameState.moonDirectionWC = { x: 0, y: 0, z: 1 };
  rig.frame(ensure);
  assert.equal(rig.manager.sunBakes, 2, "the unpublished sun bake is retried");
  assert.notEqual(
    rig.cache.lutReady,
    true,
    "a moon-only success does not publish",
  );
  rig.manager.sunOk = true;
  rig.frame(ensure);
  assert.equal(rig.manager.sunBakes, 3);
  assert.equal(rig.cache.lutReady, true, "a successful sun bake publishes");
  assert.equal(rig.cache.lastSkyViewSunCosZenith, rig.manager.zenith.at(-1));
  assert.equal(rig.manager.zenith.at(-1), 1, "baked for the observer's own up");
  const invalidations = rig.manager.invalidations;
  rig.frameState.camera.positionWC = { x: 0, y: radius, z: 0 };
  rig.frame(ensure);
  assert.equal(
    rig.manager.invalidations,
    invalidations + 1,
    "observer motion invalidates",
  );
  assert.equal(rig.manager.sunBakes, 4, "and re-bakes");
  assert.ok(Math.abs(rig.manager.zenith.at(-1)) < 1e-12);
  rig.frameState.camera.positionWC = { x: 1, y: radius, z: 0 };
  rig.frame(ensure);
  assert.equal(
    rig.manager.sunBakes,
    4,
    "a change under the threshold does not",
  );
}

test("R-14 contract: with clouds off the sky LUT keeps the base cadence and ready condition", async () => {
  assertSkyPathCloudsOff(await loadSkyLut());
});

test("R-14 contract: with clouds on the sky view re-bakes on observer motion and publishes only after a sun bake", async () => {
  const harness = await loadFrameOrder();
  // The globe-managed deck, published before the sky updates.
  assertSkyPathCloudsOn(harness.ensure);
  // A user collection, in the real frame order.
  assertUserDeckFrameOrder(harness);
});

test("MUTANT: the clouds-active gate made unreachable is red on the clouds-on half", async () => {
  const ensure = await loadSkyLut(
    (text) =>
      text.replace(
        "const cloudsActive = volumetricCloudsActive(context, frameState);",
        "const cloudsActive = false && volumetricCloudsActive(context, frameState);",
      ),
    "make the R-14 clouds-active gate unreachable",
  );
  assert.throws(() => assertSkyPathCloudsOn(ensure), assert.AssertionError);
  const harness = { ...(await loadFrameOrder()), ensure };
  assert.throws(() => assertUserDeckFrameOrder(harness), assert.AssertionError);
});

test("MUTANT: the environmental pass's deck record made unreachable is red on the user-deck half", async () => {
  const harness = await loadFrameOrder({
    environment: {
      mutate: (text) =>
        text.replace(
          "context.noteVolumetricCloudFrame?.(frameState.frameNumber);",
          "false && context.noteVolumetricCloudFrame?.(frameState.frameNumber);",
        ),
      label: "make the environmental pass's volumetric deck record unreachable",
    },
  });
  assert.throws(() => assertUserDeckFrameOrder(harness), assert.AssertionError);
  assertSkyPathCloudsOn(harness.ensure);
});

test("MUTANT: the sky's read of the deck record made unreachable is red on the user-deck half", async () => {
  const harness = await loadFrameOrder({
    sky: {
      mutate: (text) =>
        text.replace(
          "const sinceDeck = frameState.frameNumber - context.volumetricCloudFrameNumber;",
          "const sinceDeck = false && frameState.frameNumber - context.volumetricCloudFrameNumber;",
        ),
      label: "make the sky's read of the volumetric deck record unreachable",
    },
  });
  assert.throws(() => assertUserDeckFrameOrder(harness), assert.AssertionError);
  assertSkyPathCloudsOn(harness.ensure);
});

test("MUTANT: the clouds-active gate made always true is red on the clouds-off half", async () => {
  const ensure = await loadSkyLut(
    (text) =>
      text.replace(
        "const cloudsActive = volumetricCloudsActive(context, frameState);",
        "const cloudsActive = true || volumetricCloudsActive(context, frameState);",
      ),
    "make the R-14 clouds-active gate always true",
  );
  assert.throws(() => assertSkyPathCloudsOff(ensure), assert.AssertionError);
});

test("the selected march consumes curved geometry and uses the observer sky-view frame", () => {
  assert.match(march, /cloudAirCurvatureRadius\(visibleUp, -rayDir\)/);
  assert.match(march, /cloudSampleSkyViewLut\(observerUp, rayDir, sunDir\)/);
  assert.doesNotMatch(
    march,
    /cloudSampleSkyViewLut\(visibleUp, rayDir, sunDir\)/,
  );
  assert.match(march, /aerialLutWeight > 0\.0/);
  assert.match(march, /cloudAmbientSkyViewWeight\(localUp, sunDir\)/);
  assert.match(march, /hazed = mix\(toneMapped, farTarget, aerial\)/);
});
