// C-R9-VOXEL-CELL-PICK acceptance probe (VOXEL-CELL-PICK-RELAND),
// extended by NEW-VOXEL-PICK-OCTREE-COMPOSE with Parts B + C, and by
// C4-VOXEL-PICK-OCTREE-L3 (Q9 reconcile) with Part D.
// @purpose Byte-level cross-backend parity of pickVoxelCoordinate decode: single tile, refined L1 octree, customShader alpha gate, refined L3 (Parts A-D).
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
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
//
// ON THE KIT: one rig per part (PART_RIGS); `lib/probe-runtime.mjs` owns
// Edge, origin, slot, deadline, receipt and exit code; `lib/voxel-probe-page.mjs`
// opens the viewer (its WebGPU gate's device errors replace the in-page
// `onuncapturederror` hook, same clause); `lib/metrics/voxel-pick-coordinate.mjs`
// decodes the readbacks. Run: `node server.js --port 8094 --serve-built`.
import { createVoxelOctreeL4Provider } from "./fixtures/voxel-octree-l4.mjs";
import {
  exactC1113VoxelPickPipelineName,
  expectedC1113VoxelPickPipelineName,
} from "./lib/c11-13-voxel-pick-pipeline-name.mjs";
import {
  decodeVoxelPickBytes as decode,
  expectedVoxelSampleIndex as expectedSampleIndex,
  isClearedPick as isCleared,
  levelOneOctantFromSlot,
  levelThreeTileFromSlot,
  pickBytesEqual as bytesEq,
  pickSampleBytesEqual,
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
import INVERTED_RIG from "./rigs/voxel-staircase-front-inverted.mjs";
import TWO_LEVEL_RIG from "./rigs/voxel-two-level-close.mjs";
import L4_PICK_RIG from "./rigs/voxel-octree-l4-pick-close.mjs";

/** Each part's scene. */
const PART_RIGS = Object.freeze({
  A: FRONT_RIG,
  B: TWO_LEVEL_RIG,
  C: INVERTED_RIG,
  D: L4_PICK_RIG,
});
/** Bound on readback attempts per queried pixel (80 ms apart). */
const PIXEL_ATTEMPTS = 12;

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

async function capturePart({
  browser,
  origin,
  renderer,
  part,
  outputDirectory,
  captures,
}) {
  const rig = PART_RIGS[part];
  const { page, diagnostics } = await openVoxelViewer({
    browser,
    origin,
    renderer,
    rig,
  });

  const result = await page.evaluate(
    async ({
      part,
      camera,
      warmup,
      pixelAttempts,
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

      const R = 6378137.0;

      let prim;
      let targets;
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
        // The rig's CLOSE view (10 R) — both backends refine to level 1.
      } else if (part === "D") {
        // 4-level deep-octree fixture — both backends refine to LEVEL 3 at a
        // close view (WebGPU slotCount 585, atlasInfo.y == 3).
        // eslint-disable-next-line no-new-func
        const l4factory = new Function(`return (${l4Src});`)();
        const R4 = 6378137.0;
        const provider = l4factory(C, R4);
        prim = new C.VoxelPrimitive({ provider });
        targets = targetsD;
        // The rig's CLOSE view (6 R) — both backends refine to level 3.
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
      }

      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // Front view (+X looking −X): Y horizontal, Z vertical.
      v.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });

      // Let the provider resolve + the WebGPU root/child-tile uploads finish.
      // The deep (585-slot) atlas needs a longer warmup to fully populate:
      // each part's rig carries its own settle (A/C 240, B 300, D 400).
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
        for (let i = 0; i < pixelAttempts; i++) {
          const r = scene._picking.pickVoxelCoordinate(scene, pos, 1, 1, prim);
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
      };
    },
    {
      part,
      camera: rig.camera,
      warmup: rig.readiness.frames,
      pixelAttempts: PIXEL_ATTEMPTS,
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

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-cell-pick-${part}-${renderer}`,
    outputDirectory,
    captures,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { ...result, capture: shot.name, ...errors };
}

// ─────────────────────────────── judging ───────────────────────────────

/** One verdict in the runtime's shape. */
function verdict(id, claim, pass, detail = null) {
  return { id, claim, pass: pass === true, detail };
}

/** Both readbacks cleared, as a verdict. */
function clearedVerdict(id, claim, gl, gp) {
  return verdict(id, claim, isCleared(gl) && isCleared(gp), {
    webgl: gl ?? null,
    webgpu: gp ?? null,
  });
}

/** Single-tile target: bytes equal cross-backend and both decode to tile 0 / the sample. */
function singleTileOk(gl, gp, expSample) {
  const glDec = decode(gl, DIMS);
  const gpDec = decode(gp, DIMS);
  return (
    bytesEq(gl, gp) &&
    glDec !== null &&
    glDec.tile === 0 &&
    glDec.sample === expSample &&
    gpDec !== null &&
    gpDec.tile === 0 &&
    gpDec.sample === expSample
  );
}

/** Whether a resolved tile `{level, x, y, z}` is the expected one. */
function tileIs(tile, level, expected) {
  return Boolean(
    tile &&
    (level === null || tile.level === level) &&
    tile.x === expected.x &&
    tile.y === expected.y &&
    tile.z === expected.z,
  );
}

const bytesAt = (res, i) => res.picks[i]?.bytes ?? null;

function partAVerdicts(webgl, webgpu, s) {
  const out = TARGETS_A.map((t, i) => {
    const [gl, gp] = [bytesAt(webgl, i), bytesAt(webgpu, i)];
    if (!t.cell) {
      return clearedVerdict(
        `A/${t.label}/${s}`,
        `[A ${t.label}] cleared on both backends`,
        gl,
        gp,
      );
    }
    const exp = expectedSampleIndex(t.cell, DIMS);
    return verdict(
      `A/${t.label}/${s}`,
      `[A ${t.label}] cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${exp}: bytes equal cross-backend and decode to it`,
      singleTileOk(gl, gp, exp),
      { expSample: exp, webgl: gl, webgpu: gp },
    );
  });
  out.push(
    clearedVerdict(
      `A/off-box/${s}`,
      "[A off-box] cleared on both backends",
      webgl.offPick?.bytes,
      webgpu.offPick?.bytes,
    ),
    verdict(
      `A/object-pick/${s}`,
      "[A] object pick returns the VoxelPrimitive on both backends",
      webgl.objectPickOk === true && webgpu.objectPickOk === true,
      { webgl: webgl.objectPickOk, webgpu: webgpu.objectPickOk },
    ),
  );
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
  out.push(
    verdict(
      `A/pick-pipeline-name/${s}`,
      `[A] state-derived pipeline name ${JSON.stringify(expectedPipelineName)}`,
      baseNameOk,
      { actual: webgpu.pickVoxelPipelineName, state: webgpu.pickLogDepthState },
    ),
  );
  return out;
}

function partBVerdicts(webgl, webgpu, s) {
  const tileDims = { x: TILE, y: TILE, z: TILE };
  const out = [
    verdict(
      `B/atlas-refined/${s}`,
      "[B] atlas refined (slotCount=9, all children, level=1)",
      webgpu.usingRealData === true &&
        webgpu.slotCount === 9 &&
        Array.isArray(webgpu.childSlots) &&
        webgpu.childSlots.every((slot) => slot >= 0) &&
        webgpu.lastTargetLevel === 1,
      {
        slotCount: webgpu.slotCount,
        childSlots: webgpu.childSlots,
        lastTargetLevel: webgpu.lastTargetLevel,
      },
    ),
  ];
  TARGETS_B.forEach((t, i) => {
    const [gl, gp] = [bytesAt(webgl, i), bytesAt(webgpu, i)];
    if (t.expOctant === null) {
      out.push(
        clearedVerdict(
          `B/${t.label}/${s}`,
          `[B ${t.label}] cleared on both backends`,
          gl,
          gp,
        ),
      );
      return;
    }
    const [glDec, gpDec] = [decode(gl, tileDims), decode(gp, tileDims)];
    const exp = expectedSampleIndex(t.localCell, tileDims);
    // SAMPLE bytes must be byte-equal AND analytic.
    const sampleOk =
      pickSampleBytesEqual(gl, gp) &&
      glDec?.sample === exp &&
      gpDec?.sample === exp;
    // WebGL tile: resolved through the primitive's own traversal (the
    // Scene.pickVoxel decode) — must be the expected LEVEL-1 octant.
    const glTile = webgl.tileResolves ? webgl.tileResolves[i] : null;
    // WebGPU tile: atlas slot 1..8 → octant (slot-1 = x + 2y + 4z) —
    // must be the SAME level-1 octant (a root pick would read tile 0).
    const gpOctant = levelOneOctantFromSlot(gpDec ? gpDec.tile : -1);
    out.push(
      verdict(
        `B/${t.label}/${s}`,
        `[B ${t.label}] octant(${t.expOctant.x},${t.expOctant.y},${t.expOctant.z}) sample=${exp}: sample bytes equal, both tiles resolve to the octant`,
        sampleOk &&
          tileIs(glTile, 1, t.expOctant) &&
          tileIs(gpOctant, null, t.expOctant),
        {
          expSample: exp,
          webgl: gl,
          webglTile: glTile,
          webgpu: gp,
          webgpuSlot: gpDec ? gpDec.tile : null,
        },
      ),
    );
  });
  out.push(
    clearedVerdict(
      `B/off-box/${s}`,
      "[B off-box] cleared on both backends",
      webgl.offPick?.bytes,
      webgpu.offPick?.bytes,
    ),
  );
  return out;
}

function partCVerdicts(webgl, webgpu, s) {
  // The WebGPU pick pipeline must be the user-customShader variant.
  const out = [
    verdict(
      `C/user-pick-pipeline/${s}`,
      "[C] pick pipeline is the user-customShader variant",
      typeof webgpu.pickVoxelPipelineName === "string" &&
        webgpu.pickVoxelPipelineName.includes("userCustomShader#"),
      { pipeline: webgpu.pickVoxelPipelineName },
    ),
  ];
  TARGETS_C.forEach((t, i) => {
    const [gl, gp] = [bytesAt(webgl, i), bytesAt(webgpu, i)];
    const exp = expectedSampleIndex(t.cell, DIMS);
    out.push(
      verdict(
        `C/${t.label}/${s}`,
        `[C ${t.label}] INVERTED cell(${t.cell.x},${t.cell.y},${t.cell.z}) sample=${exp}: bytes equal cross-backend and decode to it`,
        singleTileOk(gl, gp, exp),
        { expSample: exp, webgl: gl, webgpu: gp },
      ),
    );
  });
  return out;
}

function partDVerdicts(webgl, webgpu, s) {
  // The WebGPU atlas must have refined to the full depth-3 585-slot atlas —
  // the precondition for the pick's shared octreeDescend to reach level 3.
  const out = [
    verdict(
      `D/atlas-depth-3/${s}`,
      "[D] atlas refined to depth 3 (slotCount=585, level=3)",
      webgpu.usingRealData === true &&
        webgpu.slotCount === 585 &&
        webgpu.lastTargetLevel === 3,
      { slotCount: webgpu.slotCount, lastTargetLevel: webgpu.lastTargetLevel },
    ),
  ];
  TARGETS_D.forEach((t, i) => {
    const [gl, gp] = [bytesAt(webgl, i), bytesAt(webgpu, i)];
    if (t.expTile === null) {
      out.push(
        clearedVerdict(
          `D/${t.label}/${s}`,
          `[D ${t.label}] cleared on both backends`,
          gl,
          gp,
        ),
      );
      return;
    }
    // SAMPLE bytes (child-local cell within the 2×2×2 L3 tile) must be
    // byte-equal cross-backend AND non-cleared (a real hit).
    const sampleOk = pickSampleBytesEqual(gl, gp) && !isCleared(gl);
    // WebGL tile resolved through the primitive's own traversal → must be
    // the expected LEVEL-3 spatial tile.
    const glTile = webgl.tileResolves ? webgl.tileResolves[i] : null;
    // WebGPU tile: an L3 atlas slot (>= 73) that inverts to the SAME
    // level-3 spatial tile — proves the pick descended the shared
    // octreeDescend all the way to level 3, not root/L1/L2.
    const gpSlot = gp ? 255 * gp[0] + gp[1] : -1;
    const gpTile = levelThreeTileFromSlot(gpSlot, webgpu.l3Slots);
    out.push(
      verdict(
        `D/${t.label}/${s}`,
        `[D ${t.label}] L3 tile(${t.expTile.x},${t.expTile.y},${t.expTile.z}): sample bytes equal and real, both tiles resolve to it`,
        sampleOk &&
          tileIs(glTile, 3, t.expTile) &&
          gpSlot >= 73 &&
          tileIs(gpTile, 3, t.expTile),
        {
          webgl: gl,
          webglTile: glTile,
          webgpu: gp,
          webgpuSlot: gpSlot,
          webgpuTile: gpTile,
        },
      ),
    );
  });
  out.push(
    clearedVerdict(
      `D/off-box/${s}`,
      "[D off-box] cleared on both backends",
      webgl.offPick?.bytes,
      webgpu.offPick?.bytes,
    ),
  );
  return out;
}

/**
 * Every part's clauses over one run's cell, plus the one error clause the
 * pre-migration probe summed across all eight captures. Pure and exported
 * for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateVoxelCellPick(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const s = `run${cell.run}`;
    const { A, B, C, D } = cell.parts;
    verdicts.push(
      ...partAVerdicts(A.webgl, A.webgpu, s),
      ...partBVerdicts(B.webgl, B.webgpu, s),
      ...partCVerdicts(C.webgl, C.webgpu, s),
      ...partDVerdicts(D.webgl, D.webgpu, s),
    );
    const legs = Object.values(cell.parts).flatMap((part) =>
      Object.values(part),
    );
    const errTotal = legs.reduce(
      (sum, res) => sum + res.consoleErrors.length + res.deviceErrors.length,
      0,
    );
    verdicts.push(
      verdict(
        `errors/${s}`,
        `console/device errors: ${errTotal}`,
        errTotal === 0,
        {
          console: legs.flatMap((res) => res.consoleErrors).slice(0, 6),
          device: legs.flatMap((res) => res.deviceErrors).slice(0, 6),
        },
      ),
    );
  }
  return verdicts;
}

function printReport(receipt) {
  for (const cell of receipt.cells) {
    for (const [part, legs] of Object.entries(cell.parts)) {
      const w = legs.webgpu;
      console.log(
        `Part ${part} WebGPU setup:`,
        JSON.stringify({
          usingRealData: w.usingRealData,
          slotCount: w.slotCount,
          lastTargetLevel: w.lastTargetLevel,
          pipeline: w.pickVoxelPipelineName,
        }),
      );
    }
  }
  for (const v of receipt.verdicts) {
    console.log(`  [${v.pass ? "PASS" : "FAIL"}] ${v.claim}`);
  }
  const pass = receipt.verdicts.every((v) => v.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
}

/** Pixels queried per part: its targets plus the one off-box pixel. */
const PIXELS_QUERIED =
  TARGETS_A.length + TARGETS_B.length + TARGETS_C.length + TARGETS_D.length + 4;

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-cell-pick",
  title:
    "Voxel pickVoxelCoordinate cross-backend byte parity (Parts A-D: single tile, refined L1, user alpha gate, refined L3)",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-cell-pick-<part>-<renderer>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // Eight pages (four parts, two backends): each part's rig settle, Part A's
  // ten-frame object-pick settle, and every queried pixel at its attempt bound.
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: 4 * options.renderers.length,
      frames:
        options.renderers.length *
        (Object.values(PART_RIGS).reduce(
          (sum, r) => sum + r.readiness.frames,
          0,
        ) +
          10 +
          PIXELS_QUERIED * PIXEL_ATTEMPTS),
      captures: 4 * options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const missing = missingRenderers(options.renderers, ["webgl", "webgpu"]);
    if (missing.length > 0) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-cell-pick compares readback bytes across backends and cannot run without ${missing.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    const parts = {};
    for (const part of ["A", "B", "C", "D"]) {
      parts[part] = {
        webgl: await capturePart({ ...legs, renderer: "webgl", part }),
        webgpu: await capturePart({ ...legs, renderer: "webgpu", part }),
      };
    }
    return [{ run, parts }];
  },
  verdicts(cells) {
    return evaluateVoxelCellPick(cells);
  },
  receipt(cells, context) {
    const rigs = Object.fromEntries(
      Object.entries(PART_RIGS).map(([part, rig]) => [part, rig.id]),
    );
    const receipt = { rigs, cells, verdicts: context.verdicts };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
