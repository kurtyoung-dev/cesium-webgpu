// C-R9-VOXEL-CELL-PICK-TAIL acceptance probe.
// @purpose Acceptance: public Scene.pickVoxel end-to-end on both backends — VoxelCell returned without throw, identical color/tile/sample cross-backend.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Exercises the PUBLIC `Scene.pickVoxel(windowPosition)` end-to-end on BOTH
// backends. Prior to this fix `Scene.pickVoxel` threw on WebGPU after the
// (byte-identical) coordinate decode because it dereferenced
// `voxelPrimitive._traversal.findKeyframeNode(...)`, and the WebGPU
// feature-renderer path never builds a `_traversal`. The fix routes the
// keyframe-node resolve through a backend-agnostic `_getPickKeyframeNode`,
// which the WebGPU voxel renderer services from its uploaded ROOT-tile content.
//
// This probe asserts, at each filled-cell target pixel:
//   * `scene.pickVoxel(...)` returns a `VoxelCell` (no throw) on BOTH backends;
//   * `cell.getProperty("color")` is the SAME 4-float value cross-backend and
//     matches the analytic first-hit cell's stored color;
//   * `cell.tileIndex === 0` (root) and `cell.sampleIndex` is the analytic
//     input-orientation sample index, identical cross-backend.
// Off-box pixels (ray misses the volume) return `undefined` on BOTH backends
// (NS-VOXEL-PICK-FOOTPRINT-SPURIOUS-ROOT — Scene.pickVoxel's ray-vs-OBB gate).
// In-box EMPTY columns (ray crosses the box but hits no filled voxel) still
// return `undefined` on WebGL but a spurious root cell on WebGPU: WebGPU's
// object-pick footprint over-reports and the cleared readback [0,0,0,0] is
// byte-indistinguishable from a genuine tile-0/sample-0 hit (which the
// PickingSpec requires to keep returning a cell), so it cannot be gated in the
// cell path. That residual tracks WebGPU object-pick occupancy accuracy.
//
// WebGPU note: the per-cell pick readback is armed-async
// (NEW-PICK-METADATA-READBACK), and the public API first performs its own
// asynchronous object pick. A new cursor is therefore retried until two
// consecutive identical REAL cells agree; repeated `undefined` results never
// establish convergence.
//
// ON THE KIT (probe-kit harvest, voxel family). The scene is the rig
// `rigs/voxel-staircase-front.mjs` (camera, viewport, settle frames). The
// runtime (`lib/probe-runtime.mjs`) owns Edge, the origin, the served-build
// preflight, the Edge slot, the deadline, the receipt and the exit code;
// `lib/voxel-probe-page.mjs` opens the viewer with the console collected and
// the WebGPU error gate armed, and the gate's uncaptured device errors take
// the place of the in-page `onuncapturederror` hook this probe used to install
// (same clause, same count). The frame is banked through `captureElement`;
// the sample-index and colour comparisons are
// `lib/metrics/voxel-pick-coordinate.mjs`.
//
// Run: `node server.js --port 8094 --serve-built`, then
//   node Tools/visual-regression/probe-voxel-pick.mjs [--port 8094]
import { advanceC1113PublicVoxelPickConvergence } from "./lib/c11-13-public-voxel-pick-convergence.mjs";
import {
  expectedVoxelSampleIndex,
  pickedColourMatches,
} from "./lib/metrics/voxel-pick-coordinate.mjs";
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
import FRONT_RIG from "./rigs/voxel-staircase-front.mjs";

/** Bound on pick attempts per target; each renders three frames. */
const PICK_ATTEMPTS = 14;

const DIMS = { x: 2, y: 4, z: 3 };

// Axis-asymmetric staircase (same asset as probe-voxel-cell-pick Part A): any
// axis swap/flip/mis-scale lands on a DIFFERENT filled cell.
function cellFilled(x, y, z) {
  return (x === 1 && y === z && y <= 2) || (x === 0 && y === 3 && z === 1);
}

// Front view (+X looking −X): at column (y,z) the ray crosses x=1 first.
const TARGETS = [
  { label: "y0z0", y: 0, z: 0, cell: { x: 1, y: 0, z: 0 } },
  { label: "y1z1", y: 1, z: 1, cell: { x: 1, y: 1, z: 1 } },
  { label: "y2z2", y: 2, z: 2, cell: { x: 1, y: 2, z: 2 } },
  { label: "y3z1", y: 3, z: 1, cell: { x: 0, y: 3, z: 1 } },
  { label: "y0z2-empty", y: 0, z: 2, cell: null },
];

// The stored color for a Z-up cell (matches the asset fill below).
function expectedColor(cell) {
  return [0.35 + 0.65 * cell.x, 0.15 + 0.28 * cell.y, 0.2 + 0.4 * cell.z, 1.0];
}

