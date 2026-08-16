// C12-G1F1 — pure-function Node spec for the environment frustum-demand
// predicate that decides whether `View.createPotentiallyVisibleSet` must
// restore the camera-range window so a frustum exists to carry the
// environment layer.
// @purpose Unit spec for EnvironmentFrustumDemand: when the camera-range window must be restored so a frustum exists to carry the environment layer.
// @status ACTIVE
//
// `EnvironmentFrustumDemand` is a TypeScript module bundled into the engine
// barrel (no per-file JS build output), so the pure functions are transpiled
// with esbuild and imported from a data: URL — the same pattern as
// `attachment-demand-registry.spec.mjs`. This is the unit half of the
// C12-G1F1 net; the cross-backend behavior is gated by
// `probe-env-pass-matrix.mjs`.
//
// Run: node --test Tools/visual-regression/env-frustum-demand.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  directory,
  "../../packages/engine/Source/Scene/EnvironmentFrustumDemand.ts",
);

const tsSource = await readFile(modulePath, "utf8");
const { code } = await transform(tsSource, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { hasInjectedEnvironmentContent, needsEnvironmentOnlyFrustum } =
  await import(moduleUrl);

const SENTINEL_NEAR = Number.MAX_VALUE;
const SENTINEL_FAR = -Number.MAX_VALUE;

const drawCommand = () => ({ execute() {} });

// Injection-convention scene (alternate scene renderer installed) in a render
// pass, every environment slot empty.
function makeScene() {
  return {
    _alternateSceneRenderer: {},
    _environmentState: {
      skyBoxCommand: undefined,
      starFieldCommand: undefined,
      skyAtmosphereCommand: undefined,
      sunDrawCommand: undefined,
      moonCommand: undefined,
      isSkyAtmosphereVisible: false,
      isSunVisible: false,
      isMoonVisible: false,
    },
    _frameState: {
      passes: { render: true },
      panoramaCommandList: [],
    },
  };
}

// Each entry turns exactly ONE environment element on. The whole point of
// C12-G1F1 is that any one of them alone must demand a frustum — no element
// may depend on another element being shown.
const ELEMENTS = {
  skyBox: (scene) => {
    scene._environmentState.skyBoxCommand = drawCommand();
  },
  starField: (scene) => {
    scene._environmentState.starFieldCommand = drawCommand();
  },
  atmosphere: (scene) => {
    scene._environmentState.skyAtmosphereCommand = drawCommand();
    scene._environmentState.isSkyAtmosphereVisible = true;
  },
  sun: (scene) => {
    scene._environmentState.sunDrawCommand = drawCommand();
    scene._environmentState.isSunVisible = true;
  },
  moon: (scene) => {
    scene._environmentState.moonCommand = drawCommand();
    scene._environmentState.isMoonVisible = true;
  },
  panorama: (scene) => {
    scene._frameState.panoramaCommandList.push(drawCommand());
  },
};

test("each environment element alone demands a frustum", () => {
  for (const [name, activate] of Object.entries(ELEMENTS)) {
    const scene = makeScene();
    activate(scene);
    assert.equal(
      hasInjectedEnvironmentContent(scene),
      true,
      `${name} alone must demand a frustum`,
    );
    assert.equal(
      needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, false, scene),
      true,
      `${name} alone must restore the camera window`,
    );
  }
});

test("every element subset demands a frustum (2^6 matrix)", () => {
  const names = Object.keys(ELEMENTS);
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const scene = makeScene();
    let count = 0;
    for (let bit = 0; bit < names.length; bit++) {
      if (mask & (1 << bit)) {
        ELEMENTS[names[bit]](scene);
        count++;
      }
    }
    assert.equal(
      hasInjectedEnvironmentContent(scene),
      count > 0,
      `mask ${mask} (${count} elements) demand mismatch`,
    );
  }
});

