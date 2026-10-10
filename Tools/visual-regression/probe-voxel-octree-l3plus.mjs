// NEW-VOXEL-OCTREE-DEEP-LEVELS acceptance probe — octree traversal to LEVEL 3.
// @purpose Acceptance: WebGPU voxel octree traversal reaches level 3 (585-slot atlas, 4-level fixture) with per-ray in-page discriminators at three views.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Scenario: a CUSTOM FOUR-level box voxel provider (availableLevels = 4, 2x2x2
// cells per tile, metadataOrder Y_UP) from
// Tools/visual-regression/fixtures/voxel-octree-l4.mjs. The finest (level-3,
// combined 16x16x16) truth is the THIN diagonal y16 == z16 extruded along x;
// every coarser level is the honest conservative downsample (self-similar
// y == z at that level's own resolution). Small tiles keep the full 585-slot
// depth-3 atlas (root + 8 L1 + 64 L2 + 512 L3) within maxTextureDimension3D.
//
// Discriminator families fall out per adjacent-level pair (empty at the finer
// grid, filled at the coarser grid):
//   L2 disc: filled@4 (L1), empty@8 (L2)  — black once traversal reaches >= 2.
//   L3 disc: filled@8 (L2), empty@16 (L3) — black ONLY once traversal reaches
//     depth 3 (the capability this probe accepts). At HEAD (depth cap 2) the
//     WebGPU march would read these FILLED (spurious).
//
// Views + gates:
//   CLOSE view (6R — the SSE ladder refines to level 3 on WebGPU):
//     * WebGPU must match the LEVEL-3 grid with >= 4 L3 discriminators black;
//       internals slotCount = 585, 8 childSlots + 64 l2Slots + 512 l3Slots
//       uploaded, lastTargetLevel = 3.
//     * WebGL: upstream traversal refines PER-NODE here (mixed L2/L3 across the
//       volume is legitimate) — each cell must merely be consistent with
//       level 2 OR level 3; the strict WebGL gate lives at CLOSE2.
//   CLOSE2 view (3.5R — deep enough that upstream WebGL refines the center to
//     level 3):
//     * WebGL must match the LEVEL-3 grid with >= 4 L3 discriminators black —
//       proves the asset + discriminators actually discriminate.
//     * WebGPU must match LEVEL-3 with all L3 discriminators black — the
//       standing acceptance gate.
//   FAR view (700R — root SSE < screenSpaceError):
//     * WebGPU lastTargetLevel = 0 and the WebGL/WebGPU center-crop mean diff
//       stays small.
//   0 console errors on both backends.
//
// Expectations are derived per-ray IN-PAGE by sampling camera pick rays against
// the authored 16/8/4/2 grids (no hand-derived visibility reasoning) with a
// 5-ray CONE per target (center + four window corners) — a cell is only judged
// BLACK when the whole cone stays in empty space. READ the output PNGs in
// Tools/visual-regression/output/.
//
// ON THE KIT (probe-kit harvest, voxel family): the three views are rigs
// (`rigs/voxel-octree-l4-close.mjs`, `-close2.mjs`, `-far.mjs`), the close rig's
// settle being the warm-up; Edge, origin, slot, deadline, receipt and exit code
// = `lib/probe-runtime.mjs`; viewer page = `lib/voxel-probe-page.mjs`; each
// view's frame is banked through `captureElement` and read in Node — the
// per-cell window median and the fill judgement by
// `lib/metrics/voxel-cell-fill.mjs`, the far-view crop difference by
// `lib/metrics/voxel-footprint.mjs`. The in-page ray expectations and every bar
// are unchanged.
// Run: `node server.js --port 8094 --serve-built`, then
//   node Tools/visual-regression/probe-voxel-octree-l3plus.mjs [--port 8094]
import { decodePng } from "../lib/png-decode.mjs";
import { createVoxelOctreeL4Provider } from "./fixtures/voxel-octree-l4.mjs";
import {
  judgeEitherLevelFill,
  judgeLevelFill,
  windowMedianRgb,
} from "./lib/metrics/voxel-cell-fill.mjs";
import { cropMeanAbsDifference } from "./lib/metrics/voxel-footprint.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  VOXEL_CANVAS_SELECTOR,
  missingRenderers,
  openVoxelViewer,
  voxelPageErrors,
  voxelWorkBudgetMs,
} from "./lib/voxel-probe-page.mjs";
import CLOSE_RIG from "./rigs/voxel-octree-l4-close.mjs";
import CLOSE2_RIG from "./rigs/voxel-octree-l4-close2.mjs";
import FAR_RIG from "./rigs/voxel-octree-l4-far.mjs";

