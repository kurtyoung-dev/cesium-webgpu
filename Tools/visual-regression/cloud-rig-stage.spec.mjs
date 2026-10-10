// cloud-rig-stage.spec.mjs — the cloud rig stager, both halves. Pure Node: no
// browser, no GPU.
//
// @purpose Drives lib/cloud-rig-stage.mjs: the Node payload builder over the real rigs the migrated W-series gates stage (and its refusals), the two page-side functions against a stub viewer and a stub Cesium namespace (dials, clock, camera, sun-relative heading, and a canvas read in the task of the final render), the one-arm capture's acceptance, refusals and record, and the demo-leg read at the viewer's own clock.
// @status ACTIVE
//
// WHY THE PAGE HALF IS RUN HERE AND NOT ONLY IN EDGE. The page functions are
// shipped as source text by `page.evaluate`, so a Node test cannot share a
// module with them — but it can run the SAME function objects against a stub
// `globalThis.viewer`, a stub `__cloudProbe` and a `data:` URL module that
// stands in for the Cesium namespace. That proves the wiring (which dial lands
// where, which heading is set, which clock renders, which frame is read and
// when) without a GPU; what the frame then looks like is the Edge leg's
// question, not this file's.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isUnderTmpdir, mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  CLOUD_RIG_MODULE_URL,
  CLOUD_RIG_READ_PATH,
  CLOUD_RIG_SCENE_DIALS,
  captureCloudRigArm,
  captureViewerCanvas,
  cloudRigStagePayload,
  settleCloudRigInPage,
  stageCloudRigInPage,
} from "./lib/cloud-rig-stage.mjs";
import { ProbeRefusal, sha256 } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The stub canvas's data URL prefix; the real one starts `data:image/png;base64,`. */
const CANVAS_READ_PREFIX = "stub-canvas:";

/** The four gates whose frames come from `captureCloudRigArm`. */
const W_SERIES_PROBES = Object.freeze([
  "probe-cloud-phase.mjs",
  "probe-cloud-ambient.mjs",
  "probe-cloud-tod.mjs",
  "probe-cloud-aerial.mjs",
]);

/** The two demo probes whose frames come from `captureViewerCanvas`. */
const DEMO_PROBES = Object.freeze([
  "probe-cloud-special.mjs",
  "probe-cloud-features.mjs",
]);

/** The rigs the migrated W-series gates stage through this module. */
const STAGED_RIG_IDS = Object.freeze([
  "cloud-phase-backlit",
  "cloud-phase-frontlit",
  "cloud-ambient-sidelit",
  "cloud-tod-dawn",
  "cloud-tod-noon",
  "cloud-tod-dusk",
  "cloud-aerial-near-deck",
  "cloud-aerial-far-deck",
  "cloud-aerial-dusk-beauty",
]);

/**
 * A stand-in for the Cesium namespace, as a `data:` URL module. The east-north-
 * up transform is the identity, so a world sun direction IS its local one.
 */
const FAKE_CESIUM = `data:text/javascript,${encodeURIComponent(`
export const Color = { fromCssColorString: (css) => ({ css }) };
export const JulianDate = { fromIso8601: (iso) => ({ iso }) };
export class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(lon, lat, height) { return new Cartesian3(lon, lat, height); }
  static normalize(v, result) {
    const m = globalThis.Math.hypot(v.x, v.y, v.z);
    result.x = v.x / m; result.y = v.y / m; result.z = v.z / m;
    return result;
  }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
}
export const Transforms = { eastNorthUpToFixedFrame: (origin) => ({ origin }) };
export class Matrix4 {
  static inverseTransformation(m) { return m; }
  static multiplyByPointAsVector(m, v, result) {
    result.x = v.x; result.y = v.y; result.z = v.z;
    return result;
  }
}
const toDegrees = (radians) => (radians * 180) / globalThis.Math.PI;
const CesiumMath = { toDegrees };
export { CesiumMath as Math };
`)}`;

