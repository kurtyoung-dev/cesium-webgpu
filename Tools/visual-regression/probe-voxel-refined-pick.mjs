// NS-VOXEL-REFINED-TILE-CELL-RETENTION acceptance probe.
// @purpose Acceptance: Scene.pickVoxel on a refined octree tile — retained child content yields a full VoxelCell with identity-encoded color parity.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Exercises the PUBLIC `Scene.pickVoxel(windowPosition)` end-to-end on a
// REFINED (octree level-1) voxel tile. Before this fix the WebGPU pick march
// already decoded the correct refined atlas slot + child-local sampleIndex
// (probe-voxel-cell-pick Part B), but `Scene.pickVoxel` returned `undefined`
// for any megatextureIndex >= 1 because the WebGPU FR nulled each child tile's
// CPU-side content after the texture upload — so no VoxelCell could be built.
// The fix retains child content CPU-side and reverse-maps the picked atlas slot
// to its spatial tile, so a refined pick now yields a full VoxelCell.
//
// Asset: two-level provider (availableLevels 2, per-tile 4×4×4, fine 8×8×8 thin
// diagonal fy==fz) at a CLOSE view where BOTH backends refine to level 1. Each
// child cell's color ENCODES its identity — r = childOctant/8, g = localLinear
// /64, b = 0.5, a = fill — so the picked `getProperty("color")` proves the
// metadata was read from the CORRECT child tile at the CORRECT local sample.
//
// At each on-diagonal target the probe asserts:
//   * `scene.pickVoxel(...)` returns a `VoxelCell` (no throw) on BOTH backends;
//   * WebGPU `cell.tileIndex >= 1` — a REFINED tile (root would be 0), proving
//     the refined-tile path is taken, not the root fallback;
//   * `cell.sampleIndex` === the analytic child-local input-orientation sample,
//     identical cross-backend;
//   * `cell.getProperty("color")` === the analytic child cell color, identical
//     cross-backend (byte-for-byte metadata parity).
// Off-box pixels return no cell (ray-OBB gate) on both backends.
//
// WebGPU note: `scene.pickVoxel` composes an asynchronous object pick with an
// asynchronous per-cell readback. A new cursor is retried until two
// consecutive identical REAL cells agree; repeated `undefined` results never
// establish convergence.
//
// ON THE KIT (probe-kit harvest, voxel family): scene =
// `rigs/voxel-two-level-identity-close.mjs`; Edge, origin, slot, deadline,
// receipt and exit code = `lib/probe-runtime.mjs`; viewer page, console and
// WebGPU error gate (whose device errors replace the in-page
// `onuncapturederror` hook, same clause) = `lib/voxel-probe-page.mjs`; sample
// index and colour comparison = `lib/metrics/voxel-pick-coordinate.mjs`.
// Run: `node server.js --port 8094 --serve-built`, then this file.
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
import RIG from "./rigs/voxel-two-level-identity-close.mjs";

/** Bound on pick attempts per target; each renders three frames. */
const PICK_ATTEMPTS = 16;
/** The pre-migration probe's colour tolerance for a picked cell. */
const COLOUR_EPSILON = 5e-3;

const TILE = 4;
const FINE = TILE * 2;

// On-diagonal fine targets: the +X→−X ray at column (k,k) first hits fine cell
// (7, k, k) → child octant (1, k>>2, k>>2), local cell (3, k%4, k%4).
const TARGETS = [0, 3, 4, 7].map((k) => ({
  label: `diag-y${k}z${k}`,
  fy: k,
  fz: k,
  octant: { x: 1, y: k >> 2, z: k >> 2 },
  localCell: { x: 3, y: k % 4, z: k % 4 },
}));

// Z-up local cell → input (glTF Y-up) sample index over the padded-free 4×4×4
// child: ix=x, iy=z, iz=TILE-1-y.
const TILE_DIMS = { x: TILE, y: TILE, z: TILE };

