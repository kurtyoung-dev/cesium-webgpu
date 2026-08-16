// C-R9-VOXEL-CELL-PICK-TAIL acceptance probe.
// @purpose Acceptance: public Scene.pickVoxel end-to-end on both backends — VoxelCell returned without throw, identical color/tile/sample cross-backend.
// @status ACTIVE
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

// Z-up cell → input (glTF Y-up) sample index (mirrors probe-voxel-cell-pick).
function expectedSampleIndex(cell, dims) {
  const inX = dims.x;
  const inY = dims.z;
  const ix = cell.x;
  const iy = cell.z;
  const iz = dims.y - 1 - cell.y;
  return ix + inX * (iy + inY * iz);
}

// The stored color for a Z-up cell (matches the asset fill below).
function expectedColor(cell) {
  return [0.35 + 0.65 * cell.x, 0.15 + 0.28 * cell.y, 0.2 + 0.4 * cell.z, 1.0];
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
    async ({ dims, filledSrc, targets, convergenceSrc }) => {
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

      const errors = [];
      const dev = scene.context?._device;
      if (dev) {
        dev.onuncapturederror = (ev) => {
          errors.push(String(ev?.error?.message).slice(0, 200));
        };
      }

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
        destination: new C.Cartesian3(4 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      for (let i = 0; i < 240; i++) {
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
        for (let i = 0; i < 14; i++) {
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
        deviceErrors: errors,
      };
    },
    {
      dims: DIMS,
      filledSrc: cellFilled.toString(),
      targets: TARGETS,
      convergenceSrc: advanceC1113PublicVoxelPickConvergence.toString(),
    },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-pick-${renderer}.png`, buf);
  await page.close();
  return { ...result, consoleErrors };
}

function colorsEq(a, b, eps = 1e-4) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

let pass = true;

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");

console.log("=== C-R9-VOXEL-CELL-PICK-TAIL — scene.pickVoxel end-to-end ===");
console.log(`renderers: webgl=${webgl.renderer} webgpu=${webgpu.renderer}`);

for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  const gl = webgl.picks[i] || {};
  const gp = webgpu.picks[i] || {};
  const glc = gl.cell;
  const gpc = gp.cell;
  if (gl.threw || gp.threw) {
    pass = false;
    console.log(
      `  [${t.label}] THREW webgl=${gl.threw ?? "-"} webgpu=${gp.threw ?? "-"}`,
    );
    continue;
  }
  if (t.cell) {
    const expSample = expectedSampleIndex(t.cell, DIMS);
    const expColor = expectedColor(t.cell);
    const glOk =
      glc &&
      gl.stable === true &&
      glc.isVoxelCell &&
      glc.tileIndex === 0 &&
      glc.sampleIndex === expSample &&
      colorsEq(glc.color, expColor);
    const gpOk =
      gpc &&
      gp.stable === true &&
      gpc.isVoxelCell &&
      gpc.tileIndex === 0 &&
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
      `  [${t.label}] expect cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${expSample} color=[${expColor.map((x) => x.toFixed(2))}]\n` +
        `      webgl  = ${JSON.stringify(glc)}\n` +
        `      webgpu = ${JSON.stringify(gpc)}  ${ok ? "ok" : "MISMATCH"}`,
    );
  } else {
    // Empty column: `scene.pickVoxel` first calls `scene.pick`, and the result
    // hinges on whether the OBJECT pick returns the voxel primitive there. On
    // WebGL it does not (empty column = background), so pickVoxel returns no
    // cell. On WebGPU the object-pick footprint currently covers the whole box
    // (a SEPARATE, pre-existing object-pick gap — a cleared readback [0,0,0,0]
    // is indistinguishable from a real tile-0/sample-0 hit on BOTH backends, so
    // this cannot be disambiguated in the cell-pick path). The cell-pick-tail
    // guarantee is only "no throw"; the WebGL result is additionally asserted.
    const glNone = !glc || !glc.isVoxelCell;
    const noThrow = !gl.threw && !gp.threw;
    if (!noThrow || !glNone) pass = false;
    console.log(
      `  [${t.label}] no-throw + webgl no-cell (object-pick footprint residual) | ` +
        `webgl=${JSON.stringify(glc)} webgpu=${JSON.stringify(gpc)} ${noThrow && glNone ? "ok" : "MISMATCH"}`,
    );
  }
}

{
  // Off-box: the pick ray misses the volume entirely.
  // NS-VOXEL-PICK-FOOTPRINT-SPURIOUS-ROOT — WebGL's `this.pick` returns no
  // object off the rendered surface, so `scene.pickVoxel` returns undefined.
  // WebGPU's object-pick footprint over-reports the whole box (and the sync
  // pick can return a stale in-box hit for an adjacent off-box pixel), which —
  // because a cleared voxel-coordinate readback [0,0,0,0] is indistinguishable
  // from a genuine tile-0/sample-0 hit — used to yield a spurious ROOT cell.
  // `Scene.pickVoxel` now casts the pick ray against the primitive's oriented
  // bounding box and rejects the off-box pick, so BOTH backends return no cell.
  const glNone = !webgl.offPick.cell || !webgl.offPick.cell.isVoxelCell;
  const gpNone = !webgpu.offPick.cell || !webgpu.offPick.cell.isVoxelCell;
  const noThrow = !webgl.offPick.threw && !webgpu.offPick.threw;
  const ok = glNone && gpNone && noThrow;
  if (!ok) pass = false;
  console.log(
    `  [off-box] no-throw + BOTH backends no-cell (ray-OBB gate) | webgl=${JSON.stringify(webgl.offPick.cell)} webgpu=${JSON.stringify(webgpu.offPick.cell)} threw(gl=${webgl.offPick.threw ?? "-"},gp=${webgpu.offPick.threw ?? "-"}) ${ok ? "ok" : "MISMATCH"}`,
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
