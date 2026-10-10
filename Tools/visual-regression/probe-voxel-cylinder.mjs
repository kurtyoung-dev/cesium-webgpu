// NEW-VOXEL-CYLINDER-SHAPEUV (B24) acceptance probe.
// @purpose Acceptance: WebGPU voxel march intersects a bounded hollow cylinder (not the box proxy) and cylindrical shapeUv cell colors match WebGL.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Renders the SAME procedural CYLINDER-shape VoxelPrimitive (hollow — a
// nonzero inner radius exercises the inner-cylinder hole interval AND the
// radial scale/offset shapeUv terms) on BOTH the WebGL and the WebGPU
// renderer at an identical fixed camera, then compares the
// footprint/silhouette masks AND the per-cell sampled colors.
//
// What it verifies:
//   * Intersection — the WebGPU ray-march intersects the BOUNDED CYLINDER
//     (outer radius x height slab, minus the inner-radius hole), not the box
//     OBB proxy: footprint IoU and coverage-area ratio are the
//     discriminators (a box silhouette against WebGL's rounded side + flat
//     caps lands well under the gate).
//   * shapeUv — interior per-cell content addressing: every voxel cell
//     carries a DISTINCT color (R = radius index, G = angle index,
//     B = height index) surfaced through a dual-language (GLSL +
//     native-WGSL) customShader, so the rendered color pattern IS the
//     radial/angle/height shapeUv mapping. Pre-B24 the WebGPU sample
//     coordinate derived through the box-affine `p + 0.5` fallback — a
//     completely different pattern from WebGL's cylindrical chain; post-B24
//     the per-grid-cell colors match. Gates: interior-cell color match
//     fraction + a WebGL-side color variance floor proving the gate
//     discriminates.
//   * Real data uploads + the color pipeline swaps to the USER-customShader
//     variant on the WebGPU path.
//   * Zero console/device errors on both backends.
//
// Reads BOTH PNGs (writes them to output/) so the operator can eyeball the
// cylinder silhouette + the radius/angle color pattern.
//
// ON THE KIT (probe-kit harvest, voxel family): scene = `rigs/voxel-cylinder-oblique.mjs`;
// Edge, origin, slot, deadline, receipt and exit code = `lib/probe-runtime.mjs`;
// viewer page = `lib/voxel-probe-page.mjs`; the frame is banked through
// `captureElement`, decoded in Node, and measured and judged by
// `lib/voxel-shape-parity-verdicts.mjs` (the clauses this probe and its
// ellipsoid twin share) over `lib/metrics/voxel-footprint.mjs`.
// Run: `node server.js --port 8094 --serve-built`, then this file.
import { decodePng } from "../lib/png-decode.mjs";
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
import {
  evaluateShapeParity,
  measureShapeFrame,
  publishedShapeCell,
  shapeParityNumbers,
} from "./lib/voxel-shape-parity-verdicts.mjs";
import RIG from "./rigs/voxel-cylinder-oblique.mjs";

// Cylinder: outer radius R, inner radius 0.3 R (hollow), half-height 0.5 R.
const R = 6378137.0;
// The oblique camera is the rig's (`RIG.camera`).

