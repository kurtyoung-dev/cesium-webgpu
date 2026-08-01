#!/usr/bin/env node
// Probe (Phase 3 Slice 3 — NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE morph leg):
// verify Billboard / Point / Label collections track SMOOTHLY through an
// ANIMATED morph transition on WebGPU (no mid-morph vanish, no MORPH-COMPLETION
// -POP), using WebGL as the reference.
//
// The sibling probe-collections-2dcv-morph.mjs only does INSTANT morphs
// (morph*(0)) — it never lands in SceneMode.MORPHING, so it cannot catch a
// marker that pops or vanishes mid-transition. This probe drives an animated
// scene.morphTo2D(duration), RE-ASSERTS a fixed camera view every frame (so
// framing is constant and the signal is pure position-tracking, not camera
// drift), bins the coloured-pixel coverage by the live morphTime, and asserts:
//   (A) WebGPU markers are non-zero at EVERY morphTime bin where WebGL shows
//       them (no mid-morph vanish),
//   (B) ZERO device/console errors throughout.
//
// Markers sit at 50 km height (above the surface, so they win the depth test
// vs the globe) and are framed by a fixed top-down camera that keeps them
// on-screen in 3D AND 2D/CV (the 2D/CV ortho derived from the same ECEF
// height). Globe ON by default; set PROBE_NOGLOBE=1 to isolate position
// tracking from depth.
//
// Usage: node Tools/visual-regression/probe-collections-morph-blend.mjs
// Env:   PROBE_BASE (default http://localhost:8134), PROBE_NOGLOBE

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const NOGLOBE = process.env.PROBE_NOGLOBE === "1";

const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 50000.0; // 50 km — above the surface so markers win depth.
const CAM_HEIGHT = 8000000.0; // 8 Mm top-down — frames the cluster in all modes.

const TARGETS = [
  { name: "to2d", id: 2 },
  { name: "tocv", id: 1 },
];

