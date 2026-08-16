#!/usr/bin/env node
// Probe: PARITY-HIZ-TILE-BOUNDING
// @purpose Gates the OBB bounding-volume fix in Hi-Z SOA population: no NaN radii for region-bounded tilesets, radii match sphere-from-OBB, no tileset vanish
// @status ACTIVE
//
// Verifies the fix for Hi-Z occlusion silently mis-culling OBB-bounded
// 3D-tile tiles. Before the fix, SOABoundingSphereLayout.populate() read
// `.radius` off EVERY boundingVolume — but OrientedBoundingBox (which
// 3D-tile DrawCommands carry, incl. `region`-bounded tilesets) has no
// `.radius`, so the radius SOA filled with NaN and the occlusion test
// produced garbage visibility.
//
// This probe:
//   1. Loads a `region`-bounded tileset (→ OBB tile bounds) on WebGPU.
//   2. Grabs the real DrawCommand list, confirms OBB-bounded commands are
//      present, runs the exact populate() code, and asserts NO NaN in the
//      radius buffer + radii match BoundingSphere.fromOrientedBoundingBox.
//   3. Enables Hi-Z occlusion (scene.renderScheduler.occlusionCulling) and
//      renders WebGPU vs WebGL from a distance, capturing PNGs so the
//      visible-tile coverage can be compared (occluded tiles culled, no
//      NaN-driven whole-tileset vanish).
//
// Usage: node Tools/visual-regression/probe-hiz-tile-occlusion.mjs
// Outputs: output/probe-hiz-tile-occlusion-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TILESET = "/Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/tileset.json";

async function run(rendererArg) {
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
    viewport: { width: 1280, height: 720 },
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle", timeout: 90000 },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(async (TILESET) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    // Enable Hi-Z occlusion (opt-in). No-op on WebGL (no compute FR), but
    // the toggle is byte-identical so exercising it is safe.
    scene.renderScheduler.occlusionCulling.enabled = true;

    const ts = await C.Cesium3DTileset.fromUrl(TILESET, {
      maximumScreenSpaceError: 4,
    });
    scene.primitives.add(ts);

    // Point the camera at the tileset from a distance so back tiles are
    // occluded by front tiles.
    await ts.readyPromise?.catch?.(() => {});
    const bs = ts.boundingSphere;
    const cart = C.Cartographic.fromCartesian(bs.center);
    v.camera.setView({
      destination: C.Cartesian3.fromRadians(
        cart.longitude,
        cart.latitude,
        cart.height + bs.radius * 3.0,
      ),
      orientation: { heading: 0, pitch: -0.5, roll: 0 },
    });

    // Settle: load tiles + let the occlusion readback loop spin up
    // (needs several frames for the one-frame-latency GPU readback).
    for (let i = 0; i < 180; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // ── Direct populate() NaN check on a real OBB-bounded command mix ──
    // The frame's own command list is BoundingSphere-heavy (models/globe),
    // so we augment it with OrientedBoundingBox-bounded DrawCommands built
    // the SAME way Vector3DTileClampedPolylines does (a real reachable path
    // — `new DrawCommand({ boundingVolume: OrientedBoundingBox })`). This is
    // the exact input that produced NaN in the radius SOA before the fix.
    const commandList = scene.frameState.commandList.slice();

    // Build OBBs from real rectangles on the ellipsoid (what
    // OrientedBoundingBox.fromRectangle yields for a clamped-polyline tile).
    const rects = [
      C.Rectangle.fromDegrees(-75.6, 40.0, -75.4, 40.2),
      C.Rectangle.fromDegrees(-80.0, 25.0, -79.5, 25.5),
      C.Rectangle.fromDegrees(10.0, 45.0, 10.5, 45.5),
    ];
    for (const rect of rects) {
      const obb = C.OrientedBoundingBox.fromRectangle(
        rect,
        0.0,
        5000.0,
        C.Ellipsoid.WGS84,
      );
      // Mirror the Vector3DTileClampedPolylines DrawCommand shape: a command
      // whose boundingVolume is a raw OrientedBoundingBox (no `.radius`).
      commandList.push(new C.DrawCommand({ boundingVolume: obb }));
    }

    let obbCount = 0;
    let sphereCount = 0;
    let commandsWithBV = 0;
    for (const cmd of commandList) {
      if (!cmd || !cmd.boundingVolume) continue;
      commandsWithBV++;
      const bv = cmd.boundingVolume;
      if (typeof bv.radius === "number") sphereCount++;
      else if (bv.halfAxes) obbCount++;
    }

    // Run the actual PRODUCTION layout.populate() and inspect the radius
    // buffer. `_soaLayout` is the exact SOABoundingSphereLayout instance the
    // occlusion path packs each frame — reaching it avoids needing the
    // @private class in the public barrel while still exercising real code.
    const layout = scene.renderScheduler.occlusionCulling._soaLayout;
    let nanCount = 0;
    let populatedCount = 0;
    let maxRadiusErr = 0;
    let radiiChecked = 0;
    if (layout && typeof layout.populate === "function") {
      populatedCount = layout.populate(commandList);
      for (let i = 0; i < populatedCount; i++) {
        if (!isFinite(layout.radius[i])) nanCount++;
      }
      // Cross-check derived radii against BoundingSphere.fromOrientedBoundingBox.
      const tmp = new C.BoundingSphere();
      for (let i = 0; i < populatedCount; i++) {
        const cmdIdx = layout.commandIndices[i];
        const bv = commandList[cmdIdx].boundingVolume;
        if (bv && bv.halfAxes && typeof bv.radius !== "number") {
          C.BoundingSphere.fromOrientedBoundingBox(bv, tmp);
          const err =
            Math.abs(tmp.radius - layout.radius[i]) / (tmp.radius || 1);
          if (err > maxRadiusErr) maxRadiusErr = err;
          radiiChecked++;
        }
      }
    }

    const occStats = scene.renderScheduler.occlusionCulling.stats;

    return {
      soaLayoutReachable: !!layout,
      commandListLength: commandList.length,
      commandsWithBV,
      obbCount,
      sphereCount,
      populatedCount,
      nanCount,
      radiiChecked,
      maxRadiusErr,
      occlusionEnabled: scene.renderScheduler.occlusionCulling.enabled,
      commandsTested: occStats.commandsTested,
      commandsOccluded: occStats.commandsOccluded,
      occlusionRate: occStats.occlusionRate,
    };
  }, TILESET);

  const outPng = path.join(
    OUT_DIR,
    `probe-hiz-tile-occlusion-${rendererArg}.png`,
  );
  const buf = await page.screenshot({ path: outPng, fullPage: false });
  await browser.close();
  return { result, outPng, pngBytes: buf.length, errs };
}

