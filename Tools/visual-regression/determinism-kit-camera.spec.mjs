// determinism-kit-camera.spec.mjs — the determinism kit places a camera only
// after the terrain holds, reads back where the camera settled, and refuses a
// camera that is not where its rig declared it.
//
// @purpose Runs the determinism kit's in-page placeCameraAfterTerrain / cameraPlacementNow against a scripted scene (late terrain, a collision lift, a terrain swap after placement) and pins decideCameraPlacement and viewHeightFromUrl, including the URLs an Edge leg recorded with the camera 640 m above its rig.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/determinism-kit-camera.spec.mjs
//
// WHAT IT PROVES.
//   K1. The camera is placed only after the globe's terrain provider has held
//       for `stableFrames` consecutive frames, so a provider that resolves
//       late is the one the camera is placed over.
//   K2. The read-back is where the camera SETTLED, not where it was put: a
//       camera the scene lifts after placement reads back lifted, and the
//       decision refuses it.
//   K3. A terrain provider replaced after placement is reported, and refused.
//   K4. Terrain that never holds is reported unsettled, and refused.
//   K5. `view=` heights are read from the page's own URL, the form the
//       CesiumViewer page writes.
//   K6. The 1 m tolerance is a closed bound on every height the decision reads.
//
// HOW. The kit's browser string is evaluated in Node over a scripted viewer:
// `scene.render()` advances a frame counter and runs the scene's script for
// that frame, and `requestAnimationFrame` is a macrotask. The Cesium stand-in
// keeps positions as {x: lon, y: lat, z: height}, so a height is read straight
// off the position; nothing here models the ellipsoid, which the kit does not
// reason about either.
//
// Inertness: set DET_KIT_PATH to a mutated copy of lib/determinism-kit.mjs to
// run these tests against it.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_URL = process.env.DET_KIT_PATH
  ? pathToFileURL(path.resolve(process.env.DET_KIT_PATH)).href
  : pathToFileURL(path.join(HERE, "lib", "determinism-kit.mjs")).href;
const kit = await import(KIT_URL);
const { DET_BROWSER_SETUP, decideCameraPlacement, viewHeightFromUrl } = kit;

// Two of the four URLs Edge leg 1 of the ssr rigs recorded (2026-10-09), as
// the capture report holds them.
const LEG1_URLS = [
  "http://localhost:8090/Apps/CesiumViewer/index.html?renderer=webgpu&view=-100.00093683%2C39.99801863999996%2C669.7937783290386%2C360%2C-5.9999806580820865%2C360",
  "http://localhost:8092/Apps/CesiumViewer/index.html?renderer=webgpu&view=-100.00093683%2C39.99801863999997%2C661.2223536740338%2C5.088887490341627e-14%2C-5.99998",
];

class EllipsoidTerrainProvider {}
class CesiumTerrainProvider {}

const C = {
  Cartesian3: {
    fromDegrees: (lon, lat, height) => ({ x: lon, y: lat, z: height }),
    clone: (a, r) => Object.assign(r ?? {}, { x: a.x, y: a.y, z: a.z }),
    distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  },
  Math: { toDegrees: (x) => x },
};

/**
 * A scripted viewer. `script(frame, world)` runs inside every render and may
 * swap `world.globe.terrainProvider` or move `world.position`.
 */
function scriptedViewer(script) {
  const world = {
    frame: 0,
    placedAtFrame: null,
    position: { x: 0, y: 0, z: 2e7 },
    globe: { terrainProvider: undefined, tilesLoaded: true },
  };
  const camera = {
    get positionWC() {
      return world.position;
    },
    get positionCartographic() {
      return {
        longitude: world.position.x,
        latitude: world.position.y,
        height: world.position.z,
      };
    },
    setView({ destination }) {
      world.placedAtFrame = world.frame;
      world.position = { ...destination };
    },
  };
  const scene = {
    globe: world.globe,
    render() {
      world.frame++;
      script(world.frame, world);
    },
  };
  return { world, viewer: { scene, camera } };
}

function freshKit() {
  const win = {};
  globalThis.requestAnimationFrame = (cb) => setImmediate(cb);
  // The kit string assigns `window.__det`; hand it a window of its own.
  // eslint-disable-next-line no-new-func
  new Function("window", DET_BROWSER_SETUP)(win);
  return win.__det;
}

const RIG_CAMERA = {
  lon: -100.00093683,
  lat: 39.99801864,
  height: 20,
  heading: 0,
  pitch: -0.1047,
  roll: 0,
};

test("K1: the camera is placed only after a late terrain provider has held", async () => {
  const det = freshKit();
  const early = new EllipsoidTerrainProvider();
  const late = new CesiumTerrainProvider();
  const { world, viewer } = scriptedViewer((frame, w) => {
    if (frame === 3) {
      w.globe.terrainProvider = early;
    }
    if (frame === 9) {
      w.globe.terrainProvider = late;
    }
  });
  const placed = await det.placeCameraAfterTerrain(C, viewer, RIG_CAMERA, {
    stableFrames: 10,
    maxFrames: 200,
  });
  assert.equal(placed.terrainSettled, true);
  assert.ok(
    world.placedAtFrame >= 9 + 10,
    `placed at frame ${world.placedAtFrame}, before the late provider held`,
  );
  assert.equal(placed.terrainProvider, "CesiumTerrainProvider");
  assert.equal(placed.height, 20);
  assert.equal(placed.cameraSettled, true);
});

