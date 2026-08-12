// C-R9-VOXEL-CELL-PICK acceptance probe (VOXEL-CELL-PICK-RELAND),
// extended by NEW-VOXEL-PICK-OCTREE-COMPOSE with Parts B + C, and by
// C4-VOXEL-PICK-OCTREE-L3 (Q9 reconcile) with Part D.
//
// Verifies per-cell voxel picking parity: `Picking.pickVoxelCoordinate`
// (the GPU pass behind `Scene.pickVoxel`) must decode to EXACTLY the same
// {tileIndex, sampleIndex} — and therefore the same cell {x,y,z} — on WebGPU
// as on WebGL.
//
// Part A (single tile, default density gate — the original probe):
//   * 2×4×3 Y_UP staircase provider; at each filled-cell target pixel the 4
//     readback bytes match WebGL byte-for-byte and decode to the analytic
//     first-hit cell; empty-column + off-box pixels return cleared [0,0,0,0];
//     object pick still returns the VoxelPrimitive on both backends.
//
// Part B (NEW-VOXEL-PICK-OCTREE-COMPOSE — refined L1 octree pick):
//   * Two-level provider (availableLevels=2, per-tile 4×4×4, fine 8×8×8 thin
//     diagonal fy==fz) at the probe-voxel-octree CLOSE camera so BOTH
//     backends refine (WebGPU atlasInfo.y >= 1). At on-diagonal fine targets
//     the SAMPLE bytes are byte-equal WebGL and both backends' decode chains
//     identify the SAME level-1 SPATIAL TILE + child-local cell.
//     NOTE on the tile bytes: WebGL's megatextureIndex is assigned in
//     priority-queue LOAD order (camera/timing dependent — see
//     VoxelTraversal.updateKeyframeNodes), and Scene.pickVoxel resolves it
//     through the primitive's OWN traversal (findKeyframeNode). It is an
//     opaque backend-internal handle, so cross-backend byte-equality of the
//     tile bytes is only well-defined for the root/single-tile case (tile 0,
//     Parts A/C). Part B therefore resolves WebGL's tile through
//     `_traversal.findKeyframeNode(tileIndex).spatialNode` (the exact
//     Scene.pickVoxel decode) and WebGPU's tile through its deterministic
//     atlas slot→octant mapping (slot = 1 + (x + 2y + 4z)), and asserts both
//     land on the SAME spatial octant. Off-diagonal columns return cleared
//     on both backends (full 4-byte equality).
//
// Part C (NEW-VOXEL-PICK-OCTREE-COMPOSE — user-customShader alpha gate):
//   * Part A's provider with a DUAL-language CustomShader remapping
//     alpha = 1 - color.a (GLSL for WebGL, native WGSL for WebGPU): the
//     visually-opaque cells are the previously-EMPTY ones. The picked cell
//     must be the analytic first INVERTED-filled cell, byte-equal across
//     backends — proving the WebGPU pick winner gate follows the user
//     shader's alpha, not the raw-texel density gate.
//
// Part D (C4-VOXEL-PICK-OCTREE-L3 — refined LEVEL-3 octree pick):
//   * The 4-level deep-octree fixture (fixtures/voxel-octree-l4.mjs,
//     availableLevels=4, 2×2×2 per tile, diagonal gy==gz) at a CLOSE view
//     where BOTH backends refine to level 3 (WebGPU atlasInfo.y == 3,
//     slotCount == 585). At on-diagonal fine (16-grid) targets the pick must
//     descend the SAME shared octreeDescend walk the color march uses ALL THE
//     WAY to level 3: the WebGPU pick tile is an L3 atlas slot (>= 73) whose
//     l3Slots inverse maps to the SAME level-3 spatial tile WebGL's own
//     traversal (findKeyframeNode) resolves, with byte-equal SAMPLE bytes
//     (same child-local cell). This locks the "reach color-march L3" bullet:
//     the pick is not root-biased and not clamped to L1/L2. Off-diagonal
//     columns return cleared on both backends.
//
// WebGPU note: `readCenterPixel` is an armed async readback (returns the
// cleared pixel on a cold query, converges 1-2 picks later —
// NEW-PICK-METADATA-READBACK contract), so each pixel is queried in a short
// retry loop until two consecutive results agree.
import { chromium } from "playwright";
import fs from "fs";
import { createVoxelOctreeL4Provider } from "./fixtures/voxel-octree-l4.mjs";
import {
  exactC1113VoxelPickPipelineName,
  expectedC1113VoxelPickPipelineName,
} from "./lib/c11-13-voxel-pick-pipeline-name.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// ───────────────────────── Part A / C shared asset ─────────────────────────

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
const TARGETS_A = [
  { label: "y0z0", y: 0, z: 0, cell: { x: 1, y: 0, z: 0 } },
  { label: "y1z1", y: 1, z: 1, cell: { x: 1, y: 1, z: 1 } },
  { label: "y2z2", y: 2, z: 2, cell: { x: 1, y: 2, z: 2 } },
  { label: "y3z1", y: 3, z: 1, cell: { x: 0, y: 3, z: 1 } },
  { label: "y0z2-empty", y: 0, z: 2, cell: null },
  { label: "y2z0-empty", y: 2, z: 0, cell: null },
];

