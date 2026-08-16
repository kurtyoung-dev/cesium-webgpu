// C10-05 minification/aliasing evidence. Loads a textured glTF at a DISTANT
// camera so the 256px face texture is heavily MINIFIED (~6:1), then per backend
// measures the high-frequency ENERGY (mean neighbour luminance gradient) over
// the textured region. Mip-0-locked sampling of a minified texture injects
// aliasing high-frequency detail (shimmer); trilinear from the correct mip is
// smooth. So a mip-0 WebGPU render shows HIGHER HF energy than WebGL trilinear;
// @purpose C10-05 pre/post evidence: high-frequency energy over a minified model texture per backend — mip-0 aliasing shimmer vs trilinear smoothness.
// @status INVESTIGATION
//
// the C10-05 fix drops WebGPU HF toward WebGL's. Also saves still PNGs for the
// eyeball read (CLAUDE.md Principle 8) and a cross-backend HF ratio.
//
//   MODE=pre|post node Tools/visual-regression/probe-model-mip-shimmer.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODE = process.env.MODE || "post";
const OUT = "Tools/visual-regression/output/model-mip";
mkdirSync(OUT, { recursive: true });

// Tight ROI around the (now small, minified) box near screen centre.
const ROI = { x: 540, y: 250, w: 220, h: 220 };

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const faults = [];
  page.on("pageerror", (e) => faults.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") faults.push(m.text());
  });
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

    const metric = await page.evaluate(async (roi) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.sun.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.requestRenderMode = false;
      scene.fog.enabled = false;
      scene.skyAtmosphere.show = false;

      const origin = C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
      const mm = C.Transforms.eastNorthUpToFixedFrame(origin);
      const model = await C.Model.fromGltfAsync({
        url: "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
        modelMatrix: mm,
        scale: 120000.0,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 140; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (model.ready && i > 40) break;
      }

      const center = C.Matrix4.multiplyByPoint(
        model.modelMatrix,
        new C.Cartesian3(0, 0, 0),
        new C.Cartesian3(),
      );
      // Far range → 120km box is ~40px on screen → 256px texture minified ~6:1.
      // Oblique heading + pitch so a face is foreshortened (anisotropic minify).
      v.camera.lookAt(center, new C.HeadingPitchRange(0.4, -0.5, 12_000_000.0));
      for (let i = 0; i < 24; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = scene.canvas;
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const rgba = ctx.getImageData(roi.x, roi.y, roi.w, roi.h);
      const d = rgba.data;
      const W = roi.w,
        H = roi.h;
      const lum = new Float64Array(W * H);
      for (let p = 0, q = 0; p < d.length; p += 4, q++) {
        lum[q] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
      }
      // High-frequency energy over textured (non-black) pixels: mean of
      // |Δlum| to right + down neighbours, only where the local mean is lit.
      let hf = 0,
        ncov = 0,
        lumsum = 0;
      for (let y = 0; y < H - 1; y++) {
        for (let x = 0; x < W - 1; x++) {
          const i = y * W + x;
          const c = lum[i];
          if (c < 12) continue; // background
          const gx = Math.abs(lum[i + 1] - c);
          const gy = Math.abs(lum[i + W] - c);
          hf += gx + gy;
          ncov++;
          lumsum += c;
        }
      }
      const hfEnergy = ncov > 0 ? hf / ncov : 0;

      // Still ROI PNG for the eyeball read.
      const outC = document.createElement("canvas");
      outC.width = W;
      outC.height = H;
      const octx = outC.getContext("2d");
      octx.putImageData(rgba, 0, 0);
      const dataUrl = outC.toDataURL("image/png");

      return {
        ready: model.ready,
        coveredPx: ncov,
        coveredMeanLum: ncov > 0 ? lumsum / ncov : 0,
        hfEnergy,
        stillPng: dataUrl,
      };
    }, ROI);

    metric.faults = faults;
    return metric;
  } finally {
    await browser.close();
  }
}

const webgl = await runBackend("webgl");
const webgpu = await runBackend("webgpu");

function savePng(name, dataUrl) {
  if (!dataUrl) return;
  writeFileSync(`${OUT}/${name}`, Buffer.from(dataUrl.split(",")[1], "base64"));
}
savePng(`${MODE}-webgl.png`, webgl.stillPng);
savePng(`${MODE}-webgpu.png`, webgpu.stillPng);

const report = {
  mode: MODE,
  webgl: {
    ready: webgl.ready,
    coveredPx: webgl.coveredPx,
    coveredMeanLum: +webgl.coveredMeanLum.toFixed(2),
    hfEnergy: +webgl.hfEnergy.toFixed(3),
    faults: webgl.faults,
  },
  webgpu: {
    ready: webgpu.ready,
    coveredPx: webgpu.coveredPx,
    coveredMeanLum: +webgpu.coveredMeanLum.toFixed(2),
    hfEnergy: +webgpu.hfEnergy.toFixed(3),
    faults: webgpu.faults,
  },
  webgpuHfVsWebglRatio: +(
    webgpu.hfEnergy / Math.max(1e-6, webgl.hfEnergy)
  ).toFixed(3),
};
console.log(JSON.stringify(report, null, 2));