test("K2: a camera lifted after placement reads back lifted and is refused", async () => {
  const provider = new EllipsoidTerrainProvider();
  const det = freshKit();
  const { world, viewer } = scriptedViewer((frame, w) => {
    w.globe.terrainProvider = provider;
    // A collision-style lift: three frames after placement the camera rises
    // to 650 m over two frames, straight up.
    if (w.placedAtFrame !== null) {
      const since = frame - w.placedAtFrame;
      if (since === 3) {
        w.position = { ...w.position, z: 400 };
      }
      if (since === 4) {
        w.position = { ...w.position, z: 650 };
      }
    }
  });
  const placed = await det.placeCameraAfterTerrain(C, viewer, RIG_CAMERA, {
    stableFrames: 8,
    maxFrames: 200,
  });
  assert.equal(placed.cameraSettled, true);
  assert.equal(placed.height, 650);
  assert.equal(world.position.z, 650);
  const decision = decideCameraPlacement({
    declaredHeight: 20,
    placement: placed,
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "camera-height-mismatch");

  const det2 = freshKit();
  const still = scriptedViewer((frame, w) => {
    w.globe.terrainProvider = provider;
  });
  const steady = await det2.placeCameraAfterTerrain(
    C,
    still.viewer,
    RIG_CAMERA,
    { stableFrames: 8, maxFrames: 200 },
  );
  assert.equal(steady.height, 20);
  assert.equal(
    decideCameraPlacement({ declaredHeight: 20, placement: steady }).refuse,
    false,
  );
});

test("K3: a terrain provider replaced after placement is reported and refused", async () => {
  const det = freshKit();
  const first = new EllipsoidTerrainProvider();
  const second = new CesiumTerrainProvider();
  let swap = false;
  const { viewer } = scriptedViewer((frame, w) => {
    w.globe.terrainProvider = swap ? second : first;
  });
  const placed = await det.placeCameraAfterTerrain(C, viewer, RIG_CAMERA, {
    stableFrames: 5,
    maxFrames: 100,
  });
  const before = det.cameraPlacementNow(C, viewer);
  assert.equal(before.terrainHeld, true);
  swap = true;
  viewer.scene.render();
  const after = det.cameraPlacementNow(C, viewer);
  assert.equal(after.terrainHeld, false);
  assert.equal(after.terrainProvider, "CesiumTerrainProvider");
  const decision = decideCameraPlacement({
    declaredHeight: 20,
    placement: placed,
    final: after,
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "camera-terrain-changed");
  assert.equal(
    decideCameraPlacement({
      declaredHeight: 20,
      placement: placed,
      final: before,
    }).refuse,
    false,
  );
});

test("K4: terrain that never holds is reported unsettled and refused", async () => {
  const det = freshKit();
  const { viewer } = scriptedViewer((frame, w) => {
    w.globe.terrainProvider =
      frame % 2 === 0
        ? new EllipsoidTerrainProvider()
        : new CesiumTerrainProvider();
  });
  const placed = await det.placeCameraAfterTerrain(C, viewer, RIG_CAMERA, {
    stableFrames: 5,
    maxFrames: 40,
  });
  assert.equal(placed.terrainSettled, false);
  assert.equal(placed.terrainFrames, 40);
  const decision = decideCameraPlacement({
    declaredHeight: 20,
    placement: placed,
  });
  assert.equal(decision.reason, "camera-terrain-unsettled");
});

test("K5: view= heights are read from the page URL, and leg 1's are refused", () => {
  assert.equal(viewHeightFromUrl(LEG1_URLS[0]), 669.7937783290386);
  assert.equal(viewHeightFromUrl(LEG1_URLS[1]), 661.2223536740338);
  assert.equal(
    viewHeightFromUrl(
      "http://localhost:8092/Apps/CesiumViewer/index.html?offline=true",
    ),
    null,
  );
  assert.equal(viewHeightFromUrl("not a url"), null);
  assert.equal(viewHeightFromUrl("http://h/x?view=1,2,abc"), null);
  const placement = { terrainSettled: true, cameraSettled: true, height: 20 };
  for (const url of LEG1_URLS) {
    const decision = decideCameraPlacement({
      declaredHeight: 20,
      placement,
      recordedUrl: url,
    });
    assert.equal(decision.reason, "camera-height-mismatch", url);
    assert.equal(decision.details.where, "view");
  }
  const missing = decideCameraPlacement({
    declaredHeight: 20,
    placement,
    recordedUrl:
      "http://localhost:8092/Apps/CesiumViewer/index.html?offline=true",
  });
  assert.equal(missing.reason, "camera-view-unrecorded");
});

test("K6: the 1 m tolerance is closed and applies to every height read", () => {
  const ok = { terrainSettled: true, cameraSettled: true };
  const held = (height) => ({ terrainHeld: true, height });
  const url = (h) => `http://h/x?view=-100%2C40%2C${h}%2C0%2C-6%2C0`;
  const at = (height, extra = {}) =>
    decideCameraPlacement({
      declaredHeight: 20,
      placement: { ...ok, height },
      ...extra,
    });
  assert.equal(at(21).refuse, false);
  assert.equal(at(19).refuse, false);
  assert.equal(at(21.01).reason, "camera-height-mismatch");
  assert.equal(at(Number.NaN).reason, "camera-height-mismatch");
  const finalOff = at(20, { final: held(22) });
  assert.equal(finalOff.reason, "camera-height-mismatch");
  assert.equal(finalOff.details.where, "final");
  const viewOff = at(20, { final: held(20), recordedUrl: url(18.5) });
  assert.equal(viewOff.reason, "camera-height-mismatch");
  assert.equal(viewOff.details.where, "view");
  assert.equal(
    at(20, { final: held(20.5), recordedUrl: url(19.5) }).refuse,
    false,
  );
});