// Part C: alpha = 1 - color.a inverts the fill — the expected pick is the
// first INVERTED-filled cell along the same +X→−X rays. Every column has at
// least one inverted-filled cell (no all-filled column exists in the asset).
const TARGETS_C = [
  { label: "y0z0-inv", y: 0, z: 0, cell: { x: 0, y: 0, z: 0 } },
  { label: "y1z1-inv", y: 1, z: 1, cell: { x: 0, y: 1, z: 1 } },
  { label: "y0z2-inv", y: 0, z: 2, cell: { x: 1, y: 0, z: 2 } },
  { label: "y3z1-inv", y: 3, z: 1, cell: { x: 1, y: 3, z: 1 } },
];

// Z-up cell → input-orientation (glTF Y-up) sample index, mirroring
// Octree.glsl's Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip over the padded
// input dims (no padding here): input (ix,iy,iz) = (x, z, dimsY-1-y),
// inputDims = (dimsX, dimsZ, dimsY), sampleIndex = ix + inX*(iy + inY*iz).
function expectedSampleIndex(cell, dims) {
  const inX = dims.x;
  const inY = dims.z;
  const ix = cell.x;
  const iy = cell.z;
  const iz = dims.y - 1 - cell.y;
  return ix + inX * (iy + inY * iz);
}

function decode(bytes, dims) {
  if (!bytes) {
    return null;
  }
  const tile = 255 * bytes[0] + bytes[1];
  const sample = 255 * bytes[2] + bytes[3];
  const inX = dims.x;
  const inY = dims.z;
  const ix = sample % inX;
  const iy = Math.floor(sample / inX) % inY;
  const iz = Math.floor(sample / (inX * inY));
  // input (ix,iy,iz) → Z-up cell (x, dimsY-1-iz, iy)
  return {
    tile,
    sample,
    cell: { x: ix, y: dims.y - 1 - iz, z: iy },
  };
}

// ───────────────────────── Part B (octree) asset ─────────────────────────

const TILE = 4;
const FINE = TILE * 2;

// Fine 8x8x8 grid: thin diagonal in (y,z), extruded along x; root = fat
// conservative downsample (y == z) — same asset as probe-voxel-octree.
// On-diagonal targets hit fine cell (7, k, k) first (front view): child
// octant (1, k>>2, k>>2) → atlas slot 1 + (1 + 2(k>>2) + 4(k>>2)), local
// cell (3, k%4, k%4).
function partBTargets() {
  const targets = [];
  for (const k of [0, 3, 4, 7]) {
    const c = k >> 2;
    targets.push({
      label: `diag-y${k}z${k}`,
      fy: k,
      fz: k,
      // Expected level-1 spatial octant (Z-up shape frame).
      expOctant: { x: 1, y: c, z: c },
      localCell: { x: 3, y: k % 4, z: k % 4 },
    });
  }
  targets.push({ label: "off-y2z5-empty", fy: 2, fz: 5, expOctant: null });
  targets.push({ label: "off-y6z1-empty", fy: 6, fz: 1, expOctant: null });
  return targets;
}
const TARGETS_B = partBTargets();

