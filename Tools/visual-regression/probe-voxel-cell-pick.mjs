// C-R9-VOXEL-CELL-PICK acceptance probe (VOXEL-CELL-PICK-RELAND).
//
// Verifies per-cell voxel picking parity: `Picking.pickVoxelCoordinate`
// (the GPU pass behind `Scene.pickVoxel`) must decode to EXACTLY the same
// {tileIndex, sampleIndex} — and therefore the same cell {x,y,z} — on WebGPU
// as on WebGL, at multiple screen pixels over a deterministic per-cell
// staircase asset (the same 2×4×3 Y_UP single-tile box provider
// probe-voxel-parity Part B uses).
//
// What it asserts, per backend pair:
//   * At each filled-cell target pixel: the 4 readback bytes match WebGL
//     byte-for-byte, and decode to the analytically-expected first-hit cell.
//   * At an empty-column pixel (ray passes only unfilled cells) and at an
//     off-box pixel: both backends return cleared [0,0,0,0].
//   * Object pick over the voxel (scene.pickAsync) still returns the
//     VoxelPrimitive on both backends (regular pick unregressed).
//   * Zero console/device errors on both backends.
//
// WebGPU note: `readCenterPixel` is an armed async readback (returns the
// cleared pixel on a cold query, converges 1-2 picks later —
// NEW-PICK-METADATA-READBACK contract), so each pixel is queried in a short
// retry loop until two consecutive results agree.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const DIMS = { x: 2, y: 4, z: 3 };

// Same axis-asymmetric staircase as probe-voxel-parity Part B: any axis
// swap/flip/mis-scale in the pick sample-coordinate derivation lands on a
// DIFFERENT filled cell (or an empty one), so exact-cell equality is a strong
// frame discriminator.
function cellFilled(x, y, z) {
  return (x === 1 && y === z && y <= 2) || (x === 0 && y === 3 && z === 1);
}

// Pick targets, front view (+X looking −X → at a given (y,z) column the ray
// crosses x=1 first, then x=0). `cell` is the expected FIRST-HIT filled cell
// in the Z-up shape frame; `empty` targets expect a cleared readback.
const TARGETS = [
  { label: "y0z0", y: 0, z: 0, cell: { x: 1, y: 0, z: 0 } },
  { label: "y1z1", y: 1, z: 1, cell: { x: 1, y: 1, z: 1 } },
  { label: "y2z2", y: 2, z: 2, cell: { x: 1, y: 2, z: 2 } },
  { label: "y3z1", y: 3, z: 1, cell: { x: 0, y: 3, z: 1 } },
  { label: "y0z2-empty", y: 0, z: 2, cell: null },
  { label: "y2z0-empty", y: 2, z: 0, cell: null },
];

// Z-up cell → input-orientation (glTF Y-up) sample index, mirroring
// Octree.glsl's Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip over the padded
// input dims (no padding here): input (ix,iy,iz) = (x, z, dimsY-1-y),
// inputDims = (dimsX, dimsZ, dimsY), sampleIndex = ix + inX*(iy + inY*iz).
function expectedSampleIndex(cell) {
  const inX = DIMS.x;
  const inY = DIMS.z;
  const ix = cell.x;
  const iy = cell.z;
  const iz = DIMS.y - 1 - cell.y;
  return ix + inX * (iy + inY * iz);
}

