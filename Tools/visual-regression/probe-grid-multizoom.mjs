// C2-10 NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING — verify the WGSL Grid material
// now draws constant-PIXEL-width antialiased lines (GridMaterial.glsl parity) via
// screen-space derivatives, instead of the old constant-UV-width step() lines
// whose apparent thickness scaled with zoom.
//
// Batch 685 reframe: the original far capture (pitch -35 from a fixed 333 m
// south offset, alt 2000) put the polygon ENTIRELY below the frustum's bottom
// edge — a deterministic black canvas on BOTH backends (3+3 reps byte-identical,
// zero console errors), so check A could never pass. Nadir waypoints were added
// so the subject is guaranteed in-frame at both zooms.
//
// Batch 686 hardening (review F9): the close OBLIQUE waypoint (C2-10-style
// pitch -35, anisotropic derivatives) is kept alongside the two nadir zoom
// waypoints; check A now requires INTERIOR-region grid lines (runs inside the
// central third of the scanline band — border/edge artifacts can't satisfy it)
// at EVERY waypoint; and WebGL's own zoom ratio is gated exactly like WebGPU's
// (the reference must satisfy its own constancy bar). Width statistics use the
// interior-run median so the polygon's solid border can't skew the far-zoom
// median. Thresholds unchanged (ratio < 1.8; >2 lines).
//
// Also hardened (Batch 685): console-error CONTENTS + pageerror are captured
// and printed (previously only counted), each capture closes its browser in a
// finally block, and the settle waits for prim.ready before the fixed frames.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-grid-multizoom.mjs
import { chromium } from "playwright";
import zlib from "zlib";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const LON = -75,
  LAT = 40;
// Waypoints: one close oblique (C2-10 original framing — exercises anisotropic
// screen-space derivatives) + two nadir zooms (subject guaranteed in-frame;
// 700/2000 m ASL = 400/1700 m above the 300 m extruded top face). The zoom
// CONSTANCY ratio is measured across the two nadir waypoints (same view
// geometry, pure zoom); the oblique waypoint feeds the render/interior check.
const WAYPOINTS = [
  { name: "oblique-400", alt: 400, pitch: -35, southOffset: 1.5 },
  { name: "nadir-700", alt: 700, pitch: -90, southOffset: 0 },
  { name: "nadir-2000", alt: 2000, pitch: -90, southOffset: 0 },
];
const RATIO_PAIR = ["nadir-700", "nadir-2000"];

async function capture(renderer, waypoint) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 600, height: 600 },
    });
    const errs = [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text().slice(0, 800));
    });
    page.on("pageerror", (e) =>
      errs.push(`PAGEERROR: ${String(e).slice(0, 800)}`),
    );
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

    await page.evaluate(
      async ({ lon, lat, alt, pitch, southOffset }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer,
          s = v.scene;
        s.requestRenderMode = false;
        s.globe.show = false;
        s.skyBox.show = false;
        s.skyAtmosphere.show = false;
        if (s.sun) s.sun.show = false;
        s.backgroundColor = C.Color.BLACK;
        for (const sel of [
          ".cesium-viewer-toolbar",
          ".cesium-viewer-animationContainer",
          ".cesium-viewer-timelineContainer",
          ".cesium-viewer-bottom",
          ".cesium-viewer-fullscreenContainer",
        ]) {
          document
            .querySelectorAll(sel)
            .forEach((e) => (e.style.display = "none"));
        }
        const d = 0.002;
        const material = C.Material.fromType("Grid", {
          color: C.Color.YELLOW,
          cellAlpha: 0.1,
          lineCount: new C.Cartesian2(8, 8),
          lineThickness: new C.Cartesian2(2, 2),
        });
        // EXTRUDED polygon (top face carries st) — the FLAT-polygon grid renders
        // solid on WebGPU (pre-existing st issue, both old+new shader). The extruded
        // top face is the path matparity uses, where the grid pattern renders.
        const prim = new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.PolygonGeometry({
              polygonHierarchy: new C.PolygonHierarchy(
                C.Cartesian3.fromDegreesArray([
                  lon - d,
                  lat - d,
                  lon + d,
                  lat - d,
                  lon + d,
                  lat + d,
                  lon - d,
                  lat + d,
                ]),
              ),
              height: 0,
              extrudedHeight: 300,
              vertexFormat:
                C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
            }),
          }),
          appearance: new C.MaterialAppearance({ material, flat: true }),
          asynchronous: false,
        });
        s.primitives.add(prim);
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            lon,
            lat - d * southOffset,
            alt,
          ),
          orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 },
        });
        // Deterministic settle: primitive ready first (bounded), then fixed frames.
        for (let i = 0; i < 600 && !prim.ready; i++) {
          s.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        for (let i = 0; i < 120; i++) {
          s.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        s.canvas.setAttribute("data-grid", "1");
      },
      {
        lon: LON,
        lat: LAT,
        alt: waypoint.alt,
        pitch: waypoint.pitch,
        southOffset: waypoint.southOffset,
      },
    );

    const png = await page
      .locator('canvas[data-grid="1"]')
      .screenshot({ type: "png" });
    const decoded = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = off.getContext("2d");
      cx.drawImage(bmp, 0, 0);
      return {
        w: bmp.width,
        h: bmp.height,
        data: Array.from(cx.getImageData(0, 0, bmp.width, bmp.height).data),
      };
    }, Buffer.from(png).toString("base64"));
    return { errs: errs.slice(0, 40), decoded };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Grid-line run statistics on the central horizontal scanlines (y 40-60%).