// ───────────────────────── Part D (L3 octree) asset ─────────────────────────

// 4-level deep-octree fixture: 16-grid finest, diagonal gy==gz. On-diagonal
// fine targets (gy==gz) are FILLED at every level, so the ray's first −X hit
// (gx=15) lands in the level-3 tile floor(15/2)=7, floor(k/2), floor(k/2). The
// pick must descend all the way to that level-3 tile.
const L3_FINE = 16;
function partDTargets() {
  const targets = [];
  for (const k of [4, 6, 8, 10]) {
    const c = k >> 1;
    targets.push({
      label: `l3-diag-y${k}z${k}`,
      fy: k,
      fz: k,
      // Expected level-3 spatial tile (Z-up shape frame).
      expTile: { x: 7, y: c, z: c },
    });
  }
  // NOTE: no in-footprint "empty column" target here. Upstream WebGL refines
  // the octree PER-NODE (mixed L2/L3 across the volume is legitimate — see
  // probe-voxel-octree-l3plus), so an off-diagonal cell that is empty at the
  // WebGPU-uniform level 3 can be FILLED at the coarser level WebGL happens to
  // hold there. Cross-backend cleared-equality is only well-defined off-box,
  // which the shared `offPick` check covers.
  return targets;
}
const TARGETS_D = partDTargets();

// ─────────────────────────── capture harness ───────────────────────────