async function capturePicks({
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
    rig: FRONT_RIG,
  });

  const result = await page.evaluate(
    async ({
      dims,
      filledSrc,
      targets,
      convergenceSrc,
      camera,
      frames,
      attemptsBound,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      const filled = new Function(`return (${filledSrc});`)();
      // eslint-disable-next-line no-new-func
      const advanceConvergence = new Function(`return (${convergenceSrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;
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

      v.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });

      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      const cy = (y) => -1 + ((y + 0.5) * 2) / dims.y;
      const cz = (z) => -1 + ((z + 0.5) * 2) / dims.z;
      const windows = targets.map((t) => {
        const world = new C.Cartesian3(0, cy(t.y) * R, cz(t.z) * R);
        const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
        return win ? { x: win.x, y: win.y } : null;
      });
      const offWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(0, 1.8 * R, 0),
      );

      // Call the PUBLIC scene.pickVoxel with an armed-async convergence loop.
      async function pickVoxelStable(win) {
        if (!win) {
          return { note: "no window coord" };
        }
        const pos = new C.Cartesian2(win.x, win.y);
        let lastCell = null;
        let threw = null;
        let attempts = 0;
        let convergence = {
          lastCellKey: null,
          consecutiveCellCount: 0,
          stable: false,
        };
        for (let i = 0; i < attemptsBound; i++) {
          attempts = i + 1;
          let cell;
          try {
            cell = scene.pickVoxel(pos);
          } catch (e) {
            threw = String(e).slice(0, 160);
            cell = undefined;
          }
          const isCell = cell instanceof C.VoxelCell;
          const key = isCell ? `${cell.tileIndex}/${cell.sampleIndex}` : "none";
          if (isCell) {
            lastCell = {
              tileIndex: cell.tileIndex,
              sampleIndex: cell.sampleIndex,
              color: Array.from(cell.getProperty("color") || []),
              isVoxelCell: true,
            };
          }
          convergence = advanceConvergence(convergence, isCell ? key : null);
          if (convergence.stable) {
            break;
          }
          for (let r = 0; r < 3; r++) {
            scene.render();
            await new Promise((rr) => setTimeout(rr, 24));
          }
        }
        return {
          cell: lastCell,
          threw,
          stable: convergence.stable,
          attempts,
        };
      }

      const picks = [];
      for (let i = 0; i < targets.length; i++) {
        picks.push(await pickVoxelStable(windows[i]));
      }
      const offPick = await pickVoxelStable(
        offWin ? { x: offWin.x, y: offWin.y } : null,
      );

      // Draw pick markers for the screenshot.
      const canvasRect = scene.canvas.getBoundingClientRect();
      const marks = windows
        .concat([offWin ? { x: offWin.x, y: offWin.y } : null])
        .filter(Boolean);
      for (const m of marks) {
        const el = document.createElement("div");
        el.style.cssText =
          "position:fixed;width:9px;height:9px;border:2px solid red;" +
          "border-radius:50%;pointer-events:none;z-index:99999;" +
          `left:${canvasRect.left + m.x - 5}px;top:${canvasRect.top + m.y - 5}px;`;
        document.body.appendChild(el);
      }

      return {
        renderer: scene.context.rendererType || null,
        picks,
        offPick,
      };
    },
    {
      dims: DIMS,
      filledSrc: cellFilled.toString(),
      targets: TARGETS,
      convergenceSrc: advanceC1113PublicVoxelPickConvergence.toString(),
      camera: FRONT_RIG.camera,
      frames: FRONT_RIG.readiness.frames,
      attemptsBound: PICK_ATTEMPTS,
    },
  );

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-pick-${renderer}`,
    outputDirectory,
    captures,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { ...result, capture: shot.name, ...errors };
}

/** The pre-migration probe's colour tolerance for a picked cell. */
const COLOUR_EPSILON = 1e-4;

/**
 * The clauses over one run's cell: per target, a cell on both backends with
 * the analytic tile, sample and stored colour and a cross-backend match; the
 * empty column's no-throw plus WebGL no-cell; the off-box no-cell on both
 * backends; and zero console or device errors. The reasoning behind the
 * empty-column and off-box clauses is the pre-migration probe's:
 *
 * Empty column: `scene.pickVoxel` first calls `scene.pick`, and the result
 * hinges on whether the OBJECT pick returns the voxel primitive there. On
 * WebGL it does not (empty column = background), so pickVoxel returns no cell.
 * On WebGPU the object-pick footprint currently covers the whole box (a
 * SEPARATE, pre-existing object-pick gap — a cleared readback [0,0,0,0] is
 * indistinguishable from a real tile-0/sample-0 hit on BOTH backends, so this
 * cannot be disambiguated in the cell-pick path). The cell-pick-tail guarantee
 * is only "no throw"; the WebGL result is additionally asserted.
 *
 * Off-box (NS-VOXEL-PICK-FOOTPRINT-SPURIOUS-ROOT): the pick ray misses the
 * volume entirely. `Scene.pickVoxel` casts the pick ray against the
 * primitive's oriented bounding box and rejects the off-box pick, so BOTH
 * backends return no cell.
 *
 * Pure and exported for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateVoxelPick(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const { webgl, webgpu } = cell;
    const suffix = `run${cell.run}`;
    for (let i = 0; i < TARGETS.length; i++) {
      const t = TARGETS[i];
      const gl = webgl.picks[i] || {};
      const gp = webgpu.picks[i] || {};
      const glc = gl.cell;
      const gpc = gp.cell;
      if (gl.threw || gp.threw) {
        verdicts.push({
          id: `target/${t.label}/${suffix}`,
          claim: `[${t.label}] pickVoxel does not throw`,
          pass: false,
          detail: { webgl: gl.threw ?? null, webgpu: gp.threw ?? null },
        });
        continue;
      }
      if (t.cell) {
        const expSample = expectedVoxelSampleIndex(t.cell, DIMS);
        const expColor = expectedColor(t.cell);
        const glOk =
          glc &&
          gl.stable === true &&
          glc.isVoxelCell &&
          glc.tileIndex === 0 &&
          glc.sampleIndex === expSample &&
          pickedColourMatches(glc.color, expColor, COLOUR_EPSILON);
        const gpOk =
          gpc &&
          gp.stable === true &&
          gpc.isVoxelCell &&
          gpc.tileIndex === 0 &&
          gpc.sampleIndex === expSample &&
          pickedColourMatches(gpc.color, expColor, COLOUR_EPSILON);
        const crossOk =
          glc &&
          gpc &&
          glc.sampleIndex === gpc.sampleIndex &&
          pickedColourMatches(glc.color, gpc.color, COLOUR_EPSILON);
        verdicts.push({
          id: `target/${t.label}/${suffix}`,
          claim: `[${t.label}] both backends pick cell(${t.cell.x},${t.cell.y},${t.cell.z}) tile 0 sample ${expSample} color [${expColor.map((x) => x.toFixed(2))}], stable, and agree`,
          pass: Boolean(glOk && gpOk && crossOk),
          detail: { expSample, expColor, webgl: glc, webgpu: gpc },
        });
      } else {
        const glNone = !glc || !glc.isVoxelCell;
        verdicts.push({
          id: `target/${t.label}/${suffix}`,
          claim: `[${t.label}] no throw, and WebGL returns no cell (object-pick footprint residual)`,
          pass: glNone,
          detail: { webgl: glc, webgpu: gpc },
        });
      }
    }

    const glNone = !webgl.offPick.cell || !webgl.offPick.cell.isVoxelCell;
    const gpNone = !webgpu.offPick.cell || !webgpu.offPick.cell.isVoxelCell;
    const noThrow = !webgl.offPick.threw && !webgpu.offPick.threw;
    verdicts.push({
      id: `off-box/${suffix}`,
      claim:
        "off-box: no throw and BOTH backends return no cell (ray-OBB gate)",
      pass: glNone && gpNone && noThrow,
      detail: {
        webgl: webgl.offPick.cell ?? null,
        webgpu: webgpu.offPick.cell ?? null,
        threw: {
          webgl: webgl.offPick.threw ?? null,
          webgpu: webgpu.offPick.threw ?? null,
        },
      },
    });

    const errTotal =
      webgl.consoleErrors.length +
      webgpu.consoleErrors.length +
      webgl.deviceErrors.length +
      webgpu.deviceErrors.length;
    verdicts.push({
      id: `errors/${suffix}`,
      claim: `no console or device errors (${errTotal})`,
      pass: errTotal === 0,
      detail: {
        webgl: webgl.consoleErrors.slice(0, 3),
        webgpu: webgpu.consoleErrors.slice(0, 3),
        webgpuDevice: webgpu.deviceErrors.slice(0, 3),
      },
    });
  }
  return verdicts;
}

function printReport(receipt) {
  console.log("=== C-R9-VOXEL-CELL-PICK-TAIL — scene.pickVoxel end-to-end ===");
  for (const cell of receipt.cells) {
    console.log(
      `renderers: webgl=${cell.webgl.renderer} webgpu=${cell.webgpu.renderer}`,
    );
  }
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  const pass = receipt.verdicts.every((verdict) => verdict.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-pick",
  title: "Voxel public Scene.pickVoxel end-to-end (C-R9-VOXEL-CELL-PICK-TAIL)",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-pick-<renderer>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // One page per backend: open, the rig's settle, then per target (and the
  // off-box pixel) up to PICK_ATTEMPTS attempts of three frames each.
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: options.renderers.length,
      frames:
        options.renderers.length *
        (FRONT_RIG.readiness.frames + (TARGETS.length + 1) * PICK_ATTEMPTS * 3),
      captures: options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const missing = missingRenderers(options.renderers, ["webgl", "webgpu"]);
    if (missing.length > 0) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-pick compares both backends' picked cells and cannot run without ${missing.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    return [
      {
        run,
        webgl: await capturePicks({ ...legs, renderer: "webgl" }),
        webgpu: await capturePicks({ ...legs, renderer: "webgpu" }),
      },
    ];
  },
  verdicts(cells) {
    return evaluateVoxelPick(cells);
  },
  receipt(cells, context) {
    const receipt = { rig: FRONT_RIG.id, cells, verdicts: context.verdicts };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