// A "line" pixel is bright (yellow line = high R+G; cells/background dark).
// F9 — runs are classified INTERIOR when they lie fully inside the central
// third of the width (x in [w/3, 2w/3]): border/edge artifacts at the frame
// or polygon boundary cannot satisfy the interior checks, and the interior
// median is immune to the polygon's solid border skewing far-zoom widths.
function lineWidth(img) {
  const widths = [];
  const interiorWidths = [];
  const y0 = (img.h * 0.4) | 0,
    y1 = (img.h * 0.6) | 0;
  const xInner0 = (img.w / 3) | 0,
    xInner1 = ((2 * img.w) / 3) | 0;
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = 0; x <= img.w; x++) {
      const bright =
        x < img.w &&
        img.data[(y * img.w + x) * 4] +
          img.data[(y * img.w + x) * 4 + 1] +
          img.data[(y * img.w + x) * 4 + 2] >
          250;
      if (bright) {
        run++;
      } else if (run > 0) {
        if (run < img.w * 0.5) {
          widths.push(run);
          const start = x - run;
          if (start >= xInner0 && x <= xInner1) interiorWidths.push(run);
        }
        run = 0;
      }
    }
  }
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[(s.length / 2) | 0];
  };
  return {
    lines: widths.length,
    medianW: median(widths),
    interiorLines: interiorWidths.length,
    interiorMedianW: median(interiorWidths),
    totalLinePx: widths.reduce((s, v) => s + v, 0),
  };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4,
    raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const res = {};
for (const r of ["webgl", "webgpu"]) {
  res[r] = {};
  for (const wp of WAYPOINTS) {
    const cap = await capture(r, wp);
    fs.writeFileSync(
      `Tools/visual-regression/output/grid-multizoom-${r}-${wp.name}.png`,
      encodePNG(cap.decoded),
    );
    res[r][wp.name] = {
      ...lineWidth(cap.decoded),
      errCount: cap.errs.length,
      errs: cap.errs,
    };
  }
}
const ratio = (r) => {
  const w0 = res[r][RATIO_PAIR[0]].interiorMedianW,
    w1 = res[r][RATIO_PAIR[1]].interiorMedianW;
  return w0 && w1 ? +(Math.max(w0, w1) / Math.min(w0, w1)).toFixed(2) : 0;
};
const gpuRatio = ratio("webgpu"),
  glRatio = ratio("webgl");
console.log(JSON.stringify(res, null, 2));
console.log(
  `Zoom ratio over ${RATIO_PAIR.join("/")} interior medians — WebGPU: ${gpuRatio} | WebGL: ${glRatio}`,
);
// Gates (F9-hardened): interior lines at EVERY waypoint on WebGPU; interior
// line width ~pixel-constant across the nadir zoom pair on BOTH backends.
const gpuRenders = WAYPOINTS.every(
  (wp) => res.webgpu[wp.name].interiorLines > 2,
);
const gpuConstant = gpuRatio > 0 && gpuRatio < 1.8;
const glConstant = glRatio > 0 && glRatio < 1.8;
const pass = gpuRenders && gpuConstant && glConstant;
console.log(
  `(A) WebGPU interior grid lines at every waypoint (oblique + both zooms): ${gpuRenders ? "PASS" : "FAIL"}`,
);
console.log(
  `(B) WebGPU line width ~pixel-constant across zoom (ratio<1.8): ${gpuConstant ? "PASS" : "FAIL"}`,
);
console.log(
  `(B-gl) WebGL reference line width ~pixel-constant across zoom (ratio<1.8): ${glConstant ? "PASS" : "FAIL"}`,
);
console.log(
  pass
    ? "GATE PASS — grid lines are constant-pixel-width AA on both backends (GridMaterial.glsl parity)."
    : "GATE FAIL.",
);
process.exit(pass ? 0 : 1);
