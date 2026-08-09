#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 447) — model/3D-Tiles ON reflection probe.
//
// Verifies the model capture pass actually renders a nearby glTF model into the
// env cube's 6 faces, composited OVER the already-captured globe + sky, with
// correct occlusion. Reads the captured cube faces back directly (no reflective-
// surface plumbing dependency, mirroring probe-scene-capture-on.mjs):
//
//   1. WebGPU viewer with `sceneCaptureReflections = true`.
//   2. Park over distinctive terrain; the env-map eye = a surface point.
//   3. Add a LARGE bright-emissive glTF model OFFSET ~horizontally from the eye
//      so an outward-looking face camera frames it against the terrain.
//   4. Enable `enableSceneCapture` on the model's env manager + drive capture.
//   5. Read back the 6 cube faces; report per-face mean color + a "has bright
//      model pixels" classification. The model is emissive/over-bright so its
//      pixels stand out against the muted terrain + sky.
//
// Compares against a flags-OFF run (model absent from the faces) to confirm the
// model is what changed. Also asserts ZERO console errors (esp. no WebGPU
// color-target-count / MRT validation error from the CAPTURE_MODE pipeline).
//
// Usage: node Tools/visual-regression/probe-model-capture-reflection.mjs
// Outputs: probe-model-capture-reflection-faces-on.png / -off.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL_URL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

