// PARITY-VOXEL-SHAPE-PARITY acceptance probe.
// @purpose Acceptance: the WebGPU voxel box renders at the correct world placement/extent (footprint IoU + color structure vs WebGL), not a flat quad.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Captures the SAME VoxelBox3DTiles VoxelPrimitive on BOTH the WebGL and the
// WebGPU renderer at an IDENTICAL camera, then pixel-diffs the two frames.
//
// What it verifies (resolves the Batch-474 open blocker):
//   * The WebGPU ray-march renders the voxel BOX at the correct WORLD
//     position / orientation / extent — i.e. the same screen footprint as
//     WebGL — NOT a flat, mis-placed quad. This is the increment-2 fix: the
//     shape/OBB transform is now wired into the ray-march (via the effective
//     model matrix derived from the shape's oriented bounding box).
//   * The colour structure (which hues appear inside the footprint) matches
//     WebGL within a tolerance.
//   * Zero device / console errors on both backends.
//
// The two renderers are NOT pixel-identical: WebGL runs the full octree
// traversal + megatexture; the WebGPU path (Batch 474) uploads only the ROOT
// tile. So the acceptance criterion is *footprint + colour-structure overlap*,
// not an exact diff. IoU (intersection-over-union) of the non-black masks is
// the primary discriminator; a mis-placed flat quad would have near-zero IoU.
//
// Reads BOTH PNGs (writes them to output/) so the operator can eyeball the box
// shape/placement.
//
// ON THE KIT (probe-kit harvest, voxel family). Each scene is a rig: Part A is
// `rigs/voxel-box3dtiles-offaxis.mjs`, Part B's two views are
// `rigs/voxel-staircase-front.mjs` and `rigs/voxel-staircase-top.mjs`, and the
// camera, viewport and settle frames are read from them. Edge, the origin, the
// served-build preflight, the Edge slot, the deadline, the receipt and the
// exit code belong to `lib/probe-runtime.mjs`; the viewer page is opened by
// `lib/voxel-probe-page.mjs`; every frame is banked through
// `captureElement` on the widget canvas, decoded in Node, and measured by
// `lib/metrics/voxel-footprint.mjs` (Part A) and
// `lib/metrics/voxel-cell-fill.mjs` (Part B) — the same arithmetic the page
// used to run, pinned against it by their specs. The clauses and their bars
// are unchanged. Console errors are gated as before; the WebGPU error gate's
// device errors are published in the receipt but are not a clause, because
// the pre-migration probe never gated them.
//
// Run: `node server.js --port 8094 --serve-built`, then
//   node Tools/visual-regression/probe-voxel-parity.mjs [--port 8094]
import { decodePng } from "../lib/png-decode.mjs";
import { spread } from "./lib/determinism-kit.mjs";
import {
  PARITY_FILL_THRESHOLDS,
  judgeExpectedFill,
  windowMeanRgb,
} from "./lib/metrics/voxel-cell-fill.mjs";
import {
  VOXEL_FOOTPRINT_LUM_THRESHOLD,
  VOXEL_PARITY_REGION,
  colourL1,
  footprintGrid,
  fractionalRegion,
  maskIoU,
  regionColourStats,
} from "./lib/metrics/voxel-footprint.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  VOXEL_CANVAS_SELECTOR,
  openVoxelViewer,
  voxelPageErrors,
  voxelWorkBudgetMs,
} from "./lib/voxel-probe-page.mjs";
import BOX_RIG from "./rigs/voxel-box3dtiles-offaxis.mjs";
import FRONT_RIG from "./rigs/voxel-staircase-front.mjs";
import TOP_RIG from "./rigs/voxel-staircase-top.mjs";

/** Part B renders this many frames before its first view is set. */
const PART_B_WARMUP_FRAMES = 240;
/** Part B renders this many frames at each view before it is captured. */
const PART_B_VIEW_FRAMES = 40;

/**
 * Part A on one backend: the VoxelBox3DTiles box at the rig's camera, its
 * frame banked, and the footprint and colour statistics read from it.
 */