async function capture(renderer, part) {
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
    async ({
      part,
      dims,
      filledSrc,
      targetsA,
      targetsC,
      targetsB,
      targetsD,
      tile,
      fine,
      l3Fine,
      l4Src,
    }) => {
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

      let prim;
      let targets;
      let camDestX;
      if (part === "B") {
        // Two-level provider (probe-voxel-octree asset): per-tile 4×4×4,
        // fine 8×8×8 thin diagonal fy==fz, root fat diagonal y==z.
        function makeTile(fillFn) {
          const data = new Float32Array(tile * tile * tile * 4);
          for (let z = 0; z < tile; z++) {
            for (let y = 0; y < tile; y++) {
              for (let x = 0; x < tile; x++) {
                const idx = x + tile * (z + tile * (tile - 1 - y));
                const d = idx * 4;
                data[d] = 0.7;
                data[d + 1] = 0.7;
                data[d + 2] = 0.7;
                data[d + 3] = fillFn(x, y, z) ? 1.0 : 0.0;
              }
            }
          }
          return data;
        }
        const rootData = makeTile((x, y, z) => y === z);
        function makeChild(cx, cy, cz) {
          return makeTile((lx, ly, lz) => cy * tile + ly === cz * tile + lz);
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
    material.diffuse = vec3(0.7);
    material.alpha = fsInput.metadata.color.a;
}`,
        });
        prim = new C.VoxelPrimitive({ provider, customShader });
        targets = targetsB;
        camDestX = 10; // CLOSE view — both backends refine to level 1.
      } else if (part === "D") {
        // 4-level deep-octree fixture — both backends refine to LEVEL 3 at a
        // close view (WebGPU slotCount 585, atlasInfo.y == 3).
        // eslint-disable-next-line no-new-func
        const l4factory = new Function(`return (${l4Src});`)();
        const R4 = 6378137.0;
        const provider = l4factory(C, R4);
        prim = new C.VoxelPrimitive({ provider });
        targets = targetsD;
        camDestX = 6; // CLOSE view — both backends refine to level 3.
      } else {
        // Parts A + C: single-tile 2×4×3 staircase, INPUT (glTF Y-up) order.
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

        let customShader;
        if (part === "C") {
          // DUAL-language user shader remapping alpha = 1 - color.a: the
          // visually-opaque cells are the previously-empty ones. WebGL runs
          // the GLSL; WebGPU runs the native WGSL through the
          // VOXEL-USER-CUSTOMSHADER codegen (and its pick-gate compose).
          customShader = new C.CustomShader({
            fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    float a = 1.0 - fsInput.metadata.color.a;
    material.diffuse = vec3(0.9, 0.5, 0.1) * a;
    material.alpha = a;
}`,
            wgslFragmentShaderText: `fn czm_voxelCustomFragmentMain(fsInput: czm_voxelCustomFragmentInput,
    material: ptr<function, czm_voxelCustomMaterial>) {
  let a = 1.0 - fsInput.metadata.color.a;
  (*material).diffuse = vec3<f32>(0.9, 0.5, 0.1) * a;
  (*material).alpha = a;
}`,
          });
        } else {
          // Part A ground truth: alpha-gated custom shader (the WebGPU
          // parity march applies the equivalent density gate internally).
          customShader = new C.CustomShader({
            fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = fsInput.metadata.color.a;
}`,
          });
        }
        prim = new C.VoxelPrimitive({ provider, customShader });
        targets = part === "C" ? targetsC : targetsA;
        camDestX = 4;
      }

      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // Front view (+X looking −X): Y horizontal, Z vertical.
      v.camera.setView({
        destination: new C.Cartesian3(camDestX * R, 0, 0),
        orientation: {
          direction: new C.Cartesian3(-1, 0, 0),
          up: new C.Cartesian3(0, 0, 1),
        },
      });

      // Let the provider resolve + the WebGPU root/child-tile uploads finish.
      // The deep (585-slot) atlas needs a longer warmup to fully populate.
      const warmup = part === "D" ? 400 : part === "B" ? 300 : 240;
      for (let i = 0; i < warmup; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 8));
      }

      // Window coordinate of each target cell-column center.
      let windows;
      if (part === "B" || part === "D") {
        const grid = part === "D" ? l3Fine : fine;
        const cc = (i) => -1 + ((i + 0.5) * 2) / grid;
        windows = targets.map((t) => {
          const world = new C.Cartesian3(0, cc(t.fy) * R, cc(t.fz) * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          return win ? { x: win.x, y: win.y } : null;
        });
      } else {
        const cy = (y) => -1 + ((y + 0.5) * 2) / dims.y;
        const cz = (z) => -1 + ((z + 0.5) * 2) / dims.z;
        windows = targets.map((t) => {
          const world = new C.Cartesian3(0, cy(t.y) * R, cz(t.z) * R);
          const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
          return win ? { x: win.x, y: win.y } : null;
        });
      }
      // Off-box pixel: a world point beside the box over black background.
      const offWin = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        new C.Cartesian3(0, 1.8 * R, 0),
      );

      // Object pick over the voxel (Part A only — regular pick must still
      // return the VoxelPrimitive).
      let objectPickOk = null;
      if (part === "A") {
        const centerWin = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          new C.Cartesian3(0, (-1 + 1 / dims.y) * R, (-1 + 1 / dims.z) * R),
        );
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
            // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
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

      // Parts B/D: resolve each picked tileIndex through the primitive's OWN
      // traversal (the exact Scene.pickVoxel decode) — WebGL only; the
      // WebGPU path's slot→tile mapping is deterministic and judged in
      // Node from the raw tile index (Part B via octant, Part D via l3Slots).
      let tileResolves = null;
      if (
        (part === "B" || part === "D") &&
        prim._traversal &&
        typeof prim._traversal.findKeyframeNode === "function"
      ) {
        tileResolves = picks.map((p) => {
          const b = p.bytes;
          if (!b || b.length !== 4 || b.every((x) => x === 0)) {
            return null;
          }
          const tileIndex = 255 * b[0] + b[1];
          try {
            const kn = prim._traversal.findKeyframeNode(tileIndex);
            const sn = kn && kn.spatialNode;
            return sn ? { level: sn.level, x: sn.x, y: sn.y, z: sn.z } : null;
          } catch (e) {
            return { error: String(e).slice(0, 100) };
          }
        });
      }

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
        slotCount: du ? du.slotCount : null,
        childSlots: du && du.childSlots ? Array.from(du.childSlots) : null,
        l2Slots: du && du.l2Slots ? Array.from(du.l2Slots) : null,
        l3Slots: du && du.l3Slots ? Array.from(du.l3Slots) : null,
        lastTargetLevel: du ? du.lastTargetLevel : null,
        tileResolves,
        pickVoxelPipelineName:
          cache && cache.pickVoxelDescriptor
            ? cache.pickVoxelDescriptor.name
            : null,
        pickLogDepthState: cache
          ? {
              master: scene.context._pickLogDepthWriteEnabled,
              frame: scene.frameState.useLogDepth,
              realized: cache._pipelinePickLogActive,
            }
          : null,
        hasPickVoxelCommand: cache ? !!cache.pickVoxelCommand : null,
        objectPickOk,
        picks,
        offPick,
        deviceErrors: errors,
      };
    },
    {
      part,
      dims: DIMS,
      filledSrc: cellFilled.toString(),
      targetsA: TARGETS_A,
      targetsC: TARGETS_C,
      targetsB: TARGETS_B,
      targetsD: TARGETS_D,
      tile: TILE,
      fine: FINE,
      l3Fine: L3_FINE,
      l4Src: createVoxelOctreeL4Provider.toString(),
    },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-cell-pick-${part}-${renderer}.png`, buf);

  await page.close();
  return { ...result, consoleErrors };
}

