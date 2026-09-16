// @purpose Pins the god-ray sun-usability determination and the disjoint uniform write ranges it publishes through, including that some setter covers the sunUnusable byte range.
// @status ACTIVE

// Ruling R-2026-09-11-5 (H3): "one shader, one uniform flag, one authority."
// The caller's boolean is the sole determination of whether this frame's sun
// is one the shaft can be built from. It feeds two consumers — the pass skip
// (`enabled = usable || scene.godRayBehindCamera`) and the shader's own
// receptor (`params3.y`, published by `setSunScreenUV`).
//
// This file asserts the observable behaviour of that determination and of the
// uniform writes it travels through. It does NOT assert the shape of the
// expressions that produce them: every test drives the real
// `configureWebGPUPostProcessPipeline` or the real `GodRayEffect` and reads
// what came out the other side — which boolean reached the setter, whether the
// two passes are enabled, and which byte ranges the GPU queue was handed.
//
// The hazard Group B exists for is silent. Per-frame writes are narrowed to
// the byte ranges each setter owns, and the only full-buffer write is
// `initialize()`. A uniform field that no setter's range covers therefore
// reaches the GPU exactly once, at init, and then freezes — with nothing
// failing to compile and no WebGPU validation error, because the buffer is
// simply longer than the ranges written into it. `sunUnusable` sits 60 bytes
// past the sun UV it is set alongside, so "the setter writes it" is not
// something the code's shape makes evident; B2 measures it.
//
// Group E is the inertness control. Each mutant makes one change unreachable
// (`if (false && …)`, or the pre-change expression restored), or a declared range
// re-aimed at bytes its setter does not own, and requires the assertion that
// covers it to go red, so no test here can pass over dead code.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const webgpuDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
);
const bridgePath = path.join(
  webgpuDirectory,
  "WebGPUPostProcessStageCollection.ts",
);
const effectPath = path.join(webgpuDirectory, "WebGPUGodRayEffect.ts");

const bridgeSource = (await readFile(bridgePath, "utf8")).replace(
  /\r\n/g,
  "\n",
);
const effectSource = (await readFile(effectPath, "utf8")).replace(
  /\r\n/g,
  "\n",
);

// `initialize()` reads these WebGPU bitfield globals, which Node has no reason
// to define. The values are irrelevant to every assertion here — nothing reads
// a usage flag back — so the smallest plausible stand-ins keep the real
// constructor on its real path.
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 8,
  TEXTURE_BINDING: 4,
  RENDER_ATTACHMENT: 16,
};
globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

/**
 * A GPUDevice that records every `queue.writeBuffer` as the byte range it
 * covered. Nothing else about the device is observed.
 *
 * @returns {object} The fake device, with its `writes` array.
 */