async function captureBox({
  browser,
  origin,
  renderer,
  outputDirectory,
  captures,
}) {
  const { page, diagnostics } = await openVoxelViewer({
    browser,
    origin,
    renderer,
    rig: BOX_RIG,
  });
  const info = await page.evaluate(
    async ({ camera, frames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      if (!C.VoxelPrimitive || !C.Cesium3DTilesVoxelProvider) {
        return { error: "VoxelPrimitive / provider not exported" };
      }

      // Strip everything that would differ between backends so the diff is
      // dominated by the voxel box itself.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
        "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
      );
      // Default modelMatrix (identity) — the provider's globalTransform places
      // the Earth-sized box. This is the same construction the Sandcastle demo
      // uses, so WebGL and WebGPU get identical placement inputs.
      const prim = new C.VoxelPrimitive({ provider });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // Identical fixed camera pose for both backends: the rig's ECEF pose,
      // whose direction is the normalised negated position (looking back at
      // the origin) with +Z up.
      v.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });

      // Render enough frames for the async voxel provider/traversal + the
      // WebGPU root-tile upload state machine to complete.
      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 16));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        // PARITY-VOXEL-COLOR-PARITY — confirm the COLOR pipeline was swapped to
        // the customShader-parity variant (the label carries the define) and
        // the drawn command is bound to it. `cmdPipelineIsColor === false`
        // would mean the command is still on the stale placeholder pipeline
        // (the raw-texel green path).
        colorDescName:
          cache && cache.colorDescriptor ? cache.colorDescriptor.name : null,
        cmdPipelineLabel:
          cache && cache.command && cache.command.pipeline
            ? cache.command.pipeline.label || "no-label"
            : null,
        cmdPipelineIsColor:
          cache && cache.command && cache.pipeline
            ? cache.command.pipeline === cache.pipeline
            : null,
        obb: prim.orientedBoundingBox
          ? {
              cx: prim.orientedBoundingBox.center.x,
              cy: prim.orientedBoundingBox.center.y,
              cz: prim.orientedBoundingBox.center.z,
            }
          : null,
      };
    },
    { camera: BOX_RIG.camera, frames: BOX_RIG.readiness.frames },
  );

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-parity-${renderer}`,
    outputDirectory,
    captures,
  });

  // The centred region the pre-migration probe chose to avoid the top toolbar
  // + right help panel (both are now stripped before any frame; see
  // lib/voxel-probe-page.mjs): a coarse 64x48 non-black mask for the IoU
  // against the other backend, and the average colour and coverage of the
  // region's non-black pixels.
  const frame = decodePng(shot.buffer);
  const region = fractionalRegion(frame, VOXEL_PARITY_REGION);
  const grid = footprintGrid(frame, region);
  const stats = regionColourStats(frame, region, {
    lumThreshold: VOXEL_FOOTPRINT_LUM_THRESHOLD,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return {
    info,
    capture: shot.name,
    px: {
      mask: Array.from(grid.mask),
      maskCells: grid.maskCells,
      distinctColors: grid.colourClasses,
      avgColor: stats.avgColor,
      coveragePct: stats.coveragePct,
    },
    ...errors,
    pngBytes: shot.byteLength,
  };
}

// ---------------------------------------------------------------------------
// Part B — VOXEL-SHAPEUV-CONVENTION per-cell sample-frame scenario.
//
// Renders a CUSTOM single-tile box provider (dims 2×4×3, metadataOrder Y_UP —
// the same glTF-order convention the 3D Tiles voxel asset uses) whose alpha
// fills an axis-ASYMMETRIC staircase of cells:
//   filled(x,y,z) = (x==1 && y==z && y<=2) || (x==0 && y==3 && z==1)
// in the Z-up shape frame. Any axis swap / flip / mis-scale in the WebGPU
// sample-coordinate derivation rearranges WHICH cells appear filled on screen,
// so asserting the per-cell fill layout against WebGL verifies the sampled-cell
// frame — not just the aggregate footprint.
//
// WebGL renders with a customShader exposing the per-cell property color +
// alpha (its megatexture path is the ground truth). The WebGPU path renders
// its default gray with alpha-gated density — the assertion is the per-cell
// FILL LAYOUT (which cell regions are lit), identical on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling the exact camera→target
// ray against the authored cell grid (no hand-derived visibility reasoning);
// rays that merely graze a filled cell (<2% of in-box samples) are skipped.
// ---------------------------------------------------------------------------

const CELL_DIMS = { x: 2, y: 4, z: 3 };

function cellFilled(x, y, z) {
  return (x === 1 && y === z && y <= 2) || (x === 0 && y === 3 && z === 1);
}

async function captureCells({
  browser,
  origin,
  renderer,
  outputDirectory,
  captures,
}) {
  // The staircase rigs are shared with the pick probes, which load the viewer
  // without `offline=true`; this part always loaded it WITH the flag, and it
  // still does, so its page is exactly the page its bars were set on.
  const { page, diagnostics } = await openVoxelViewer({
    browser,
    origin,
    renderer,
    rig: FRONT_RIG,
    query: { offline: "true" },
  });
  const setupInfo = await page.evaluate(
    async ({ dims, filledSrc, warmupFrames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const filled = new Function(`return (${filledSrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
      // Author the metadata in INPUT (glTF Y-up) order: a Z-up cell (x,y,z)
      // lands at input cell (x, z, dimsY-1-y), i.e. index
      // x + dimsX*(z + dimsZ*(dimsY-1-y)) — the inverse of Octree.glsl's
      // Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip.
      const voxelCount = dims.x * dims.y * dims.z;
      const data = new Float32Array(voxelCount * 4);
      for (let z = 0; z < dims.z; z++) {
        for (let y = 0; y < dims.y; y++) {
          for (let x = 0; x < dims.x; x++) {
            const idx = x + dims.x * (z + dims.z * (dims.y - 1 - y));
            const d = idx * 4;
            data[d] = 0.35 + 0.65 * x;
            data[d + 1] = 0.15 + 0.28 * y;
            data[d + 2] = 0.2 + 0.4 * z;
            data[d + 3] = filled(x, y, z) ? 1.0 : 0.0;
          }
        }
      }

      const provider = {
        shape: C.VoxelShapeType.BOX,
        minBounds: new C.Cartesian3(-1, -1, -1),
        maxBounds: new C.Cartesian3(1, 1, 1),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R)),
        availableLevels: 1,
        metadataOrder: C.VoxelMetadataOrder.Y_UP,
        requestData: function (options) {
          if (options.tileLevel >= 1) {
            return Promise.reject("single tile");
          }
          return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
        },
      };

      // WebGL ground truth: expose the per-cell property color + alpha. The
      // WebGPU path ignores the customShader (default gray, alpha-gated) —
      // the comparison below is the per-cell FILL LAYOUT.
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = fsInput.metadata.color.a;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      for (let i = 0; i < warmupFrames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      window.__voxelProbe = { C, scene, prim, R, dims, filled };
      return {
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        hasConvention: du ? !!du.convention : null,
        conventionYUp:
          du && du.convention ? du.convention.yUpBox === true : null,
      };
    },
    {
      dims: CELL_DIMS,
      filledSrc: cellFilled.toString(),
      warmupFrames: PART_B_WARMUP_FRAMES,
    },
  );

  // One view = set the rig's camera, render, capture, then project each cell
  // target to window coords and analytically ray-sample the expected fill.
  async function captureView(name, rig, targets) {
    const proj = await page.evaluate(
      async ({ camera, targets, viewFrames }) => {
        const { C, scene, R, dims, filled } = window.__voxelProbe;
        window.viewer.camera.setView({
          destination: new C.Cartesian3(...camera.position),
          orientation: {
            direction: new C.Cartesian3(...camera.direction),
            up: new C.Cartesian3(...camera.up),
          },
        });
        for (let i = 0; i < viewFrames; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 8));
        }
        const out = [];
        for (const t of targets) {
          const world = new C.Cartesian3(t.p[0] * R, t.p[1] * R, t.p[2] * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          // Analytic expectation: sample the camera→target ray uniformly
          // inside the box and record the fraction of in-box samples landing
          // in filled cells (Z-up frame).
          const cam = window.viewer.camera.positionWC;
          const o = [cam.x / R, cam.y / R, cam.z / R];
          const q = [t.p[0], t.p[1], t.p[2]];
          const dv = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
          const len = Math.hypot(dv[0], dv[1], dv[2]);
          const rd = [dv[0] / len, dv[1] / len, dv[2] / len];
          let inBox = 0;
          let inFilled = 0;
          const S = 4000;
          const tMax = len * 3;
          for (let i = 0; i < S; i++) {
            const tt = (i / S) * tMax;
            const px = o[0] + rd[0] * tt;
            const py = o[1] + rd[1] * tt;
            const pz = o[2] + rd[2] * tt;
            if (px < -1 || px > 1 || py < -1 || py > 1 || pz < -1 || pz > 1) {
              continue;
            }
            inBox++;
            const cx = Math.min(
              dims.x - 1,
              Math.floor(((px + 1) / 2) * dims.x),
            );
            const cy = Math.min(
              dims.y - 1,
              Math.floor(((py + 1) / 2) * dims.y),
            );
            const cz = Math.min(
              dims.z - 1,
              Math.floor(((pz + 1) / 2) * dims.z),
            );
            if (filled(cx, cy, cz)) {
              inFilled++;
            }
          }
          const frac = inBox > 0 ? inFilled / inBox : 0;
          out.push({
            label: t.label,
            win: win ? [win.x, win.y] : null,
            filledFrac: frac,
            expected: frac >= 0.02 ? "filled" : frac === 0 ? "empty" : "skip",
          });
        }
        return out;
      },
      { camera: rig.camera, targets, viewFrames: PART_B_VIEW_FRAMES },
    );

    const shot = await captureElement({
      page,
      selector: VOXEL_CANVAS_SELECTOR,
      name: `probe-voxel-cells-${renderer}-${name}`,
      outputDirectory,
      captures,
    });
    // The mean colour of a 7x7 window at each projected cell centre.
    const frame = decodePng(shot.buffer);
    return proj.map((p) => ({ ...p, rgb: windowMeanRgb(frame, p.win, 3) }));
  }

  const R1 = 1.0;
  const cy = (y) => -R1 + ((y + 0.5) * 2 * R1) / CELL_DIMS.y;
  const cz = (z) => -R1 + ((z + 0.5) * 2 * R1) / CELL_DIMS.z;
  const cx = (x) => -R1 + ((x + 0.5) * 2 * R1) / CELL_DIMS.x;

  // Front view (+X looking −X): the Y (horizontal) × Z (vertical) cell layout.
  const frontTargets = [];
  for (let z = 0; z < CELL_DIMS.z; z++) {
    for (let y = 0; y < CELL_DIMS.y; y++) {
      frontTargets.push({ label: `y${y}z${z}`, p: [0, cy(y), cz(z)] });
    }
  }
  const front = await captureView("front", FRONT_RIG, frontTargets);

  // Top view (+Z looking −Z): the X × Y cell layout (catches X mirroring the
  // front view cannot see).
  const topTargets = [];
  for (let y = 0; y < CELL_DIMS.y; y++) {
    for (let x = 0; x < CELL_DIMS.x; x++) {
      topTargets.push({ label: `x${x}y${y}`, p: [cx(x), cy(y), 0] });
    }
  }
  const top = await captureView("top", TOP_RIG, topTargets);

  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { setupInfo, front, top, ...errors };
}