/** Frames rendered at each view before its capture. */
const VIEW_FRAMES = 120;

// Combined per-axis resolutions: level 0 = 2, 1 = 4, 2 = 8, 3 = 16.
const FINEST = 16;

async function captureViews({
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
    rig: CLOSE_RIG,
  });

  await page.evaluate(
    async ({ providerFactorySrc, camera, frames }) => {
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

      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = vec3(0.7);
    material.alpha = fsInput.metadata.color.a;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // CLOSE view during warm-up so the SSE test streams descendants in.
      window.viewer.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });
      // 512 level-3 tiles stream in over many frames — warm generously.
      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }
      window.__voxelProbe = { C, scene, prim, R };
    },
    {
      providerFactorySrc: createVoxelOctreeL4Provider.toString(),
      camera: CLOSE_RIG.camera,
      frames: CLOSE_RIG.readiness.frames,
    },
  );

  async function measureView(name, rig, judgeTargets = true) {
    const proj = await page.evaluate(
      async ({ camera, finest, judgeTargets, viewFrames }) => {
        const { C, scene, prim, R } = window.__voxelProbe;
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
        const du0 = prim._webgpuCache ? prim._webgpuCache.dataUpload : null;
        const internals = du0
          ? {
              usingRealData:
                prim._webgpuCache.usingRealData === true ? true : false,
              slotCount: du0.slotCount,
              childPhase: du0.childPhase,
              childSlots: du0.childSlots ? Array.from(du0.childSlots) : null,
              l2Uploaded: du0.l2Slots
                ? Array.from(du0.l2Slots).filter((x) => x >= 0).length
                : null,
              l3Uploaded: du0.l3Slots
                ? Array.from(du0.l3Slots).filter((x) => x >= 0).length
                : null,
              lastTargetLevel: du0.lastTargetLevel,
            }
          : null;
        if (!judgeTargets) {
          return {
            targets: [],
            half: 1,
            lastTargetLevel: du0 ? du0.lastTargetLevel : null,
            internals,
          };
        }

        // Self-similar fill truth: y === z per level.
        const filledAt = (n, x, y, z) => y === z;
        const cc = (i) => -1 + ((i + 0.5) * 2) / finest;
        const targets = [];
        for (let fz = 0; fz < finest; fz++) {
          for (let fy = 0; fy < finest; fy++) {
            targets.push({ label: `y${fy}z${fz}`, p: [0, cc(fy), cc(fz)] });
          }
        }

        const pa = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, cc(7) * R, cc(7) * R),
        );
        const pb = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, cc(8) * R, cc(8) * R),
        );
        const cellPx =
          pa && pb ? Math.hypot(pb.x - pa.x, pb.y - pa.y) / Math.SQRT2 : 8;
        const half = Math.max(1, Math.min(3, Math.floor(cellPx / 4)));

        const scratchWin = new C.Cartesian2();
        function rayHits(wx, wy) {
          scratchWin.x = wx;
          scratchWin.y = wy;
          const ray = window.viewer.camera.getPickRay(scratchWin);
          if (!ray) return null;
          const o = [ray.origin.x / R, ray.origin.y / R, ray.origin.z / R];
          const rd = [ray.direction.x, ray.direction.y, ray.direction.z];
          const len = Math.hypot(o[0], o[1], o[2]);
          const t0 = Math.max(0, len - 2);
          const t1 = len + 2;
          const S = 2500;
          let inBox = 0;
          const inGrid = [0, 0, 0, 0]; // levels 0 (2), 1 (4), 2 (8), 3 (16)
          for (let i = 0; i < S; i++) {
            const tt = t0 + ((t1 - t0) * i) / S;
            const px = o[0] + rd[0] * tt;
            const py = o[1] + rd[1] * tt;
            const pz = o[2] + rd[2] * tt;
            if (px < -1 || px > 1 || py < -1 || py > 1 || pz < -1 || pz > 1) {
              continue;
            }
            inBox++;
            for (let lvl = 0; lvl < 4; lvl++) {
              const n = 2 << lvl;
              const q = (val) =>
                Math.min(n - 1, Math.floor(((val + 1) / 2) * n));
              if (filledAt(n, q(px), q(py), q(pz))) inGrid[lvl]++;
            }
          }
          return { frac: inGrid.map((c) => (inBox > 0 ? c / inBox : 0)) };
        }

        const out = [];
        const d = half + 1;
        for (const t of targets) {
          const world = new C.Cartesian3(t.p[0] * R, t.p[1] * R, t.p[2] * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          if (!win) {
            out.push({
              label: t.label,
              win: null,
              frac: [0, 0, 0, 0],
              coneAny: [true, true, true, true],
              discL2: false,
              discL3: false,
            });
            continue;
          }
          const center = rayHits(win.x, win.y);
          const corners = [
            rayHits(win.x - d, win.y - d),
            rayHits(win.x + d, win.y - d),
            rayHits(win.x - d, win.y + d),
            rayHits(win.x + d, win.y + d),
          ];
          const rays = [center, ...corners].filter((r) => r !== null);
          const frac = center ? center.frac : [0, 0, 0, 0];
          const coneAny = [0, 1, 2, 3].map((lvl) =>
            rays.some((r) => r.frac[lvl] > 0),
          );
          out.push({
            label: t.label,
            win: [win.x, win.y],
            frac, // [l0Frac, l1Frac, l2Frac, l3Frac]
            coneAny,
            // L2 discriminator: cone empty in the 8-grid, center filled@4.
            discL2: !coneAny[2] && frac[1] >= 0.05,
            // L3 discriminator: cone empty in the 16-grid, center filled@8.
            discL3: !coneAny[3] && frac[2] >= 0.05,
          });
        }

        return {
          targets: out,
          half,
          lastTargetLevel: internals?.lastTargetLevel,
          internals,
        };
      },
      {
        camera: rig.camera,
        finest: FINEST,
        judgeTargets,
        viewFrames: VIEW_FRAMES,
      },
    );

    const shot = await captureElement({
      page,
      selector: VOXEL_CANVAS_SELECTOR,
      name: `probe-voxel-octree-l3plus-${renderer}-${name}`,
      outputDirectory,
      captures,
    });
    // MEDIAN pixel by luminance of each cell's window — robust against 1-3 px
    // star dots / faint UI specks inside the window (a mean is not).
    const frame = decodePng(shot.buffer);
    return {
      cells: proj.targets.map((p) => ({
        ...p,
        rgb: windowMedianRgb(frame, p.win, proj.half),
      })),
      internals: proj.internals,
      lastTargetLevel: proj.lastTargetLevel,
      frame,
    };
  }

  const close = await measureView("close", CLOSE_RIG);
  const close2 = await measureView("close2", CLOSE2_RIG);
  const far = await measureView("far", FAR_RIG, false);

  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { close, close2, far, ...errors };
}