// ─────────────────────────────── judging ───────────────────────────────

const isCleared = (b) =>
  Array.isArray(b) && b.length === 4 && b.every((x) => x === 0);

function bytesEq(a, b) {
  return (
    a && b && a.length === 4 && b.length === 4 && a.every((v, k) => v === b[k])
  );
}

let pass = true;
let errTotal = 0;

function tallyErrors(label, res) {
  const n =
    res.consoleErrors.length + (res.deviceErrors ? res.deviceErrors.length : 0);
  errTotal += n;
  if (n > 0) {
    console.log(
      `  [${label}] errors:`,
      res.consoleErrors.slice(0, 3),
      res.deviceErrors?.slice(0, 3),
    );
  }
}

// ── Part A ──
{
  const webgl = await capture("webgl", "A");
  const webgpu = await capture("webgpu", "A");
  console.log("=== Part A — single tile, default density gate ===");
  console.log(
    "WebGPU setup:",
    JSON.stringify({
      usingRealData: webgpu.usingRealData,
      uploadPhase: webgpu.uploadPhase,
      hasPickVoxelCommand: webgpu.hasPickVoxelCommand,
      pipeline: webgpu.pickVoxelPipelineName,
    }),
  );
  for (let i = 0; i < TARGETS_A.length; i++) {
    const t = TARGETS_A[i];
    const gl = webgl.picks[i]?.bytes ?? null;
    const gp = webgpu.picks[i]?.bytes ?? null;
    const glDec = decode(gl, DIMS);
    const gpDec = decode(gp, DIMS);
    let verdict;
    if (t.cell) {
      const expSample = expectedSampleIndex(t.cell, DIMS);
      const ok =
        bytesEq(gl, gp) &&
        glDec &&
        glDec.tile === 0 &&
        glDec.sample === expSample &&
        gpDec &&
        gpDec.tile === 0 &&
        gpDec.sample === expSample;
      verdict = ok ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${expSample} | ` +
          `webgl=${JSON.stringify(gl)} webgpu=${JSON.stringify(gp)} ${verdict}`,
      );
    } else {
      verdict = isCleared(gl) && isCleared(gp) ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect cleared | webgl=${JSON.stringify(gl)} webgpu=${JSON.stringify(gp)} ${verdict}`,
      );
    }
    if (verdict !== "ok") pass = false;
  }
  const offOk =
    isCleared(webgl.offPick?.bytes) && isCleared(webgpu.offPick?.bytes);
  console.log(`  [off-box] cleared: ${offOk ? "ok" : "MISMATCH"}`);
  if (!offOk) pass = false;
  const objectPickOk =
    webgl.objectPickOk === true && webgpu.objectPickOk === true;
  console.log(`  objectPickOk: ${objectPickOk}`);
  if (!objectPickOk) pass = false;
  // Part A state gate: derive the one exact expected name from independent
  // master, frame, and realized log-depth booleans. Never accept either name
  // loosely or infer the expected suffix from the descriptor under test.
  const expectedPipelineName = expectedC1113VoxelPickPipelineName(
    webgpu.pickLogDepthState,
  );
  const baseNameOk = exactC1113VoxelPickPipelineName(
    webgpu.pickLogDepthState,
    webgpu.pickVoxelPipelineName,
  );
  console.log(
    `  state-derived pipeline name ${JSON.stringify(expectedPipelineName)}: ${baseNameOk}`,
  );
  if (!baseNameOk) pass = false;
  tallyErrors("A webgl", webgl);
  tallyErrors("A webgpu", webgpu);
}