/**
 * Part A and Part B clauses over one run's cell. The bars, the conjunction and
 * the reasoning behind each are the pre-migration probe's:
 *
 * PRIMARY gate (this task = shape/OBB placement parity): a correctly
 * shaped+placed WebGPU box overlaps the WebGL footprint heavily (high IoU) and
 * leaves a non-trivial amount of BLACK background (so the box is a bounded
 * silhouette, not a full-frame fill that would make IoU trivially 1.0). A flat
 * mis-placed quad (the pre-fix defect: a tiny [-0.5,0.5] cube at the ECEF
 * origin) would have near-zero footprint overlap with WebGL's Earth-sized box.
 *
 * PARITY-VOXEL-COLOR-PARITY — COLOR is a HARD gate. The WebGPU ray-march
 * applies the default voxel customShader colour mapping + WebGL-matching
 * front-to-back accumulation, so the mean colour of the voxel footprint must
 * match WebGL's within a tolerance (gray box on BOTH backends, not gray-vs-
 * green). Tolerance is generous — WebGL runs the full octree megatexture while
 * the WebGPU path uploads only the ROOT tile, so per-voxel sampling differs
 * slightly — but a raw-texel green/teal (the pre-fix defect, colorL1 ~433)
 * blows well past it while a matched gray sits comfortably under. The WebGPU
 * box must also be near-gray (r≈g≈b): the pre-fix defect was a strong green
 * cast (g >> r, b), which the max pairwise channel spread guards.
 *
 * Part B (VOXEL-SHAPEUV-CONVENTION) judges the per-cell fill layout on both
 * backends at both views, and requires the WebGPU data upload to have taken
 * the Y-up box sampling convention.
 *
 * Pure and exported so the routing spec can put a fixture on either side of
 * every bar without a browser.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateVoxelParity(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const { webgl, webgpu } = cell.partA;
    const suffix = `run${cell.run}`;
    const iou = maskIoU(webgl.px.mask, webgpu.px.mask).iou;
    const colorL1 = colourL1(webgl.px.avgColor, webgpu.px.avgColor);
    const webgpuChannelSpread = spread(webgpu.px.avgColor);
    const covGL = webgl.px.coveragePct;
    const covGPU = webgpu.px.coveragePct;
    verdicts.push(
      {
        id: `A/both-render/${suffix}`,
        claim: `both backends render (footprint cells ${webgl.px.maskCells} and ${webgpu.px.maskCells} > 200)`,
        pass: webgl.px.maskCells > 200 && webgpu.px.maskCells > 200,
        detail: { webgl: webgl.px.maskCells, webgpu: webgpu.px.maskCells },
      },
      {
        id: `A/bounded/${suffix}`,
        claim: `both 8% < coverage < 92%, the box is a silhouette not a fill (${covGL.toFixed(2)}%, ${covGPU.toFixed(2)}%)`,
        pass: covGL < 92 && covGPU < 92 && covGL > 8 && covGPU > 8,
        detail: { webgl: covGL, webgpu: covGPU },
      },
      {
        id: `A/footprint-match/${suffix}`,
        claim: `footprint IoU (WebGL ∩ WebGPU) ${iou.toFixed(3)} >= 0.85`,
        pass: iou >= 0.85,
        detail: { iou },
      },
      {
        id: `A/no-console-errors/${suffix}`,
        claim: `no console errors (${webgl.consoleErrors.length} WebGL, ${webgpu.consoleErrors.length} WebGPU)`,
        pass:
          webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0,
        detail: {
          webgl: webgl.consoleErrors.slice(0, 5),
          webgpu: webgpu.consoleErrors.slice(0, 5),
        },
      },
      {
        id: `A/colour-match/${suffix}`,
        claim: `avg-color L1 ${colorL1} <= ${COLOR_L1_TOLERANCE}`,
        pass: colorL1 <= COLOR_L1_TOLERANCE,
        detail: {
          colorL1,
          webgl: webgl.px.avgColor,
          webgpu: webgpu.px.avgColor,
        },
      },
      {
        id: `A/webgpu-neutral/${suffix}`,
        claim: `WebGPU channel spread ${webgpuChannelSpread} <= 40, not green-cast`,
        pass: webgpuChannelSpread <= 40,
        detail: { spread: webgpuChannelSpread },
      },
    );

    const b = cell.partB;
    const judged = {
      "webgl-front": judgeExpectedFill(b.webgl.front, PARITY_FILL_THRESHOLDS),
      "webgpu-front": judgeExpectedFill(b.webgpu.front, PARITY_FILL_THRESHOLDS),
      "webgl-top": judgeExpectedFill(b.webgl.top, PARITY_FILL_THRESHOLDS),
      "webgpu-top": judgeExpectedFill(b.webgpu.top, PARITY_FILL_THRESHOLDS),
    };
    for (const [view, result] of Object.entries(judged)) {
      verdicts.push({
        id: `B/${view}-cells/${suffix}`,
        claim: `${view} per-cell fill layout matches the analytic expectation`,
        pass: result.pass,
        detail: { rows: result.rows },
      });
    }
    const s = b.webgpu.setupInfo;
    verdicts.push(
      {
        id: `B/webgpu-convention-active/${suffix}`,
        claim:
          "WebGPU real data uploaded with the Y-up box sampling convention",
        pass:
          s.usingRealData === true &&
          s.hasConvention === true &&
          s.conventionYUp === true,
        detail: s,
      },
      {
        id: `B/no-console-errors/${suffix}`,
        claim: `no console errors in the cell scenario (${b.webgl.consoleErrors.length + b.webgpu.consoleErrors.length})`,
        pass:
          b.webgl.consoleErrors.length + b.webgpu.consoleErrors.length === 0,
        detail: {
          webgl: b.webgl.consoleErrors.slice(0, 3),
          webgpu: b.webgpu.consoleErrors.slice(0, 3),
        },
      },
    );
  }
  return verdicts;
}

/** The pre-migration probe's colour bar, named as it was. */
const COLOR_L1_TOLERANCE = 90;