/**
 * Install a stub viewer, harness and animation-frame hook on `globalThis`,
 * run `body`, and remove them again whatever happens.
 *
 * @param {object} options Stub options.
 * @param {{x: number, y: number, z: number}} options.sun World sun direction.
 * @param {(log: object) => Promise<void>} body The test body.
 * @returns {Promise<void>}
 */
async function withStubPage({ sun }, body) {
  const log = { configure: [], renders: [], setView: [], rafs: 0, events: [] };
  const scene = {
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    sun: { show: true },
    moon: { show: true },
    globe: { show: true },
    backgroundColor: null,
    context: { uniformState: { sunDirectionWC: sun } },
    frameState: { frameNumber: 0 },
    // The canvas the same-task block reads: it answers with the number of the
    // frame rendered last, so a read can be matched to its render.
    canvas: {
      toDataURL(type) {
        log.events.push("read");
        return `${CANVAS_READ_PREFIX}${type}:${scene.frameState.frameNumber}`;
      },
    },
    initializeFrame() {
      log.renders.push("initializeFrame");
    },
    render(time) {
      scene.frameState.frameNumber += 1;
      log.events.push("render");
      log.renders.push(time === undefined ? "wall-clock" : time.iso);
    },
  };
  const viewer = {
    scene,
    useDefaultRenderLoop: true,
    clock: { shouldAnimate: true, currentTime: null },
    camera: {
      setView(view) {
        log.setView.push(view);
      },
    },
  };
  const saved = {
    viewer: globalThis.viewer,
    __cloudProbe: globalThis.__cloudProbe,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    document: globalThis.document,
  };
  globalThis.viewer = viewer;
  // The same-task block makes its decode canvas up front; a settle never
  // decodes (it returns the data URL), so the stub context is never drawn on.
  globalThis.document = {
    createElement: () => ({ getContext: () => ({}) }),
  };
  globalThis.__cloudProbe = {
    configure(options) {
      log.configure.push(options);
      return {
        ok: true,
        config: { ...options.volumetric },
        rendererType: "webgpu",
      };
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    log.rafs += 1;
    log.events.push("raf");
    setImmediate(callback);
  };
  try {
    await body({ log, viewer, scene });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    }
  }
}

test("S1: every rig a migrated gate stages turns into a payload, with the dials split by owner", async () => {
  const rigs = await loadRigs();
  for (const id of STAGED_RIG_IDS) {
    const rig = rigs.find((candidate) => candidate.id === id);
    assert.ok(rig, `${id} is missing from the registry`);
    const payload = cloudRigStagePayload(rig);
    assert.equal(payload.rigId, id);
    assert.equal(payload.moduleUrl, CLOUD_RIG_MODULE_URL);
    assert.equal(payload.clock, rig.clock);
    for (const key of Object.keys(payload.scene)) {
      assert.ok(CLOUD_RIG_SCENE_DIALS.includes(key), `${id}: scene ${key}`);
    }
    for (const key of Object.keys(payload.volumetric)) {
      assert.match(key, /^cloud[A-Z]/, `${id}: volumetric ${key}`);
    }
    // Every dial lands on exactly one side.
    assert.equal(
      Object.keys(payload.scene).length +
        Object.keys(payload.volumetric).length,
      Object.keys(rig.dials).length,
      `${id}: a dial was dropped`,
    );
    // JSON-safe: page.evaluate serialises it.
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  }
});

test("S2: overrides replace the rig's values for one leg and leave the rig alone", async () => {
  const rigs = await loadRigs();
  const near = rigs.find((rig) => rig.id === "cloud-aerial-near-deck");
  const off = cloudRigStagePayload(near, {
    volumetric: { cloudAerialStrength: 0 },
  });
  assert.equal(off.volumetric.cloudAerialStrength, 0);
  assert.equal(near.dials.cloudAerialStrength, 1, "the rig itself moved");
  const pitched = cloudRigStagePayload(near, { camera: { pitch: 0.5 } });
  assert.equal(pitched.camera.pitch, 0.5);
  assert.equal(pitched.camera.heading, near.camera.heading);
  const wall = cloudRigStagePayload(near, { clock: null });
  assert.equal(wall.clock, null);
});

