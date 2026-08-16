// NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH acceptance probe.
// @purpose Acceptance: voxel pick with the log-depth gate forced ON — same cell picked, [ld] pipelines bound, occlusion proves frag_depth is written.
// @status ACTIVE
//
// Verifies the voxel PICK path when the pick-fleet log-depth gate is FORCED ON
// (context._pickLogDepthWriteEnabled = true — the switch C10-11 will flip for
// the whole fleet). With the gate off, probe-voxel-pick / probe-voxel-parity
// already prove the default path is byte-identical; this probe proves the
// INFRASTRUCTURE works when activated:
//
//   Part 1 (gate ON, single voxel):
//     * scene.pickVoxel returns the SAME correct cell as the gate-off run
//       (proves "same voxel picked" — only the frag_depth value changes).
//     * scene.pick returns the voxel primitive at a filled pixel (object pick).
//     * The voxel PICK descriptors are the [ld] log variants with
//       depthWriteEnabled === true (proves the log-write pipeline is bound).
//     * 0 device / console errors (proves the LOG_DEPTH module + both pick
//       pipelines compiled & built — the @builtin(frag_depth) WGSL is valid naga).
//   Part 2 (gate ON, front/back occlusion):
//     * A nearer "blocker" voxel correctly occludes a farther voxel in the
//       shared pick FBO at the overlap pixel — positive proof the log frag_depth
//       is WRITTEN, non-degenerate, and monotonic (depthWriteEnabled + a
//       plausible log depth are BOTH required for the nearer one to win).
//
// The full 20/500/5,000 km 3-altitude pick-depth-plane consistency gate is
// C10-11's (the whole fleet must be log first — this voxel slice is the
// prerequisite). WebGPU only.
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
function cellFilled(x, y, z) {
  return (x === 1 && y === z && y <= 2) || (x === 0 && y === 3 && z === 1);
}
// Front view (+X looking −X): the ray crosses x=1 first at column (y,z).
const TARGETS = [
  { label: "y0z0", y: 0, z: 0, cell: { x: 1, y: 0, z: 0 } },
  { label: "y1z1", y: 1, z: 1, cell: { x: 1, y: 1, z: 1 } },
  { label: "y2z2", y: 2, z: 2, cell: { x: 1, y: 2, z: 2 } },
];
function expectedSampleIndex(cell, dims) {
  const inX = dims.x;
  const inY = dims.z;
  return cell.x + inX * (cell.z + inY * (dims.y - 1 - cell.y));
}

async function run() {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(
    async ({ dims, filledSrc, targets }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func -- in-page snippet compiled from source text; that is the probe harness contract
      const filled = new Function(`return (${filledSrc});`)();

      // FORCE the pick-fleet log-depth gate ON (C10-11 will do this fleet-wide).
      scene.context._pickLogDepthWriteEnabled = true;

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
      function makeProvider() {
        return {
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
            if (options.tileLevel >= 1) return Promise.reject("single tile");
            return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
          },
        };
      }
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = fsInput.metadata.color.a;
}`,
      });
      const prim = new C.VoxelPrimitive({
        provider: makeProvider(),
        customShader,
      });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      v.camera.setView({
        destination: new C.Cartesian3(4 * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      for (let i = 0; i < 260; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      // ---- introspect the built voxel pick descriptors (structural proof) ----
      const cache = prim._webgpuCache || {};
      const pickDesc = cache.pickDescriptor || {};
      const pickVoxelDesc = cache.pickVoxelDescriptor || {};
      const introspect = {
        pickName: pickDesc.name || null,
        pickDepthWrite: pickDesc.depthStencil
          ? pickDesc.depthStencil.depthWriteEnabled
          : null,
        pickVoxelName: pickVoxelDesc.name || null,
        pickVoxelDepthWrite: pickVoxelDesc.depthStencil
          ? pickVoxelDesc.depthStencil.depthWriteEnabled
          : null,
        gate: scene.context._pickLogDepthWriteEnabled,
      };

      // ---- Part 1: cell + object pick correctness (gate ON) ----
      const cy = (y) => -1 + ((y + 0.5) * 2) / dims.y;
      const cz = (z) => -1 + ((z + 0.5) * 2) / dims.z;
      const wins = targets.map((t) => {
        const w = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, cy(t.y) * R, cz(t.z) * R),
        );
        return w ? { x: w.x, y: w.y } : null;
      });

      async function pickVoxelStable(win) {
        if (!win) return { note: "no-win" };
        const pos = new C.Cartesian2(win.x, win.y);
        let prevKey = null;
        let last = null;
        for (let i = 0; i < 14; i++) {
          let cell;
          try {
            cell = scene.pickVoxel(pos);
          } catch (e) {
            return { threw: String(e).slice(0, 160) };
          }
          const isCell = cell instanceof C.VoxelCell;
          const key = isCell ? `${cell.tileIndex}/${cell.sampleIndex}` : "none";
          if (isCell) {
            last = {
              tileIndex: cell.tileIndex,
              sampleIndex: cell.sampleIndex,
              isVoxelCell: true,
            };
          }
          if (prevKey !== null && i >= 2 && prevKey === key) break;
          prevKey = key;
          for (let r = 0; r < 3; r++) {
            scene.render();
            await new Promise((rr) => setTimeout(rr, 24));
          }
        }
        return { cell: last };
      }

      const cellPicks = [];
      for (let i = 0; i < targets.length; i++) {
        cellPicks.push(await pickVoxelStable(wins[i]));
      }

      // scene.pick is armed-async on WebGPU (NEW-PICK-METADATA-READBACK) — the
      // first call at a fresh pixel returns a cold/stale readback, so converge.
      async function pickStable(win, want) {
        if (!win) return { note: "no-win" };
        const pos = new C.Cartesian2(win.x, win.y);
        let last = { hit: false };
        for (let i = 0; i < 16; i++) {
          const p = scene.pick(pos);
          last = {
            hit: !!p,
            matches: !!p && p.primitive === want,
            other: !!p && p.primitive !== want,
          };
          if (last.matches) break;
          for (let r = 0; r < 2; r++) {
            scene.render();
            await new Promise((rr) => setTimeout(rr, 20));
          }
        }
        return last;
      }

      // object pick (scene.pick → fragmentPickMain path) at the first target
      let objectPick = null;
      if (wins[0]) {
        const op = await pickStable(wins[0], prim);
        objectPick = { hit: op.hit, isVoxel: op.matches === true };
      }

      // ---- Part 2: front/back occlusion in the shared pick FBO ----
      // A second voxel scaled 0.25R placed at +2.5R (nearer the 4R camera) must
      // occlude the big voxel at the shared pixel: with log depth WRITTEN the
      // nearer hit wins the less-equal test.
      const blockerData = new Float32Array(voxelCount * 4);
      for (let i = 0; i < voxelCount; i++) blockerData[i * 4 + 3] = 1.0; // fully solid
      const blockerProvider = {
        shape: C.VoxelShapeType.BOX,
        minBounds: new C.Cartesian3(-1, -1, -1),
        maxBounds: new C.Cartesian3(1, 1, 1),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.multiply(
          C.Matrix4.fromTranslation(new C.Cartesian3(2.5 * R, 0, 0)),
          C.Matrix4.fromScale(new C.Cartesian3(0.25 * R, 0.25 * R, 0.25 * R)),
          new C.Matrix4(),
        ),
        availableLevels: 1,
        metadataOrder: C.VoxelMetadataOrder.Y_UP,
        requestData: function (options) {
          if (options.tileLevel >= 1) return Promise.reject("single tile");
          return Promise.resolve(
            C.VoxelContent.fromMetadataArray([blockerData]),
          );
        },
      };
      const blocker = new C.VoxelPrimitive({
        provider: blockerProvider,
        customShader,
      });
      blocker.nearestSampling = true;
      scene.primitives.add(blocker);
      for (let i = 0; i < 200; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }
      // The blocker is centered on +X axis → projects to screen center, where
      // the big voxel also renders. Pick at screen center.
      const centerWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(2.5 * R, 0, 0),
      );
      let occlusion = { note: "no-win" };
      if (centerWin) {
        const op = await pickStable(centerWin, blocker);
        occlusion = {
          hit: op.hit,
          isBlocker: op.matches === true,
          isBigVoxel: op.other === true,
        };
      }

      return {
        renderer: scene.context.rendererType || null,
        introspect,
        cellPicks,
        objectPick,
        occlusion,
        deviceErrors: errors,
      };
    },
    { dims: DIMS, filledSrc: cellFilled.toString(), targets: TARGETS },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-pick-logdepth.png`, buf);
  await page.close();
  return { ...result, consoleErrors };
}

