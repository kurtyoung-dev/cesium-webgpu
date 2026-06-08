#!/usr/bin/env node
// Diagnostic (Bug 5 — collections render nothing in 2D/CV on WebGPU).
// Introspects, in SCENE2D, a single billboard's actual-position, its WebGPU
// draw-command bounding volume, whether the command survives frustum binning
// (scene.isVisible), and the manually-computed clip position from the packed
// camera matrices. Prints raw numbers — no PNG. WebGPU only.
//
// Usage: node Tools/visual-regression/probe-billboard-2d-debug.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
// PROBE_MODE = "2d" (default) | "3d" — selects the scene mode to introspect.
const MODE = process.env.PROBE_MODE === "3d" ? "3d" : "2d";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(
  async ({ lon, lat, probeMode }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    const pos = C.Cartesian3.fromDegrees(lon, lat, 0.0);
    const bb = scene.primitives.add(new C.BillboardCollection());
    const b = bb.add({
      position: pos,
      image: (() => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 24;
        const g = cv.getContext("2d");
        g.fillStyle = "#ff00ff";
        g.fillRect(0, 0, 24, 24);
        return cv;
      })(),
    });

    if (probeMode === "3d") {
      scene.morphTo3D(0);
    } else {
      scene.morphTo2D(0);
    }
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0) });
    for (let i = 0; i < 100; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0) });
    for (let i = 0; i < 20; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const report = {};
    report.sceneMode = scene.mode; // 2 = SCENE2D

    // 1. actual position (projected in 2D)
    const ap = b._actualPosition;
    report.actualPosition = ap ? { x: ap.x, y: ap.y, z: ap.z } : null;
    report.rawPosition = { x: pos.x, y: pos.y, z: pos.z };

    // 2. bounding volume of the collection (used by the draw command)
    const bv = bb._boundingVolume;
    report.boundingVolume = bv
      ? { cx: bv.center.x, cy: bv.center.y, cz: bv.center.z, r: bv.radius }
      : null;
    const bv2d = bb._baseVolume2D;
    report.baseVolume2D = bv2d
      ? { cx: bv2d.center.x, cy: bv2d.center.y, cz: bv2d.center.z, r: bv2d.radius }
      : null;

    // 3. is the WebGPU color command built, and is it in the command list?
    const cache = bb._webgpuBillboardCache || bb._webgpuCache;
    report.cacheKeys = cache ? Object.keys(cache).slice(0, 40) : null;
    if (cache) {
      report.resolverCalls = cache._resolverCalls ?? 0;
      report.resolverSlices = cache._resolverSlices ?? null;
      report.resolverFrustum = cache._resolverFrustum ?? null;
      report.perSliceBuffers = cache.perSliceUniformBuffers
        ? cache.perSliceUniformBuffers.length
        : 0;
      report.colorCommandHasResolver = !!(
        cache.colorCommand && cache.colorCommand.bindGroupResolvers
      );
      report.colorCommandPass = cache.colorCommand?.pass;
    }

    // 4. scene.isVisible against the current culling volume (does it survive?)
    try {
      const us = scene.context.uniformState;
      const fs = scene._view?.frameState || scene.frameState;
      const cullingVolume = fs?.cullingVolume;
      report.haveCullingVolume = !!cullingVolume;
      if (cullingVolume && bv) {
        // Visibility enum: OUTSIDE=-1, INTERSECTING=0, INSIDE=1
        report.bvVisibility = cullingVolume.computeVisibility(bv);
      }
      if (cullingVolume && bv2d) {
        report.bv2dVisibility = cullingVolume.computeVisibility(bv2d);
      }
    } catch (e) {
      report.isVisibleError = String(e);
    }

    // 5. Manually compute the clip position: projection * view * actualPosition
    try {
      const us = scene.context.uniformState;
      const view = us.view;
      const proj = us.projection;
      const mvp = C.Matrix4.multiply(proj, view, new C.Matrix4());
      const apc = ap || pos;
      const clip = C.Matrix4.multiplyByVector(
        mvp,
        new C.Cartesian4(apc.x, apc.y, apc.z, 1.0),
        new C.Cartesian4(),
      );
      report.clip = { x: clip.x, y: clip.y, z: clip.z, w: clip.w };
      if (clip.w !== 0) {
        report.ndc = { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
      }
      // camera position in the view frame (what my fix encodes)
      const invView = C.Matrix4.inverse(view, new C.Matrix4());
      report.camInViewFrame = { x: invView[12], y: invView[13], z: invView[14] };
      report.cameraPositionWC = {
        x: scene.camera.positionWC.x,
        y: scene.camera.positionWC.y,
        z: scene.camera.positionWC.z,
      };
    } catch (e) {
      report.clipError = String(e);
    }

    // 5b. frustum near/far + multifrustum count + eye-space depth
    try {
      const us = scene.context.uniformState;
      report.frustum = {
        near: scene.camera.frustum.near,
        far: scene.camera.frustum.far,
        type: scene.camera.frustum.constructor?.name,
      };
      const view = us.view;
      const apc = ap || pos;
      const eye = C.Matrix4.multiplyByVector(
        view,
        new C.Cartesian4(apc.x, apc.y, apc.z, 1.0),
        new C.Cartesian4(),
      );
      report.eyeSpace = { x: eye.x, y: eye.y, z: eye.z, w: eye.w };
      // projection matrix (column-major flat)
      report.projection = Array.from({ length: 16 }, (_, i) => us.projection[i]);
      // multifrustum
      const fcl =
        scene._view?.frustumCommandsList || scene.frustumCommandsList;
      report.numFrustums = fcl ? fcl.length : "n/a";
      if (fcl) {
        report.frustumNearFars = fcl.map((f) => ({ near: f.near, far: f.far }));
      }
    } catch (e) {
      report.frustumError = String(e);
    }

    // 6. how many commands of each pass are in the list this frame
    try {
      const fs = scene._view?.frameState || scene.frameState;
      const cl = fs?.commandList || [];
      report.commandListLength = cl.length;
      report.billboardCommands = cl.filter(
        (c) => c && c.owner === bb,
      ).length;
    } catch (e) {
      report.cmdError = String(e);
    }

    return report;
  },
  { lon: LON, lat: LAT, probeMode: MODE },
);

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errors.slice(0, 6));
await browser.close();