async function run(captureOn) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const report = await page.evaluate(
    async ({ MODEL_URL, captureOn }) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const ctx = scene.context;

      if (!ctx._options) ctx._options = {};
      ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
        sceneCaptureReflections: captureOn,
      });

      // Env-map eye = surface point; model OFFSET so a side-face camera frames
      // it against the terrain (a model AT the eye sits at the camera origin and
      // is never visible to any outward face camera).
      const lon = -105.0;
      const lat = 40.0;
      const eyeSurface = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

      // Model ~6 km East of the eye, lifted so it's clearly above the surface,
      // BIG + emissive so its pixels stand out in the low-res cube faces.
      const modelLon = -104.93; // ~6 km East at this latitude
      const modelPos = Cesium.Cartesian3.fromDegrees(modelLon, lat, 2000);
      const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(modelPos);
      let model;
      try {
        model = scene.primitives.add(
          await Cesium.Model.fromGltfAsync({
            url: MODEL_URL,
            modelMatrix,
            scale: 4000.0,
            // Bright so the model's captured pixels are unmistakable.
            color: Cesium.Color.RED,
            colorBlendMode: Cesium.ColorBlendMode.MIX,
            colorBlendAmount: 0.9,
          }),
        );
      } catch (e) {
        return { error: "model load failed: " + e.message };
      }

      scene.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1_000_000),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });

      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // The model owns its own env manager. Force capture from the EYE surface
      // point (so face cameras look outward toward the offset model + terrain).
      const manager = model.environmentMapManager;
      manager.enableSceneCapture = true;
      manager.enabled = true;
      manager.shouldUpdate = true;
      manager._position = eyeSurface;

      for (let i = 0; i < 60; i++) {
        scene.render();
        manager.update(scene._frameState);
        await new Promise((r) => requestAnimationFrame(r));
      }

      const cache = manager._webgpuCache;
      if (!cache || !cache.cubemapTexture) {
        return {
          error: "no cube allocated — capture path not reached",
          diag: {
            flagOnContext: ctx.sceneCaptureReflections,
            modelReady: model.ready,
            mode: scene._frameState.mode,
            globeSources: !!ctx._webgpuSceneCaptureSources,
            modelSources: !!ctx._webgpuSceneCaptureModels,
            modelCount: ctx._webgpuSceneCaptureModels?.models?.length ?? 0,
          },
        };
      }

      // Read back all 6 cube faces via a compute pass (cube has no COPY_SRC).
      const device = ctx.device;
      const size = cache.size;
      const fmt = cache.cubemapFormat || "rgba8unorm";
      const arrayView = cache.cubemapTexture.createView({
        dimension: "2d-array",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: 0,
        mipLevelCount: 1,
      });
      const GRID = 32;
      const FACE_FLOATS = 4 + GRID * GRID * 4 + 1; // +1 = bright-pixel count
      const outBuf = device.createBuffer({
        size: 6 * FACE_FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const wgsl = `
@group(0) @binding(0) var cubeArr: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<f32>;
const SIZE: u32 = ${size}u;
const GRID: u32 = ${GRID}u;
const FACE_FLOATS: u32 = ${FACE_FLOATS}u;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let face = gid.x;
  if (face >= 6u) { return; }
  let base = face * FACE_FLOATS;
  var rsum = 0.0; var gsum = 0.0; var bsum = 0.0; var n = 0.0;
  var bright = 0.0;
  var grid: array<vec4<f32>, ${GRID * GRID}>;
  for (var y: u32 = 0u; y < SIZE; y = y + 1u) {
    for (var x: u32 = 0u; x < SIZE; x = x + 1u) {
      let c = textureLoad(cubeArr, vec2<i32>(i32(x), i32(y)), i32(face), 0);
      rsum = rsum + c.r; gsum = gsum + c.g; bsum = bsum + c.b; n = n + 1.0;
      // The RED-tinted model: strongly red-dominant pixels (red >> green & blue
      // by a wide margin) that the muted terrain + blue sky never produce.
      if (c.r > 0.40 && c.r > c.g + 0.20 && c.r > c.b + 0.20) {
        bright = bright + 1.0;
      }
      let gx = min(GRID - 1u, (x * GRID) / SIZE);
      let gy = min(GRID - 1u, (y * GRID) / SIZE);
      let gi = gy * GRID + gx;
      grid[gi] = grid[gi] + vec4<f32>(c.rgb, 1.0);
    }
  }
  outBuf[base + 0u] = rsum / max(n, 1.0);
  outBuf[base + 1u] = gsum / max(n, 1.0);
  outBuf[base + 2u] = bsum / max(n, 1.0);
  outBuf[base + 3u] = n;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    let g4 = grid[i];
    let cnt = max(g4.w, 1.0);
    outBuf[base + 4u + i * 4u + 0u] = g4.r / cnt;
    outBuf[base + 4u + i * 4u + 1u] = g4.g / cnt;
    outBuf[base + 4u + i * 4u + 2u] = g4.b / cnt;
    outBuf[base + 4u + i * 4u + 3u] = 1.0;
  }
  outBuf[base + 4u + GRID * GRID * 4u] = bright;
}`;
      const module = device.createShaderModule({ code: wgsl });
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: arrayView },
          { binding: 1, resource: { buffer: outBuf } },
        ],
      });
      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(pipeline);
      cp.setBindGroup(0, bg);
      cp.dispatchWorkgroups(6);
      cp.end();
      const readBuf = device.createBuffer({
        size: 6 * FACE_FLOATS * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 6 * FACE_FLOATS * 4);
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const floats = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();

      const faceNames = [
        "+X East",
        "-X West",
        "+Y Up/zenith",
        "-Y Down/nadir",
        "+Z North",
        "-Z South",
      ];
      const faces = [];
      let totalBright = 0;
      for (let layer = 0; layer < 6; layer++) {
        const base = layer * FACE_FLOATS;
        const mr = floats[base] * 255;
        const mg = floats[base + 1] * 255;
        const mb = floats[base + 2] * 255;
        const bright = floats[base + 4 + GRID * GRID * 4];
        totalBright += bright;
        const thumb = new Uint8ClampedArray(GRID * GRID * 4);
        for (let i = 0; i < GRID * GRID; i++) {
          const go = base + 4 + i * 4;
          thumb[i * 4] = Math.max(0, Math.min(255, floats[go] * 255));
          thumb[i * 4 + 1] = Math.max(0, Math.min(255, floats[go + 1] * 255));
          thumb[i * 4 + 2] = Math.max(0, Math.min(255, floats[go + 2] * 255));
          thumb[i * 4 + 3] = 255;
        }
        faces.push({
          layer,
          name: faceNames[layer],
          meanRGB: [Math.round(mr), Math.round(mg), Math.round(mb)],
          modelPixels: Math.round(bright),
          thumb: Array.from(thumb),
        });
      }

      return {
        size,
        format: fmt,
        captureOn,
        modelReady: model.ready,
        globeSourcesPublished: !!ctx._webgpuSceneCaptureSources,
        modelSourcesPublished: !!ctx._webgpuSceneCaptureModels,
        modelEntryCount: ctx._webgpuSceneCaptureModels?.models?.length ?? 0,
        recordCount:
          ctx._webgpuSceneCaptureModels?.models?.reduce(
            (a, m) => a + (m.records?.length ?? 0),
            0,
          ) ?? 0,
        totalModelPixels: totalBright,
        faces: faces.map((f) => ({
          layer: f.layer,
          name: f.name,
          meanRGB: f.meanRGB,
          modelPixels: f.modelPixels,
        })),
        thumbs: faces.map((f) => f.thumb),
      };
    },
    { MODEL_URL, captureOn },
  );

  if (report.thumbs) {
    const tile = await page.evaluate((thumbs) => {
      const cols = 6;
      const tw = 32;
      const c = document.createElement("canvas");
      c.width = cols * (tw + 4) + 4;
      c.height = tw + 4 + 16;
      const g = c.getContext("2d");
      g.fillStyle = "#222";
      g.fillRect(0, 0, c.width, c.height);
      thumbs.forEach((t, i) => {
        const img = g.createImageData(32, 32);
        img.data.set(new Uint8ClampedArray(t));
        const x = 4 + i * (tw + 4);
        const tmp = document.createElement("canvas");
        tmp.width = 32;
        tmp.height = 32;
        tmp.getContext("2d").putImageData(img, 0, 0);
        g.drawImage(tmp, x, 4);
        g.fillStyle = "#fff";
        g.font = "9px monospace";
        g.fillText(["+X", "-X", "+Y", "-Y", "+Z", "-Z"][i], x + 6, tw + 14);
      });
      return c.toDataURL("image/png");
    }, report.thumbs);
    const b64 = tile.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(
      path.join(
        OUT_DIR,
        `probe-model-capture-reflection-faces-${captureOn ? "on" : "off"}.png`,
      ),
      Buffer.from(b64, "base64"),
    );
  }

  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { report, errs };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    "[model-capture-on] capturing with flags OFF (model absent from faces)…",
  );
  const off = await run(false);
  console.log("[model-capture-on] capturing with flags ON (model in faces)…");
  const on = await run(true);

  const printFaces = (label, r) => {
    console.log(`\n  === ${label} ===`);
    if (r.report.error) {
      console.log(
        "  ERROR:",
        r.report.error,
        JSON.stringify(r.report.diag || {}),
      );
      return;
    }
    console.log(
      `  cube ${r.report.size}px ${r.report.format} | modelSources=${r.report.modelSourcesPublished} entries=${r.report.modelEntryCount} records=${r.report.recordCount} | totalModelPixels=${r.report.totalModelPixels}`,
    );
    r.report.faces.forEach((f) =>
      console.log(
        `    face ${f.layer} (${f.name}): meanRGB=${JSON.stringify(f.meanRGB)} modelPixels=${f.modelPixels}`,
      ),
    );
    if (r.errs.length) {
      console.log(`  ${r.errs.length} console errors:`);
      r.errs.slice(0, 10).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    } else {
      console.log("  console errors: 0");
    }
  };

  printFaces("FLAGS OFF (baseline — model should NOT appear)", off);
  printFaces("FLAGS ON (model should appear in faces)", on);

  const onBright = on.report.totalModelPixels ?? 0;
  const offBright = off.report.totalModelPixels ?? 0;
  const noValidationErr =
    on.errs.filter((e) =>
      /color.?target|fragment output|validation|MRT|attachment/i.test(e.text),
    ).length === 0;
  const ok =
    !on.report.error &&
    on.report.modelSourcesPublished === true &&
    on.report.recordCount > 0 &&
    onBright > 0 &&
    onBright > offBright &&
    noValidationErr;
  console.log(
    `\n[model-capture-on] VERDICT: ${ok ? "PASS — model rendered into env faces (ON has model pixels, OFF does not), no MRT/validation errors" : "FAIL — see state above"}`,
  );
  console.log(
    `  model pixels: ON=${onBright} vs OFF=${offBright}  (ON must be > OFF and > 0)`,
  );
  console.log(
    "  output: probe-model-capture-reflection-faces-on.png / -off.png",
  );
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(ok ? 0 : 1);
})();
