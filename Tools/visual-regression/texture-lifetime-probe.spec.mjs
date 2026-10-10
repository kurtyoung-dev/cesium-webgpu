// Pure-Node spec for the texture-lifetime probe's own logic: the in-page
// texture census (driven against fake GPUDevice / GPUTexture prototypes), its
// summary, the per-label error tally, the sky-corner colour reading and the
// cell plan.
//
// @purpose Pins the GPU texture census counting (per label, repeat destroys counted once, no texture retained), its summary, the per-texture-label error tally, the corner-colour metric and the probe's cell plan and scene refusal, without a browser.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/texture-lifetime-probe.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  gpuTextureCensusInit,
  summarizeTextureCensus,
} from "./lib/gpu-texture-census.mjs";
import { cornerMeans, dominantChannel } from "./lib/metrics/corner-colour.mjs";
import {
  NO_TEXTURE_LABEL,
  planLifetimeCells,
  tallyErrorsByLabel,
} from "./probe-texture-lifetime.mjs";

function withFakeWebGPU(body) {
  const saved = {
    GPUDevice: globalThis.GPUDevice,
    GPUTexture: globalThis.GPUTexture,
    census: globalThis.__gpuTextureCensus,
  };
  class GPUTexture {
    destroy() {
      this.destroyCalls = (this.destroyCalls ?? 0) + 1;
    }
  }
  class GPUDevice {
    createTexture() {
      return new GPUTexture();
    }
  }
  globalThis.GPUDevice = GPUDevice;
  globalThis.GPUTexture = GPUTexture;
  delete globalThis.__gpuTextureCensus;
  try {
    body(new GPUDevice());
  } finally {
    globalThis.GPUDevice = saved.GPUDevice;
    globalThis.GPUTexture = saved.GPUTexture;
    if (saved.census === undefined) {
      delete globalThis.__gpuTextureCensus;
    } else {
      globalThis.__gpuTextureCensus = saved.census;
    }
  }
}

test("the census counts creates and destroys per label and a repeat destroy once", () => {
  withFakeWebGPU((device) => {
    gpuTextureCensusInit();
    const a = device.createTexture({ label: "A" });
    const b = device.createTexture({ label: "A" });
    device.createTexture({ label: "B" });
    device.createTexture({});
    a.destroy();
    a.destroy();
    const census = globalThis.__gpuTextureCensus;
    assert.equal(census.installed, true);
    assert.deepEqual(census.byLabel, {
      A: { created: 2, destroyed: 1 },
      B: { created: 1, destroyed: 0 },
      "(unlabelled)": { created: 1, destroyed: 0 },
    });
    assert.equal(census.repeatedDestroys, 1);
    // The wrapped methods still reach the real ones.
    assert.equal(a.destroyCalls, 2);
    assert.equal(b.destroyCalls, undefined);
    assert.deepEqual(summarizeTextureCensus(census, "A"), {
      label: "A",
      created: 2,
      destroyed: 1,
      live: 1,
    });
  });
});

test("installing the census twice does not double-count", () => {
  withFakeWebGPU((device) => {
    gpuTextureCensusInit();
    gpuTextureCensusInit();
    device.createTexture({ label: "A" }).destroy();
    assert.deepEqual(globalThis.__gpuTextureCensus.byLabel.A, {
      created: 1,
      destroyed: 1,
    });
  });
});

test("a page without WebGPU gets an empty, uninstalled census", () => {
  withFakeWebGPU(() => {
    delete globalThis.GPUDevice;
    gpuTextureCensusInit();
    assert.equal(globalThis.__gpuTextureCensus.installed, false);
    assert.deepEqual(
      summarizeTextureCensus(globalThis.__gpuTextureCensus, "A"),
      {
        label: "A",
        created: 0,
        destroyed: 0,
        live: 0,
      },
    );
  });
});

function solidImage(width, height, rgb, centre = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inCentre =
        centre &&
        x >= width / 4 &&
        x < (3 * width) / 4 &&
        y >= height / 4 &&
        y < (3 * height) / 4;
      const c = inCentre ? centre : rgb;
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test("the corner means read the corners, not the centre, and name the dominant channel", () => {
  const image = solidImage(200, 120, [20, 20, 220], [220, 20, 20]);
  const means = cornerMeans(image, { patch: 16 });
  assert.equal(means.pixels, 4 * 16 * 16);
  assert.deepEqual([means.r, means.g, means.b], [20, 20, 220]);
  assert.equal(dominantChannel(means), "blue");
  assert.equal(dominantChannel({ r: 200, g: 30, b: 30 }), "red");
  assert.equal(dominantChannel({ r: 100, g: 90, b: 95 }), "none");
});

test("the plan is scene-major with both renderers, and an unknown scene is refused", () => {
  assert.deepEqual(planLifetimeCells({ scene: "skybox,resize" }), [
    { scene: "skybox", renderer: "webgl" },
    { scene: "skybox", renderer: "webgpu" },
    { scene: "resize", renderer: "webgl" },
    { scene: "resize", renderer: "webgpu" },
  ]);
  assert.throws(
    () => planLifetimeCells({ scene: "resize,nope" }),
    (error) =>
      error.name === "ProbeRefusal" && error.reason === "scene-unknown",
  );
});

test("the runtime's renderer list narrows the plan", () => {
  assert.deepEqual(
    planLifetimeCells({ scene: "resize", renderers: ["webgpu"] }),
    [{ scene: "resize", renderer: "webgpu" }],
  );
});

test("errors are tallied per texture label, and a GlobeDepth line is not counted under SceneFramebuffer-Color", () => {
  const depthCopy =
    'uncaptured GPU error: Destroyed texture [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"] used in a submit.';
  const resolve =
    'uncaptured GPU error: Destroyed texture [Texture "SceneFramebuffer-Color_depth_resolve_ss"] used in a submit.';
  const sampleType =
    'uncaptured GPU error: [Texture "SceneFramebuffer-Color_depth_resolve_ss"] sample type mismatch while validating [BindGroup "Hi-Z 12"].';
  const tally = tallyErrorsByLabel({
    gateErrors: [depthCopy, depthCopy, resolve, sampleType],
    pageLines: [
      'Destroyed texture [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"] used in a submit.',
      "Some unrelated warning",
    ],
  });
  assert.deepEqual(tally.uncapturedByLabel, {
    "GlobeDepth-DepthCopy_color_rgba8unorm": 2,
    "SceneFramebuffer-Color_depth_resolve_ss": 2,
  });
  assert.deepEqual(tally.destroyedTextureByLabel, {
    "GlobeDepth-DepthCopy_color_rgba8unorm": 3,
    "SceneFramebuffer-Color_depth_resolve_ss": 1,
  });
  const sceneColourDestroyed = Object.entries(tally.destroyedTextureByLabel)
    .filter(([label]) => label.startsWith("SceneFramebuffer-Color_"))
    .reduce((sum, [, count]) => sum + count, 0);
  assert.equal(sceneColourDestroyed, 1);
  assert.deepEqual(tally.totals, {
    uncaptured: 4,
    destroyedTextureLines: 4,
    pageLines: 2,
  });
  // The same fault on two textures is one class; a different fault is another.
  assert.equal(Object.keys(tally.uncapturedByClass).length, 2);
  assert.deepEqual(
    tallyErrorsByLabel({ gateErrors: ["uncaptured GPU error: OOM"] })
      .uncapturedByLabel,
    { [NO_TEXTURE_LABEL]: 1 },
  );
});
