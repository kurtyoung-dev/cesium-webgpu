#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 446) — ON-correctness probe.
//
// Verifies the capture pass actually renders the opaque globe surface into the
// env cube's 6 faces, AND that the face-basis remap is correct (terrain lands
// on the CORRECT cube face, not mirrored/rotated). Reads the captured cube faces
// back directly (no model-IBL plumbing dependency):
//
//   1. Build a fresh WebGPU Viewer with
//      `contextOptions.webgpu.sceneCaptureReflections = true`.
//   2. Park the camera over distinctive terrain (North America), let tiles load.
//   3. Construct a DynamicEnvironmentMapManager with `enableSceneCapture = true`
//      whose `_position` is the surface point under the camera, and drive its
//      `.update(frameState)` each frame so the capture pass runs.
//   4. Copy the 6 cube faces to a readback buffer; report each face's mean color
//      + a "terrain vs sky" classification (terrain = greens/browns with low
//      blue dominance; sky = blue-dominant / near-black).
//
// Face order (layer == faceUvToDirection case): 0=+X(East) 1=-X(West)
// 2=+Y(Up/zenith) 3=-Y(Down/nadir) 4=+Z(North) 5=-Z(South). For a camera looking
// straight down at the surface, the DOWN face (3, -Y / nadir) MUST show terrain;
// the UP face (2, +Y / zenith) MUST show sky. That asymmetry is the load-bearing
// face-placement check.
//
// Usage: node Tools/visual-regression/probe-scene-capture-on.mjs
// Outputs: probe-scene-capture-on-faces.png (6 faces tiled), console report.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  // Load the WebGPU viewer page to get the Cesium global + a device.
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const report = await page.evaluate(async () => {
    // The app uses ESM imports (no global `Cesium`); dynamically import the
    // built engine module to get the constructors.
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    // Reuse the existing WebGPU viewer (recreating it destroys the shared
    // device). Patch the context options so the `sceneCaptureReflections`
    // getter (reads `_options.webgpu.sceneCaptureReflections`) returns true —
    // exactly what `contextOptions.webgpu.sceneCaptureReflections: true` would
    // have produced at construction.
    const viewer = window.viewer;
    const scene = viewer.scene;
    const ctx = scene.context;
    if (!ctx._options) ctx._options = {};
    ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
      sceneCaptureReflections: true,
    });

    // Park over distinctive North-American terrain, low enough that LOD tiles
    // are loaded, looking straight DOWN.
    const lon = -105.0;
    const lat = 40.0;
    const height = 1_500_000;
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO, // straight down
        roll: 0,
      },
    });

    // Surface point under the camera = the env-map eye (reflective owner).
    const surface = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

    // Let tiles + imagery load.
    for (let i = 0; i < 200; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Build + drive an env manager with capture enabled.
    const manager = new Cesium.DynamicEnvironmentMapManager();
    manager.enableSceneCapture = true;
    manager.enabled = true;
    manager.shouldUpdate = true;
    manager._position = surface;

    // Drive several update cycles (each forces a fresh capture via the
    // every-K-frames debounce + the position being new each first call).
    for (let i = 0; i < 40; i++) {
      scene.render(); // publishes the visible tile set on context
      manager.update(scene._frameState);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const cache = manager._webgpuCache;
    if (!cache || !cache.cubemapTexture) {
      return {
        error: "no cube allocated — capture path not reached",
        diag: {
          flagOnContext: ctx.sceneCaptureReflections,
          hasFR: !!scene.context.getFeatureRenderer,
          mipmapLevels: manager._mipmapLevels,
          enabled: manager.enabled,
          shouldUpdate: manager.shouldUpdate,
          hasPosition: !!manager._position,
          mode: scene._frameState.mode,
          captureSources: !!scene.context._webgpuSceneCaptureSources,
        },
      };
    }

    // Read back all 6 cube faces. The env cube has no COPY_SRC usage (only
    // TEXTURE_BINDING | STORAGE_BINDING | RENDER_ATTACHMENT | COPY_DST), so a
    // copyTextureToBuffer would fail validation. Instead bind the cube as a
    // 2d-array SAMPLED texture and `textureLoad` it in a compute pass that
    // accumulates per-face mean RGB (+ a downsample grid) into a storage buffer.
    const device = scene.context.device;
    const size = cache.size;
    const fmt = cache.cubemapFormat || "rgba8unorm";

    const arrayView = cache.cubemapTexture.createView({
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    // Output: per face → 4 floats mean (center 50%) + 32x32 grid of 4 floats.
    const GRID = 32;
    const FACE_FLOATS = 4 + GRID * GRID * 4;
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
  let lo = SIZE / 4u; let hi = (SIZE * 3u) / 4u;
  // grid accumulation
  var grid: array<vec4<f32>, ${GRID * GRID}>;
  for (var y: u32 = 0u; y < SIZE; y = y + 1u) {
    for (var x: u32 = 0u; x < SIZE; x = x + 1u) {
      let c = textureLoad(cubeArr, vec2<i32>(i32(x), i32(y)), i32(face), 0);
      if (x >= lo && x < hi && y >= lo && y < hi) {
        rsum = rsum + c.r; gsum = gsum + c.g; bsum = bsum + c.b; n = n + 1.0;
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
    for (let layer = 0; layer < 6; layer++) {
      const base = layer * FACE_FLOATS;
      const mr = floats[base] * 255;
      const mg = floats[base + 1] * 255;
      const mb = floats[base + 2] * 255;
      // Build the 32x32 thumbnail from the grid.
      const thumb = new Uint8ClampedArray(GRID * GRID * 4);
      for (let i = 0; i < GRID * GRID; i++) {
        const go = base + 4 + i * 4;
        thumb[i * 4] = Math.max(0, Math.min(255, floats[go] * 255));
        thumb[i * 4 + 1] = Math.max(0, Math.min(255, floats[go + 1] * 255));
        thumb[i * 4 + 2] = Math.max(0, Math.min(255, floats[go + 2] * 255));
        thumb[i * 4 + 3] = 255;
      }
      const lum = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
      // Terrain heuristic: green/brown land has green ≳ blue and isn't strongly
      // blue-dominant. Sky/ocean is blue-dominant. Near-black = empty/no tiles.
      const blueDominant = mb > mg + 8 && mb > mr + 8;
      const classification =
        lum < 6
          ? "dark/empty"
          : blueDominant
            ? "sky/water (blue-dominant)"
            : "TERRAIN (land-like)";
      faces.push({
        layer,
        name: faceNames[layer],
        meanRGB: [Math.round(mr), Math.round(mg), Math.round(mb)],
        lum: Math.round(lum),
        classification,
        thumb: Array.from(thumb),
      });
    }

    return {
      size,
      format: fmt,
      capturePipelineVariants: scene.context._webgpuSceneCaptureSources
        ? "sources published"
        : "NOT published",
      faces: faces.map((f) => ({
        layer: f.layer,
        name: f.name,
        meanRGB: f.meanRGB,
        lum: f.lum,
        classification: f.classification,
      })),
      thumbs: faces.map((f) => f.thumb),
    };
  });

  // Render the 6 face thumbnails into a tiled PNG for the human read.
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
        // putImageData ignores transforms; draw via temp canvas to position.
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
      path.join(OUT_DIR, "probe-scene-capture-on-faces.png"),
      Buffer.from(b64, "base64"),
    );
  }
  // Full-page screenshot too.
  await page.screenshot({
    path: path.join(OUT_DIR, "probe-scene-capture-on-canvas.png"),
  });

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log("[probe-scene-capture-on] report:");
  if (report.error) {
    console.log("  ERROR:", report.error);
  } else {
    console.log(`  cube: ${report.size}px ${report.format}, ${report.capturePipelineVariants}`);
    report.faces.forEach((f) =>
      console.log(
        `  face ${f.layer} (${f.name}): meanRGB=${JSON.stringify(f.meanRGB)} lum=${f.lum} → ${f.classification}`,
      ),
    );
  }
  if (errs.length) {
    console.log(`  ${errs.length} console errors:`);
    errs.slice(0, 8).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  console.log("  output: Tools/visual-regression/output/probe-scene-capture-on-faces.png");
})();
