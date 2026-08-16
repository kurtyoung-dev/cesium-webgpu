#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 446) — DECISIVE cardinal-orientation probe.
// @purpose Ground-truth cardinal check for globe env capture: per-face on-screen camera replicas vs captured cube faces, detecting E/W swap or mirror.
// @status INVESTIGATION
//
// Resolves the ONE open correctness question for the globe scene capture:
//   "Is the side-face cardinal mapping (East/West/North/South) AND the
//    within-face horizontal orientation correct, or mirrored/swapped?"
//
// The existing ON probe puts the eye on the surface where all 4 side faces are
// horizon-symmetric, so E/W is indistinguishable there. This probe does the
// GOLD-STANDARD ground-truth comparison (Option A in the task):
//
//   1. Pick an eye at altitude over a location chosen so the 6 cube faces look
//      across genuinely different geography.
//   2. For EACH face, replicate `buildCubeFaceCamera` IN JS (ENU basis +
//      LOCAL_FACE_BASIS table), then point the ON-SCREEN main WebGPU camera at
//      EXACTLY that (position, direction, up) with a 90° square frustum, render,
//      and screenshot the canvas. That screenshot is the GROUND TRUTH for what
//      the world looks like along that face's world-forward axis.
//   3. Build + drive a DynamicEnvironmentMapManager whose eye is the SAME point
//      with capture enabled, then read back the 6 captured cube faces (same
//      texture_2d_array compute readback the ON probe uses).
//   4. Save, per face, the ground-truth screenshot next to the captured face,
//      and print mean-color + cardinal land/ocean classification.
//
// If the captured face shows the SAME geography on the SAME side as the
// ground-truth view → mapping + orientation CORRECT. If it shows a DIFFERENT
// cardinal (e.g. West face shows what the East ground-truth shows) → E/W SWAP.
// If it shows the SAME cardinal but horizontally mirrored → within-face FLIP.
//
// Usage: node Tools/visual-regression/probe-scene-capture-cardinal.mjs
// Outputs (Tools/visual-regression/output/):
//   cardinal-face<N>-<name>-gt.png      ground-truth on-screen view for face N
//   cardinal-face<N>-<name>-cap.png     captured cube face N (upscaled)
//   cardinal-report.json                metrics

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// ── Eye location. Chosen for SHARP, UNAMBIGUOUS cardinal geography. ──
// We use a HIGH eye over the eastern Pacific / west coast of South America so
// the side faces look across clearly different regions, AND a LOW corroborating
// eye at a straight meridional coastline.
//
// Primary eye: over the Big Sur / central-California coast — a STRAIGHT, sharp
// N-S meridional coastline. WEST of here is the open Pacific (ocean → dark blue,
// low variance); EAST is the California / Nevada landmass (land → brighter,
// varied). NORTH and SOUTH run roughly along the coast (mixed). This is the
// Option-B geography the task recommends, and the E/W contrast is unambiguous.
//
// Side-face cameras look HORIZONTALLY along E/W/N/S, so the local horizon sits
// at the vertical CENTER of each side face: sky in the top half, ground in the
// BOTTOM half. We therefore sample the BOTTOM-CENTER band of each side face
// (both on-screen ground truth AND captured cube face) to read its cardinal
// terrain. Height ~300 km so the bottom band looks down-and-out at nearby
// terrain in that cardinal direction rather than only a hazed far horizon.
const EYE = { lon: -121.9, lat: 36.3, height: 300_000 };