// ── Part B ──
{
  const webgl = await capture("webgl", "B");
  const webgpu = await capture("webgpu", "B");
  console.log("=== Part B — refined L1 octree pick (compose) ===");
  console.log(
    "WebGPU setup:",
    JSON.stringify({
      usingRealData: webgpu.usingRealData,
      slotCount: webgpu.slotCount,
      childSlots: webgpu.childSlots,
      lastTargetLevel: webgpu.lastTargetLevel,
    }),
  );
  const atlasOk =
    webgpu.usingRealData === true &&
    webgpu.slotCount === 9 &&
    Array.isArray(webgpu.childSlots) &&
    webgpu.childSlots.every((s) => s >= 0) &&
    webgpu.lastTargetLevel === 1;
  console.log(
    `  atlas refined (slotCount=9, all children, level=1): ${atlasOk}`,
  );
  if (!atlasOk) pass = false;
  const tileDims = { x: TILE, y: TILE, z: TILE };
  for (let i = 0; i < TARGETS_B.length; i++) {
    const t = TARGETS_B[i];
    const gl = webgl.picks[i]?.bytes ?? null;
    const gp = webgpu.picks[i]?.bytes ?? null;
    const glDec = decode(gl, tileDims);
    const gpDec = decode(gp, tileDims);
    let verdict;
    if (t.expOctant !== null) {
      const expSample = expectedSampleIndex(t.localCell, tileDims);
      // SAMPLE bytes must be byte-equal AND analytic.
      const sampleOk =
        gl &&
        gp &&
        gl.length === 4 &&
        gp.length === 4 &&
        gl[2] === gp[2] &&
        gl[3] === gp[3] &&
        glDec &&
        glDec.sample === expSample &&
        gpDec &&
        gpDec.sample === expSample;
      // WebGL tile: resolved through the primitive's own traversal (the
      // Scene.pickVoxel decode) — must be the expected LEVEL-1 octant.
      const glTile = webgl.tileResolves ? webgl.tileResolves[i] : null;
      const glTileOk =
        glTile &&
        glTile.level === 1 &&
        glTile.x === t.expOctant.x &&
        glTile.y === t.expOctant.y &&
        glTile.z === t.expOctant.z;
      // WebGPU tile: atlas slot 1..8 → octant (slot-1 = x + 2y + 4z) —
      // must be the SAME level-1 octant (a root pick would read tile 0).
      const slot = gpDec ? gpDec.tile : -1;
      const gpTileOk =
        slot >= 1 &&
        slot <= 8 &&
        ((slot - 1) & 1) === t.expOctant.x &&
        (((slot - 1) >> 1) & 1) === t.expOctant.y &&
        (((slot - 1) >> 2) & 1) === t.expOctant.z;
      verdict = sampleOk && glTileOk && gpTileOk ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect octant(${t.expOctant.x},${t.expOctant.y},${t.expOctant.z}) localCell(${t.localCell.x},${t.localCell.y},${t.localCell.z}) sample=${expSample} | ` +
          `webgl=${JSON.stringify(gl)}→tile${glDec ? glDec.tile : "?"}=${JSON.stringify(glTile)}/s${glDec ? glDec.sample : "?"} ` +
          `webgpu=${JSON.stringify(gp)}→slot${gpDec ? gpDec.tile : "?"}/s${gpDec ? gpDec.sample : "?"} ${verdict}`,
      );
    } else {
      verdict = isCleared(gl) && isCleared(gp) ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect cleared | webgl=${JSON.stringify(gl)} webgpu=${JSON.stringify(gp)} ${verdict}`,
      );
    }
    if (verdict !== "ok") pass = false;
  }
  const offOk =
    isCleared(webgl.offPick?.bytes) && isCleared(webgpu.offPick?.bytes);
  console.log(`  [off-box] cleared: ${offOk ? "ok" : "MISMATCH"}`);
  if (!offOk) pass = false;
  tallyErrors("B webgl", webgl);
  tallyErrors("B webgpu", webgpu);
}

