// VOXEL-USER-CUSTOMSHADER acceptance probe.
// @purpose Acceptance: user voxel customShader — GLSL (WebGL) vs native-WGSL codegen (WebGPU) render the same blue-red ramp; pipeline-name gate.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Renders the VoxelBox3DTiles VoxelPrimitive with a USER-supplied scalar-ramp
// customShader on BOTH backends at an identical camera:
//   - WebGL consumes the GLSL `fragmentShaderText` (the upstream voxel
//     customShader pipeline).
//   - WebGPU consumes the native-WGSL `wgslFragmentShaderText` through the
//     VOXEL-USER-CUSTOMSHADER codegen path (generated metadata chunk +
//     VOXEL_USER_CUSTOM_SHADER nested define).
//
// Both bodies author the SAME mapping: value = property.r ramped from blue to
// red, alpha 1 (entry face wins — the march-model-independent case).
//
// Gates:
//   1. Both backends render a bounded voxel silhouette (same as
//      probe-voxel-parity Part A).
//   2. Footprint IoU >= 0.85 (the user shader must not move the box).
//   3. Avg-color L1 (WebGL vs WebGPU) <= 90 — the WebGPU ramp matches the
//      WebGL ramp, not the default gray.
//   4. The WebGPU render is NOT neutral gray (channel spread > 40) — proves
//      the user ramp actually replaced the default-gray mapping.
//   5. The WebGPU color pipeline is the user-customShader variant (name
//      carries `userCustomShader#<hash>`), and the drawn command uses it.
//   6. Zero console errors on both backends.
//
// READ the PNGs in Tools/visual-regression/output/ — both must show the SAME
// blue↔red-ramped box.
//
// ON THE KIT (probe-kit harvest, voxel family): scene =
// `rigs/voxel-box3dtiles-user-ramp.mjs` (the same off-axis camera as
// probe-voxel-parity Part A); Edge, origin, slot, deadline, receipt and exit
// code = `lib/probe-runtime.mjs`; viewer page = `lib/voxel-probe-page.mjs`;
// the frame is banked through `captureElement` and measured in Node by
// `lib/metrics/voxel-footprint.mjs`. Clauses and bars unchanged.
// Run: `node server.js --port 8094 --serve-built`, then this file.
import { decodePng } from "../lib/png-decode.mjs";
import { spread } from "./lib/determinism-kit.mjs";
import {
  VOXEL_FOOTPRINT_LUM_THRESHOLD,
  VOXEL_PARITY_REGION,
  colourL1,
  footprintGrid,
  fractionalRegion,
  maskIoU,
  regionColourStats,
} from "./lib/metrics/voxel-footprint.mjs";
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
import RIG from "./rigs/voxel-box3dtiles-user-ramp.mjs";

