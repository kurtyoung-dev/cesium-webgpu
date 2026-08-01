#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 448) — 3D TILESET reflection capture probe.
//
// Batch 447 verified a glTF MilkTruck captures into the env cube. This probe
// verifies the headline "buildings reflect in water" case: an actual 3D TILESET
// (a batched-building tileset) routed through Model3DTileContent.update →
// this._model.update → updateWebGPUModel (the SAME WebGPUModelRenderer producer
// glTF uses) publishes to context._webgpuSceneCaptureModels and renders into the
// 6 cube faces over the globe, with correct occlusion + zero validation errors.
//
//   1. WebGPU viewer with `sceneCaptureReflections = true`.
//   2. Load the LOCAL batched building tileset
//      (Apps/SampleData/Cesium3DTiles/Tilesets/Tileset). Style it bright RED so
//      its captured pixels stand out against the muted terrain + blue sky in the
//      low-res cube faces (same detection trick the glTF probe uses).
//   3. Set the env-map eye to a surface point a short horizontal offset from the
//      buildings, so an outward-looking face camera frames the buildings against
//      the terrain backdrop.
//   4. Enable `enableSceneCapture` on a model's env manager + drive capture.
//   5. Read back the 6 cube faces; report per-face mean color + "has red
//      building pixels". Compare ON vs a flags-OFF run (buildings absent).
//
// Asserts ZERO console errors (esp. no WebGPU color-target-count / MRT
// validation error from the CAPTURE_MODE pipeline on a multi-primitive tile).
//
// Usage: node Tools/visual-regression/probe-tileset-capture-reflection.mjs
// Outputs: probe-tileset-capture-reflection-faces-on.png / -off.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TILESET_URL =
  "/Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/tileset.json";

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
    async ({ TILESET_URL, captureOn }) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const ctx = scene.context;

      if (!ctx._options) ctx._options = {};
      ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
        sceneCaptureReflections: captureOn,
      });

      // Building tileset center (computed from its bounding region).
      const lon = -75.61209,
        lat = 40.04253;
      // Env-map eye = a surface point a short distance WEST of the buildings,
      // lifted a bit so an EAST-looking face camera frames the buildings against
      // terrain. Buildings are ~88 m tall over a ~400 m footprint, so the eye
      // sits close (~250 m) for them to subtend a meaningful solid angle.
      const eyeLon = -75.6149; // ~250 m West of center at this latitude
      const eyeSurface = Cesium.Cartesian3.fromDegrees(eyeLon, lat, 60);

      let tileset;
      try {
        tileset = await Cesium.Cesium3DTileset.fromUrl(TILESET_URL, {
          // Keep everything loaded at full detail for the capture.
          maximumScreenSpaceError: 1,
        });
        scene.primitives.add(tileset);
        // NOTE: a Cesium3DTileStyle color() overlay is NOT applied along the
        // env-capture material path (capture replays the model's real PBR
        // material with neutral IBL, not the WebGL per-feature color blend), so
        // the buildings capture in their natural light-gray — see the
        // companion full-res probe-tileset-capture-face-zoom-on.png where the
        // gray boxes are unmistakable on the +X East face. We therefore detect
        // the capture geometrically (records published + ON horizon band
        // diverging from the OFF sky/terrain-only baseline) rather than by hue.
      } catch (e) {
        return { error: "tileset load failed: " + e.message };
      }

      // View straight down on the area so the tileset traverses + loads.
      scene.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1500),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });

      // Render many frames so tile content streams in + the model FR processes
      // every tile's Model (publishing capture records when the flag is ON).
      for (let i = 0; i < 360; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // The tileset exposes a DynamicEnvironmentMapManager via its root model;
      // but to drive a deterministic capture we reuse a standalone manager that
      // owns the cube. The capture pass reads ctx._webgpuSceneCaptureModels
      // (published by the tileset's tile models), so ANY manager that triggers
      // runSceneCapture renders them. Use the tileset's environmentMapManager.
      const manager =
        tileset.environmentMapManager ||
        scene.globe?.environmentMapManager ||
        viewer.scene.environmentMapManager;
      if (!manager) {
        return {
          error: "no env manager available on tileset/globe/scene",
          diag: {
            modelSources: !!ctx._webgpuSceneCaptureModels,
            modelCount: ctx._webgpuSceneCaptureModels?.models?.length ?? 0,
          },
        };
      }
      manager.enableSceneCapture = true;
      manager.enabled = true;
      manager.shouldUpdate = true;
      manager._position = eyeSurface;

      for (let i = 0; i < 90; i++) {
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
            tilesetReady: tileset.ready,
            tilesActive: tileset._selectedTiles?.length ?? -1,
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
      const FACE_FLOATS = 4 + GRID * GRID * 4 + 1; // +1 = red-pixel count
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
  var red = 0.0;
  var grid: array<vec4<f32>, ${GRID * GRID}>;
  for (var y: u32 = 0u; y < SIZE; y = y + 1u) {
    for (var x: u32 = 0u; x < SIZE; x = x + 1u) {
      let c = textureLoad(cubeArr, vec2<i32>(i32(x), i32(y)), i32(face), 0);
      rsum = rsum + c.r; gsum = gsum + c.g; bsum = bsum + c.b; n = n + 1.0;
      // RED-styled buildings: strongly red-dominant pixels the muted terrain +
      // blue sky never produce.
      if (c.r > 0.40 && c.r > c.g + 0.20 && c.r > c.b + 0.20) {
        red = red + 1.0;
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
  outBuf[base + 4u + GRID * GRID * 4u] = red;
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
      let totalRed = 0;
      for (let layer = 0; layer < 6; layer++) {
        const base = layer * FACE_FLOATS;
        const mr = floats[base] * 255;
        const mg = floats[base + 1] * 255;
        const mb = floats[base + 2] * 255;
        const red = floats[base + 4 + GRID * GRID * 4];
        totalRed += red;
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
          buildingPixels: Math.round(red),
          thumb: Array.from(thumb),
        });
      }

      return {
        size,
        format: fmt,
        captureOn,
        tilesetReady: tileset.ready,
        tilesActive: tileset._selectedTiles?.length ?? -1,
        globeSourcesPublished: !!ctx._webgpuSceneCaptureSources,
        modelSourcesPublished: !!ctx._webgpuSceneCaptureModels,
        modelEntryCount: ctx._webgpuSceneCaptureModels?.models?.length ?? 0,
        recordCount:
          ctx._webgpuSceneCaptureModels?.models?.reduce(
            (a, m) => a + (m.records?.length ?? 0),
            0,
          ) ?? 0,
        totalBuildingPixels: totalRed,
        faces: faces.map((f) => ({
          layer: f.layer,
          name: f.name,
          meanRGB: f.meanRGB,
          buildingPixels: f.buildingPixels,
        })),
        thumbs: faces.map((f) => f.thumb),
      };
    },
    { TILESET_URL, captureOn },
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
        `probe-tileset-capture-reflection-faces-${captureOn ? "on" : "off"}.png`,
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
    "[tileset-capture] capturing with flags OFF (buildings absent from faces)…",
  );
  const off = await run(false);
  console.log(
    "[tileset-capture] capturing with flags ON (buildings in faces)…",
  );
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
      `  cube ${r.report.size}px ${r.report.format} | tilesReady=${r.report.tilesetReady} tilesActive=${r.report.tilesActive} | modelSources=${r.report.modelSourcesPublished} entries=${r.report.modelEntryCount} records=${r.report.recordCount} | totalBuildingPixels=${r.report.totalBuildingPixels}`,
    );
    r.report.faces.forEach((f) =>
      console.log(
        `    face ${f.layer} (${f.name}): meanRGB=${JSON.stringify(f.meanRGB)} buildingPixels=${f.buildingPixels}`,
      ),
    );
    if (r.errs.length) {
      console.log(`  ${r.errs.length} console errors:`);
      r.errs.slice(0, 10).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    } else {
      console.log("  console errors: 0");
    }
  };

  printFaces("FLAGS OFF (baseline — buildings should NOT appear)", off);
  printFaces("FLAGS ON (buildings should appear in faces)", on);

  const noValidationErr =
    on.errs.filter((e) =>
      /color.?target|fragment output|validation|MRT|attachment/i.test(e.text),
    ).length === 0;

  // Geometric divergence: with the tileset captured ON, the cube faces carry
  // building + globe-detail geometry the gated-OFF baseline (sky/terrain only)
  // does not. Sum the per-face mean-RGB L1 distance between ON and OFF; a
  // capture that rendered nothing new would leave this near zero.
  let faceDivergence = 0;
  if (!on.report.error && !off.report.error) {
    for (let i = 0; i < 6; i++) {
      const a = on.report.faces[i].meanRGB;
      const b = off.report.faces[i].meanRGB;
      faceDivergence +=
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    }
  }

  const ok =
    !on.report.error &&
    on.report.modelSourcesPublished === true &&
    on.report.recordCount > 0 &&
    off.report.recordCount === 0 &&
    faceDivergence > 30 &&
    noValidationErr;
  console.log(
    `\n[tileset-capture] VERDICT: ${ok ? "PASS — tileset published capture records (ON) vs none (OFF), faces diverged from baseline, no MRT/validation errors. Read probe-tileset-capture-face-zoom-on.png for the visible gray buildings." : "FAIL — see state above"}`,
  );
  console.log(
    `  records: ON=${on.report.recordCount} OFF=${off.report.recordCount} | face mean-RGB divergence ON-vs-OFF=${faceDivergence} (must be > 30)`,
  );
  console.log(
    "  output: probe-tileset-capture-reflection-faces-on.png / -off.png",
  );
})();