test("S3: a rig the stager cannot stage is refused before a browser is involved", () => {
  const base = {
    id: "fixture",
    camera: { lon: 0, lat: 0, height: 1, heading: 0, pitch: 0, roll: 0 },
    clock: null,
    dials: {},
  };
  assert.throws(
    () => cloudRigStagePayload({ ...base, camera: null }),
    /camera\.lon/,
  );
  assert.throws(
    () =>
      cloudRigStagePayload({
        ...base,
        camera: { lon: 0, lat: 0, height: 1 },
      }),
    /camera\.heading/,
  );
  assert.throws(
    () =>
      cloudRigStagePayload({
        ...base,
        camera: { ...base.camera, headingReference: "moon" },
      }),
    /headingReference/,
  );
  // The globe-surface dial names Batch 622 removed are neither a scene dial
  // nor a CloudVolumetrics property, and neither is a typo'd key.
  assert.throws(
    () =>
      cloudRigStagePayload({ ...base, dials: { showProceduralClouds: true } }),
    /showProceduralClouds/,
  );
  assert.throws(
    () => cloudRigStagePayload({ ...base, dials: { coverage: 0.5 } }),
    /coverage/,
  );
});

test("S4: the page stager applies scene dials, hands cloud dials to the harness, sets the clock and the camera", async () => {
  await withStubPage(
    { sun: { x: 0, y: 1, z: 0 } },
    async ({ log, viewer, scene }) => {
      const payload = {
        ...cloudRigStagePayload({
          id: "fixture",
          camera: {
            lon: -95,
            lat: 39,
            height: 800,
            heading: 1.25,
            pitch: 0.25,
            roll: 0,
          },
          clock: "2026-06-21T18:20:00Z",
          dials: {
            cloudCoverage: 0.5,
            skyBoxShow: false,
            sunShow: false,
            skyAtmosphereShow: false,
            backgroundColor: "rgb(0,0,0)",
            useDefaultRenderLoop: false,
          },
        }),
        moduleUrl: FAKE_CESIUM,
      };
      const staged = await stageCloudRigInPage(payload);
      assert.deepEqual(log.configure, [
        { volumetric: { cloudCoverage: 0.5 }, requireWebGPU: true },
      ]);
      assert.equal(viewer.useDefaultRenderLoop, false);
      assert.equal(scene.skyBox.show, false);
      assert.equal(scene.sun.show, false);
      assert.equal(scene.skyAtmosphere.show, false);
      assert.equal(scene.moon.show, true, "an undeclared dial is left alone");
      assert.equal(scene.globe.show, true, "an undeclared dial is left alone");
      assert.deepEqual(scene.backgroundColor, { css: "rgb(0,0,0)" });
      assert.equal(viewer.clock.shouldAnimate, false);
      assert.deepEqual(viewer.clock.currentTime, {
        iso: "2026-06-21T18:20:00Z",
      });
      // An absolute heading is used as declared; no render happens to find the sun.
      assert.equal(log.renders.length, 0);
      assert.equal(log.setView.length, 1);
      assert.deepEqual(log.setView[0].orientation, {
        heading: 1.25,
        pitch: 0.25,
        roll: 0,
      });
      assert.equal(staged.headingRadians, 1.25);
      assert.equal(staged.sunHeadingDeg, null);
      assert.deepEqual(staged.config, { cloudCoverage: 0.5 });
    },
  );
});