/**
 * The console report: the same lines the pre-migration probe printed, then
 * each clause, then the verdict.
 *
 * @param {object} receipt The receipt fields.
 * @returns {void}
 */
function printReport(receipt) {
  for (const cell of receipt.cells) {
    const { webgl, webgpu } = cell.partA;
    console.log("WebGL  info:", JSON.stringify(webgl.info));
    console.log("WebGPU info:", JSON.stringify(webgpu.info));
    for (const [label, side] of [
      ["WebGL ", webgl],
      ["WebGPU", webgpu],
    ]) {
      console.log(
        `${label} px:`,
        JSON.stringify({
          maskCells: side.px.maskCells,
          distinctColors: side.px.distinctColors,
          avgColor: side.px.avgColor,
          coveragePct: side.px.coveragePct.toFixed(2),
        }),
      );
    }
    console.log(
      "WebGL  cells setup:",
      JSON.stringify(cell.partB.webgl.setupInfo),
    );
    console.log(
      "WebGPU cells setup:",
      JSON.stringify(cell.partB.webgpu.setupInfo),
    );
  }
  console.log("---");
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    if (verdict.detail?.rows) {
      console.log(`    ${verdict.detail.rows.join(" | ")}`);
    }
  }
  const pass = receipt.verdicts.every((verdict) => verdict.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL/PARTIAL");
}

