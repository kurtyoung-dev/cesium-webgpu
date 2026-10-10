// PARITY-VOXEL-MEGATEXTURE-UPLOAD acceptance probe.
// @purpose Acceptance: real tile data reaches the 3D megatexture; demand-driven descendant streaming; LRU eviction over a capacity-capped atlas.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Loads VoxelBox3DTiles on the WebGPU renderer, adds a VoxelPrimitive, and
// ray-marches the volume. Asserts that the REAL per-tile 'a' VEC4 property
// data was uploaded into the 3D megatexture (replacing the 4x4x4 gradient
// placeholder) AND that the volume renders non-empty pixels.
//
// Discriminators the probe checks:
//   1. cache.usingRealData === true and dataUpload.phase === 'done'
//      (the renderer swapped the placeholder for real tile content).
//   2. The uploaded texture dimensions match the tileset's [2,4,3] dims
//      (NOT the placeholder's 4x4x4).
//   3. The ray-march produces non-black pixels (the volume is visible).
//
// A FAIL/partial is reported honestly if only the placeholder still renders.
//
// PART 2 — NEW-VOXEL-STREAMING-UPLOAD (demand-driven descendant upload):
// loads the 3-level custom box provider (voxel-octree-l3 fixture, 73-slot
// atlas) on a fresh WebGPU page and asserts the streaming state machine:
//   FAR view (120R, SSE demand 0): root uploads, but NO descendant tiles do
//     (childSlots all -1, 0 l2 tiles, childPhase still "loading",
//     demandLevel 0) — the pre-B19 eager path would have uploaded all 72.
//   NEAR view (10R, SSE demand 2): level-1 + level-2 tiles STREAM IN on
//     demand (8 childSlots + 64 l2Slots uploaded, childPhase "done",
//     demandLevel 2, lastTargetLevel 2) and the refined volume renders.
//   RETURN-FAR view: demand recedes to 0 (targetLevel back to 0) but the
//     uploaded tiles stay RESIDENT (the full 73-slot atlas is UNDER capacity
//     — no eviction pressure) — the same steady state the eager path
//     converged to (off-gate; this is also the NEW-VOXEL-ATLAS-LRU-EVICT
//     off-gate: under-capacity scenes keep the exact static B19 behavior).
//
// PART 3 — NEW-VOXEL-ATLAS-LRU-EVICT (LRU slot eviction over a capacity-
// capped atlas): same 3-level provider, but the primitive opts into
// `_webgpuVoxelAtlasMaxSlots = 13` → 9 static root+L1 slots + a DYNAMIC
// 4-slot level-2 pool for the 64 level-2 tiles, plus `screenSpaceError = 100`
// so the per-tile SSE gate only demands tiles near the camera. The camera
// sits just OUTSIDE opposite box corners (±1.05R on the main diagonal,
// looking at the center — the corner fills the frame) so the demand mask
// selects disjoint corner-local tile sets (11 here, > the 4-slot pool):
//   CORNER A: demand > pool → exactly 4 tiles resident (no overflow), the
//     complete demanded set is protected before allocation/eviction.
//   CORNER B: A-residents fall out of demand → LRU-EVICTED (evictionCount
//     rises, slots 9..12 are reused by B tiles, pool never exceeds 4).
//   BOUNDED A/B RETURN SWEEP: an already-ready overflow wave may correctly
//     win the first return while the original A residents re-request. Alternate
//     corners until the exact A1 set reappears with newer request serials AND
//     slot generations; then its frame must pixel-match A1. Every leg replaces
//     exactly four disjoint residents, and failure to converge within the
//     fixture-derived bound is a hard red.
//
// ON THE KIT (probe-kit harvest, voxel family): each part's scene is a rig —
// PART 1 `rigs/voxel-box3dtiles-megatexture.mjs`, PART 2
// `rigs/voxel-octree-l3-streaming-near.mjs` (its far station is the camera of
// `rigs/voxel-octree-l3-far.mjs`), PART 3 `rigs/voxel-octree-l3-lru-corner-a.mjs`
// and `-corner-b.mjs`. Edge, origin, slot, deadline, receipt and exit code =
// `lib/probe-runtime.mjs`; viewer pages = `lib/voxel-probe-page.mjs`; the
// frames are banked through `captureElement` and read in Node by
// `lib/metrics/voxel-footprint.mjs` (region statistics, and the PART 3 A1/A2
// comparison through the kit's `diffImages`; that comparison answers NaN for
// two frames of different sizes, so the A1/A2 bar fails closed); the PART 3
// evidence policy is `lib/voxel-megatexture-reupload-gate.mjs`, unchanged.
// WebGPU only.
// Run: `node server.js --port 8094 --serve-built`, then this file.
import { decodePng } from "../lib/png-decode.mjs";
import { createVoxelOctreeL3Provider } from "./fixtures/voxel-octree-l3.mjs";
import {
  fractionalRegion,
  framePairRegionDifference,
  regionColourStats,
} from "./lib/metrics/voxel-footprint.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS,
  VOXEL_MEGATEXTURE_POOL_SLOTS,
  assessVoxelMegatextureReuploadEvidence,
  voxelMegatextureResidentSetWasRepublished,
} from "./lib/voxel-megatexture-reupload-gate.mjs";
import {
  VOXEL_CANVAS_SELECTOR,
  missingRenderers,
  openVoxelViewer,
  voxelPageErrors,
  voxelWorkBudgetMs,
} from "./lib/voxel-probe-page.mjs";
import MEGATEXTURE_RIG from "./rigs/voxel-box3dtiles-megatexture.mjs";
import CORNER_A_RIG from "./rigs/voxel-octree-l3-lru-corner-a.mjs";
import CORNER_B_RIG from "./rigs/voxel-octree-l3-lru-corner-b.mjs";
import FAR_RIG from "./rigs/voxel-octree-l3-far.mjs";
import STREAMING_RIG from "./rigs/voxel-octree-l3-streaming-near.mjs";