/**
 * The clauses over one run's pair of three views. The fill arithmetic is
 * `lib/metrics/voxel-cell-fill.mjs` (FILLED when the centre ray passes at
 * least 15 % of its in-box path through the level's filled cells, EMPTY only
 * when the whole five-ray cone misses them, SKIP otherwise; filled reads
 * r+g+b > 60, empty r+g+b < 40), and the discriminator families are the
 * probe's own:
 *
 *   - CLOSE (6R): WebGPU matches level 3 with >= 4 L3 discriminators, all
 *     black; WebGL may refine per node, so each cell need only be consistent
 *     with level 2 OR level 3.
 *   - CLOSE2 (3.5R): WebGL must match level 3 with >= 4 L3 discriminators all
 *     black (proves the asset and discriminators discriminate), and WebGPU
 *     must match level 3 with all of them black (the standing gate).
 *   - WebGPU internals: the 585-slot atlas fully engaged (8 L1 + 64 L2 + 512 L3
 *     tiles uploaded), target level 3 at both close views and 0 far.
 *   - FAR: the centre-crop mean absolute channel difference < 6.
 *   - No console errors on either backend.
 *
 * Pure and exported for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateOctree(cells) {
  const verdicts = [];
  for (const { run, webgl, webgpu, farDiff } of cells) {
    const sfx = `run${run}`;
    const add = (id, claim, pass, detail) =>
      verdicts.push({ id: `${id}/${sfx}`, claim, pass: pass === true, detail });
    const gpClose = judgeLevelFill(webgpu.close.cells, {
      level: 3,
      discriminator: "discL3",
    });
    const glClose = judgeEitherLevelFill(webgl.close.cells, {
      levels: [2, 3],
    });
    const glClose2 = judgeLevelFill(webgl.close2.cells, {
      level: 3,
      discriminator: "discL3",
    });
    const gpClose2 = judgeLevelFill(webgpu.close2.cells, {
      level: 3,
      discriminator: "discL3",
    });
    const allDiscriminators = (j) =>
      j.discriminators >= 4 && j.discriminatorsOk === j.discriminators;
    const s = webgpu.close.internals || {};
    add(
      "atlas-active",
      "atlasActive (slotCount=585, 8 L1 + 64 L2 + 512 L3 uploaded)",
      s.usingRealData === true &&
        s.slotCount === 585 &&
        s.childPhase === "done" &&
        Array.isArray(s.childSlots) &&
        s.childSlots.every((x) => x >= 0) &&
        s.l2Uploaded === 64 &&
        s.l3Uploaded === 512,
      s,
    );
    add(
      "refined-close",
      `WebGPU targetLevel=3 at close + close2 (${webgpu.close.lastTargetLevel}, ${webgpu.close2.lastTargetLevel})`,
      webgpu.close.lastTargetLevel === 3 && webgpu.close2.lastTargetLevel === 3,
    );
    add(
      "root-far",
      `WebGPU targetLevel=0 at far (${webgpu.far.lastTargetLevel})`,
      webgpu.far.lastTargetLevel === 0,
    );
    add(
      "close-discriminators",
      `L3 discriminators on WebGPU close (>=4, all black): ${gpClose.discriminatorsOk}/${gpClose.discriminators}`,
      allDiscriminators(gpClose),
    );
    add("webgpu-close", "WebGPU close matches level 3", gpClose.pass, {
      failures: gpClose.failures.slice(0, 12),
    });
    add(
      "webgl-close",
      "WebGL close is consistent with level 2 or 3 per cell",
      glClose.pass,
      { failures: glClose.failures.slice(0, 12) },
    );
    add(
      "webgl-close2-proven",
      `WebGL close2 matches level 3 with >= 4 discriminators all black (${glClose2.discriminatorsOk}/${glClose2.discriminators})`,
      glClose2.pass && allDiscriminators(glClose2),
      { failures: glClose2.failures.slice(0, 12) },
    );
    add(
      "webgpu-close2",
      `WebGPU close2 matches level 3 with >= 4 discriminators all black (${gpClose2.discriminatorsOk}/${gpClose2.discriminators})`,
      gpClose2.pass && allDiscriminators(gpClose2),
      { failures: gpClose2.failures.slice(0, 12) },
    );
    add(
      "far-diff",
      `far-view centre-crop mean abs diff ${farDiff.toFixed(2)} < 6`,
      farDiff < 6,
      { farDiff },
    );
    add(
      "no-console-errors",
      `no console errors (${webgl.consoleErrors.length} WebGL, ${webgpu.consoleErrors.length} WebGPU)`,
      webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0,
      {
        webgl: webgl.consoleErrors.slice(0, 5),
        webgpu: webgpu.consoleErrors.slice(0, 5),
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

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-octree-l3plus",
  title: "Voxel octree traversal to level 3 (585-slot atlas), three views",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-octree-l3plus-<renderer>-<view>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // One page per backend: the close rig's warm-up, then three views of
  // VIEW_FRAMES each, one capture per view.
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: options.renderers.length,
      frames:
        options.renderers.length *
        (CLOSE_RIG.readiness.frames + 3 * VIEW_FRAMES),
      captures: 3 * options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const missing = missingRenderers(options.renderers, ["webgl", "webgpu"]);
    if (missing.length > 0) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-octree-l3plus judges WebGL against WebGPU and cannot run without ${missing.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    const webgl = await captureViews({ ...legs, renderer: "webgl" });
    const webgpu = await captureViews({ ...legs, renderer: "webgpu" });
    // Both backends render the ROOT level at the far view and the box is
    // small on screen, so their centre crops must nearly agree.
    const farDiff = cropMeanAbsDifference(webgl.far.frame, webgpu.far.frame);
    for (const leg of [webgl, webgpu]) {
      for (const view of ["close", "close2", "far"]) {
        delete leg[view].frame;
      }
    }
    return [{ run, webgl, webgpu, farDiff }];
  },
  verdicts(cells) {
    return evaluateOctree(cells);
  },
  receipt(cells, context) {
    if (cells.length > 0) {
      printReport({ cells, verdicts: context.verdicts });
    }
    return {
      rigs: [CLOSE_RIG.id, CLOSE2_RIG.id, FAR_RIG.id],
      cells,
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
