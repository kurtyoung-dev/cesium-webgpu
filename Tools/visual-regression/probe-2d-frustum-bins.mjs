#!/usr/bin/env node
// Diagnostic probe (SCENE2D-FRUSTUM-BINS): in SCENE2D with the globe SHOWN,
// dump the multi-frustum split + which frustum(s) the billboard command and the
// GLOBE-pass commands bin into. Confirms the root cause that SCENE2D markers are
// overwritten because the billboard bins only into the farthest frustum(s) while
// nearer-frustum opaque globe passes draw over the accumulated color.
//
// Usage: node Tools/visual-regression/probe-2d-frustum-bins.mjs [webgl|webgpu]
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const RENDERER = process.argv[2] || "webgpu";
const LON = -75.0;
const LAT = 40.0;

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

const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`;
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(
  async ({ lon, lat }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    const pos = C.Cartesian3.fromDegrees(lon, lat, 0.0);
    const bb = scene.primitives.add(new C.BillboardCollection());
    const _billboard = bb.add({
      position: pos,
      image: (() => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 16;
        const g = cv.getContext("2d");
        g.fillStyle = "#ff00ff";
        g.fillRect(0, 0, 16, 16);
        return cv;
      })(),
    });

    scene.morphTo2D(0);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0),
    });
    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat, 1500000.0),
    });
    for (let i = 0; i < 30; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Render once more, then inspect the view's frustumCommandsList AFTER
    // createPotentiallyVisibleSet has run (it runs inside render()).
    // Capture the commandList snapshot DURING the frame by hooking the view's
    // createPotentiallyVisibleSet so we see the exact list it bins.
    const viewHook = scene._view;
    let snap = null;
    const origPVS = viewHook.createPotentiallyVisibleSet.bind(viewHook);
    viewHook.createPotentiallyVisibleSet = function (s) {
      const fs = s.frameState;
      const cl = fs.commandList;
      const cam = fs.camera;
      let noBV = 0;
      let minNear = Number.MAX_VALUE;
      let minNearPass = -1;
      const noBVpasses = {};
      for (let i = 0; i < cl.length; i++) {
        const cmd = cl[i];
        if (!cmd) continue;
        if (cmd.pass === 0 /*COMPUTE*/ || cmd.pass === 10 /*OVERLAY*/) continue;
        if (!cmd.boundingVolume) {
          noBV++;
          noBVpasses[cmd.pass] = (noBVpasses[cmd.pass] || 0) + 1;
        } else if (cmd.boundingVolume.computePlaneDistances) {
          const iv = cmd.boundingVolume.computePlaneDistances(
            cam.positionWC,
            cam.directionWC,
          );
          if (iv.start < minNear) {
            minNear = iv.start;
            minNearPass = cmd.pass;
          }
        }
      }
      snap = {
        clLen: cl.length,
        noBV,
        noBVpasses,
        minNearWithBV: +minNear.toFixed(2),
        minNearPass,
        frustumNear: +cam.frustum.near.toFixed(4),
        frustumFar: +cam.frustum.far.toFixed(2),
      };
      return origPVS(s);
    };
    scene.render();
    viewHook.createPotentiallyVisibleSet = origPVS;

    const view = scene._view;
    const fcl = view.frustumCommandsList;
    const _Pass = C.Pass ?? null;
    // Pass IDs we care about. From Renderer/Pass.js ordering.
    // GLOBE and OPAQUE are the relevant opaque writers; TRANSLUCENT is where
    // billboards live.
    const PASS_GLOBE = 2;
    const PASS_OPAQUE = 7;
    const PASS_TRANSLUCENT = 8;

    function binsForPass(passId) {
      const out = [];
      for (let f = 0; f < fcl.length; f++) {
        const fc = fcl[f];
        out.push(fc.indices[passId] | 0);
      }
      return out;
    }

    // Find which frustum(s) the billboard's draw command landed in.
    // Billboard draw commands are TRANSLUCENT. Scan each frustum's translucent
    // command list for one whose owner is our billboard collection.
    const billboardBins = [];
    for (let f = 0; f < fcl.length; f++) {
      const fc = fcl[f];
      const cnt = fc.indices[PASS_TRANSLUCENT] | 0;
      const cmds = fc.commands[PASS_TRANSLUCENT];
      let found = false;
      for (let k = 0; k < cnt; k++) {
        const cmd = cmds[k];
        if (cmd && cmd.owner === bb) {
          found = true;
          break;
        }
      }
      if (found) billboardBins.push(f);
    }

    const splits = fcl.map((fc) => ({
      near: +fc.near.toFixed(2),
      far: +fc.far.toFixed(2),
    }));

    // Compute the billboard's command extent (near/far plane distances) the
    // way View.createPotentiallyVisibleSet does, to see which frustum range it
    // should occupy.
    let bbExtent = null;
    const globeExtents = [];
    {
      // Find the billboard command anywhere in the commandList.
      const cl = scene._frameState.commandList;
      const cam = scene._frameState.camera;
      const PASS_GLOBE2 = 2;
      for (let i = 0; i < cl.length; i++) {
        const cmd = cl[i];
        if (!cmd || !cmd.boundingVolume) continue;
        if (cmd && cmd.owner === bb && cmd.boundingVolume) {
          const iv = cmd.boundingVolume.computePlaneDistances(
            cam.positionWC,
            cam.directionWC,
          );
          bbExtent = { start: +iv.start.toFixed(2), stop: +iv.stop.toFixed(2) };
        }
        if (
          cmd.pass === PASS_GLOBE2 &&
          cmd.boundingVolume.computePlaneDistances
        ) {
          const iv = cmd.boundingVolume.computePlaneDistances(
            cam.positionWC,
            cam.directionWC,
          );
          globeExtents.push({
            start: +iv.start.toFixed(0),
            stop: +iv.stop.toFixed(0),
            r: +(cmd.boundingVolume.radius ?? 0).toFixed(0),
          });
        }
      }
    }
    // Globe tile selection stats: how many tiles rendered + their levels.
    let tileLevels;
    try {
      const surf = scene.globe?._surface;
      const tilesToRender = surf?._tilesToRender ?? [];
      const lv = {};
      for (const t of tilesToRender) {
        lv[t.level] = (lv[t.level] || 0) + 1;
      }
      tileLevels = { count: tilesToRender.length, byLevel: lv };
    } catch (e) {
      tileLevels = { err: String(e) };
    }

    return {
      mode: scene.mode,
      numFrustums: fcl.length,
      splits,
      cameraZ: +scene.camera.position.z.toFixed(2),
      globeBins: binsForPass(PASS_GLOBE),
      opaqueBins: binsForPass(PASS_OPAQUE),
      translucentBins: binsForPass(PASS_TRANSLUCENT),
      billboardBins,
      bbExtent,
      globeExtents: globeExtents.slice().sort((a, b) => a.start - b.start),
      tileLevels,
      snap,
    };
  },
  { lon: LON, lat: LAT },
);

await browser.close();
console.log(`[probe-2d-frustum-bins/${RENDERER}]`);
console.log(JSON.stringify(out, null, 2));
console.log(`errs=${errors.length}`);
errors.slice(0, 6).forEach((e) => console.log("  ERR:", e));