async function captureRamp({
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
    async ({ camera, frames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.fog.enabled = false;

      const provider = await C.Cesium3DTilesVoxelProvider.fromUrl(
        "/Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
      );
      const propName = provider.names[0];

      // The SAME authored mapping in both languages: scalar ramp over the
      // property's red channel, blue → red, opaque.
      const glsl = `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
    float value = clamp(fsInput.metadata.${propName}.r, 0.0, 1.0);
    material.diffuse = mix(vec3(0.05, 0.05, 1.0), vec3(1.0, 0.1, 0.05), value);
    material.alpha = 1.0;
}`;
      const wgsl = `fn czm_voxelCustomFragmentMain(fsInput: czm_voxelCustomFragmentInput,
    material: ptr<function, czm_voxelCustomMaterial>) {
  let value = clamp(fsInput.metadata.${propName}.r, 0.0, 1.0);
  (*material).diffuse = mix(vec3<f32>(0.05, 0.05, 1.0), vec3<f32>(1.0, 0.1, 0.05), value);
  (*material).alpha = 1.0;
}`;

      const customShader = new C.CustomShader({
        fragmentShaderText: glsl,
        wgslFragmentShaderText: wgsl,
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
        await new Promise((r) => setTimeout(r, 16));
      }

      const cache = prim._webgpuCache || null;
      const du = (cache && cache.dataUpload) || null;
      return {
        renderer: scene.context.rendererType || null,
        propName,
        usingRealData: cache ? cache.usingRealData === true : null,
        uploadPhase: du ? du.phase : null,
        colorDescName:
          cache && cache.colorDescriptor ? cache.colorDescriptor.name : null,
        cmdPipelineIsColor:
          cache && cache.command && cache.pipeline
            ? cache.command.pipeline === cache.pipeline
            : null,
      };
    },
    { camera: RIG.camera, frames: RIG.readiness.frames },
  );

  const shot = await captureElement({
    page,
    selector: VOXEL_CANVAS_SELECTOR,
    name: `probe-voxel-user-customshader-${renderer}`,
    outputDirectory,
    captures,
  });
  const frame = decodePng(shot.buffer);
  const region = fractionalRegion(frame, VOXEL_PARITY_REGION);
  const grid = footprintGrid(frame, region);
  const stats = regionColourStats(frame, region, {
    lumThreshold: VOXEL_FOOTPRINT_LUM_THRESHOLD,
  });
  const errors = await voxelPageErrors(page, diagnostics);
  await page.close();
  return {
    info,
    capture: shot.name,
    px: {
      mask: Array.from(grid.mask),
      maskCells: grid.maskCells,
      avgColor: stats.avgColor,
      coveragePct: stats.coveragePct,
    },
    ...errors,
  };
}

/**
 * The six gates of the header over each run's pair: both render a bounded
 * silhouette, footprint IoU >= 0.85, avg-color L1 <= 90, the WebGPU render is
 * not neutral gray (spread > 40), the WebGPU colour pipeline is the
 * user-customShader variant and the drawn command uses it, and no console
 * errors. Pure and exported for the routing spec.
 *
 * @param {Array<object>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateUserCustomShader(cells) {
  const verdicts = [];
  for (const { run, webgl, webgpu } of cells) {
    const s = `run${run}`;
    const add = (id, claim, pass, detail) =>
      verdicts.push({ id: `${id}/${s}`, claim, pass: pass === true, detail });
    const iou = maskIoU(webgl.px.mask, webgpu.px.mask).iou;
    const colorL1 = colourL1(webgl.px.avgColor, webgpu.px.avgColor);
    const webgpuSpread = spread(webgpu.px.avgColor);
    const covGL = webgl.px.coveragePct;
    const covGPU = webgpu.px.coveragePct;
    add(
      "both-render",
      `both backends render (${webgl.px.maskCells} and ${webgpu.px.maskCells} footprint cells > 200)`,
      webgl.px.maskCells > 200 && webgpu.px.maskCells > 200,
    );
    add(
      "bounded",
      `both 8% < coverage < 92% (${covGL.toFixed(2)}%, ${covGPU.toFixed(2)}%)`,
      covGL < 92 && covGPU < 92 && covGL > 8 && covGPU > 8,
    );
    add(
      "footprint-match",
      `footprint IoU ${iou.toFixed(3)} >= 0.85`,
      iou >= 0.85,
      {
        iou,
      },
    );
    add("colour-match", `avg-color L1 ${colorL1} <= 90`, colorL1 <= 90, {
      colorL1,
      webgl: webgl.px.avgColor,
      webgpu: webgpu.px.avgColor,
    });
    add(
      "ramp-applied",
      `WebGPU spread ${webgpuSpread} > 40, differs from gray`,
      webgpuSpread > 40,
    );
    add(
      "user-pipeline",
      "WebGPU on the userCustomShader# pipeline, and the drawn command uses it",
      typeof webgpu.info.colorDescName === "string" &&
        webgpu.info.colorDescName.startsWith(
          "Voxel color pipeline (userCustomShader#",
        ) &&
        webgpu.info.cmdPipelineIsColor === true,
      {
        colorDescName: webgpu.info.colorDescName ?? null,
        cmdPipelineIsColor: webgpu.info.cmdPipelineIsColor ?? null,
      },
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
  for (const cell of receipt.cells) {
    console.log("WebGL  info:", JSON.stringify(cell.webgl.info));
    console.log("WebGPU info:", JSON.stringify(cell.webgpu.info));
  }
  for (const verdict of receipt.verdicts) {
    console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
  }
  const pass = receipt.verdicts.every((verdict) => verdict.pass === true);
  console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
}

/** Drop the footprint masks from the published cell; the IoU carries them. */
function publishedCell(cell) {
  const strip = (leg) => ({ ...leg, px: { ...leg.px, mask: undefined } });
  return { ...cell, webgl: strip(cell.webgl), webgpu: strip(cell.webgpu) };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "voxel-user-customshader",
  title:
    "Voxel user customShader — GLSL (WebGL) vs native-WGSL codegen (WebGPU) blue-red ramp",
  // Empty, so the banked frames keep their pre-migration paths
  // (`output/probe-voxel-user-customshader-<renderer>.png`).
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
        `probe-voxel-user-customshader compares WebGL with WebGPU and cannot run without ${missing.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const legs = { browser, origin, outputDirectory, captures };
    return [
      {
        run,
        webgl: await captureRamp({ ...legs, renderer: "webgl" }),
        webgpu: await captureRamp({ ...legs, renderer: "webgpu" }),
      },
    ];
  },
  verdicts(cells) {
    return evaluateUserCustomShader(cells);
  },
  receipt(cells, context) {
    if (cells.length > 0) {
      printReport({ cells, verdicts: context.verdicts });
    }
    return {
      rig: RIG.id,
      cells: cells.map(publishedCell),
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