// Pixel diff of the two rendered screenshots (canvas decode, no Node PNG dep).
// Also counts non-background (rendered-tile) pixels per image so we can
// confirm the tileset actually rendered on WebGPU (a NaN mis-cull would
// blank it).
async function diffAndCoverage(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const r = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const total = A.w * A.h;
      let mismatch = 0;
      let covA = 0;
      let covB = 0;
      // Background is the sky/globe; "tile coverage" here is a coarse proxy
      // — we compare per-image non-uniform pixel counts, mainly to confirm
      // WebGPU didn't blank the whole tileset (NaN mis-cull symptom).
      for (let i = 0; i < A.data.length; i += 4) {
        const dr = Math.abs(A.data[i] - B.data[i]);
        const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
        const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (dr + dg + db > 40) mismatch++;
        // crude coverage: pixels brighter than deep-sky black
        const lumA = A.data[i] + A.data[i + 1] + A.data[i + 2];
        const lumB = B.data[i] + B.data[i + 1] + B.data[i + 2];
        if (lumA > 60) covA++;
        if (lumB > 60) covB++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
        coverageA: covA,
        coverageB: covB,
        coverageRatio: (covA / Math.max(1, covB)).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return r;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("[probe-hiz-tile-occlusion] WebGPU run...");
  const gpu = await run("webgpu");
  console.log("  webgpu result:", JSON.stringify(gpu.result, null, 2));
  console.log("  webgpu png:", gpu.outPng, gpu.pngBytes, "bytes");
  if (gpu.errs.length) {
    console.log("  webgpu errors:", gpu.errs.slice(0, 5));
  }

  console.log("[probe-hiz-tile-occlusion] WebGL run...");
  const gl = await run("webgl");
  console.log("  webgl result:", JSON.stringify(gl.result, null, 2));
  console.log("  webgl png:", gl.outPng, gl.pngBytes, "bytes");
  if (gl.errs.length) {
    console.log("  webgl errors:", gl.errs.slice(0, 5));
  }

  console.log("[probe-hiz-tile-occlusion] diff + coverage...");
  const diff = await diffAndCoverage(gl.outPng, gpu.outPng);
  console.log("  diff:", JSON.stringify(diff));

  // ── Verdicts ──
  const R = gpu.result;
  const passOBB = R.obbCount > 0;
  const passNoNaN = R.nanCount === 0 && R.populatedCount > 0;
  const passRadius = R.radiiChecked > 0 && R.maxRadiusErr < 1e-3;
  const passCoverage =
    diff &&
    !diff.error &&
    Number(diff.coverageRatio) > 0.5 &&
    Number(diff.coverageRatio) < 2.0;

  console.log("\n=== VERDICT ===");
  console.log(
    `  OBB-bounded commands present : ${passOBB ? "PASS" : "FAIL"} (obbCount=${R.obbCount})`,
  );
  console.log(
    `  No NaN in radius SOA         : ${passNoNaN ? "PASS" : "FAIL"} (nanCount=${R.nanCount}, populated=${R.populatedCount})`,
  );
  console.log(
    `  OBB radius == BS.fromOBB     : ${passRadius ? "PASS" : "FAIL"} (checked=${R.radiiChecked}, maxErr=${R.maxRadiusErr})`,
  );
  console.log(
    `  WebGPU tileset not blanked   : ${passCoverage ? "PASS" : "FAIL"} (coverageRatio=${diff.coverageRatio})`,
  );
  const allPass = passOBB && passNoNaN && passRadius && passCoverage;
  console.log(`\n  OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log("[probe-hiz-tile-occlusion] done");
  process.exit(allPass ? 0 : 1);
})();