test("S5: a sun-relative heading is the sun's local azimuth plus the rig's offset", async () => {
  // Sun due east in the camera's local frame: azimuth atan2(1, 0) = pi / 2.
  await withStubPage({ sun: { x: 1, y: 0, z: 0 } }, async ({ log }) => {
    const rigs = await loadRigs();
    for (const [id, offset] of [
      ["cloud-phase-backlit", 0],
      ["cloud-phase-frontlit", Math.PI],
      ["cloud-ambient-sidelit", Math.PI / 2],
    ]) {
      log.setView.length = 0;
      log.renders.length = 0;
      const rig = rigs.find((candidate) => candidate.id === id);
      const staged = await stageCloudRigInPage({
        ...cloudRigStagePayload(rig),
        moduleUrl: FAKE_CESIUM,
      });
      assert.equal(staged.headingRadians, Math.PI / 2 + offset, id);
      assert.equal(log.setView[0].orientation.heading, Math.PI / 2 + offset);
      assert.equal(staged.sunHeadingDeg, 90);
      assert.equal(staged.sunElevationDeg, 0);
      // One frame is rendered, at the page's own clock (these rigs declare none).
      assert.deepEqual(log.renders, ["initializeFrame", "wall-clock"]);
    }
  });
});

test("S6: settling renders the declared frames at the staged clock, yielding between them, then reads the canvas in the task of one more render", async () => {
  await withStubPage({ sun: { x: 0, y: 0, z: 1 } }, async ({ log, viewer }) => {
    const settled = await settleCloudRigInPage({
      frames: 3,
      clock: "2026-06-21T11:40:00Z",
      moduleUrl: FAKE_CESIUM,
      camera: { lon: 0, lat: 0, height: 1 },
    });
    // Three settle frames and the one whose frame is read, all at the clock.
    assert.deepEqual(log.renders, [
      "2026-06-21T11:40:00Z",
      "2026-06-21T11:40:00Z",
      "2026-06-21T11:40:00Z",
      "2026-06-21T11:40:00Z",
    ]);
    // A yield after every settle frame, and NONE between the last render and
    // the read: the read is of a frame no compositor swap has touched.
    assert.deepEqual(log.events, [
      "render",
      "raf",
      "render",
      "raf",
      "render",
      "raf",
      "render",
      "read",
    ]);
    assert.equal(log.rafs, 3);
    assert.deepEqual(viewer.clock.currentTime, { iso: "2026-06-21T11:40:00Z" });
    assert.equal(settled.frames, 3);
    // The read is the canvas's PNG, of the frame rendered last.
    assert.equal(settled.png, `${CANVAS_READ_PREFIX}image/png:4`);
    assert.equal(settled.frameNumber, 4);
    // The stub's "up" at (0, 0, 1) is +z and the sun is +z: elevation 90.
    assert.equal(settled.sunElevationDeg, 90);

    log.renders.length = 0;
    await settleCloudRigInPage({
      frames: 2,
      clock: null,
      moduleUrl: FAKE_CESIUM,
      camera: { lon: 0, lat: 0, height: 1 },
    });
    assert.deepEqual(log.renders, ["wall-clock", "wall-clock", "wall-clock"]);
  });
});

/**
 * A page for `captureCloudRigArm`: every `page.evaluate` runs the function it
 * is handed against the stub viewer (so the page halves really execute),
 * except the gate read, which answers `gate`; the canvas read answers `png`.
 *
 * @param {{png: string|null, gate: object}} answers What the page reports.
 * @param {{calls: string[]}} log Call sink.
 * @returns {object} The page.
 */
function armPage({ png, gate }, log) {
  return {
    async evaluate(fn, arg) {
      if (String(fn).includes("__webgpuGate")) {
        log.calls.push("gate");
        return gate;
      }
      log.calls.push(fn.name);
      const result = await fn({ ...arg, moduleUrl: FAKE_CESIUM });
      return fn.name === "settleCloudRigInPage" ? { ...result, png } : result;
    },
    locator() {
      throw new Error("the arm must never take an element screenshot");
    },
  };
}

const LIVE_GATE = Object.freeze({
  errors: [],
  deviceLost: null,
  armedDevices: 1,
});

const pngDataUrl = (rgba) =>
  `data:image/png;base64,${Buffer.from(encodeRgbaPng(new Uint8Array(rgba), 1, 1)).toString("base64")}`;