// ── Part C ──
{
  const webgl = await capture("webgl", "C");
  const webgpu = await capture("webgpu", "C");
  console.log("=== Part C — user-customShader alpha-remap pick gate ===");
  console.log(
    "WebGPU setup:",
    JSON.stringify({
      usingRealData: webgpu.usingRealData,
      pipeline: webgpu.pickVoxelPipelineName,
    }),
  );
  // The WebGPU pick pipeline must be the user-customShader variant.
  const userPipelineOk =
    typeof webgpu.pickVoxelPipelineName === "string" &&
    webgpu.pickVoxelPipelineName.includes("userCustomShader#");
  console.log(`  pick pipeline is user variant: ${userPipelineOk}`);
  if (!userPipelineOk) pass = false;
  for (let i = 0; i < TARGETS_C.length; i++) {
    const t = TARGETS_C[i];
    const gl = webgl.picks[i]?.bytes ?? null;
    const gp = webgpu.picks[i]?.bytes ?? null;
    const glDec = decode(gl, DIMS);
    const gpDec = decode(gp, DIMS);
    const expSample = expectedSampleIndex(t.cell, DIMS);
    const ok =
      bytesEq(gl, gp) &&
      glDec &&
      glDec.tile === 0 &&
      glDec.sample === expSample &&
      gpDec &&
      gpDec.tile === 0 &&
      gpDec.sample === expSample;
    const verdict = ok ? "ok" : "MISMATCH";
    console.log(
      `  [${t.label}] expect INVERTED cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${expSample} | ` +
        `webgl=${JSON.stringify(gl)}→${glDec ? `t${glDec.tile}/s${glDec.sample}/cell(${glDec.cell.x},${glDec.cell.y},${glDec.cell.z})` : "?"} ` +
        `webgpu=${JSON.stringify(gp)}→${gpDec ? `t${gpDec.tile}/s${gpDec.sample}/cell(${gpDec.cell.x},${gpDec.cell.y},${gpDec.cell.z})` : "?"} ${verdict}`,
    );
    if (!ok) pass = false;
  }
  tallyErrors("C webgl", webgl);
  tallyErrors("C webgpu", webgpu);
}