const FACE_NAMES = [
  "+X-East",
  "-X-West",
  "+Y-Up",
  "-Y-Down",
  "+Z-North",
  "-Z-South",
];

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
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // ── Step 1: compute the 6 face cameras in JS (mirror of buildCubeFaceCamera),
  // enable capture, park camera so tiles load, build env manager. ──
  const setup = await page.evaluate(async (EYE) => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const ctx = scene.context;
    if (!ctx._options) ctx._options = {};
    ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, {
      sceneCaptureReflections: true,
    });

    const eyeWC = Cesium.Cartesian3.fromDegrees(EYE.lon, EYE.lat, EYE.height);

    // ── Replicate LOCAL_FACE_BASIS (capture file lines 129-146). ──
    // [fwd, up, right] in IBL local frame: X=East, Y=Up, Z=North.
    const LOCAL_FACE_BASIS = [
      { fwd: [1, 0, 0], up: [0, 1, 0], right: [0, 0, -1] }, // +X East
      { fwd: [-1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] }, // -X West
      { fwd: [0, 1, 0], up: [0, 0, -1], right: [1, 0, 0] }, // +Y Up
      { fwd: [0, -1, 0], up: [0, 0, 1], right: [1, 0, 0] }, // -Y Down
      { fwd: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0] }, // +Z North
      { fwd: [0, 0, -1], up: [0, 1, 0], right: [-1, 0, 0] }, // -Z South
    ];

    // ENU columns from eastNorthUpToFixedFrame (East=col0, North=col1, Up=col2).
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
      eyeWC,
      Cesium.Ellipsoid.WGS84,
      new Cesium.Matrix4(),
    );
    const m = enu; // column-major Matrix4 indexable
    const norm3 = (x, y, z) => {
      const L = Math.hypot(x, y, z);
      return [x / L, y / L, z / L];
    };
    const East = norm3(m[0], m[1], m[2]);
    const North = norm3(m[4], m[5], m[6]);
    const Up = norm3(m[8], m[9], m[10]);
    // localToWorld: world = v.x*East + v.y*Up + v.z*North  (capture lines 161-169)
    const l2w = (v) => {
      const x = v[0] * East[0] + v[1] * Up[0] + v[2] * North[0];
      const y = v[0] * East[1] + v[1] * Up[1] + v[2] * North[1];
      const z = v[0] * East[2] + v[1] * Up[2] + v[2] * North[2];
      const L = Math.hypot(x, y, z);
      return { x: x / L, y: y / L, z: z / L };
    };

    const faceCams = LOCAL_FACE_BASIS.map((b) => ({
      direction: l2w(b.fwd),
      up: l2w(b.up),
      right: l2w(b.right),
    }));

    // Park camera roughly at the eye looking down so the quadtree selects tiles
    // around this region (the capture reuses the main-camera visible tile set).
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(EYE.lon, EYE.lat, EYE.height),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    for (let i = 0; i < 200; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Build + drive the env manager (capture eye == EYE).
    const manager = new Cesium.DynamicEnvironmentMapManager();
    manager.enableSceneCapture = true;
    manager.enabled = true;
    manager.shouldUpdate = true;
    manager._position = eyeWC.clone();
    window.__capManager = manager;
    window.__faceCams = faceCams;
    window.__eyeWC = { x: eyeWC.x, y: eyeWC.y, z: eyeWC.z };

    return {
      ok: true,
      East,
      North,
      Up,
      faceCams,
    };
  }, EYE);

  // ── Step 2: per face — set on-screen camera to the face camera, render,
  // screenshot the canvas as ground truth. ──
  const gtMeans = [];
  for (let face = 0; face < 6; face++) {
    const mean = await page.evaluate(async (face) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const scene = window.viewer.scene;
      const fc = window.__faceCams[face];
      const eye = window.__eyeWC;
      // Square 90° frustum to match the face camera.
      const cam = scene.camera;
      cam.frustum.fov = Math.PI / 2;
      cam.frustum.aspectRatio = 1.0;
      scene.camera.setView({
        destination: new Cesium.Cartesian3(eye.x, eye.y, eye.z),
        orientation: {
          direction: new Cesium.Cartesian3(
            fc.direction.x,
            fc.direction.y,
            fc.direction.z,
          ),
          up: new Cesium.Cartesian3(fc.up.x, fc.up.y, fc.up.z),
        },
      });
      // Render a number of frames to let tiles for THIS direction load.
      for (let i = 0; i < 120; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Sample the canvas mean color (center region) for a quick land/ocean read.
      const canvas = scene.canvas;
      const gl2d = document.createElement("canvas");
      gl2d.width = canvas.width;
      gl2d.height = canvas.height;
      const g = gl2d.getContext("2d");
      g.drawImage(canvas, 0, 0);
      const w = canvas.width;
      const h = canvas.height;
      // BOTTOM-CENTER band: ground sits below the horizon (frame center) for a
      // horizontal-looking side-face camera. x in [25%,75%], y in [55%,95%].
      const x0 = (w * 0.25) | 0;
      const y0 = (h * 0.55) | 0;
      const x1 = (w * 0.75) | 0;
      const y1 = (h * 0.95) | 0;
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let r = 0,
        gg = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        gg += d[i + 1];
        b += d[i + 2];
        n++;
      }
      return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
    }, face);
    gtMeans.push(mean);
    await page.screenshot({
      path: path.join(
        OUT_DIR,
        `cardinal-face${face}-${FACE_NAMES[face]}-gt.png`,
      ),
    });
  }

  // ── Step 3: drive the capture + read back the 6 cube faces. ──
  const cap = await page.evaluate(async (EYE) => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const scene = window.viewer.scene;
    const manager = window.__capManager;
    // Re-park top-down at high altitude so the quadtree selects a BROAD tile set
    // spanning all cardinal directions around the eye (the capture reuses the
    // main-camera visible tile set). Restore a normal frustum first (the GT loop
    // left a 90° square frustum).
    scene.camera.frustum.fov = Cesium.Math.toRadians(60);
    scene.camera.frustum.aspectRatio =
      scene.canvas.clientWidth / scene.canvas.clientHeight || 1;
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(EYE.lon, EYE.lat, EYE.height),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    for (let i = 0; i < 150; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 60; i++) {
      scene.render();
      manager.update(scene._frameState);
      await new Promise((r) => requestAnimationFrame(r));
    }

    // ── Diagnostic: at capture time, how many of the reused visible tiles have
    // READY imagery? If ~0, the captured globe is flat-shaded (no continents),
    // which would make any structural E/W comparison impossible regardless of
    // the camera-basis correctness. ──
    let tileDiag = { error: "no sources" };
    const srcs = scene.context._webgpuSceneCaptureSources;
    const tilesToRender = srcs?.tileProvider?._quadtree?._tilesToRender;
    if (tilesToRender) {
      let total = 0,
        withData = 0,
        withReadyImagery = 0,
        levelMin = 99,
        levelMax = -1;
      for (const t of tilesToRender) {
        total++;
        if (t && t.data) withData++;
        if (t) {
          if (t.level < levelMin) levelMin = t.level;
          if (t.level > levelMax) levelMax = t.level;
        }
        const imagery = t?.data?.imagery;
        if (imagery) {
          for (let i = 0; i < imagery.length; i++) {
            const ti = imagery[i];
            if (ti && ti.readyImagery && ti.readyImagery.imageryLayer) {
              withReadyImagery++;
              break;
            }
          }
        }
      }
      tileDiag = { total, withData, withReadyImagery, levelMin, levelMax };
    }
    window.__tileDiag = tileDiag;

    const cache = manager._webgpuCache;
    if (!cache || !cache.cubemapTexture) {
      return {
        error: "no cube allocated",
        diag: { flag: scene.context.sceneCaptureReflections },
      };
    }
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
    // Read the FULL face as a downsampled grid for image reconstruction.
    const GRID = 64;
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
    const floats = Array.from(
      new Float32Array(readBuf.getMappedRange().slice(0)),
    );
    readBuf.unmap();
    return {
      size,
      fmt,
      GRID,
      FACE_FLOATS,
      floats,
      tileDiag: window.__tileDiag,
    };
  }, EYE);

  if (cap.error) {
    console.log(
      "[cardinal] CAPTURE ERROR:",
      cap.error,
      JSON.stringify(cap.diag),
    );
    await browser.close();
    return;
  }

  // Reconstruct + upscale each captured face PNG, compute mean color.
  const { GRID, FACE_FLOATS, floats } = cap;
  const capMeans = [];
  const capBottomMeans = [];
  const capBottomVar = []; // luminance std-dev of the bottom band (flatness probe)
  for (let face = 0; face < 6; face++) {
    const base = face * FACE_FLOATS;
    capMeans.push([
      Math.round(floats[base] * 255),
      Math.round(floats[base + 1] * 255),
      Math.round(floats[base + 2] * 255),
    ]);
    // BOTTOM-CENTER band of the captured face (large gy = ground; mirror of the
    // on-screen GT bottom band). gx in [25%,75%], gy in [55%,95%].
    {
      let r = 0,
        gg = 0,
        b = 0,
        n = 0;
      const gx0 = Math.floor(GRID * 0.25);
      const gx1 = Math.floor(GRID * 0.75);
      const gy0 = Math.floor(GRID * 0.55);
      const gy1 = Math.floor(GRID * 0.95);
      for (let gy = gy0; gy < gy1; gy++) {
        for (let gx = gx0; gx < gx1; gx++) {
          const go = base + 4 + (gy * GRID + gx) * 4;
          r += floats[go];
          gg += floats[go + 1];
          b += floats[go + 2];
          n++;
        }
      }
      capBottomMeans.push([
        Math.round((r / n) * 255),
        Math.round((gg / n) * 255),
        Math.round((b / n) * 255),
      ]);
      // Luminance std-dev over the same bottom band → flatness metric.
      let lsum = 0,
        l2sum = 0,
        ln = 0;
      for (let gy = gy0; gy < gy1; gy++) {
        for (let gx = gx0; gx < gx1; gx++) {
          const go = base + 4 + (gy * GRID + gx) * 4;
          const L =
            0.2126 * floats[go] * 255 +
            0.7152 * floats[go + 1] * 255 +
            0.0722 * floats[go + 2] * 255;
          lsum += L;
          l2sum += L * L;
          ln++;
        }
      }
      const meanL = lsum / ln;
      capBottomVar.push(Math.sqrt(Math.max(0, l2sum / ln - meanL * meanL)));
    }
    // Build a GRID×GRID thumbnail and upscale to 256.
    const thumb = new Array(GRID * GRID * 4);
    for (let i = 0; i < GRID * GRID; i++) {
      const go = base + 4 + i * 4;
      thumb[i * 4] = Math.max(0, Math.min(255, floats[go] * 255));
      thumb[i * 4 + 1] = Math.max(0, Math.min(255, floats[go + 1] * 255));
      thumb[i * 4 + 2] = Math.max(0, Math.min(255, floats[go + 2] * 255));
      thumb[i * 4 + 3] = 255;
    }
    const dataUrl = await page.evaluate(
      ({ thumb, GRID }) => {
        const c = document.createElement("canvas");
        c.width = GRID;
        c.height = GRID;
        const g = c.getContext("2d");
        const img = g.createImageData(GRID, GRID);
        img.data.set(new Uint8ClampedArray(thumb));
        g.putImageData(img, 0, 0);
        const big = document.createElement("canvas");
        big.width = 256;
        big.height = 256;
        const bg2 = big.getContext("2d");
        bg2.imageSmoothingEnabled = false;
        bg2.drawImage(c, 0, 0, 256, 256);
        return big.toDataURL("image/png");
      },
      { thumb, GRID },
    );
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(
      path.join(OUT_DIR, `cardinal-face${face}-${FACE_NAMES[face]}-cap.png`),
      Buffer.from(b64, "base64"),
    );
  }

  // Classification helper.
  const classify = ([r, g, b]) => {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 6) return "dark/empty";
    if (b > g + 8 && b > r + 8) return "OCEAN/sky (blue-dominant)";
    return "LAND (varied/green-brown)";
  };

  const report = {
    eye: EYE,
    enu: { East: setup.East, North: setup.North, Up: setup.Up },
    faces: FACE_NAMES.map((name, i) => ({
      face: i,
      name,
      groundTruthBottomMean: gtMeans[i],
      groundTruthClass: classify(gtMeans[i]),
      capturedBottomMean: capBottomMeans[i],
      capturedClass: classify(capBottomMeans[i]),
      capturedFullCenterMean: capMeans[i],
    })),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "cardinal-report.json"),
    JSON.stringify(report, null, 2),
  );

  await browser.close();

  console.log("[cardinal] eye:", JSON.stringify(EYE));
  console.log("  ENU East:", setup.East.map((v) => v.toFixed(3)).join(","));
  console.log("  ENU North:", setup.North.map((v) => v.toFixed(3)).join(","));
  console.log("");
  console.log("  capture-time tile diag:", JSON.stringify(cap.tileDiag));
  console.log(
    "  (bottom-center band = ground below the horizon for side faces)",
  );
  console.log(
    "  face       GROUND-TRUTH(on-screen)          CAPTURED(cube face)            bottomStdDev",
  );
  for (let i = 0; i < report.faces.length; i++) {
    const f = report.faces[i];
    console.log(
      `  ${f.name.padEnd(10)} GT=${JSON.stringify(f.groundTruthBottomMean).padEnd(15)} ${f.groundTruthClass.padEnd(26)} CAP=${JSON.stringify(f.capturedBottomMean).padEnd(15)} ${f.capturedClass.padEnd(26)} ${capBottomVar[i].toFixed(2)}`,
    );
  }
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} console errors (first 5):`);
    errs.slice(0, 5).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  console.log(
    "  PNGs: Tools/visual-regression/output/cardinal-face*-{gt,cap}.png",
  );
})();