/**
 * PART 1 on WebGPU: the VoxelBox3DTiles box at the rig's camera, the uploaded
 * root tile's texture read from the renderer and the centre region's lit
 * pixels read from the banked frame.
 */
async function partOne({ browser, origin, outputDirectory, captures }) {
  const { page, diagnostics, echo } = await openVoxelViewer({
    browser,
    origin,
    renderer: "webgpu",
    rig: MEGATEXTURE_RIG,
    echoPrefix: "PROBE:",
  });

  const res = await page.evaluate(
    async ({ camera, frames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      if (!C.VoxelPrimitive || !C.Cesium3DTilesVoxelProvider) {
        return { error: "VoxelPrimitive / provider not exported" };
      }

      const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
        "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
      );
      const providerDims = {
        x: provider.dimensions.x,
        y: provider.dimensions.y,
        z: provider.dimensions.z,
      };
      // PARITY-VOXEL-SHAPE-PARITY (Batch 475) wired the shape/OBB transform into
      // the ray-march: the box is now placed by the provider's own compound
      // transform (an Earth-radius box at the origin for this asset), so the
      // historical 500 km modelMatrix hack + fromDegrees camera no longer frame
      // it. Use identity modelMatrix + the same fixed diagonal ECEF camera the
      // parity probe uses.
      const prim = new C.VoxelPrimitive({ provider });
      scene.primitives.add(prim);

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      // Aim the camera at the Earth-sized box from the rig's diagonal pose so
      // the box reads as a bounded silhouette.
      v.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });

      // Render many frames so the async root-tile request → glTF process → upload
      // state machine completes and the real-data bind group is swapped in.
      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 16));
      }

      // Inspect the WebGPU cache to confirm real data was uploaded.
      const cache = prim._webgpuCache || {};
      const du = cache.dataUpload || {};
      const upDims = du.texture
        ? {
            w: du.texture.width,
            h: du.texture.height,
            d: du.texture.depthOrArrayLayers,
          }
        : null;
      const upFormat = du.texture ? du.texture.format : null;
      const canvas = scene.canvas;

      return {
        providerDims,
        usingRealData: cache.usingRealData === true,
        uploadPhase: du.phase ?? null,
        uploadDims: upDims,
        uploadFormat: upFormat,
        canvasW: canvas.width,
        canvasH: canvas.height,
      };
    },
    {
      camera: MEGATEXTURE_RIG.camera,
      frames: MEGATEXTURE_RIG.readiness.frames,
    },
  );

  // The page's own `PROBE:` trace lines, printed once the setup returns (the
  // retired listener printed them as they arrived).
  for (const { text } of echo.console) {
    console.log(text);
  }
  console.log(JSON.stringify(res, null, 2));

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: "probe-voxel-megatexture",
    outputDirectory,
    captures,
  });
  // The centred region where the ray-marched cube sits (chosen before the
  // migration to avoid the top toolbar + right help panel, which are now
  // stripped before any frame), read from the banked frame.
  const frame = decodePng(shot.buffer);
  const px = regionColourStats(frame, fractionalRegion(frame, PART_1_REGION), {
    lumThreshold: 12,
    quantizeShift: 4,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { res, px, capture: shot.name, ...errors };
}

// ---------------------------------------------------------------------------
// PART 2 — NEW-VOXEL-STREAMING-UPLOAD: demand-driven descendant tile upload.
// ---------------------------------------------------------------------------
async function partTwo({ browser, origin, outputDirectory, captures }) {
  const { page: page2, diagnostics: diagnostics2 } = await openVoxelViewer({
    browser,
    origin,
    renderer: "webgpu",
    rig: STREAMING_RIG,
  });

  const stream = await page2.evaluate(
    async ({ providerFactorySrc, cameras }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const makeProvider = new Function(`return (${providerFactorySrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      scene.skyBox = undefined;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
      const provider = makeProvider(C, R);
      const prim = new C.VoxelPrimitive({ provider });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      const setCam = (pose) => {
        v.camera.setView({
          destination: new C.Cartesian3(...pose.position),
          orientation: {
            direction: new C.Cartesian3(...pose.direction),
            up: new C.Cartesian3(...pose.up),
          },
        });
      };
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
      };
      const snap = () => {
        const cache = prim._webgpuCache || {};
        const du = cache.dataUpload || {};
        return {
          usingRealData: cache.usingRealData === true,
          phase: du.phase ?? null,
          slotCount: du.slotCount ?? null,
          childPhase: du.childPhase ?? null,
          childUploaded: du.childSlots
            ? Array.from(du.childSlots).filter((s) => s >= 0).length
            : null,
          l2Uploaded: du.l2Slots
            ? Array.from(du.l2Slots).filter((s) => s >= 0).length
            : null,
          demandLevel: du.demandLevel ?? null,
          lastTargetLevel: du.lastTargetLevel ?? null,
        };
      };

      // FAR: root uploads; demand 0 → NO descendant tiles stream.
      setCam(cameras.far);
      await renderFrames(300);
      const far = snap();

      // NEAR: demand jumps to 2 → level-1 + level-2 tiles stream in. Poll
      // until fully streamed (bounded).
      setCam(cameras.near);
      let near;
      for (let iter = 0; iter < 40; iter++) {
        await renderFrames(15);
        near = snap();
        if (near.childPhase === "done" && near.l2Uploaded === 64) {
          break;
        }
      }
      // A few extra frames so lastTargetLevel reflects the fully-uploaded atlas.
      await renderFrames(30);
      near = snap();

      // RETURN-FAR: demand recedes; tiles stay resident (no eviction yet).
      setCam(cameras.far);
      await renderFrames(60);
      const returnFar = snap();

      // Back to near for the visible-pixels screenshot.
      setCam(cameras.near);
      await renderFrames(30);

      return { far, near, returnFar };
    },
    {
      providerFactorySrc: createVoxelOctreeL3Provider.toString(),
      cameras: { far: FAR_RIG.camera, near: STREAMING_RIG.camera },
    },
  );

  console.log("PART 2 streaming states:", JSON.stringify(stream, null, 2));

  const shot = await captureElement({
    page: page2,
    selector: VOXEL_CANVAS_SELECTOR,
    name: "probe-voxel-megatexture-streaming",
    outputDirectory,
    captures,
  });
  const frame = decodePng(shot.buffer);
  const px2 = regionColourStats(frame, fractionalRegion(frame, PART_2_REGION), {
    lumThreshold: 12,
  });
  const errors = await voxelPageErrors(page2, diagnostics2);
  await page2.close();
  return { stream, px2, capture: shot.name, ...errors };
}

// ---------------------------------------------------------------------------
// PART 3 — NEW-VOXEL-ATLAS-LRU-EVICT: LRU eviction on a capacity-capped pool.
// ---------------------------------------------------------------------------
async function partThree({ browser, origin, outputDirectory, captures }) {
  const { page: page3, diagnostics: diagnostics3 } = await openVoxelViewer({
    browser,
    origin,
    renderer: "webgpu",
    rig: CORNER_A_RIG,
  });

  // Step 1 — set up the capped primitive, camera inside corner A, stream in.
  const evictA1 = await page3.evaluate(
    async ({ providerFactorySrc, corners }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const makeProvider = new Function(`return (${providerFactorySrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      scene.skyBox = undefined;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
      const provider = makeProvider(C, R);
      const prim = new C.VoxelPrimitive({ provider });
      prim.nearestSampling = true;
      // NEW-VOXEL-ATLAS-LRU-EVICT opt-in: cap the atlas at 13 slots — 9 static
      // (root + 8 level-1) + a dynamic 4-slot LRU pool for the 64 level-2 tiles.
      prim._webgpuVoxelAtlasMaxSlots = 13;
      // Tighten the SSE target so the per-tile demand gate only passes tiles
      // within ~1.26R of the camera — the corner-local set (~7 of 64), giving
      // demand > pool with the camera OUTSIDE the volume (camera-inside proxy
      // rasterization is a separate known WebGPU gap).
      prim.screenSpaceError = 100;
      scene.primitives.add(prim);
      window.__evictProbe = { C, prim, R };

      // Just outside the ±(R,R,R) corner, looking at the box centre: the two
      // corner rigs' poses (direction toward the centre, up = right x dir with
      // right = dir x Z), derived there with Cesium's own arithmetic.
      window.__evictProbe.setCorner = (sign) => {
        const pose = sign > 0 ? corners.a : corners.b;
        v.camera.setView({
          destination: new C.Cartesian3(...pose.position),
          orientation: {
            direction: new C.Cartesian3(...pose.direction),
            up: new C.Cartesian3(...pose.up),
          },
        });
      };
      window.__evictProbe.renderFrames = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
      };
      window.__evictProbe.snap = () => {
        const du = (prim._webgpuCache || {}).dataUpload || {};
        const resident = [];
        const slotsUsed = [];
        const requestSerials = [];
        const slotGenerations = [];
        if (du.l2Slots) {
          for (let i = 0; i < 64; i++) {
            if (du.l2Slots[i] >= 0) {
              resident.push(i);
              slotsUsed.push(du.l2Slots[i]);
              requestSerials.push(du.l2States?.[i]?.requestSerial ?? null);
              slotGenerations.push(du.l2States?.[i]?.slotGeneration ?? null);
            }
          }
        }
        return {
          usingRealData: (prim._webgpuCache || {}).usingRealData === true,
          slotCount: du.slotCount ?? null,
          l2Dynamic: du.l2Dynamic === true,
          l2PoolSize: du.l2PoolSize ?? null,
          childPhase: du.childPhase ?? null,
          childUploaded: du.childSlots
            ? Array.from(du.childSlots).filter((s) => s >= 0).length
            : null,
          resident,
          slotsUsed,
          requestSerials,
          slotGenerations,
          evictionCount: du.evictionCount ?? null,
          demandCount: du.lastL2DemandCount ?? null,
          demandLevel: du.demandLevel ?? null,
          lastTargetLevel: du.lastTargetLevel ?? null,
        };
      };

      const P = window.__evictProbe;
      P.setCorner(1);
      let s;
      let maxResident = 0;
      for (let iter = 0; iter < 60; iter++) {
        await P.renderFrames(15);
        s = P.snap();
        maxResident = Math.max(maxResident, s.resident.length);
        if (s.resident.length >= s.l2PoolSize && s.childUploaded === 8) break;
      }
      // Extra settle frames — resident set must be STABLE at the pool size.
      await P.renderFrames(30);
      s = P.snap();
      maxResident = Math.max(maxResident, s.resident.length);
      return { ...s, maxResident };
    },
    {
      providerFactorySrc: createVoxelOctreeL3Provider.toString(),
      corners: { a: CORNER_A_RIG.camera, b: CORNER_B_RIG.camera },
    },
  );
  console.log("PART 3 corner A (first visit):", JSON.stringify(evictA1));
  const shotA1 = await captureElement({
    page: page3,
    selector: VOXEL_CANVAS_SELECTOR,
    name: "probe-voxel-evict-cornerA1",
    outputDirectory,
    captures,
  });

  // Step 2 — camera to the OPPOSITE corner: A residents leave demand → evicted.
  const evictB = await page3.evaluate(async () => {
    const P = window.__evictProbe;
    P.setCorner(-1);
    let s;
    let maxResident = 0;
    for (let iter = 0; iter < 60; iter++) {
      await P.renderFrames(15);
      s = P.snap();
      maxResident = Math.max(maxResident, s.resident.length);
      if (s.evictionCount >= 4 && s.resident.length >= s.l2PoolSize) break;
    }
    await P.renderFrames(15);
    s = P.snap();
    maxResident = Math.max(maxResident, s.resident.length);
    return { ...s, maxResident };
  });
  console.log("PART 3 corner B (eviction):", JSON.stringify(evictB));

  // Step 3 — alternate back through A/B until the exact first-A tiles have
  // re-requested and REPUBLISHED into newer atlas-slot generations. Demand is
  // deliberately greater than capacity (11 tiles competing for 4 slots), so a
  // one-return equality assertion is a stale scheduling oracle: the first A
  // return may correctly publish an already-ready overflow wave while the four
  // evicted A1 requests resolve. The bound is fail-closed and larger than the
  // fixture's ceil(demand/pool) wave count.
  const returnSweep = await page3.evaluate(
    async ({ firstA, firstB, maxAttempts, republishedSource }) => {
      const P = window.__evictProbe;
      // eslint-disable-next-line no-new-func
      const wasRepublished = new Function(`return (${republishedSource});`)();
      const attempts = [];
      let previous = firstB;

      const renderLeg = async (sign, expectedEvictionCount, settleFrames) => {
        P.setCorner(sign);
        let s;
        let maxResident = 0;
        for (let iter = 0; iter < 60; iter++) {
          await P.renderFrames(15);
          s = P.snap();
          maxResident = Math.max(maxResident, s.resident.length);
          if (
            s.evictionCount >= expectedEvictionCount &&
            s.resident.length >= s.l2PoolSize
          ) {
            break;
          }
        }
        await P.renderFrames(settleFrames);
        s = P.snap();
        maxResident = Math.max(maxResident, s.resident.length);
        return { ...s, maxResident };
      };

      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
        const a = await renderLeg(
          1,
          previous.evictionCount + firstA.l2PoolSize,
          30,
        );
        const attempt = { a, b: null };
        attempts.push(attempt);
        if (wasRepublished(firstA, a)) {
          return { converged: true, attempts, finalA: a };
        }
        if (attemptIndex === maxAttempts - 1) {
          break;
        }
        attempt.b = await renderLeg(
          -1,
          a.evictionCount + firstA.l2PoolSize,
          15,
        );
        previous = attempt.b;
      }
      return {
        converged: false,
        attempts,
        finalA: attempts.at(-1)?.a ?? null,
      };
    },
    {
      firstA: evictA1,
      firstB: evictB,
      maxAttempts: VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS,
      republishedSource: voxelMegatextureResidentSetWasRepublished.toString(),
    },
  );
  console.log("PART 3 corner return sweep:", JSON.stringify(returnSweep));
  console.log(
    "PART 3 corner A (republished return):",
    JSON.stringify(returnSweep.finalA),
  );
  const shotA2 = await captureElement({
    page: page3,
    selector: VOXEL_CANVAS_SELECTOR,
    name: "probe-voxel-evict-cornerA2",
    outputDirectory,
    captures,
  });

  // Pixel-compare the two corner-A frames: identical camera + the exact
  // first-A tiles at newer publication generations (possibly in different slots
  // — slot indirection makes that invisible) must reproduce the original frame.
  const diffA = framePairRegionDifference(
    decodePng(shotA1.buffer),
    decodePng(shotA2.buffer),
    CORNER_PAIR_REGION,
    { tolerance: 8, lumThreshold: 12 },
  );
  console.log("PART 3 A1-vs-A2 pixel diff:", JSON.stringify(diffA));

  const errors = await voxelPageErrors(page3, diagnostics3);
  await page3.close();
  return { evictA1, evictB, returnSweep, diffA, ...errors };
}

// Regions of the banked frames, as the pre-migration probe cropped them.
const PART_1_REGION = Object.freeze({ x: 0.28, y: 0.28, w: 0.4, h: 0.4 });
const PART_2_REGION = Object.freeze({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
const CORNER_PAIR_REGION = Object.freeze({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 });

/**
 * The three parts' clauses over one run's cell.
 *
 * PART 1: the uploaded texture is the REAL tile (real-data flag, phase done,
 * and dimensions in the INPUT orientation — VOXEL-SHAPEUV-CONVENTION: the
 * metadata array's own layout, glTF Y-up for this 3D Tiles box asset, so
 * provider dims [2,4,3] upload as [2,3,4], still a hard discriminator against
 * the 4x4x4 placeholder), the ray-march produced visible pixels, and no
 * console errors.
 *
 * PART 2: FAR — root uploaded (real data bound) but zero descendants streamed
 * (the demand-driven discriminator against the pre-B19 eager upload); NEAR —
 * full stream-in under demand; RETURN-FAR — demand recedes, tiles stay
 * resident (no eviction); the near view renders; no console errors.
 *
 * PART 3: the capped atlas engaged (13 slots, dynamic 4-slot L2 pool); corner
 * A demand exceeds the pool and the pool fills exactly; corner B LRU-evicts
 * the stale A tiles and reuses their slots; the exact first-A tiles are
 * re-requested and republished; and the shared evidence assessor
 * (`assessVoxelMegatextureReuploadEvidence`: exact four-slot replacement on
 * every leg, full-pool uniqueness, the bounded stop, the A1/A2 pixels and a
 * clean console) holds.
 *
 * Pure and exported for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateMegatexture(cells) {
  const verdicts = [];
  for (const { run, one, two, three } of cells) {
    const sfx = `run${run}`;
    const add = (id, claim, pass, detail) =>
      verdicts.push({ id: `${id}/${sfx}`, claim, pass: pass === true, detail });

    const res = one.res;
    add(
      "part1/real-tile-uploaded",
      "PART 1: real data, phase done, texture dims = provider dims in input orientation",
      !res.error &&
        res.usingRealData === true &&
        res.uploadPhase === "done" &&
        Boolean(res.uploadDims) &&
        res.uploadDims.w === res.providerDims?.x &&
        res.uploadDims.h === res.providerDims?.z &&
        res.uploadDims.d === res.providerDims?.y,
      {
        error: res.error ?? null,
        providerDims: res.providerDims ?? null,
        uploadDims: res.uploadDims ?? null,
      },
    );
    add(
      "part1/visible",
      `PART 1: the ray-march is visible (${one.px.nonBlack} lit pixels > 500)`,
      one.px.nonBlack > 500,
    );
    add(
      "part1/no-console-errors",
      `PART 1: no console errors (${one.consoleErrors.length})`,
      one.consoleErrors.length === 0,
      { errors: one.consoleErrors.slice(0, 8) },
    );

    const { far, near, returnFar } = two.stream;
    add(
      "part2/far-root-only",
      "PART 2 farRootOnly (demand 0 → no descendant upload)",
      far.usingRealData === true &&
        far.phase === "done" &&
        far.slotCount === 73 &&
        far.childPhase === "loading" &&
        far.childUploaded === 0 &&
        far.l2Uploaded === 0 &&
        far.demandLevel === 0 &&
        far.lastTargetLevel === 0,
      far,
    );
    add(
      "part2/near-streamed",
      "PART 2 nearStreamed (demand 2 → 8+64 tiles stream in)",
      near.childPhase === "done" &&
        near.childUploaded === 8 &&
        near.l2Uploaded === 64 &&
        near.demandLevel === 2 &&
        near.lastTargetLevel === 2,
      near,
    );
    add(
      "part2/resident-after-recede",
      "PART 2 residentAfterRecede (no eviction, targetLevel back to 0)",
      returnFar.demandLevel === 0 &&
        returnFar.lastTargetLevel === 0 &&
        returnFar.childUploaded === 8 &&
        returnFar.l2Uploaded === 64,
      returnFar,
    );
    add(
      "part2/near-visible",
      `PART 2: the near view renders (${two.px2.nonBlack} lit pixels > 500)`,
      two.px2.nonBlack > 500,
    );
    add(
      "part2/no-console-errors",
      `PART 2: no console errors (${two.consoleErrors.length})`,
      two.consoleErrors.length === 0,
      { errors: two.consoleErrors.slice(0, 8) },
    );

    const { evictA1, evictB, returnSweep, diffA } = three;
    const slotsInPool = (s) =>
      s.slotsUsed.every((x) => VOXEL_MEGATEXTURE_POOL_SLOTS.includes(x));
    add(
      "part3/capped-atlas",
      "PART 3 cappedAtlas (13 slots, dynamic 4-slot L2 pool)",
      evictA1.usingRealData === true &&
        evictA1.slotCount === 13 &&
        evictA1.l2Dynamic === true &&
        evictA1.l2PoolSize === 4,
    );
    // Corner A: demand exceeds the pool, pool fills exactly (no overflow), all
    // 8 static L1 slots also uploaded.
    add(
      "part3/over-demand-no-overflow",
      "PART 3 overDemandNoOverflow (demand > pool, exactly 4 resident)",
      evictA1.demandCount > 4 &&
        evictA1.resident.length === 4 &&
        evictA1.maxResident <= 4 &&
        evictA1.childUploaded === 8 &&
        evictA1.demandLevel === 2 &&
        slotsInPool(evictA1),
      evictA1,
    );
    // Corner B: LRU evicted the stale A tiles and REUSED their slots.
    add(
      "part3/evicted",
      "PART 3 evicted (LRU eviction + slot reuse at corner B)",
      evictB.evictionCount >= 4 &&
        evictB.resident.length === 4 &&
        evictB.maxResident <= 4 &&
        JSON.stringify(evictB.resident) !== JSON.stringify(evictA1.resident) &&
        slotsInPool(evictB),
      evictB,
    );
    // Return to A: the exact first-A tiles re-requested and REPUBLISHED into
    // newer slot generations.
    add(
      "part3/reuploaded",
      "PART 3 reuploaded (exact A set re-requested + republished after eviction)",
      voxelMegatextureResidentSetWasRepublished(evictA1, returnSweep.finalA),
      { finalA: returnSweep.finalA, converged: returnSweep.converged },
    );
    const reuploadAssessment = assessVoxelMegatextureReuploadEvidence({
      firstA: evictA1,
      firstB: evictB,
      returnAttempts: returnSweep.attempts,
      pixelDiff: diffA,
      consoleErrorCount: three.consoleErrors.length,
    });
    add(
      "part3/reupload-evidence",
      "PART 3 reupload evidence (exact replacement, bounded stop, A1/A2 pixels, clean console)",
      reuploadAssessment.pass,
      {
        failures: reuploadAssessment.failures,
        // Republished tiles render the SAME frame as the original visit.
        // An incomparable pair (`comparable: false`, NaN counts) is no match.
        pixelsMatch:
          diffA.comparable === true &&
          diffA.nonBlackA > 500 &&
          diffA.mismatchPct < 1.5,
        diffA,
      },
    );
  }
  return verdicts;
}

function printReport(receipt) {
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    for (const failure of verdict.detail?.failures ?? []) {
      console.log(`    ${failure}`);
    }
  }
  const pass = receipt.verdicts.every((verdict) => verdict.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");
}

/**
 * Frames each part may render at its in-page loop bounds: PART 1 the rig's
 * settle; PART 2 300 far, up to 40 x 15 + 30 near, 60 return-far and 30 near;
 * PART 3 up to 60 x 15 + 30 at corner A, 60 x 15 + 15 at corner B, and each
 * return attempt one A leg and one B leg of the same bounds.
 */
const PART_FRAMES =
  MEGATEXTURE_RIG.readiness.frames +
  (300 + 40 * 15 + 30 + 60 + 30) +
  (60 * 15 + 30) +
  (60 * 15 + 15) +
  VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS * (60 * 15 + 30 + 60 * 15 + 15);

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-megatexture",
  title:
    "Voxel megatexture: real root-tile upload, demand-driven streaming, LRU eviction (WebGPU)",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-megatexture.png`, `-streaming.png`,
  // `probe-voxel-evict-cornerA1.png`, `-cornerA2.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () =>
    voxelWorkBudgetMs({ pages: 3, frames: PART_FRAMES, captures: 4 }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (missingRenderers(options.renderers, ["webgpu"]).length > 0) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        `probe-voxel-megatexture measures the WebGPU megatexture only; got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    return [
      {
        run,
        one: await partOne(legs),
        two: await partTwo(legs),
        three: await partThree(legs),
      },
    ];
  },
  verdicts(cells) {
    return evaluateMegatexture(cells);
  },
  receipt(cells, context) {
    if (cells.length > 0) {
      printReport({ cells, verdicts: context.verdicts });
    }
    return {
      rigs: [
        MEGATEXTURE_RIG.id,
        STREAMING_RIG.id,
        FAR_RIG.id,
        CORNER_A_RIG.id,
        CORNER_B_RIG.id,
      ],
      cells,
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