async function captureShape({
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

  const info = await page.evaluate(
    async ({ camera, R, frames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      // Strip everything that would differ between backends so the diff is
      // dominated by the voxel cylinder itself.
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      // Procedural single-tile CYLINDER provider: bounds are (radius, angle,
      // height); the world extents come from the globalTransform scale.
      // Hollow (minBounds.x = 0.3) so the inner-radius hole interval + the
      // radial scale/offset terms are exercised.
      // NEW-VOXEL-CYLINDER-SHAPEUV — every cell gets a DISTINCT color:
      // R encodes the radius index, G the angle index, B the height index.
      // The visible surface pattern is then exactly the shapeUv mapping
      // under test.
      const dims = { x: 8, y: 8, z: 8 };
      const voxelCount = dims.x * dims.y * dims.z;
      const data = new Float32Array(voxelCount * 4);
      for (let k = 0; k < dims.z; k++) {
        for (let j = 0; j < dims.y; j++) {
          for (let i = 0; i < dims.x; i++) {
            const d = (i + dims.x * (j + dims.y * k)) * 4;
            data[d] = i / (dims.x - 1);
            data[d + 1] = j / (dims.y - 1);
            data[d + 2] = k / (dims.z - 1);
            data[d + 3] = 1.0;
          }
        }
      }
      const provider = {
        shape: C.VoxelShapeType.CYLINDER,
        minBounds: new C.Cartesian3(0.3, -Math.PI, -1.0),
        maxBounds: new C.Cartesian3(1.0, Math.PI, 1.0),
        dimensions: new C.Cartesian3(dims.x, dims.y, dims.z),
        names: ["color"],
        types: [C.MetadataType.VEC4],
        componentTypes: [C.MetadataComponentType.FLOAT32],
        globalTransform: C.Matrix4.fromScale(new C.Cartesian3(R, R, R * 0.5)),
        availableLevels: 1,
        requestData: function (options) {
          if (options.tileLevel >= 1) {
            return Promise.reject("single tile");
          }
          return Promise.resolve(C.VoxelContent.fromMetadataArray([data]));
        },
      };

      // The SAME authored mapping in both languages: unlit metadata color,
      // opaque — the rendered pattern is purely the sample-coordinate chain.
      const customShader = new C.CustomShader({
        fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    material.diffuse = fsInput.metadata.color.rgb;
    material.alpha = 1.0;
}`,
        wgslFragmentShaderText: `fn czm_voxelCustomFragmentMain(fsInput: czm_voxelCustomFragmentInput,
    material: ptr<function, czm_voxelCustomMaterial>) {
  (*material).diffuse = fsInput.metadata.color.xyz;
  (*material).alpha = 1.0;
}`,
      });

      const prim = new C.VoxelPrimitive({ provider, customShader });
      prim.nearestSampling = true;
      scene.primitives.add(prim);

      // The rig's oblique ECEF pose: the direction is the normalised negated
      // position (looking back at the origin) with +Z up.
      v.camera.setView({
        destination: new C.Cartesian3(...camera.position),
        orientation: {
          direction: new C.Cartesian3(...camera.direction),
          up: new C.Cartesian3(...camera.up),
        },
      });

      // Render enough frames for the async provider resolve + the WebGPU
      // root-tile upload state machine + the parity pipeline swap.
      for (let i = 0; i < frames; i++) {
        scene.render();
        await new Promise((r) => setTimeout(r, 12));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        colorDescName:
          cache && cache.colorDescriptor ? cache.colorDescriptor.name : null,
      };
    },
    { camera: RIG.camera, R, frames: RIG.readiness.frames },
  );

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-cylinder-${renderer}`,
    outputDirectory,
    captures,
  });
  // The coarse mask + per-grid-cell colour record over the centred region
  // (the parity probe's harness, extended with per-cell RGB for the shapeUv
  // gate), measured in Node from the banked frame.
  const px = measureShapeFrame(decodePng(shot.buffer));
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return { info, capture: shot.name, px, ...errors };
}

function printReport(receipt) {
  for (const cell of receipt.cells) {
    const n = shapeParityNumbers(cell.webgl, cell.webgpu);
    console.log("WebGL  info:", JSON.stringify(cell.webgl.info));
    console.log("WebGPU info:", JSON.stringify(cell.webgpu.info));
    console.log(
      "Footprint IoU (WebGL ∩ WebGPU):",
      n.iou.toFixed(3),
      "coverage (GL vs GPU):",
      n.covGL.toFixed(2),
      n.covGPU.toFixed(2),
      "interior cells",
      n.cells.interiorCells,
      "matched",
      n.cells.matchedCells,
      "meanDist",
      n.cells.meanDistance.toFixed(1),
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
  name: "voxel-cylinder",
  title:
    "Voxel CYLINDER shape parity — bounded hollow cylinder + radius/angle/height shapeUv (B24)",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-cylinder-<renderer>.png`).
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: (options) =>
    voxelWorkBudgetMs({
      pages: options.renderers.length,
      frames: options.renderers.length * RIG.readiness.frames,
      captures: options.renderers.length,
    }),
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const missing = missingRenderers(options.renderers, ["webgl", "webgpu"]);
    if (missing.length > 0) {
      throw new ProbeRefusal(
        "renderer-pair-required",
        `probe-voxel-cylinder compares WebGL with WebGPU and cannot run without ${missing.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    return [
      {
        run,
        webgl: await captureShape({ ...legs, renderer: "webgl" }),
        webgpu: await captureShape({ ...legs, renderer: "webgpu" }),
      },
    ];
  },
  verdicts(cells) {
    return evaluateShapeParity(cells);
  },
  receipt(cells, context) {
    if (cells.length > 0) {
      printReport({ cells, verdicts: context.verdicts });
    }
    return {
      rig: RIG.id,
      cells: cells.map(publishedShapeCell),
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