test("S7: one arm stages, settles, reads the canvas and banks the frame it measures, with the runtime's record fields", async () => {
  const rigs = await loadRigs();
  const rig = rigs.find((candidate) => candidate.id === "cloud-tod-dawn");
  const root = mkLaneTmp("cloud-rig-stage-arm-");
  assert.ok(isUnderTmpdir(root), "the sandbox must live under tmpdir");
  try {
    await withStubPage({ sun: { x: 0, y: 0, z: 1 } }, async ({ log: stub }) => {
      const log = { calls: [] };
      const captures = [];
      const png = pngDataUrl([10, 20, 30, 255]);
      const arm = await captureCloudRigArm({
        page: armPage({ png, gate: LIVE_GATE }, log),
        rig,
        name: "arm-fixture",
        outputDirectory: root,
        captures,
      });
      assert.deepEqual(log.calls, [
        "stageCloudRigInPage",
        "settleCloudRigInPage",
        "gate",
      ]);
      assert.equal(arm.staged.rigId, "cloud-tod-dawn");
      assert.equal(arm.settled.frames, rig.readiness.frames);
      // The frame the metrics read IS the frame that was banked.
      assert.deepEqual([...arm.image.data], [10, 20, 30, 255]);
      const banked = readFileSync(path.join(root, "arm-fixture.png"));
      assert.ok(banked.equals(Buffer.from(png.split(",")[1], "base64")));
      assert.equal(captures.length, 1);
      assert.deepEqual(Object.keys(captures[0]).sort(), [
        "byteLength",
        "liveness",
        "name",
        "path",
        "readPath",
        "sha256",
      ]);
      assert.equal(captures[0].readPath, CLOUD_RIG_READ_PATH);
      assert.equal(captures[0].sha256, sha256(banked));
      assert.equal(captures[0].liveness.state, "live");
      assert.equal(captures[0].liveness.frameNumber, rig.readiness.frames + 1);
      // Pass-3 advisory A1: every render of the arm, its declared settle
      // frames and the one whose frame is read, is at the RIG'S instant. An
      // arm that lost the rig's clock on its way to the settle renders at the
      // wall clock (the viewer's own loop is stopped, so these renders are
      // the only ones), and fails here.
      assert.equal(
        typeof rig.clock,
        "string",
        "the dawn rig declares an instant",
      );
      assert.deepEqual(
        stub.renders,
        Array.from({ length: rig.readiness.frames + 1 }, () => rig.clock),
      );
    });
  } finally {
    removeLaneTmp(root);
  }
});

test("S8: a lost device or a read that is not a PNG refuses and banks nothing; an orderly teardown does not refuse", async () => {
  const rigs = await loadRigs();
  const rig = rigs.find((candidate) => candidate.id === "cloud-tod-noon");
  const goodPng = pngDataUrl([1, 2, 3, 255]);
  const root = mkLaneTmp("cloud-rig-stage-refusal-");
  assert.ok(isUnderTmpdir(root), "the sandbox must live under tmpdir");
  try {
    await withStubPage({ sun: { x: 0, y: 0, z: 1 } }, async () => {
      const run = (answers, name) =>
        captureCloudRigArm({
          page: armPage(answers, { calls: [] }),
          rig,
          name,
          outputDirectory: root,
        });
      await assert.rejects(
        run(
          {
            png: goodPng,
            gate: { ...LIVE_GATE, deviceLost: "device lost: reason=unknown" },
          },
          "lost",
        ),
        (error) =>
          error instanceof ProbeRefusal &&
          error.reason === "capture-device-lost",
      );
      // `data:,` is what a canvas with no drawing surface hands back.
      for (const bad of ["data:,", null]) {
        await assert.rejects(
          run({ png: bad, gate: LIVE_GATE }, "bad"),
          (error) =>
            error instanceof ProbeRefusal && error.reason === "capture-not-png",
        );
      }
      assert.deepEqual(readdirSync(root), [], "a refused frame was banked");
      const teardown = await run(
        {
          png: goodPng,
          gate: { ...LIVE_GATE, deviceLost: "device lost: reason=destroyed" },
        },
        "teardown",
      );
      assert.equal(teardown.capture.liveness.state, "teardown");
    });
  } finally {
    removeLaneTmp(root);
  }
});

