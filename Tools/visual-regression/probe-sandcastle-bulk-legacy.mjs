#!/usr/bin/env node
// probe-sandcastle-bulk-legacy.mjs — gates the BEHAVIOR the "WebGPU Bulk vs
// Legacy Visualizers" Sandcastle (Batch 342) demonstrates: that a DataSourceDisplay
// driven with DataSourceDisplay.defaultVisualizersCallback (bulk) vs
// DataSourceDisplay.legacyVisualizersCallback (Batch 341) produces the expected
// lane classification + per-frame difference for a static catalog, against the
// REAL current build.
// @purpose Gates DataSourceDisplay bulk vs legacy visualizer callbacks: lane classification correct and bulk << legacy per-frame cost, on the real build.
// @status ACTIVE
//
// (The Sandcastle HTML itself is served only via the built Sandcastle2 app and is
// verified manually per the project convention; this probe gates the underlying
// comparison code path the demo relies on — the legacy callback being present in
// the build, the bulk static-lane classification, and bulk << legacy per-frame.)
//
// Edge + --enable-unsafe-webgpu. Run:
//   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-sandcastle-bulk-legacy.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const time = v.clock.currentTime;
    const N = 2500;

    function makeSource() {
      const src = new C.CustomDataSource("perf");
      src.entities.suspendEvents();
      for (let i = 0; i < N; i++) {
        src.entities.add({
          id: `e${i}`,
          position: C.Cartesian3.fromDegrees(
            -98 + (i % 50) * 0.1,
            39 + Math.floor(i / 50) * 0.08,
            0,
          ),
          point: { pixelSize: 5 },
        });
      }
      src.entities.resumeEvents();
      return src;
    }

    function laneOf(src) {
      const vs = src._visualizers || [];
      let s = -1;
      let f = -1;
      for (const vis of vs) {
        if (typeof vis.staticCount === "number") {
          s = (s < 0 ? 0 : s) + vis.staticCount;
          f = (f < 0 ? 0 : f) + vis.fallbackCount;
        }
      }
      return { static: s, fallback: f };
    }

    async function measure(callback) {
      const dsc = new C.DataSourceCollection();
      const disp = new C.DataSourceDisplay({
        scene,
        dataSourceCollection: dsc,
        visualizersCallback: callback,
      });
      const src = makeSource();
      await dsc.add(src);
      disp.update(time);
      const lane = laneOf(src);
      for (let k = 0; k < 10; k++) {
        disp.update(time); // warm
      }
      let sum = 0;
      const frames = 40;
      for (let k = 0; k < frames; k++) {
        const t0 = performance.now();
        disp.update(time);
        sum += performance.now() - t0;
      }
      const perFrame = sum / frames;
      disp.destroy();
      dsc.destroy();
      return { lane, perFrame };
    }

    return {
      legacyCallbackExists:
        typeof C.DataSourceDisplay.legacyVisualizersCallback === "function",
      bulk: await measure(C.DataSourceDisplay.defaultVisualizersCallback),
      legacy: await measure(C.DataSourceDisplay.legacyVisualizersCallback),
    };
  });

  await browser.close();

  const realErrors = errors.filter((e) => !/favicon|status of 404/i.test(e));
  const checks = [];
  let pass = true;
  const ok = (name, cond) => {
    checks.push(`${cond ? "ok  " : "FAIL"} ${name}`);
    pass = cond && pass;
  };

  ok("no console errors", realErrors.length === 0);
  ok(
    "DataSourceDisplay.legacyVisualizersCallback present in build",
    result.legacyCallbackExists,
  );
  ok(
    `bulk classifies the static catalog into the static lane (static=${result.bulk.lane.static}, fallback=${result.bulk.lane.fallback})`,
    result.bulk.lane.static === 2500 && result.bulk.lane.fallback === 0,
  );
  ok(
    `legacy has no bulk lanes (staticCount sentinel=${result.legacy.lane.static})`,
    result.legacy.lane.static === -1,
  );
  ok(
    `bulk static per-frame << legacy static per-frame (bulk=${result.bulk.perFrame.toFixed(3)}ms vs legacy=${result.legacy.perFrame.toFixed(3)}ms)`,
    result.legacy.perFrame > result.bulk.perFrame,
  );

  console.log(checks.join("\n"));
  console.log(
    `\nbulk(static)   perFrame=${result.bulk.perFrame.toFixed(3)}ms lanes=${result.bulk.lane.static}/${result.bulk.lane.fallback}`,
  );
  console.log(`legacy(static) perFrame=${result.legacy.perFrame.toFixed(3)}ms`);
  if (realErrors.length) {
    console.log("\nERRORS:\n" + realErrors.join("\n"));
  }
  console.log(`\n[probe-sandcastle-bulk-legacy] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