/** Drop the footprint masks from the published cell; the IoU carries them. */
function publishedCell(cell) {
  const strip = (side) => ({ ...side, px: { ...side.px, mask: undefined } });
  return {
    ...cell,
    partA: { webgl: strip(cell.partA.webgl), webgpu: strip(cell.partA.webgpu) },
  };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-parity",
  title:
    "Voxel shape parity — footprint IoU + colour structure (Part A) and per-cell sample frame (Part B)",
  // Empty, so the banked frames keep their pre-migration paths directly under
  // `output/` (`probe-voxel-parity-<renderer>.png`,
  // `probe-voxel-cells-<renderer>-<view>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  // The viewer page imports the unminified bundle, and so does every in-page
  // setup; the default list's other bucket is never loaded here.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // Two pages per backend: Part A (open, rig settle, one capture) and Part B
  // (open, warm-up, two views of their own settle and one capture each).
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: 2 * options.renderers.length,
      frames:
        options.renderers.length *
        (BOX_RIG.readiness.frames +
          PART_B_WARMUP_FRAMES +
          2 * PART_B_VIEW_FRAMES),
      captures: 3 * options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (options.renderers.length !== 2) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-parity compares WebGL with WebGPU and cannot measure one backend alone; got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    const partA = {
      webgl: await captureBox({ ...legs, renderer: "webgl" }),
      webgpu: await captureBox({ ...legs, renderer: "webgpu" }),
    };
    const partB = {
      webgl: await captureCells({ ...legs, renderer: "webgl" }),
      webgpu: await captureCells({ ...legs, renderer: "webgpu" }),
    };
    return [{ run, partA, partB }];
  },
  verdicts(cells) {
    return evaluateVoxelParity(cells);
  },
  receipt(cells, context) {
    const receipt = {
      rigs: [BOX_RIG.id, FRONT_RIG.id, TOP_RIG.id],
      cells: cells.map(publishedCell),
      verdicts: context.verdicts,
    };
    if (cells.length > 0) {
      printReport({ cells, verdicts: context.verdicts });
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
