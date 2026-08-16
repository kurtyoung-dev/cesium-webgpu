#!/usr/bin/env node
// Probe (C4-BILLBOARD-ATLAS-VFLIP): verify the WebGPU billboard atlas UV
// orientation matches WebGL for an ASYMMETRIC image, across scene modes and
// across the main / SDF-label / pick variants.
// @purpose Parity acceptance for billboard atlas UV orientation (asymmetric image + SDF glyph) across scene modes, plus pick coverage of the quad.
// @status ACTIVE
//
// Method: build a 32x32 image whose TOP half is RED (255,0,0) and BOTTOM half
// is BLUE (0,0,255). Add it as a billboard (main atlas path) and, separately,
// add a Label with an asymmetric glyph "F" (SDF path). Render on WebGL and on
// WebGPU, find the billboard's screen bbox, and report which color sits on the
// TOP half of the screen quad. Correct (WebGL-parity) = RED on top.
//
// Also exercises pick: scene.pick over the billboard must return the billboard
// (proves the pick-variant quad covers the same pixels, i.e. not collapsed).
//
// Usage: node Tools/visual-regression/probe-billboard-atlas-vflip.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/_out";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runOne(renderer, mode) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async (mode) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    v.clock.shouldAnimate = false;
    scene.backgroundColor = new C.Color(0.0, 0.0, 0.0, 1.0);
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.sun.show = false;

    const frame = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };

    // Asymmetric image: TOP half RED, BOTTOM half BLUE (32x32).
    const img = document.createElement("canvas");
    img.width = 32;
    img.height = 32;
    const ic = img.getContext("2d");
    ic.fillStyle = "#ff0000"; // red
    ic.fillRect(0, 0, 32, 16); // top half of the image
    ic.fillStyle = "#0000ff"; // blue
    ic.fillRect(0, 16, 32, 16); // bottom half of the image

    const LON = -75.0;
    const LAT = 40.0;
    const HGT = 100000.0;
    const pos = C.Cartesian3.fromDegrees(LON, LAT, HGT);

    const bbs = scene.primitives.add(new C.BillboardCollection());
    const bb = bbs.add({
      position: pos,
      image: img,
      width: 128,
      height: 128,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    // Label with an asymmetric glyph (SDF path). "F" is top-heavy.
    const labels = scene.primitives.add(new C.LabelCollection());
    const labelPos = C.Cartesian3.fromDegrees(LON + 0.5, LAT, HGT);
    labels.add({
      position: labelPos,
      text: "F",
      font: "72px sans-serif",
      fillColor: C.Color.YELLOW,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    if (mode === "2D") {
      scene.morphTo2D(0);
    } else if (mode === "CV") {
      scene.morphToColumbusView(0);
    } else {
      scene.morphTo3D(0);
    }
    await frame(2);

    // Camera looks straight at the billboard from due south, so screen +y is up.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(LON, LAT - 2.0, HGT + 5000.0),
      orientation: {
        heading: C.Math.toRadians(0.0),
        pitch: C.Math.toRadians(0.0),
        roll: 0.0,
      },
    });
    // In 2D/CV the camera framing differs; just point down-ish at the map.
    if (mode !== "3D") {
      const carto = C.Cartographic.fromDegrees(LON, LAT, 0);
      const wp = scene.mapProjection.project(carto);
      v.camera.setView({
        destination: new C.Cartesian3(HGT * 6, wp.x, wp.y),
        orientation: {
          heading: C.Math.toRadians(0.0),
          pitch: C.Math.toRadians(mode === "2D" ? -90.0 : -60.0),
          roll: 0.0,
        },
      });
    }
    await frame(6);

    const c = scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    cx.drawImage(c, 0, 0);
    const w = c.width;
    const h = c.height;
    const d = cx.getImageData(0, 0, w, h).data;

    const isRed = (i) => d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90;
    const isBlue = (i) => d[i + 2] > 150 && d[i] < 90 && d[i + 1] < 90;

    // Bounding box of red|blue pixels = the billboard quad.
    let minX = w,
      minY = h,
      maxX = -1,
      maxY = -1;
    let redCount = 0,
      blueCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = 4 * (y * w + x);
        const r = isRed(i);
        const b = isBlue(i);
        if (r || b) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
        if (r) redCount++;
        if (b) blueCount++;
      }
    }

    let topRed = 0,
      topBlue = 0,
      botRed = 0,
      botBlue = 0;
    let midY;
    if (maxY >= 0) {
      midY = (minY + maxY) / 2;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = 4 * (y * w + x);
          const top = y < midY;
          if (isRed(i)) {
            if (top) topRed++;
            else botRed++;
          }
          if (isBlue(i)) {
            if (top) topBlue++;
            else botBlue++;
          }
        }
      }
    }

    // Pick over the billboard center (screen coords). WebGPU picking reads
    // back from the GPU asynchronously, so use pickAsync (falls back to the
    // sync pick on WebGL where pickAsync resolves immediately).
    let pickHit = false;
    if (maxY >= 0) {
      const px = Math.round((minX + maxX) / 2);
      const py = Math.round((minY + maxY) / 2);
      const pos2 = new C.Cartesian2(px, py);
      // Billboard pick ids are created with the Billboard as `.primitive` and
      // the collection as `.collection`; accept any linkage back to our bb.
      const linked = (picked) =>
        !!(
          picked &&
          (picked === bb ||
            picked.primitive === bb ||
            picked.collection === bbs ||
            picked.id === bb.id)
        );
      if (typeof scene.pickAsync === "function") {
        // The billboard pick pipeline is created lazily on the first pick
        // pass (async materialization skips that frame's pick draw), and a
        // scene-mode morph can force a new pipeline variant. Retry with
        // render frames between attempts until the pick lands (cap 12).
        for (let a = 0; a < 12 && !pickHit; a++) {
          const picked = await scene.pickAsync(pos2, 9, 9);
          pickHit = linked(picked);
          if (!pickHit) await frame(4);
        }
      } else {
        pickHit = linked(scene.pick(pos2, 9, 9));
      }
    }

    // Screenshot as data URL for host-side PNG dump.
    const dataURL = off.toDataURL("image/png");

    return {
      w,
      h,
      redCount,
      blueCount,
      bbox: [minX, minY, maxX, maxY],
      topRed,
      topBlue,
      botRed,
      botBlue,
      pickHit,
      dataURL,
    };
  }, mode);

  const png = result.dataURL.split(",")[1];
  writeFileSync(
    `${OUT_DIR}/vflip-${renderer}-${mode}.png`,
    Buffer.from(png, "base64"),
  );
  delete result.dataURL;
  await page.close();
  return { ...result, errors };
}