test("an all-off environment keeps the zero-frustum fast path", () => {
  const scene = makeScene();
  assert.equal(hasInjectedEnvironmentContent(scene), false);
  assert.equal(
    needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, false, scene),
    false,
  );
});

test("culled atmosphere/sun/moon commands are not demand", () => {
  for (const slot of [
    "skyAtmosphereCommand",
    "sunDrawCommand",
    "moonCommand",
  ]) {
    const scene = makeScene();
    scene._environmentState[slot] = drawCommand();
    assert.equal(hasInjectedEnvironmentContent(scene), false, slot);
  }
});

test("a command the injector would skip is not demand", () => {
  const scene = makeScene();
  scene._environmentState.skyBoxCommand = {};
  assert.equal(hasInjectedEnvironmentContent(scene), false);
  scene._frameState.panoramaCommandList.push({});
  assert.equal(hasInjectedEnvironmentContent(scene), false);
});

test("inert on the direct-execution convention (WebGL)", () => {
  for (const renderer of [null, undefined]) {
    const scene = makeScene();
    scene._alternateSceneRenderer = renderer;
    for (const activate of Object.values(ELEMENTS)) {
      activate(scene);
    }
    assert.equal(hasInjectedEnvironmentContent(scene), false);
    assert.equal(
      needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, false, scene),
      false,
    );
  }
});

test("inert outside the render pass (pick / offscreen)", () => {
  const scene = makeScene();
  scene._frameState.passes.render = false;
  for (const activate of Object.values(ELEMENTS)) {
    activate(scene);
  }
  assert.equal(hasInjectedEnvironmentContent(scene), false);
});

test("missing scene / frame state / environment state are safe", () => {
  assert.equal(hasInjectedEnvironmentContent(undefined), false);
  assert.equal(hasInjectedEnvironmentContent(null), false);
  assert.equal(hasInjectedEnvironmentContent({}), false);
  const noFrameState = makeScene();
  noFrameState._frameState = undefined;
  assert.equal(hasInjectedEnvironmentContent(noFrameState), false);
  const noEnvState = makeScene();
  noEnvState._environmentState = undefined;
  assert.equal(hasInjectedEnvironmentContent(noEnvState), false);
  const noPanoramas = makeScene();
  noPanoramas._frameState.panoramaCommandList = undefined;
  assert.equal(hasInjectedEnvironmentContent(noPanoramas), false);
});

test("never widens a range geometry already produced", () => {
  const scene = makeScene();
  ELEMENTS.moon(scene);
  // near <= far: real content set the accumulators; leave them alone.
  assert.equal(needsEnvironmentOnlyFrustum(10, 1000, false, scene), false);
  assert.equal(needsEnvironmentOnlyFrustum(10, 1000, true, scene), false);
  // Degenerate-but-valid equal range is still "set" — not a sentinel.
  assert.equal(needsEnvironmentOnlyFrustum(10, 10, true, scene), false);
});

test("C10-01 binned-environment fallback still fires without inject demand", () => {
  const scene = makeScene();
  assert.equal(
    needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, true, scene),
    true,
  );
  // ...and on WebGL, where the predicate half is always false.
  const webgl = makeScene();
  webgl._alternateSceneRenderer = null;
  assert.equal(
    needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, true, webgl),
    true,
  );
});

test("moon-only day/night asymmetry is gone (the Batch 756 evidence)", () => {
  // Night control: emulate a frame where some other environment producer set
  // `sawEnvironmentNoBV`; the moon must still request a frustum.
  const night = makeScene();
  ELEMENTS.moon(night);
  ELEMENTS.starField(night);
  assert.equal(
    needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, true, night),
    true,
  );
  // With no binned producer, `sawEnvironmentNoBV` is false. Pre-fix this
  // yielded zero frustums and the moon vanished.
  const day = makeScene();
  ELEMENTS.moon(day);
  assert.equal(
    needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, false, day),
    true,
  );
});