function recordingDevice() {
  const writes = [];
  return {
    writes,
    createBuffer: (descriptor) => ({ label: descriptor.label }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroupLayout: () => ({}),
    queue: {
      writeBuffer: (buffer, offset, data, dataOffset, size) =>
        writes.push({
          offset,
          size: size ?? data.byteLength,
          bufferLength: data.byteLength,
        }),
      writeTexture: () => {},
    },
  };
}

/**
 * The per-frame setters, by the range each one claims to own. The spec reads
 * the offsets from the module rather than restating them, so a layout change
 * moves both together and B2 keeps measuring the field it names.
 *
 * @param {object} mod The bundled effect module.
 * @returns {Array<object>} One entry per per-frame setter.
 */
function perFrameSetters(mod) {
  const ranges = mod.GOD_RAY_UNIFORM_RANGES;
  return [
    {
      name: "setSunScreenUV",
      drive: (fx) => fx.setSunScreenUV(0.25, 0.75, false),
      owns: [ranges.sunUV, ranges.sunUnusable],
    },
    {
      name: "updateConfig",
      drive: (fx) => fx.updateConfig({ density: 0.111 }),
      owns: [ranges.appearance, ranges.emitter],
    },
    {
      name: "setFrustum",
      drive: (fx) => fx.setFrustum(2, 2e6, true),
      owns: [ranges.frustum],
    },
  ];
}

/**
 * Builds a real `GodRayEffect` on a recording device, initialized.
 *
 * @param {object} mod The bundled effect module.
 * @returns {object} `{fx, device}`.
 */
function initializedEffect(mod) {
  const device = recordingDevice();
  const fx = new mod.GodRayEffect();
  fx.initialize(device, 800, 400, "bgra8unorm");
  device.writes.length = 0;
  return { fx, device };
}

// A column-major view-projection whose row 3 is (0, 0, -1, 0), so
// `cw = -sz` — the clip-w of Cesium's perspective frustum, which is the sun's
// distance in FRONT of the camera along the view axis. Rows 0 and 1 are
// identity, so `cx = sx` and `cy = sy`. Chosen so every case below can be
// reasoned about from the sun's coordinates alone.
function viewProjectionLookingDownMinusZ() {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[11] = -1;
  return m;
}

/**
 * Drives the real configure pass for one sun position and returns what the
 * god-ray effect was told.
 *
 * @param {object} mod The bundled bridge module.
 * @param {object} sun World-space sun position.
 * @param {object} [sceneExtra] Extra scene fields, e.g. the opt-in.
 * @returns {object} `{enabled, calls}`.
 */
function configureFrame(mod, sun, sceneExtra = {}) {
  const calls = [];
  const effect = {
    enabled: true,
    updateConfig() {},
    setSunScreenUV(u, v, usable) {
      calls.push({ u, v, usable });
    },
    setFrustum() {},
  };
  // Every pipeline member other than the god-ray slot is a no-op: the
  // configure pass lazily adds a dozen unrelated effects, and none of them has
  // anything to say about the sun determination.
  const pipeline = new Proxy(
    { godRayEffect: effect },
    {
      get: (target, key) => (key in target ? target[key] : () => {}),
    },
  );
  mod.configureWebGPUPostProcessPipeline(
    pipeline,
    { _webgpuCache: {} },
    {},
    "bgra8unorm",
    {
      godRayEnabled: true,
      camera: { frustum: { near: 1, far: 1e7 } },
      context: {
        uniformState: {
          viewProjection: viewProjectionLookingDownMinusZ(),
          sunPositionWC: sun,
        },
      },
      ...sceneExtra,
    },
  );
  return { enabled: effect.enabled, calls };
}

const SUN_IN_FRONT = { x: 0.2, y: 0.1, z: -10 };
// The same sun reflected through the camera: it lands on the antisolar point,
// which projects to the mirror of the in-front UV about the screen centre.
const SUN_BEHIND = { x: 0.2, y: 0.1, z: 10 };
// A sun 1e-9 m in front of the camera plane but 1e9 m to the side. Its
// projection is finite in f64 AND in f32 — |ndc| is 1e18, far below the f32
// ceiling — so a finiteness check cannot reject it, yet the UV it produces
// carries no per-pixel information at all.
const SUN_GRAZING = { x: 1e9, y: 0, z: -1e-9 };

const bridge = await bundle({
  path: bridgePath,
  source: bridgeSource,
  real: [],
});
const effectModule = await bundle({
  path: effectPath,
  source: effectSource,
  real: ["WebGPUPostProcessEffects"],
});

// ---------------------------------------------------------------------------
// Group A — the determination, and that it reaches both consumers.
// ---------------------------------------------------------------------------

test("A1: a sun in front of the camera is published as usable and runs the passes", () => {
  const frame = configureFrame(bridge, SUN_IN_FRONT);
  assert.equal(frame.calls.length, 1, "the sun UV is published exactly once");
  assert.equal(frame.calls[0].usable, true);
  assert.equal(frame.enabled, true);
});

test("A2: a sun behind the camera is published as unusable and both passes are skipped", () => {
  const frame = configureFrame(bridge, SUN_BEHIND);
  assert.equal(frame.calls.length, 1);
  assert.equal(
    frame.calls[0].usable,
    false,
    "the shader receptor must be told, not just the pass skip",
  );
  assert.equal(frame.enabled, false, "default is to skip, not to shade");
});

test("A3: the behind-camera opt-in keeps the passes running without making the sun usable", () => {
  const frame = configureFrame(bridge, SUN_BEHIND, {
    godRayBehindCamera: true,
  });
  assert.equal(frame.enabled, true, "the opt-in keeps a live pass");
  assert.equal(
    frame.calls[0].usable,
    false,
    "the opt-in must not forge the determination — there is one authority",
  );
});

test("A4: a behind-camera sun is published with the antisolar UV, not a parked one", () => {
  const front = configureFrame(bridge, SUN_IN_FRONT).calls[0];
  const behind = configureFrame(bridge, SUN_BEHIND).calls[0];
  // The antisolar point is the sun reflected through the camera, so its UV is
  // the sun's UV reflected through the screen centre. A future anticrepuscular
  // mode converges there, so the value has to survive the rejection.
  assert.ok(
    Math.abs(behind.u - (1 - front.u)) < 1e-12,
    `antisolar u ${behind.u} should mirror ${front.u}`,
  );
  assert.ok(Math.abs(behind.v - (1 - front.v)) < 1e-12);
});

test("A5: a sun grazing the camera plane is unusable even though its projection is finite", () => {
  const frame = configureFrame(bridge, SUN_GRAZING);
  // Establish that finiteness cannot be what rejects it: compute the UV the
  // unguarded projection would have produced and show it is a finite f32.
  const unguardedNdcX = SUN_GRAZING.x / -SUN_GRAZING.z;
  const unguardedU = unguardedNdcX * 0.5 + 0.5;
  assert.ok(
    Number.isFinite(Math.fround(unguardedU)),
    "the grazing UV is finite, so only a magnitude guard can reject it",
  );
  assert.equal(frame.calls[0].usable, false);
  assert.equal(frame.enabled, false);
});

test("A6: a sun comfortably in front is not swept up by the grazing guard", () => {
  // The guard must reject the degenerate band and nothing else. A sun one
  // metre in front and one metre to the side is nowhere near it.
  const frame = configureFrame(bridge, { x: 1, y: 0, z: -1 });
  assert.equal(frame.calls[0].usable, true);
  assert.equal(frame.enabled, true);
});

// ---------------------------------------------------------------------------
// Group B — the uniform write ranges. B2 is Widfara's C4 extension.
// ---------------------------------------------------------------------------

test("B1: initialization writes the whole struct exactly once", () => {
  const device = recordingDevice();
  const fx = new effectModule.GodRayEffect();
  fx.initialize(device, 800, 400, "bgra8unorm");
  const full = device.writes.filter((w) => w.offset === 0 && w.size >= 80);
  assert.equal(full.length, 1, "one full-buffer write, at init");
  assert.equal(full[0].size, effectModule.GOD_RAY_UNIFORM_BYTE_LENGTH);
});

test("B2: some per-frame setter covers the sunUnusable byte range", () => {
  const range = effectModule.GOD_RAY_UNIFORM_RANGES.sunUnusable;
  const covering = [];
  for (const setter of perFrameSetters(effectModule)) {
    const { fx, device } = initializedEffect(effectModule);
    setter.drive(fx);
    const covers = device.writes.some(
      (w) =>
        w.offset <= range.offset &&
        w.offset + w.size >= range.offset + range.size,
    );
    if (covers) {
      covering.push(setter.name);
    }
  }
  assert.ok(
    covering.length > 0,
    `no per-frame setter writes bytes ${range.offset}-${range.offset + range.size}; ` +
      `the field would reach the GPU only at init and then freeze silently`,
  );
});

test("B3: a sun update leaves the appearance and frustum bytes alone", () => {
  const ranges = effectModule.GOD_RAY_UNIFORM_RANGES;
  const { fx, device } = initializedEffect(effectModule);
  fx.setSunScreenUV(0.25, 0.75, false);
  for (const foreign of [ranges.appearance, ranges.frustum]) {
    for (const write of device.writes) {
      const overlaps =
        write.offset < foreign.offset + foreign.size &&
        foreign.offset < write.offset + write.size;
      assert.equal(
        overlaps,
        false,
        `a sun update wrote ${write.offset}..${write.offset + write.size}, ` +
          `which overlaps ${foreign.offset}..${foreign.offset + foreign.size}`,
      );
    }
  }
});

test("B4: every per-frame write lands inside a range its own setter declares", () => {
  for (const setter of perFrameSetters(effectModule)) {
    const { fx, device } = initializedEffect(effectModule);
    setter.drive(fx);
    assert.ok(device.writes.length > 0, `${setter.name} wrote nothing`);
    for (const write of device.writes) {
      const owned = setter.owns.some(
        (range) =>
          write.offset >= range.offset &&
          write.offset + write.size <= range.offset + range.size,
      );
      assert.ok(
        owned,
        `${setter.name} wrote ${write.offset}..${write.offset + write.size}, ` +
          `outside every range it owns`,
      );
    }
  }
});

test("B5: the sun flag survives a resize, because resize rewrites the whole struct", () => {
  const { fx, device } = initializedEffect(effectModule);
  fx.setSunScreenUV(0.25, 0.75, false);
  device.writes.length = 0;
  fx.resize(1024, 512);
  const full = device.writes.filter(
    (w) =>
      w.offset === 0 && w.size === effectModule.GOD_RAY_UNIFORM_BYTE_LENGTH,
  );
  assert.equal(
    full.length,
    1,
    "resize re-enters initialize and rewrites all of it",
  );
});

// ---------------------------------------------------------------------------
// Group C — the appearance snapshot's change test.
// ---------------------------------------------------------------------------

test("C1: re-applying an unchanged appearance writes nothing", () => {
  const { fx, device } = initializedEffect(effectModule);
  fx.updateConfig({ density: 0.5 });
  device.writes.length = 0;
  fx.updateConfig({ density: 0.5 });
  assert.equal(device.writes.length, 0, "the change test must skip the write");
});

test("C2: an array-valued appearance field is compared by value, not by identity", () => {
  // `scene.godRayConfig` rebuilds this triple in an object literal each frame.
  // Comparing identities would force a uniform write on every frame.
  const { fx, device } = initializedEffect(effectModule);
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.7] });
  device.writes.length = 0;
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.7] });
  assert.equal(
    device.writes.length,
    0,
    "an equal array rebuilt each frame must not count as a change",
  );
});

