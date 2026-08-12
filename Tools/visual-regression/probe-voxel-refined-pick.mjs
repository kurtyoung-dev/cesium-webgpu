// NS-VOXEL-REFINED-TILE-CELL-RETENTION acceptance probe.
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
import { chromium } from "playwright";
import fs from "fs";
import { advanceC1113PublicVoxelPickConvergence } from "./lib/c11-13-public-voxel-pick-convergence.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

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
// child (mirrors probe-voxel-cell-pick): ix=x, iy=z, iz=TILE-1-y.
function expectedSampleIndex(cell) {
  return cell.x + TILE * (cell.z + TILE * (TILE - 1 - cell.y));
}

// Analytic stored color for a child at `octant` local cell `c` (matches the
// makeChild fill below): r = octantIndex/8, g = localLinear/64, b = 0.5, a = 1.
function expectedColor(octant, c) {
  const octantIndex = octant.x + 2 * octant.y + 4 * octant.z;
  const localLinear = c.x + 4 * c.y + 16 * c.z;
  return [octantIndex / 8, localLinear / 64, 0.5, 1.0];
}

async function capture(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(
    async ({ tile, fine, targets, convergenceSrc }) => {
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

      const errors = [];
      const dev = scene.context?._device;
      if (dev) {
        dev.onuncapturederror = (ev) => {
          errors.push(String(ev?.error?.message).slice(0, 200));
        };
      }

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
        destination: new C.Cartesian3(10 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      for (let i = 0; i < 320; i++) {
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
        for (let i = 0; i < 16; i++) {
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
        deviceErrors: errors,
      };
    },
    {
      tile: TILE,
      fine: FINE,
      targets: TARGETS,
      convergenceSrc: advanceC1113PublicVoxelPickConvergence.toString(),
    },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-refined-pick-${renderer}.png`, buf);
  await page.close();
  return { ...result, consoleErrors };
}

function colorsEq(a, b, eps = 5e-3) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

let pass = true;

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");

console.log(
  "=== NS-VOXEL-REFINED-TILE-CELL-RETENTION — refined scene.pickVoxel ===",
);
console.log(`renderers: webgl=${webgl.renderer} webgpu=${webgpu.renderer}`);
console.log(
  "WebGPU setup:",
  JSON.stringify({
    slotCount: webgpu.slotCount,
    lastTargetLevel: webgpu.lastTargetLevel,
  }),
);

// Precondition: WebGPU must actually be refined (root-only would make every
// pick a tileIndex-0 cell and this probe would be vacuous).
const refinedOk = webgpu.slotCount === 9 && webgpu.lastTargetLevel === 1;
console.log(`  WebGPU refined to L1 (slotCount=9, level=1): ${refinedOk}`);
if (!refinedOk) pass = false;

for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  const gl = webgl.picks[i] || {};
  const gp = webgpu.picks[i] || {};
  const glc = gl.cell;
  const gpc = gp.cell;
  const expSample = expectedSampleIndex(t.localCell);
  const expColor = expectedColor(t.octant, t.localCell);

  if (gl.threw || gp.threw) {
    pass = false;
    console.log(
      `  [${t.label}] THREW webgl=${gl.threw ?? "-"} webgpu=${gp.threw ?? "-"}`,
    );
    continue;
  }

  const glOk =
    glc &&
    gl.stable === true &&
    glc.isVoxelCell &&
    glc.sampleIndex === expSample &&
    colorsEq(glc.color, expColor);
  // WebGPU must be a REFINED cell (tileIndex >= 1) with the analytic sample+color.
  const gpOk =
    gpc &&
    gp.stable === true &&
    gpc.isVoxelCell &&
    gpc.tileIndex >= 1 &&
    gpc.sampleIndex === expSample &&
    colorsEq(gpc.color, expColor);
  const crossOk =
    glc &&
    gpc &&
    glc.sampleIndex === gpc.sampleIndex &&
    colorsEq(glc.color, gpc.color);
  const ok = glOk && gpOk && crossOk;
  if (!ok) pass = false;
  console.log(
    `  [${t.label}] expect octant(${t.octant.x},${t.octant.y},${t.octant.z}) ` +
      `local(${t.localCell.x},${t.localCell.y},${t.localCell.z}) sample=${expSample} ` +
      `color=[${expColor.map((x) => x.toFixed(3))}]\n` +
      `      webgl  = ${JSON.stringify(glc)}\n` +
      `      webgpu = ${JSON.stringify(gpc)}  ${ok ? "ok" : "MISMATCH"}`,
  );
}

{
  const glNone = !webgl.offPick.cell || !webgl.offPick.cell.isVoxelCell;
  const gpNone = !webgpu.offPick.cell || !webgpu.offPick.cell.isVoxelCell;
  const noThrow = !webgl.offPick.threw && !webgpu.offPick.threw;
  const ok = glNone && gpNone && noThrow;
  if (!ok) pass = false;
  console.log(
    `  [off-box] BOTH backends no-cell (ray-OBB gate) | ` +
      `webgl=${JSON.stringify(webgl.offPick.cell)} webgpu=${JSON.stringify(webgpu.offPick.cell)} ${ok ? "ok" : "MISMATCH"}`,
  );
}

const errTotal =
  webgl.consoleErrors.length +
  webgpu.consoleErrors.length +
  (webgl.deviceErrors?.length || 0) +
  (webgpu.deviceErrors?.length || 0);
if (errTotal > 0) {
  pass = false;
  console.log("console/device errors:", errTotal, {
    webgl: webgl.consoleErrors.slice(0, 3),
    webgpu: webgpu.consoleErrors.slice(0, 3),
    webgpuDev: webgpu.deviceErrors?.slice(0, 3),
  });
}

console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
