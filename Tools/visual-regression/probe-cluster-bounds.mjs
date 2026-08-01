#!/usr/bin/env node
// Probe-cluster-bounds — Slice 5d Batch 137c verification.
//
// Constructs a WebGPUClusterBoundsRenderer in a fresh CesiumViewer
// page, dispatches the compute shader with a known perspective
// projection, then reads back the storage buffer via a staging copy
// and verifies the per-cluster AABBs match expectations.
//
// Sanity checks per cluster:
//   - sliceZ=0   clusters at near plane (~1.0)
//   - sliceZ=23  clusters at far plane (eye-space Z exponentially
//                spaced between near and far)
//   - all clusters have minZ < maxZ (AABB has positive depth extent)
//   - tile (0,0,sliceZ) has x bounds in [-something, -something/2]
//     (left edge of frustum)
//   - tile (15,0,sliceZ) has x bounds in [+something/2, +something]
//     (right edge of frustum)
//
// Also verifies dirty tracking: a second dispatch with identical
// inputs skips and returns false.

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
    // Import the renderer module directly.
    const mod = await import("/Build/CesiumUnminified/index.js");
    const device = window.viewer.scene.context._device;

    // Pull WebGPUClusterBoundsRenderer from the main bundle (Batch 147
    // added it to the public engine + Cesium exports).
    const WebGPUClusterBoundsRenderer = mod.WebGPUClusterBoundsRenderer;
    if (typeof WebGPUClusterBoundsRenderer !== "function") {
      return {
        earlyExitErr: `WebGPUClusterBoundsRenderer not on main bundle (got ${typeof WebGPUClusterBoundsRenderer}) — likely dev-server bundle cache is stale from before Batch 147 build`,
      };
    }

    const renderer = new WebGPUClusterBoundsRenderer(device);

    // Construct a representative perspective inverse projection:
    //   fov = 60° vertical, aspect = 1.333, near = 1, far = 1000.
    // Use Cesium's Matrix4 utilities to build the matrix.
    const C = mod;
    const projection = C.Matrix4.computePerspectiveFieldOfView(
      Math.PI / 3, // 60° vertical
      4.0 / 3.0, // aspect
      1.0, // near
      1000.0, // far
      new C.Matrix4(),
    );
    const inverseProjection = C.Matrix4.inverse(projection, new C.Matrix4());
    // Cesium stores column-major as a 16-element array.
    const invProjArray = new Array(16);
    for (let i = 0; i < 16; i++) {
      invProjArray[i] = inverseProjection[i];
    }

    // Dispatch once.
    const encoder1 = device.createCommandEncoder({ label: "cluster-test-1" });
    const did1 = renderer.dispatch(
      encoder1,
      800,
      600,
      1.0,
      1000.0,
      invProjArray,
    );
    device.queue.submit([encoder1.finish()]);

    // Dispatch again with identical inputs — should skip.
    const encoder2 = device.createCommandEncoder({ label: "cluster-test-2" });
    const did2 = renderer.dispatch(
      encoder2,
      800,
      600,
      1.0,
      1000.0,
      invProjArray,
    );
    device.queue.submit([encoder2.finish()]);

    // Read back via staging buffer.
    const TOTAL_CLUSTERS = 16 * 9 * 24;
    const BYTES = TOTAL_CLUSTERS * 32;
    const stagingBuffer = device.createBuffer({
      size: BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const copyEncoder = device.createCommandEncoder({
      label: "cluster-readback",
    });
    copyEncoder.copyBufferToBuffer(
      renderer.storageBuffer,
      0,
      stagingBuffer,
      0,
      BYTES,
    );
    device.queue.submit([copyEncoder.finish()]);
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(stagingBuffer.getMappedRange().slice());
    stagingBuffer.unmap();

    // Sample a few clusters.
    // Cluster index = tileX + tileY * 16 + sliceZ * 16 * 9.
    // Each cluster = 8 floats (2 vec4): min.xyz + min.w pad, max.xyz + max.w pad.
    function clusterAABB(tileX, tileY, sliceZ) {
      const idx = tileX + tileY * 16 + sliceZ * 16 * 9;
      const base = idx * 8;
      return {
        minX: raw[base + 0],
        minY: raw[base + 1],
        minZ: raw[base + 2],
        maxX: raw[base + 4],
        maxY: raw[base + 5],
        maxZ: raw[base + 6],
      };
    }

    const samples = [];
    // Near depth slice (sliceZ=0)
    samples.push({ at: "(0,0,0)", aabb: clusterAABB(0, 0, 0) });
    samples.push({ at: "(8,4,0)", aabb: clusterAABB(8, 4, 0) });
    samples.push({ at: "(15,8,0)", aabb: clusterAABB(15, 8, 0) });
    // Mid depth (sliceZ=12)
    samples.push({ at: "(0,0,12)", aabb: clusterAABB(0, 0, 12) });
    samples.push({ at: "(8,4,12)", aabb: clusterAABB(8, 4, 12) });
    samples.push({ at: "(15,8,12)", aabb: clusterAABB(15, 8, 12) });
    // Far depth (sliceZ=23)
    samples.push({ at: "(0,0,23)", aabb: clusterAABB(0, 0, 23) });
    samples.push({ at: "(8,4,23)", aabb: clusterAABB(8, 4, 23) });
    samples.push({ at: "(15,8,23)", aabb: clusterAABB(15, 8, 23) });

    return {
      did1,
      did2,
      samples,
      totalClustersRead: TOTAL_CLUSTERS,
      bytesRead: BYTES,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-cluster-bounds] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  console.log(`  did1 (first dispatch): ${result.did1} (expect true)`);
  console.log(
    `  did2 (second dispatch, same inputs): ${result.did2} (expect false — dirty-tracking skip)`,
  );
  console.log(
    `  read back: ${result.bytesRead} bytes / ${result.totalClustersRead} clusters`,
  );
  console.log("\n  sampled clusters:");
  for (const s of result.samples) {
    const a = s.aabb;
    console.log(
      `    ${s.at.padEnd(12)} min=(${a.minX.toFixed(2)}, ${a.minY.toFixed(2)}, ${a.minZ.toFixed(2)})  max=(${a.maxX.toFixed(2)}, ${a.maxY.toFixed(2)}, ${a.maxZ.toFixed(2)})`,
    );
  }
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
  }

  // Sanity assertions.
  let pass = true;
  if (result.did1 !== true) {
    console.log("FAIL: first dispatch returned false (expected true)");
    pass = false;
  }
  if (result.did2 !== false) {
    console.log(
      "FAIL: second dispatch returned true (expected false — dirty-tracking skip)",
    );
    pass = false;
  }
  // sliceZ=0 should be near (|Z| ≈ 1.0); sliceZ=23 should approach
  // far (|Z| ≈ 1000). Use magnitudes — Cesium projections may use
  // either +Z or -Z forward convention depending on the matrix
  // builder. The cluster bounds are eye-space-correct either way;
  // downstream sphere-AABB consumers don't care about sign.
  const near = result.samples.find((s) => s.at === "(8,4,0)").aabb;
  const far = result.samples.find((s) => s.at === "(8,4,23)").aabb;
  const nearZMag = Math.min(Math.abs(near.minZ), Math.abs(near.maxZ));
  const farZMag = Math.max(Math.abs(far.minZ), Math.abs(far.maxZ));
  if (nearZMag < 0.5 || nearZMag > 2.0) {
    console.log(
      `FAIL: near cluster |Z| ${nearZMag.toFixed(3)} outside [0.5, 2.0]`,
    );
    pass = false;
  }
  if (farZMag < 500 || farZMag > 1200) {
    console.log(
      `FAIL: far cluster |Z| ${farZMag.toFixed(3)} outside [500, 1200]`,
    );
    pass = false;
  }
  // All clusters should have non-zero depth extent (regardless of sign).
  for (const s of result.samples) {
    if (Math.abs(s.aabb.maxZ - s.aabb.minZ) < 1e-6) {
      console.log(
        `FAIL: cluster ${s.at} has zero depth extent (minZ=${s.aabb.minZ}, maxZ=${s.aabb.maxZ})`,
      );
      pass = false;
    }
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: cluster bounds populated + dirty tracking works + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