// ── Part D ──
{
  const webgl = await capture("webgl", "D");
  const webgpu = await capture("webgpu", "D");
  console.log(
    "=== Part D — refined LEVEL-3 octree pick (C4-VOXEL-PICK-OCTREE-L3) ===",
  );
  console.log(
    "WebGPU setup:",
    JSON.stringify({
      usingRealData: webgpu.usingRealData,
      slotCount: webgpu.slotCount,
      lastTargetLevel: webgpu.lastTargetLevel,
    }),
  );
  // The WebGPU atlas must have refined to the full depth-3 585-slot atlas —
  // the precondition for the pick's shared octreeDescend to reach level 3.
  const atlasOk =
    webgpu.usingRealData === true &&
    webgpu.slotCount === 585 &&
    webgpu.lastTargetLevel === 3;
  console.log(
    `  atlas refined to depth 3 (slotCount=585, level=3): ${atlasOk}`,
  );
  if (!atlasOk) pass = false;
  // Invert a WebGPU L3 atlas slot (>= 73) back to its level-3 tile coordinate
  // through the uploaded l3Slots map (idx = x + 8y + 64z, base slot 73 region).
  function gpL3Tile(slot, l3Slots) {
    if (!(slot >= 73) || !Array.isArray(l3Slots)) {
      return null;
    }
    const idx = l3Slots.indexOf(slot);
    if (idx < 0) {
      return null;
    }
    return {
      level: 3,
      x: idx % 8,
      y: Math.floor(idx / 8) % 8,
      z: Math.floor(idx / 64),
    };
  }
  for (let i = 0; i < TARGETS_D.length; i++) {
    const t = TARGETS_D[i];
    const gl = webgl.picks[i]?.bytes ?? null;
    const gp = webgpu.picks[i]?.bytes ?? null;
    let verdict;
    if (t.expTile !== null) {
      // SAMPLE bytes (child-local cell within the 2×2×2 L3 tile) must be
      // byte-equal cross-backend AND non-cleared (a real hit).
      const sampleOk =
        gl &&
        gp &&
        gl.length === 4 &&
        gp.length === 4 &&
        gl[2] === gp[2] &&
        gl[3] === gp[3] &&
        !(gl[0] === 0 && gl[1] === 0 && gl[2] === 0 && gl[3] === 0);
      // WebGL tile resolved through the primitive's own traversal → must be
      // the expected LEVEL-3 spatial tile.
      const glTile = webgl.tileResolves ? webgl.tileResolves[i] : null;
      const glTileOk =
        glTile &&
        glTile.level === 3 &&
        glTile.x === t.expTile.x &&
        glTile.y === t.expTile.y &&
        glTile.z === t.expTile.z;
      // WebGPU tile: an L3 atlas slot (>= 73) that inverts to the SAME
      // level-3 spatial tile — proves the pick descended the shared
      // octreeDescend all the way to level 3, not root/L1/L2.
      const gpSlot = gp ? 255 * gp[0] + gp[1] : -1;
      const gpTile = gpL3Tile(gpSlot, webgpu.l3Slots);
      const gpTileOk =
        gpSlot >= 73 &&
        gpTile &&
        gpTile.x === t.expTile.x &&
        gpTile.y === t.expTile.y &&
        gpTile.z === t.expTile.z;
      verdict = sampleOk && glTileOk && gpTileOk ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect L3 tile(${t.expTile.x},${t.expTile.y},${t.expTile.z}) | ` +
          `webgl=${JSON.stringify(gl)}→${JSON.stringify(glTile)} ` +
          `webgpu=${JSON.stringify(gp)}→slot${gpSlot}=${JSON.stringify(gpTile)} ${verdict}`,
      );
    } else {
      verdict = isCleared(gl) && isCleared(gp) ? "ok" : "MISMATCH";
      console.log(
        `  [${t.label}] expect cleared | webgl=${JSON.stringify(gl)} webgpu=${JSON.stringify(gp)} ${verdict}`,
      );
    }
    if (verdict !== "ok") pass = false;
  }
  const offOk =
    isCleared(webgl.offPick?.bytes) && isCleared(webgpu.offPick?.bytes);
  console.log(`  [off-box] cleared: ${offOk ? "ok" : "MISMATCH"}`);
  if (!offOk) pass = false;
  tallyErrors("D webgl", webgl);
  tallyErrors("D webgpu", webgpu);
}

console.log("console/device errors:", errTotal);
if (errTotal > 0) pass = false;

console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