function decode(bytes) {
  if (!bytes) {
    return null;
  }
  const tile = 255 * bytes[0] + bytes[1];
  const sample = 255 * bytes[2] + bytes[3];
  const inX = DIMS.x;
  const inY = DIMS.z;
  const ix = sample % inX;
  const iy = Math.floor(sample / inX) % inY;
  const iz = Math.floor(sample / (inX * inY));
  // input (ix,iy,iz) → Z-up cell (x, dimsY-1-iz, iy)
  return {
    tile,
    sample,
    cell: { x: ix, y: DIMS.y - 1 - iz, z: iy },
  };
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
    async ({ dims, filledSrc, targets }) => {
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

      const errors = [];
      const dev = scene.context?._device;
      if (dev) {
        dev.onuncapturederror = (ev) => {
          errors.push(String(ev?.error?.message).slice(0, 200));
        };
      }

      const R = 6378137.0;
      // Author metadata in INPUT (glTF Y-up) order — identical to
      // probe-voxel-parity Part B.
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

      // WebGL ground truth: alpha-gated custom shader (the WebGPU parity
      // march applies the equivalent density gate internally).
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

      // Front view (+X looking −X): Y horizontal, Z vertical.
      v.camera.setView({
        destination: new C.Cartesian3(4 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      // Let the provider resolve + the WebGPU root-tile upload finish.
      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      // Window coordinate of each target cell-column center.
      const cy = (y) => -1 + ((y + 0.5) * 2) / dims.y;
      const cz = (z) => -1 + ((z + 0.5) * 2) / dims.z;
      const windows = targets.map((t) => {
        const world = new C.Cartesian3(0, cy(t.y) * R, cz(t.z) * R);
        const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
        return win ? { x: win.x, y: win.y } : null;
      });
      // Off-box pixel: a world point beside the box over black background.
      const offWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(0, 1.8 * R, 0),
      );

      // Object pick over the voxel (center of the box) — regular pick must
      // still return the VoxelPrimitive.
      const centerWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(0, cy(0) * R, cz(0) * R),
      );
      let objectPickOk = null;
      if (centerWin && scene.pickAsync) {
        try {
          const picked = await scene.pickAsync(
            new C.Cartesian2(centerWin.x, centerWin.y),
          );
          objectPickOk = !!picked && picked.primitive === prim;
        } catch (e) {
          objectPickOk = `error: ${String(e).slice(0, 120)}`;
        }
        // Let the async pick readback settle before the pickVoxel passes.
        for (let i = 0; i < 10; i++) {
          scene.render();
          await new Promise((r) => setTimeout(r, 16));
        }
      }

      // Query pickVoxelCoordinate at each pixel with a convergence loop
      // (WebGPU readback is armed-async; WebGL is synchronous and converges
      // on the first call).
      async function queryPixel(win) {
        if (!win) {
          return { bytes: null, note: "no window coord" };
        }
        const pos = new C.Cartesian2(win.x, win.y);
        let prev = null;
        let last = null;
        for (let i = 0; i < 12; i++) {
          const r = scene._picking.pickVoxelCoordinate(scene, pos, 1, 1);
          last = Array.from(r || []);
          if (
            prev &&
            i >= 2 &&
            prev.length === 4 &&
            last.length === 4 &&
            prev.every((bv, k) => bv === last[k])
          ) {
            break;
          }
          prev = last;
          await new Promise((rr) => setTimeout(rr, 80));
        }
        return { bytes: last };
      }

      const picks = [];
      for (let i = 0; i < targets.length; i++) {
        picks.push(await queryPixel(windows[i]));
      }
      const offPick = await queryPixel(
        offWin ? { x: offWin.x, y: offWin.y } : null,
      );

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;

      // Draw markers at the pick points for the screenshot.
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
        el.className = "probe-pick-marker";
        document.body.appendChild(el);
      }

      return {
        renderer: scene.context.rendererType || null,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        hasPickVoxelCommand: cache ? !!cache.pickVoxelCommand : null,
        objectPickOk,
        picks,
        offPick,
        deviceErrors: errors,
      };
    },
    { dims: DIMS, filledSrc: cellFilled.toString(), targets: TARGETS },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-cell-pick-${renderer}.png`, buf);

  await page.close();
  return { ...result, consoleErrors };
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");
await browser.close();

console.log(
  "WebGL  setup:",
  JSON.stringify({
    renderer: webgl.renderer,
    objectPickOk: webgl.objectPickOk,
  }),
);
console.log(
  "WebGPU setup:",
  JSON.stringify({
    renderer: webgpu.renderer,
    usingRealData: webgpu.usingRealData,
    uploadPhase: webgpu.uploadPhase,
    hasPickVoxelCommand: webgpu.hasPickVoxelCommand,
    objectPickOk: webgpu.objectPickOk,
  }),
);

let pass = true;
const isCleared = (b) =>
  Array.isArray(b) && b.length === 4 && b.every((x) => x === 0);

for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  const gl = webgl.picks[i]?.bytes ?? null;
  const gp = webgpu.picks[i]?.bytes ?? null;
  const glDec = decode(gl);
  const gpDec = decode(gp);
  const bytesEqual =
    gl && gp && gl.length === 4 && gp.length === 4 &&
    gl.every((bv, k) => bv === gp[k]);

  let verdict;
  if (t.cell) {
    const expSample = expectedSampleIndex(t.cell);
    const glOk = glDec && glDec.tile === 0 && glDec.sample === expSample;
    const gpOk = gpDec && gpDec.tile === 0 && gpDec.sample === expSample;
    verdict = bytesEqual && glOk && gpOk ? "ok" : "MISMATCH";
    console.log(
      `  [${t.label}] expect cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${expSample} | ` +
        `webgl=${JSON.stringify(gl)}→${glDec ? `t${glDec.tile}/s${glDec.sample}/cell(${glDec.cell.x},${glDec.cell.y},${glDec.cell.z})` : "?"} | ` +
        `webgpu=${JSON.stringify(gp)}→${gpDec ? `t${gpDec.tile}/s${gpDec.sample}/cell(${gpDec.cell.x},${gpDec.cell.y},${gpDec.cell.z})` : "?"} | ` +
        `bytesEqual=${bytesEqual} ${verdict}`,
    );
  } else {
    const bothCleared = isCleared(gl) && isCleared(gp);
    verdict = bothCleared ? "ok" : "MISMATCH";
    console.log(
      `  [${t.label}] expect cleared | webgl=${JSON.stringify(gl)} webgpu=${JSON.stringify(gp)} ${verdict}`,
    );
  }
  if (verdict !== "ok") {
    pass = false;
  }
}

const offGl = webgl.offPick?.bytes ?? null;
const offGp = webgpu.offPick?.bytes ?? null;
const offOk = isCleared(offGl) && isCleared(offGp);
console.log(
  `  [off-box] expect cleared | webgl=${JSON.stringify(offGl)} webgpu=${JSON.stringify(offGp)} ${offOk ? "ok" : "MISMATCH"}`,
);
if (!offOk) {
  pass = false;
}

const objectPickOk =
  webgl.objectPickOk === true && webgpu.objectPickOk === true;
console.log("objectPickOk (both return the VoxelPrimitive):", objectPickOk);
if (!objectPickOk) {
  pass = false;
}

const errCount =
  webgl.consoleErrors.length +
  webgpu.consoleErrors.length +
  (webgl.deviceErrors?.length ?? 0) +
  (webgpu.deviceErrors?.length ?? 0);
console.log("console/device errors:", errCount);
if (errCount > 0) {
  console.log(
    "  webgl:",
    webgl.consoleErrors.slice(0, 3),
    webgl.deviceErrors?.slice(0, 3),
  );
  console.log(
    "  webgpu:",
    webgpu.consoleErrors.slice(0, 3),
    webgpu.deviceErrors?.slice(0, 3),
  );
  pass = false;
}

console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