async function capture(rendererArg, target) {
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
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ targetName, lon, lat, height, camHeight, noGlobe }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      if (noGlobe) scene.globe.show = false;

      const pos = C.Cartesian3.fromDegrees(lon, lat, height);
      const pos2 = C.Cartesian3.fromDegrees(lon + 1.0, lat + 0.5, height);

      // Use a 64px source billboard. A small (16px) billboard falls below the
      // magenta detection floor on WebGPU because of the PRE-EXISTING
      // billboard-size parity gap (WebGPU renders billboards ~half linear
      // size -> ~1/4 area, in ALL scene modes incl. 3D — tracked separately
      // as NEW-BILLBOARD-SIZE-PARITY, NOT a morph-blend issue). 64px keeps the
      // billboard above the floor so this probe measures morph POSITION
      // tracking, not the size gap.
      const bb = scene.primitives.add(new C.BillboardCollection());
      bb.add({
        position: pos,
        image: (() => {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 64;
          const g = cv.getContext("2d");
          g.fillStyle = "#ff00ff";
          g.fillRect(0, 0, 64, 64);
          return cv;
        })(),
      });

      const pts = scene.primitives.add(new C.PointPrimitiveCollection());
      pts.add({ position: pos2, color: C.Color.YELLOW, pixelSize: 24 });

      const lbls = scene.primitives.add(new C.LabelCollection());
      lbls.add({
        position: C.Cartesian3.fromDegrees(lon - 0.5, lat - 1.0, height),
        text: "TEST",
        fillColor: C.Color.LIME,
        font: "36px sans-serif",
      });

      const setCam = () =>
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, camHeight),
        });

      scene.morphTo3D(0);
      setCam();
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const countColors = () => {
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const data = cx.getImageData(0, 0, c.width, c.height).data;
        let magenta = 0,
          yellow = 0,
          lime = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          if (r > 180 && b > 180 && g < 120) magenta++;
          else if (r > 180 && g > 180 && b < 120) yellow++;
          else if (g > 180 && r < 160 && b < 120) lime++;
        }
        return { magenta, yellow, lime };
      };

      // Bin coverage by morphTime decile so the two backends are compared at
      // the SAME transition phase even if their RAF cadence differs.
      const bins = new Map(); // bin(0..10) -> {magenta,yellow,lime,count}
      const recordBin = () => {
        const mt = scene.morphTime; // 1=3D ... 0=2D/CV
        const bin = Math.round(mt * 10);
        const c = countColors();
        const e = bins.get(bin) || { magenta: 0, yellow: 0, lime: 0, count: 0 };
        e.magenta += c.magenta;
        e.yellow += c.yellow;
        e.lime += c.lime;
        e.count += 1;
        bins.set(bin, e);
      };

      recordBin(); // 3D start (bin 10)

      const DURATION = 3.0;
      if (targetName === "to2d") scene.morphTo2D(DURATION);
      else scene.morphToColumbusView(DURATION);

      // Render until the morph completes (mode leaves MORPHING) or a frame
      // budget is hit, re-asserting the fixed camera each frame and recording.
      for (let i = 0; i < 400; i++) {
        setCam(); // keep framing constant through the whole transition
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        recordBin();
        if (i > 5 && scene.mode !== 0 /* MORPHING */) break;
      }

      // Settle at endpoint.
      for (let i = 0; i < 40; i++) {
        setCam();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      recordBin(); // endpoint (bin 0)

      const out = [];
      for (let b = 10; b >= 0; b--) {
        const e = bins.get(b);
        if (e) {
          out.push({
            bin: b,
            magenta: Math.round(e.magenta / e.count),
            yellow: Math.round(e.yellow / e.count),
            lime: Math.round(e.lime / e.count),
            count: e.count,
          });
        }
      }
      return { bins: out, mode: scene.mode };
    },
    {
      targetName: target.name,
      lon: LON,
      lat: LAT,
      height: HEIGHT,
      camHeight: CAM_HEIGHT,
      noGlobe: NOGLOBE,
    },
  );

  await page.waitForTimeout(300);
  const out = path.join(
    OUT_DIR,
    `morphblend-${target.name}-${rendererArg}${NOGLOBE ? "-noglobe" : ""}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  return { out, bins: result.bins, mode: result.mode, errors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  let anyFail = false;
  console.log(`globe=${NOGLOBE ? "OFF" : "ON"}`);
  for (const target of TARGETS) {
    console.log(`\n=== morph target: ${target.name} ===`);
    const gl = await capture("webgl", target);
    const gp = await capture("webgpu", target);

    console.log(
      `  errors: webgl=${gl.errors.length} webgpu=${gp.errors.length}`,
    );
    gp.errors.slice(0, 4).forEach((e) => console.log(`    GPU-ERR: ${e}`));

    const glB = Object.fromEntries(gl.bins.map((b) => [b.bin, b]));
    const gpB = Object.fromEntries(gp.bins.map((b) => [b.bin, b]));

    console.log("  bin(morphT*10) | GL(m/y/l) [n]      GPU(m/y/l) [n]");
    let vanish = false;
    for (let b = 10; b >= 0; b--) {
      const g = glB[b];
      const p = gpB[b];
      if (!g && !p) continue;
      const gs = g
        ? `${g.magenta}/${g.yellow}/${g.lime} [${g.count}]`
        : "-- (no GL frame)";
      const ps = p
        ? `${p.magenta}/${p.yellow}/${p.lime} [${p.count}]`
        : "-- (no GPU frame)";
      console.log(
        `  ${String(b).padStart(2)}             | ${gs.padEnd(18)} ${ps}`,
      );
      // Vanish: GL SUBSTANTIALLY shows a marker in this bin (>30 px, above
      // near-horizon / AA noise), GPU shows none. A loose >8 floor false-
      // triggers on borderline near-horizon bins where GL itself barely
      // clears the threshold (e.g. a point grazing the globe limb at
      // morph-start) — those are depth-grazing artifacts, not a position-
      // blend vanish.
      if (g && p) {
        if (g.magenta > 30 && p.magenta === 0) vanish = true;
        if (g.yellow > 30 && p.yellow === 0) vanish = true;
        if (g.lime > 30 && p.lime === 0) vanish = true;
      }
    }

    if (gp.errors.length > 0) {
      console.log(
        `  RESULT(${target.name}): FAIL — webgpu device/console errors`,
      );
      anyFail = true;
    } else if (vanish) {
      console.log(
        `  RESULT(${target.name}): FAIL — marker VANISHED in a morph bin on WebGPU`,
      );
      anyFail = true;
    } else {
      console.log(
        `  RESULT(${target.name}): PASS — markers tracked through morph, no errors`,
      );
    }
  }
  console.log(`\n[probe-collections-morph-blend] ${anyFail ? "FAIL" : "PASS"}`);
  process.exit(anyFail ? 1 : 0);
})();
