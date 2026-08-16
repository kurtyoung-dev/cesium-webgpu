// VOXEL-USER-CUSTOMSHADER acceptance probe.
// @purpose Acceptance: user voxel customShader — GLSL (WebGL) vs native-WGSL codegen (WebGPU) render the same blue-red ramp; pipeline-name gate.
// @status ACTIVE
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

// Same fixed off-axis camera as probe-voxel-parity Part A.
const CAMERA = {
  destinationXYZ: [6378137.0 * 6.0, 6378137.0 * 4.5, 6378137.0 * 4.0],
};

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

  const info = await page.evaluate(
    async ({ camera }) => {
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
        destination: new C.Cartesian3(
          camera.destinationXYZ[0],
          camera.destinationXYZ[1],
          camera.destinationXYZ[2],
        ),
        orientation: {
          direction: C.Cartesian3.normalize(
            C.Cartesian3.negate(
              new C.Cartesian3(
                camera.destinationXYZ[0],
                camera.destinationXYZ[1],
                camera.destinationXYZ[2],
              ),
              new C.Cartesian3(),
            ),
            new C.Cartesian3(),
          ),
          up: C.Cartesian3.UNIT_Z,
        },
      });

      for (let i = 0; i < 300; i++) {
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
    { camera: CAMERA },
  );

  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-voxel-user-customshader-${renderer}.png`, buf);

  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const px = await page.evaluate(async (url) => {
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = url;
    });
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const w = img.width;
    const h = img.height;
    const rx = Math.floor(w * 0.2);
    const ry = Math.floor(h * 0.2);
    const rw = Math.floor(w * 0.55);
    const rh = Math.floor(h * 0.6);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const GW = 64;
    const GH = 48;
    const mask = new Uint8Array(GW * GH);
    let nonBlack = 0;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const sx = rx + Math.floor((gx / GW) * rw);
        const sy = ry + Math.floor((gy / GH) * rh);
        const dd = ctx.getImageData(sx, sy, 1, 1).data;
        if (dd[0] + dd[1] + dd[2] > 20) {
          mask[gy * GW + gx] = 1;
          nonBlack++;
        }
      }
    }
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 20) {
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
    }
    const nn = Math.max(1, n);
    return {
      mask: Array.from(mask),
      maskCells: nonBlack,
      avgColor: [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)],
      coveragePct: (n / (d.length / 4)) * 100,
    };
  }, dataUrl);

  await page.close();
  return { info, px, consoleErrors };
}

const webgl = await capture("webgl");
const webgpu = await capture("webgpu");
await browser.close();

console.log("WebGL  info:", JSON.stringify(webgl.info));
console.log("WebGPU info:", JSON.stringify(webgpu.info));
console.log(
  "WebGL  px:",
  JSON.stringify({
    ...webgl.px,
    mask: undefined,
    coveragePct: webgl.px.coveragePct.toFixed(2),
  }),
);
console.log(
  "WebGPU px:",
  JSON.stringify({
    ...webgpu.px,
    mask: undefined,
    coveragePct: webgpu.px.coveragePct.toFixed(2),
  }),
);
console.log("WebGL  console errors:", webgl.consoleErrors.length);
console.log("WebGPU console errors:", webgpu.consoleErrors.length);
if (webgl.consoleErrors.length) {
  console.log("  WebGL:", webgl.consoleErrors.slice(0, 5).join("\n  "));
}
if (webgpu.consoleErrors.length) {
  console.log("  WebGPU:", webgpu.consoleErrors.slice(0, 5).join("\n  "));
}

let inter = 0;
let uni = 0;
for (let i = 0; i < webgl.px.mask.length; i++) {
  const av = webgl.px.mask[i];
  const bv = webgpu.px.mask[i];
  if (av && bv) inter++;
  if (av || bv) uni++;
}
const iou = uni > 0 ? inter / uni : 0;

const ac = webgl.px.avgColor;
const bc = webgpu.px.avgColor;
const colorL1 =
  Math.abs(ac[0] - bc[0]) + Math.abs(ac[1] - bc[1]) + Math.abs(ac[2] - bc[2]);
const webgpuSpread =
  Math.max(bc[0], bc[1], bc[2]) - Math.min(bc[0], bc[1], bc[2]);

console.log("---");
console.log("Footprint IoU:", iou.toFixed(3));
console.log("Avg-color L1:", colorL1);
console.log("WebGPU channel spread (ramp, not gray):", webgpuSpread);

const bothRender = webgl.px.maskCells > 200 && webgpu.px.maskCells > 200;
const bounded =
  webgl.px.coveragePct < 92 &&
  webgpu.px.coveragePct < 92 &&
  webgl.px.coveragePct > 8 &&
  webgpu.px.coveragePct > 8;
const footprintMatch = iou >= 0.85;
const colorMatch = colorL1 <= 90;
const rampApplied = webgpuSpread > 40;
const userPipeline =
  typeof webgpu.info.colorDescName === "string" &&
  webgpu.info.colorDescName.startsWith(
    "Voxel color pipeline (userCustomShader#",
  ) &&
  webgpu.info.cmdPipelineIsColor === true;
const noErrors =
  webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0;

console.log("---");
console.log("bothRender:", bothRender);
console.log("bounded:", bounded);
console.log("footprintMatch (IoU>=0.85):", footprintMatch);
console.log(`colorMatch (L1 ${colorL1} <= 90):`, colorMatch);
console.log(
  `rampApplied (spread ${webgpuSpread} > 40, differs from gray):`,
  rampApplied,
);
console.log(
  "userPipeline (WebGPU on userCustomShader# pipeline):",
  userPipeline,
);
console.log("noErrors:", noErrors);

const pass =
  bothRender &&
  bounded &&
  footprintMatch &&
  colorMatch &&
  rampApplied &&
  userPipeline &&
  noErrors;
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