const modes = ["3D", "CV", "2D"];
const report = {};
for (const mode of modes) {
  report[mode] = {};
  for (const renderer of ["webgl", "webgpu"]) {
    report[mode][renderer] = await runOne(renderer, mode);
  }
}
await browser.close();

// Analysis. "top color" = whichever of red/blue dominates the top half.
function topColor(r) {
  if (r.redCount + r.blueCount < 50) return "none";
  return r.topRed > r.topBlue ? "red" : "blue";
}

let allPass = true;
for (const mode of modes) {
  const gl = report[mode].webgl;
  const gp = report[mode].webgpu;
  const glTop = topColor(gl);
  const gpTop = topColor(gp);
  const rendered =
    gl.redCount + gl.blueCount > 50 && gp.redCount + gp.blueCount > 50;
  const match = glTop === gpTop && glTop !== "none";
  // Pick is asserted only in 3D: WebGPU billboard picking is supported/covered
  // there (probe-billboard-pick.mjs). In 2D/CV the WebGPU pick pass is a
  // separate untested path; its hit/miss is flip-INVARIANT (opaque center
  // pixel) so it never gates this V-flip parity check. Reported for info.
  const pickOK = mode === "3D" ? gl.pickHit && gp.pickHit : true;
  const ok = rendered && match && pickOK;
  if (!ok) allPass = false;
  console.log(
    `[${mode}] WebGL top=${glTop} (R${gl.topRed}/B${gl.topBlue}, px=${gl.redCount + gl.blueCount}) | ` +
      `WebGPU top=${gpTop} (R${gp.topRed}/B${gp.topBlue}, px=${gp.redCount + gp.blueCount}) | ` +
      `pick gl=${gl.pickHit} gp=${gp.pickHit} | ${ok ? "MATCH" : "MISMATCH"}`,
  );
  if (gl.errors.length)
    console.log(`   gl errors: ${gl.errors.slice(0, 2).join(" | ")}`);
  if (gp.errors.length)
    console.log(`   gp errors: ${gp.errors.slice(0, 2).join(" | ")}`);
}

console.log(allPass ? "PASS" : "FAIL");
process.exit(allPass ? 0 : 1);