test("S9: the in-page read is the kit's canonical same-task block, and no other canvas reader exists in the stager, the four W-series gates or the two demo probes", () => {
  const stager = readFileSync(
    path.join(HERE, "lib", "cloud-rig-stage.mjs"),
    "utf8",
  );
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(stager), []);
  assert.deepEqual(checkFusedCaptureUsage(stager), []);
  for (const file of [...W_SERIES_PROBES, ...DEMO_PROBES]) {
    const source = readFileSync(path.join(HERE, file), "utf8");
    assert.deepEqual(checkFusedCaptureUsage(source), [], file);
  }
});

test("S10: a demo leg renders once at the viewer's own clock, reads the canvas in that task, and is accepted, refused and recorded as an arm is", async () => {
  const root = mkLaneTmp("cloud-rig-stage-demo-");
  assert.ok(isUnderTmpdir(root), "the sandbox must live under tmpdir");
  try {
    await withStubPage(
      { sun: { x: 0, y: 0, z: 1 } },
      async ({ log, viewer }) => {
        // The probe froze the viewer's clock; the read must draw at it, not at
        // the wall clock a bare `scene.render()` would use.
        viewer.clock.currentTime = { iso: "viewer-frozen" };
        const settled = await settleCloudRigInPage({
          frames: 0,
          clock: null,
          moduleUrl: FAKE_CESIUM,
          camera: null,
          timeSource: "viewer-clock",
        });
        assert.deepEqual(log.renders, ["viewer-frozen"]);
        assert.deepEqual(log.events, ["render", "read"]);
        assert.equal(log.rafs, 0);
        assert.equal(settled.png, `${CANVAS_READ_PREFIX}image/png:1`);
        assert.equal(settled.sunElevationDeg, null, "no camera, no elevation");
        await assert.rejects(
          settleCloudRigInPage({
            frames: 0,
            clock: null,
            moduleUrl: FAKE_CESIUM,
            camera: null,
            timeSource: "wall",
          }),
          /unknown timeSource wall/,
        );

        const calls = { calls: [] };
        const captures = [];
        const png = pngDataUrl([40, 50, 60, 255]);
        const leg = await captureViewerCanvas({
          page: armPage({ png, gate: LIVE_GATE }, calls),
          name: "demo-leg",
          rigId: "weather-inspector-cumulonimbus-deck",
          outputDirectory: root,
          captures,
        });
        assert.deepEqual(calls.calls, ["settleCloudRigInPage", "gate"]);
        assert.deepEqual([...leg.image.data], [40, 50, 60, 255]);
        const banked = readFileSync(path.join(root, "demo-leg.png"));
        assert.ok(banked.equals(Buffer.from(png.split(",")[1], "base64")));
        assert.equal(captures.length, 1);
        assert.equal(captures[0].readPath, CLOUD_RIG_READ_PATH);
        assert.equal(captures[0].sha256, sha256(banked));
        assert.equal(captures[0].liveness.state, "live");

        const refused = (answers) =>
          captureViewerCanvas({
            page: armPage(answers, { calls: [] }),
            name: "demo-refused",
            rigId: "weather-inspector-cumulonimbus-deck",
            outputDirectory: root,
          });
        await assert.rejects(
          refused({
            png,
            gate: { ...LIVE_GATE, deviceLost: "device lost: reason=unknown" },
          }),
          (error) =>
            error instanceof ProbeRefusal &&
            error.reason === "capture-device-lost",
        );
        await assert.rejects(
          refused({ png: "data:,", gate: LIVE_GATE }),
          (error) =>
            error instanceof ProbeRefusal &&
            error.reason === "capture-not-png" &&
            error.details?.rigId === "weather-inspector-cumulonimbus-deck",
        );
        assert.deepEqual(readdirSync(root), ["demo-leg.png"]);
      },
    );
  } finally {
    removeLaneTmp(root);
  }
});