const r = await run();
let pass = true;
console.log("=== NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH — gate FORCED ON ===");
console.log(`renderer=${r.renderer}`);
console.log("introspect:", JSON.stringify(r.introspect));

// Structural: the [ld] log pick pipelines with depthWriteEnabled true are bound.
const ins = r.introspect || {};
const ldOk =
  ins.gate === true &&
  typeof ins.pickName === "string" &&
  ins.pickName.includes("[ld]") &&
  ins.pickDepthWrite === true &&
  typeof ins.pickVoxelName === "string" &&
  ins.pickVoxelName.includes("[ld]") &&
  ins.pickVoxelDepthWrite === true;
if (!ldOk) pass = false;
console.log(
  `  [struct] [ld] pick pipelines + depthWriteEnabled: ${ldOk ? "ok" : "MISMATCH"}`,
);

// Cell pick correctness (same voxel picked, gate on).
for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  const exp = expectedSampleIndex(t.cell, DIMS);
  const c = r.cellPicks[i] && r.cellPicks[i].cell;
  const ok = c && c.isVoxelCell && c.tileIndex === 0 && c.sampleIndex === exp;
  if (!ok) pass = false;
  console.log(
    `  [cell ${t.label}] expect sample=${exp} got=${JSON.stringify(c)} ${ok ? "ok" : "MISMATCH"}`,
  );
}

// Object pick correctness.
const objOk = r.objectPick && r.objectPick.hit && r.objectPick.isVoxel;
if (!objOk) pass = false;
console.log(
  `  [object pick] voxel primitive returned: ${JSON.stringify(r.objectPick)} ${objOk ? "ok" : "MISMATCH"}`,
);

// Front/back occlusion: nearer blocker wins the shared pick FBO depth test.
const occ = r.occlusion || {};
const occOk = occ.hit && occ.isBlocker === true;
if (!occOk) pass = false;
console.log(
  `  [occlusion] nearer voxel wins (log depth written+ordered): ${JSON.stringify(occ)} ${occOk ? "ok" : "MISMATCH"}`,
);

const errTotal = (r.consoleErrors?.length || 0) + (r.deviceErrors?.length || 0);
if (errTotal > 0) {
  pass = false;
  console.log("console/device errors:", errTotal, {
    console: r.consoleErrors?.slice(0, 4),
    device: r.deviceErrors?.slice(0, 4),
  });
} else {
  console.log(
    "  [errors] 0 device/console errors (LOG_DEPTH pipelines compiled) ok",
  );
}

console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