// Analytic stored color for a child at `octant` local cell `c` (matches the
// makeChild fill below): r = octantIndex/8, g = localLinear/64, b = 0.5, a = 1.
function expectedColor(octant, c) {
  const octantIndex = octant.x + 2 * octant.y + 4 * octant.z;
  const localLinear = c.x + 4 * c.y + 16 * c.z;
  return [octantIndex / 8, localLinear / 64, 0.5, 1.0];
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
    rig: RIG,
  });

  const result = await page.evaluate(
    async ({
      tile,
      fine,
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
      const advanceConvergence = new Function(`return (${convergenceSrc});`)();

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const R = 6378137.0;

      // Per-tile 4×4×4 in INPUT (glTF Y-up) order: idx = x + tile*(z + tile*(tile-1-y)).
      function makeTile(fillFn, colorFn) {
        const data = new Float32Array(tile * tile * tile * 4);
        for (let z = 0; z < tile; z++) {
          for (let y = 0; y < tile; y++) {
            for (let x = 0; x < tile; x++) {
              const idx = x + tile * (z + tile * (tile - 1 - y));
              const d = idx * 4;
              const col = colorFn(x, y, z);
              data[d] = col[0];
              data[d + 1] = col[1];
              data[d + 2] = col[2];
              data[d + 3] = fillFn(x, y, z) ? 1.0 : 0.0;
            }
          }
        }
        return data;
      }
      const rootData = makeTile(
        (x, y, z) => y === z,
        () => [0.2, 0.2, 0.2],
      );
      function makeChild(cx, cy, cz) {
        const octantIndex = cx + 2 * cy + 4 * cz;
        return makeTile(
          (lx, ly, lz) => cy * tile + ly === cz * tile + lz,
          (lx, ly, lz) => [octantIndex / 8, (lx + 4 * ly + 16 * lz) / 64, 0.5],
        );
      }
      const provider = {
        shape: C.VoxelShapeType.BOX,
        minBounds: new C.Cartesian3(-1, -1, -1),
        maxBounds: new C.Cartesian3(1, 1, 1),
        dimensions: new C.Cartesian3(tile, tile, tile),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R)),
        availableLevels: 2,
        metadataOrder: C.VoxelMetadataOrder.Y_UP,
        requestData: function (options) {
          const level = options.tileLevel ?? 0;
          if (level === 0) {
            return Promise.resolve(
              C.VoxelContent.fromMetadataArray([rootData]),
            );
          }
          if (level === 1) {
            return Promise.resolve(
              C.VoxelContent.fromMetadataArray([
                makeChild(options.tileX, options.tileY, options.tileZ),
              ]),
            );
          }
          return Promise.reject("no tiles beyond level 1");
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

      // Front view (+X looking −X): Y horizontal, Z vertical, CLOSE so both refine.
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

      const cc = (i) => -1 + ((i + 0.5) * 2) / fine;
      const windows = targets.map((t) => {
        const world = new C.Cartesian3(0, cc(t.fy) * R, cc(t.fz) * R);
        const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
        return win ? { x: win.x, y: win.y } : null;
      });
      const offWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(0, 1.8 * R, 0),
      );

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

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        slotCount: du ? du.slotCount : null,
        lastTargetLevel: du ? du.lastTargetLevel : null,
        picks,
        offPick,
      };
    },
    {
      tile: TILE,
      fine: FINE,
      targets: TARGETS,
      convergenceSrc: advanceC1113PublicVoxelPickConvergence.toString(),
      camera: RIG.camera,
      frames: RIG.readiness.frames,
      attemptsBound: PICK_ATTEMPTS,
    },
  );

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-refined-pick-${renderer}`,
    outputDirectory,
    captures,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { ...result, capture: shot.name, ...errors };
}

/**
 * The clauses over one run's cell. Precondition first: WebGPU must actually be
 * refined (root-only would make every pick a tileIndex-0 cell and this probe
 * vacuous). Then per on-diagonal target: a stable VoxelCell on both backends
 * with the analytic child-local sample and child colour, WebGPU on a REFINED
 * tile (tileIndex >= 1), and a cross-backend match; the off-box pixel returns
 * no cell on both backends; zero console or device errors.
 *
 * Pure and exported for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateVoxelRefinedPick(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const { webgl, webgpu } = cell;
    const suffix = `run${cell.run}`;
    verdicts.push({
      id: `webgpu-refined/${suffix}`,
      claim: `WebGPU refined to L1 (slotCount ${webgpu.slotCount} = 9, level ${webgpu.lastTargetLevel} = 1)`,
      pass: webgpu.slotCount === 9 && webgpu.lastTargetLevel === 1,
      detail: {
        slotCount: webgpu.slotCount,
        lastTargetLevel: webgpu.lastTargetLevel,
      },
    });

    for (let i = 0; i < TARGETS.length; i++) {
      const t = TARGETS[i];
      const gl = webgl.picks[i] || {};
      const gp = webgpu.picks[i] || {};
      const glc = gl.cell;
      const gpc = gp.cell;
      const expSample = expectedVoxelSampleIndex(t.localCell, TILE_DIMS);
      const expColor = expectedColor(t.octant, t.localCell);
      if (gl.threw || gp.threw) {
        verdicts.push({
          id: `target/${t.label}/${suffix}`,
          claim: `[${t.label}] pickVoxel does not throw`,
          pass: false,
          detail: { webgl: gl.threw ?? null, webgpu: gp.threw ?? null },
        });
        continue;
      }
      const glOk =
        glc &&
        gl.stable === true &&
        glc.isVoxelCell &&
        glc.sampleIndex === expSample &&
        pickedColourMatches(glc.color, expColor, COLOUR_EPSILON);
      // WebGPU must be a REFINED cell (tileIndex >= 1) with the analytic sample+color.
      const gpOk =
        gpc &&
        gp.stable === true &&
        gpc.isVoxelCell &&
        gpc.tileIndex >= 1 &&
        gpc.sampleIndex === expSample &&
        pickedColourMatches(gpc.color, expColor, COLOUR_EPSILON);
      const crossOk =
        glc &&
        gpc &&
        glc.sampleIndex === gpc.sampleIndex &&
        pickedColourMatches(glc.color, gpc.color, COLOUR_EPSILON);
      verdicts.push({
        id: `target/${t.label}/${suffix}`,
        claim: `[${t.label}] octant(${t.octant.x},${t.octant.y},${t.octant.z}) local(${t.localCell.x},${t.localCell.y},${t.localCell.z}) sample ${expSample} color [${expColor.map((x) => x.toFixed(3))}] on both backends, WebGPU on a refined tile`,
        pass: Boolean(glOk && gpOk && crossOk),
        detail: { expSample, expColor, webgl: glc, webgpu: gpc },
      });
    }

    const glNone = !webgl.offPick.cell || !webgl.offPick.cell.isVoxelCell;
    const gpNone = !webgpu.offPick.cell || !webgpu.offPick.cell.isVoxelCell;
    const noThrow = !webgl.offPick.threw && !webgpu.offPick.threw;
    verdicts.push({
      id: `off-box/${suffix}`,
      claim: "off-box: BOTH backends return no cell (ray-OBB gate)",
      pass: glNone && gpNone && noThrow,
      detail: {
        webgl: webgl.offPick.cell ?? null,
        webgpu: webgpu.offPick.cell ?? null,
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
  console.log(
    "=== NS-VOXEL-REFINED-TILE-CELL-RETENTION — refined scene.pickVoxel ===",
  );
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  const pass = receipt.verdicts.every((verdict) => verdict.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-refined-pick",
  title:
    "Voxel Scene.pickVoxel on a refined octree tile (NS-VOXEL-REFINED-TILE-CELL-RETENTION)",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-refined-pick-<renderer>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: options.renderers.length,
      frames:
        options.renderers.length *
        (RIG.readiness.frames + (TARGETS.length + 1) * PICK_ATTEMPTS * 3),
      captures: options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const missing = missingRenderers(options.renderers, ["webgl", "webgpu"]);
    if (missing.length > 0) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-refined-pick compares both backends' picked cells and cannot run without ${missing.join(",")}`,
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
    return evaluateVoxelRefinedPick(cells);
  },
  receipt(cells, context) {
    const receipt = { rig: RIG.id, cells, verdicts: context.verdicts };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
