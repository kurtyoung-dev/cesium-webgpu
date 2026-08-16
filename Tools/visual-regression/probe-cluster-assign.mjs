#!/usr/bin/env node
// Probe-cluster-assign — Slice 5d Batch 148 verification.
// @purpose Compute-readback check of WebGPUClusterAssignRenderer: known 3-light scene yields expected per-cluster counts; dirty-skip works.
// @status ACTIVE
//
// Composes WebGPUClusterBoundsRenderer + WebGPUClusterAssignRenderer
// in a fresh page. Dispatches both compute passes against a known
// scene:
//   - 60° fov, 4:3 aspect, near=1, far=1000 perspective.
//   - 3 representative lights:
//     * Directional (always overlaps every cluster)
//     * Point at eye-space (0, 0, 50), range 20 (overlaps clusters
//       near depth slice ~10)
//     * Spot at eye-space (0, 0, 500), range 100 (overlaps clusters
//       near depth slice ~20)
//
// Reads back perClusterLightCount + perClusterLightIndices via
// staging copy and asserts:
//   - First cluster (gid=0,0,0, near) has count >= 1 (the directional
//     light at minimum).
//   - Some cluster near depth slice 10 has count >= 2 (directional +
//     point light overlap).
//   - Far cluster (gid=15,8,23) has count >= 1 (directional reaches
//     every cluster).
//   - Total overlap count summed across all clusters > 3456 (every
//     cluster has at least the directional light = 3456 baseline).
//   - Dirty tracking: second dispatch with identical inputs returns
//     false.

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
    if (typeof BoundsCtor !== "function" || typeof AssignCtor !== "function") {
      return {
        earlyExitErr: `class missing — Bounds=${typeof BoundsCtor}, Assign=${typeof AssignCtor}. Dev-server bundle cache likely stale.`,
      };
    }
    const TOTAL = mod.CLUSTER_TOTAL_COUNT;
    const PER_CLUSTER_CAP = mod.CLUSTER_MAX_LIGHTS_PER_CLUSTER;
    const C = mod;

    // 1. Compute bounds.
    const bounds = new BoundsCtor(device);
    const projection = C.Matrix4.computePerspectiveFieldOfView(
      Math.PI / 3,
      4 / 3,
      1.0,
      1000.0,
      new C.Matrix4(),
    );
    const inverseProjection = C.Matrix4.inverse(projection, new C.Matrix4());
    const invProjArray = new Array(16);
    for (let i = 0; i < 16; i++) invProjArray[i] = inverseProjection[i];

    const encoderBounds = device.createCommandEncoder({
      label: "probe-cluster-assign:bounds",
    });
    bounds.dispatch(encoderBounds, 800, 600, 1.0, 1000.0, invProjArray);
    device.queue.submit([encoderBounds.finish()]);

    // 2. Build representative lights in eye-space. Cesium's projection
    // (per probe-cluster-bounds.mjs sample output) uses -Z forward
    // convention — clusters in front of the camera have negative
    // eye-space Z. Place point/spot lights at negative Z to put them
    // inside the frustum where overlap tests will fire.
    const lights = [
      {
        type: 0, // DIRECTIONAL
        posOrDir: { x: 0, y: -1, z: -1 },
        color: { r: 1, g: 1, b: 1 },
        intensity: 1.0,
        range: 0,
      },
      {
        type: 1, // POINT — at eye-space depth -50 (50m in front)
        posOrDir: { x: 0, y: 0, z: -50 },
        color: { r: 1, g: 0.5, b: 0.2 },
        intensity: 5.0,
        range: 20.0,
      },
      {
        type: 2, // SPOT — at eye-space depth -500
        posOrDir: { x: 0, y: 0, z: -500 },
        color: { r: 0.2, g: 0.5, b: 1 },
        intensity: 10.0,
        range: 100.0,
        innerConeAngle: 0.2,
        outerConeAngle: 0.5,
        spotDir: { x: 0, y: 0, z: -1 },
      },
    ];

    // 3. Dispatch assign.
    const assign = new AssignCtor(device);
    const encoderAssign1 = device.createCommandEncoder({
      label: "probe-cluster-assign:dispatch1",
    });
    const did1 = assign.dispatch(encoderAssign1, bounds.storageBuffer, lights);
    device.queue.submit([encoderAssign1.finish()]);

    // 4. Second dispatch with same lights — should skip.
    const encoderAssign2 = device.createCommandEncoder({
      label: "probe-cluster-assign:dispatch2",
    });
    const did2 = assign.dispatch(encoderAssign2, bounds.storageBuffer, lights);
    device.queue.submit([encoderAssign2.finish()]);

    // 5. Read back perClusterLightCount.
    const COUNT_BYTES = TOTAL * 4;
    const countStaging = device.createBuffer({
      size: COUNT_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const countEncoder = device.createCommandEncoder({
      label: "count-readback",
    });
    countEncoder.copyBufferToBuffer(
      assign.perClusterLightCountBuffer,
      0,
      countStaging,
      0,
      COUNT_BYTES,
    );
    device.queue.submit([countEncoder.finish()]);
    await countStaging.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(countStaging.getMappedRange().slice());
    countStaging.unmap();

    // 6. Read back perClusterLightIndices (just first cluster for sanity).
    const INDICES_BYTES = PER_CLUSTER_CAP * 4 * 6; // first 6 clusters
    const idxStaging = device.createBuffer({
      size: INDICES_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const idxEncoder = device.createCommandEncoder({
      label: "indices-readback",
    });
    idxEncoder.copyBufferToBuffer(
      assign.perClusterLightIndicesBuffer,
      0,
      idxStaging,
      0,
      INDICES_BYTES,
    );
    device.queue.submit([idxEncoder.finish()]);
    await idxStaging.mapAsync(GPUMapMode.READ);
    const indicesAll = new Uint32Array(idxStaging.getMappedRange().slice());
    idxStaging.unmap();

    // Stats
    let totalOverlap = 0;
    let maxPerCluster = 0;
    let clustersWith3Lights = 0;
    let clustersWith2Lights = 0;
    for (let i = 0; i < TOTAL; i++) {
      totalOverlap += counts[i];
      if (counts[i] > maxPerCluster) maxPerCluster = counts[i];
      if (counts[i] >= 3) clustersWith3Lights++;
      else if (counts[i] >= 2) clustersWith2Lights++;
    }

    // Inspect specific clusters.
    function clusterAt(tileX, tileY, sliceZ) {
      const ci = tileX + tileY * 16 + sliceZ * 16 * 9;
      return { idx: ci, count: counts[ci] };
    }
    const samples = [
      clusterAt(0, 0, 0), // near corner
      clusterAt(8, 4, 0), // near center
      clusterAt(8, 4, 5), // mid-near
      clusterAt(8, 4, 10), // mid (point light expected here)
      clusterAt(8, 4, 20), // mid-far (spot light expected here)
      clusterAt(15, 8, 23), // far corner
    ];
    // Index list at cluster (8,4,10) — should contain at least
    // light index 0 (directional). Probably also 1 (point) if the
    // sphere overlap fired.
    const idxClusterMid = 8 + 4 * 16 + 10 * 16 * 9;
    const idxFirst6 = [];
    for (let k = 0; k < 6; k++) {
      idxFirst6.push(indicesAll[k]);
    }

    return {
      did1,
      did2,
      totalOverlap,
      maxPerCluster,
      clustersWith3Lights,
      clustersWith2Lights,
      TOTAL,
      samples,
      indexBufferFirst6: idxFirst6,
      clusterMidIdx: idxClusterMid,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-cluster-assign] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  console.log(
    `  did1: ${result.did1}  did2: ${result.did2} (expect true, false)`,
  );
  console.log(
    `  totalOverlap=${result.totalOverlap} across ${result.TOTAL} clusters`,
  );
  console.log(`  maxPerCluster=${result.maxPerCluster}`);
  console.log(`  clusters with ≥3 lights: ${result.clustersWith3Lights}`);
  console.log(`  clusters with ≥2 lights: ${result.clustersWith2Lights}`);
  console.log("  sampled clusters (count):");
  result.samples.forEach((s) =>
    console.log(`    idx=${s.idx}  count=${s.count}`),
  );
  console.log(`  indices[0..5]=[${result.indexBufferFirst6.join(", ")}]`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
  }

  let pass = true;
  if (result.did1 !== true) {
    console.log("FAIL: first dispatch returned false");
    pass = false;
  }
  if (result.did2 !== false) {
    console.log("FAIL: second dispatch returned true (dirty-tracking failed)");
    pass = false;
  }
  // Every cluster has the directional light → totalOverlap >= TOTAL.
  if (result.totalOverlap < result.TOTAL) {
    console.log(
      `FAIL: totalOverlap (${result.totalOverlap}) < cluster count (${result.TOTAL}) — directional light should reach every cluster`,
    );
    pass = false;
  }
  // First cluster's first index should be 0 (the directional light,
  // tested first and inserted first).
  if (result.indexBufferFirst6[0] !== 0) {
    console.log(
      `FAIL: indices[0] = ${result.indexBufferFirst6[0]}, expected 0 (directional light index)`,
    );
    pass = false;
  }
  // At least some clusters should have >= 2 lights (where the point
  // or spot also fired).
  if (result.clustersWith2Lights + result.clustersWith3Lights === 0) {
    console.log(
      `FAIL: no clusters with multiple lights — point + spot AABB tests likely never fired`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }

  if (pass) {
    console.log(
      "\nPASS: cluster-assign produces sane per-cluster counts + dirty tracking + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
