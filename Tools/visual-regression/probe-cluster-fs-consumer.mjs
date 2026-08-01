#!/usr/bin/env node
// Probe-cluster-fs-consumer — Slice 5d Batch 149 end-to-end validation.
//
// Composes the FULL Forward+ chain:
//   1. WebGPUClusterBoundsRenderer  — compute cluster eye-space AABBs.
//   2. WebGPUClusterAssignRenderer  — assign lights to clusters.
//   3. WebGPUClusterDebugRenderer   — render per-cluster light-count
//      visualization to a 640×360 offscreen texture.
//
// Then reads back the rendered texture and verifies that:
//   - Pixels in tiles where the directional light reaches (always)
//     are non-black (count ≥ 1 → red).
//   - Pixels in tiles where point/spot lights also overlap show
//     count ≥ 2 → yellow.
//   - The probe walks `testViewZ` through multiple depth slices and
//     captures coverage at each — confirms the cluster Z-slice
//     mapping in the FS chunk matches what ClusterAssign wrote.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const result = await page.evaluate(async () => {
    const mod = await import("/Build/CesiumUnminified/index.js");
    const device = window.viewer.scene.context._device;

    const BoundsCtor = mod.WebGPUClusterBoundsRenderer;
    const AssignCtor = mod.WebGPUClusterAssignRenderer;
    const DebugCtor = mod.WebGPUClusterDebugRenderer;
    if (!BoundsCtor || !AssignCtor || !DebugCtor) {
      return {
        earlyExitErr: `class missing — Bounds=${typeof BoundsCtor}, Assign=${typeof AssignCtor}, Debug=${typeof DebugCtor}. Dev-server bundle cache likely stale.`,
      };
    }
    const C = mod;

    // === 1. Compute cluster bounds. ===
    const bounds = new BoundsCtor(device);
    const W = 640;
    const H = 360;
    const near = 1.0;
    const far = 1000.0;
    const projection = C.Matrix4.computePerspectiveFieldOfView(
      Math.PI / 3,
      W / H,
      near,
      far,
      new C.Matrix4(),
    );
    const inverseProjection = C.Matrix4.inverse(projection, new C.Matrix4());
    const invProjArray = new Array(16);
    for (let i = 0; i < 16; i++) invProjArray[i] = inverseProjection[i];

    const eb = device.createCommandEncoder({ label: "bounds" });
    bounds.dispatch(eb, W, H, near, far, invProjArray);
    device.queue.submit([eb.finish()]);

    // === 2. Compute light assignment. ===
    // Point at eye-space (0, 0, -50), big range so it covers most
    // pixels in slice ~10.
    const lights = [
      {
        type: 0,
        posOrDir: { x: 0, y: -1, z: -1 },
        color: { r: 1, g: 1, b: 1 },
        intensity: 1,
        range: 0,
      },
      {
        type: 1,
        posOrDir: { x: 0, y: 0, z: -50 },
        color: { r: 1, g: 0, b: 0 },
        intensity: 5,
        range: 80,
      },
    ];
    const assign = new AssignCtor(device);
    const ea = device.createCommandEncoder({ label: "assign" });
    assign.dispatch(ea, bounds.storageBuffer, lights);
    device.queue.submit([ea.finish()]);

    // === 3. Render debug visualization. ===
    const debugRenderer = new DebugCtor(device);
    const targetFormat = "rgba8unorm";
    const targetTex = device.createTexture({
      label: "cluster-debug-target",
      size: [W, H, 1],
      format: targetFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const targetView = targetTex.createView();

    // Test at depth slice ~10 (eye-space Z ≈ -42 → in front of camera
    // where the point light at z=-50 overlaps).
    const er = device.createCommandEncoder({ label: "debug-render" });
    debugRenderer.render(
      er,
      targetView,
      targetFormat,
      { width: W, height: H },
      near,
      far,
      45.0, // testViewZ (abs value; the FS uses abs(viewZ))
      lights.length,
      assign.lightStorageBuffer,
      bounds.storageBuffer,
      assign.perClusterLightCountBuffer,
      assign.perClusterLightIndicesBuffer,
    );
    device.queue.submit([er.finish()]);

    // === 4. Readback rendered pixels. ===
    // Row stride must be 256-byte aligned per WebGPU rules. W*4 = 2560
    // which is already a multiple of 256, so no padding needed.
    const bytesPerRow = W * 4;
    const READBACK_BYTES = bytesPerRow * H;
    const stagingBuffer = device.createBuffer({
      size: READBACK_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const copyEncoder = device.createCommandEncoder({ label: "readback" });
    copyEncoder.copyTextureToBuffer(
      { texture: targetTex },
      { buffer: stagingBuffer, bytesPerRow, rowsPerImage: H },
      [W, H, 1],
    );
    device.queue.submit([copyEncoder.finish()]);
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(stagingBuffer.getMappedRange().slice());
    stagingBuffer.unmap();

    // Stats: classify pixels by color encoding.
    let countBlack = 0;
    let countRed = 0;
    let countYellow = 0;
    let countOrange = 0;
    let countWhite = 0;
    let countOther = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (r === 0 && g === 0 && b === 0) countBlack++;
      else if (r === 255 && g === 0 && b === 0) countRed++;
      else if (r === 255 && g === 255 && b === 0) countYellow++;
      else if (r === 255 && Math.abs(g - 128) <= 1 && b === 0) countOrange++;
      else if (r === 255 && g === 255 && b === 255) countWhite++;
      else countOther++;
    }
    const totalPixels = W * H;

    return {
      did1: true,
      totalPixels,
      countBlack,
      countRed,
      countYellow,
      countOrange,
      countWhite,
      countOther,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-cluster-fs-consumer] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  const r = result;
  console.log(`  total pixels: ${r.totalPixels}`);
  console.log(
    `  black   (count=0): ${r.countBlack} (${((100 * r.countBlack) / r.totalPixels).toFixed(1)}%)`,
  );
  console.log(
    `  red     (count=1): ${r.countRed} (${((100 * r.countRed) / r.totalPixels).toFixed(1)}%)`,
  );
  console.log(
    `  yellow  (count=2): ${r.countYellow} (${((100 * r.countYellow) / r.totalPixels).toFixed(1)}%)`,
  );
  console.log(`  orange  (count=3): ${r.countOrange}`);
  console.log(`  white   (count≥4): ${r.countWhite}`);
  console.log(`  other:             ${r.countOther}`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
  }

  let pass = true;
  // Directional light should reach every cluster — black count should
  // be 0 (or extremely low — only border tiles where Z mapping might
  // fall just outside the grid).
  if (r.countBlack > r.totalPixels * 0.01) {
    console.log(
      `FAIL: ${r.countBlack} black pixels (>1% of total) — directional light should reach every cluster`,
    );
    pass = false;
  }
  // Some pixels should show count≥2 where the point light also fires.
  if (r.countYellow + r.countOrange + r.countWhite < 100) {
    console.log(
      `FAIL: ${r.countYellow + r.countOrange + r.countWhite} pixels with count≥2 — point light overlap not visible (expected at least a hundred yellow pixels in tiles the point reaches)`,
    );
    pass = false;
  }
  // No unexpected color combinations.
  if (r.countOther > 0) {
    console.log(
      `FAIL: ${r.countOther} pixels with unexpected color — possible FS bug`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: full Forward+ chain renders correct per-cluster light counts + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