test("C3: a genuinely different array is still a change", () => {
  const { fx, device } = initializedEffect(effectModule);
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.7] });
  device.writes.length = 0;
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.6] });
  assert.ok(device.writes.length > 0, "a different value must still write");
});

// ---------------------------------------------------------------------------
// Group E — inertness controls. Each one makes a change unreachable and
// requires the assertion covering it to go red.
// ---------------------------------------------------------------------------

/**
 * Re-bundles the bridge through a mutation and returns a frame driver over it.
 *
 * @param {Function} mutate The source rewrite.
 * @param {string} label The mutation's name.
 * @returns {Promise<Function>} A `configureFrame`-shaped driver.
 */
async function mutatedBridge(mutate, label) {
  const mod = await bundle({
    path: bridgePath,
    source: bridgeSource,
    real: [],
    mutate,
    label,
  });
  return (sun, sceneExtra) => configureFrame(mod, sun, sceneExtra);
}

test("E1: with the opt-in branch dead, A3 fails", async () => {
  const drive = await mutatedBridge(
    (source) =>
      source.replace(
        "pipeline.godRayEffect.enabled = sunUsable || behindCameraOptIn;",
        "pipeline.godRayEffect.enabled = sunUsable || (false && behindCameraOptIn);",
      ),
    "dead behind-camera opt-in",
  );
  const frame = drive(SUN_BEHIND, { godRayBehindCamera: true });
  assert.equal(
    frame.enabled,
    false,
    "the opt-in is inert here, so A3's assertion must be the thing that fails",
  );
});

test("E2: with the usable argument dropped, A2 fails", async () => {
  const drive = await mutatedBridge(
    (source) =>
      source.replace(
        "    fx.setSunScreenUV(u, v, false);",
        "    fx.setSunScreenUV(u, v);",
      ),
    "usable argument dropped",
  );
  const frame = drive(SUN_BEHIND);
  assert.notEqual(
    frame.calls[0].usable,
    false,
    "with the argument dropped the receptor is never told, which is what A2 pins",
  );
});

test("E3: with the grazing guard dead, A5 fails", async () => {
  const drive = await mutatedBridge(
    (source) =>
      source.replace(
        "  if (Math.abs(cw) <= cwEpsilon) {",
        "  if (false && Math.abs(cw) <= cwEpsilon) {",
      ),
    "dead grazing guard",
  );
  const frame = drive(SUN_GRAZING);
  assert.equal(
    frame.calls[0].usable,
    true,
    "without the guard the grazing sun passes as usable, which is what A5 pins",
  );
});

test("E4: with the sunUnusable write dead, B2 fails", async () => {
  const mod = await bundle({
    path: effectPath,
    source: effectSource,
    real: ["WebGPUPostProcessEffects"],
    label: "dead sunUnusable write",
    mutate: (source) =>
      source.replace(
        "      const flagRange = GOD_RAY_UNIFORM_RANGES.sunUnusable;",
        "      const flagRange = { offset: 0, size: 0 };",
      ),
  });
  const range = mod.GOD_RAY_UNIFORM_RANGES.sunUnusable;
  let covered = false;
  for (const setter of perFrameSetters(mod)) {
    const { fx, device } = initializedEffect(mod);
    setter.drive(fx);
    covered ||= device.writes.some(
      (w) =>
        w.offset <= range.offset &&
        w.offset + w.size >= range.offset + range.size,
    );
  }
  assert.equal(
    covered,
    false,
    "the orphaning this mutant produces is exactly what B2 must catch",
  );
});

test("E5: with the value compare reverted to identity, C2 fails", async () => {
  const mod = await bundle({
    path: effectPath,
    source: effectSource,
    real: ["WebGPUPostProcessEffects"],
    label: "identity appearance compare",
    mutate: (source) =>
      source.replace(
        "if (!appearanceValueEquals(this._config[key], value)) {",
        "if (this._config[key] !== value) {",
      ),
  });
  const { fx, device } = initializedEffect(mod);
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.7] });
  device.writes.length = 0;
  fx.updateConfig({ sunRadiance: [0.9, 0.8, 0.7] });
  assert.ok(
    device.writes.length > 0,
    "an identity compare writes every frame, which is what C2 pins",
  );
});

test("E6: with updateConfig's second write re-aimed across the frustum, B4 fails", async () => {
  function inside(write, range) {
    return (
      write.offset >= range.offset &&
      write.offset + write.size <= range.offset + range.size
    );
  }

  function unownedUnder(mod) {
    const setter = perFrameSetters(mod).find(
      (entry) => entry.name === "updateConfig",
    );
    const { fx, device } = initializedEffect(mod);
    setter.drive(fx);
    return device.writes.filter(
      (write) => !setter.owns.some((range) => inside(write, range)),
    ).length;
  }

  const mod = await bundle({
    path: effectPath,
    source: effectSource,
    real: ["WebGPUPostProcessEffects"],
    label: "emitter write spans the frustum",
    mutate: (source) =>
      source.replace(
        "        GOD_RAY_UNIFORM_RANGES.emitter,",
        "        { offset: 8, size: 56 },",
      ),
  });
  assert.equal(
    unownedUnder(effectModule),
    0,
    "the shipped effect writes only ranges updateConfig declares",
  );
  assert.ok(
    unownedUnder(mod) > 0,
    "a write outside every declared range is exactly what B4 must catch",
  );
});
