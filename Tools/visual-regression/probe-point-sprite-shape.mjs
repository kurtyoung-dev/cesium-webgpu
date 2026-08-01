// POINT-SPRITE-SHAPE — point sprite shape parity (WebGL vs WebGPU).
//
// WebGL rasterizes gl_Points as SOLID SQUARES (ModelFS.glsl only carves a
// circle under HAS_POINT_DIAMETER — the Bentley point-style extension). The
// WebGPU point-cloud quad shaders used to carve a soft circle via
// length(pointUV), leaving a large cross-backend residual. This probe
// captures both backends on:
//   scene "pointcloud"  — TimeDynamicPointCloud (EDL off, style pointSize 8;
//                         the constant style DISABLES attenuation on both
//                         backends per WebGL's hasPointSizeStyle priority)
//   scene "pcatten"     — same point cloud, attenuation ON and NO style —
//                         exercises the u.attenuation > 0 per-point clamp
//                         min(geomError·scale·height/sse / eyeDepth, maxAtten)
//                         that the styled scene bypasses
//   scene "pointprims"  — PointPrimitiveCollection (circle+outline on BOTH
//                         backends by upstream design — regression guard)
// and reports the cross-backend mismatch percentage over lit pixels.
//
// Three metrics per scene:
//   raw   — per-pixel diff (informational; dominated by sub-pixel AA
//           rasterization differences between the APIs at sprite edges)
//   ds4   — 4x4 box-downsampled diff (informational for the two
//           point-cloud scenes, the GATE for pointprims; measures
//           shape/size/color at feature scale)
//   nds4  — gain-NORMALIZED ds4 (the GATE for the point-cloud scenes):
//           per-channel means over lit cells are equalized before the
//           per-cell compare, cancelling the pre-existing WebGPU
//           point-cloud blue/brightness COLOR tint (WebGPU ~27-45%
//           brighter, blue lifted most — gains ~R0.78/G0.72/B0.69;
//           PARITY-POINT-SPRITE-SHAPE-RESIDUALS in DEFERRED_WORK.md).
//           The raw ds4 residual DRIFTS run-to-run with that tint (seven
//           consecutive 2026-07-02 runs crept monotonically: styled
//           9.34 -> 16.67%, pcatten 12.29 -> 18.85% — session/machine
//           state-correlated, i.e. a fixed raw threshold is a moving
//           target and a lead for the tint investigation), while
//           shape/size/coverage errors are SPATIAL and survive the
//           normalization: the pre-fix round/mis-sized WebGPU points
//           scored 25%+ on ds4 and a dead attenuation clamp (all points
//           at max size) scores far past any tint gain.
//
// Gate: pointcloud nds4 < 16%, pcatten nds4 < 16%, pointprims ds4 < 5%,
// 0 device errors. Measured at fix time: pc nds4 9.72/11.0%, pca nds4
// 11.33/12.43% across two runs — the tint's NONLINEAR component drifts
// too (~1pp/run within the session), so the 16% gate leaves ~3.6pp over
// the worst observed value. If this gate flakes, fix
// PARITY-POINTCLOUD-COLOR-TINT (the drift source) rather than widening;
// TIGHTEN to ~8% once the tint lands.
// Pre-fix baselines (2026-07-02): pc raw 34.65% / pp raw 46%;
// post-fix: pc raw ~13.7-22.7% (ds4 ~9-19%), pp raw ~26% (ds4 0%).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-point-sprite-shape.mjs
import { chromium } from "playwright";
import zlib from "zlib";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function capture(renderer, sceneKind) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(async (sceneKind) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.requestRenderMode = false;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    s.backgroundColor = C.Color.BLACK;
    s.globe.show = false;
    for (const sel of [
      ".cesium-viewer-toolbar",
      ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer",
      ".cesium-viewer-bottom",
      ".cesium-viewer-fullscreenContainer",
      ".cesium-widget-credits",
    ]) {
      document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
    }

    if (sceneKind === "pointcloud" || sceneKind === "pcatten") {
      const dates = [
        "2018-07-19T15:18:00Z",
        "2018-07-19T15:18:00.5Z",
        "2018-07-19T15:18:01Z",
        "2018-07-19T15:18:01.5Z",
        "2018-07-19T15:18:02Z",
        "2018-07-19T15:18:02.5Z",
      ];
      const uris = [0, 1, 2, 3, 4].map(
        (i) =>
          `/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudTimeDynamic/${i}.pnts`,
      );
      const intervals = C.TimeIntervalCollection.fromIso8601DateArray({
        iso8601Dates: dates,
        dataCallback: (interval, index) => ({ uri: uris[index] }),
      });
      const start = C.JulianDate.fromIso8601(dates[0]);
      v.clock.startTime = start;
      v.clock.currentTime = start;
      v.clock.stopTime = C.JulianDate.fromIso8601(dates[dates.length - 1]);
      v.clock.clockRange = C.ClockRange.LOOP_STOP;
      v.clock.shouldAnimate = false;
      // "pointcloud": constant style pointSize 8 — WebGL's hasPointSizeStyle
      // branch wins, so attenuation is bypassed on both backends.
      // "pcatten": NO style — the attenuation clamp drives per-point size.
      const pc = new C.TimeDynamicPointCloud({
        intervals,
        clock: v.clock,
        ...(sceneKind === "pointcloud"
          ? { style: new C.Cesium3DTileStyle({ pointSize: 8 }) }
          : {}),
        shading: {
          attenuation: true,
          maximumAttenuation: 10,
          eyeDomeLighting: false,
        },
      });
      s.primitives.add(pc);
      const fixedBS = new C.BoundingSphere(
        new C.Cartesian3(1215012.9, -4736312.85, 4081606.1),
        4.1,
      );
      let framed = false;
      for (let i = 0; i < 600; i++) {
        v.camera.viewBoundingSphere(
          fixedBS,
          new C.HeadingPitchRange(0.3, -0.25, fixedBS.radius * 4.0),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (pc.boundingSphere) framed = true;
        if (i > 250 && framed) break;
      }
      for (let i = 0; i < 60; i++) {
        v.camera.viewBoundingSphere(
          fixedBS,
          new C.HeadingPitchRange(0.3, -0.25, fixedBS.radius * 4.0),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      s.canvas.setAttribute("data-pc", "1");
      return { framed, rendererType: s.context.rendererType };
    }

    // sceneKind === "pointprims" — PointPrimitiveCollection grid.
    const points = s.primitives.add(new C.PointPrimitiveCollection());
    const center = C.Cartesian3.fromDegrees(-75.59777, 40.03883, 0.0);
    const enu = C.Transforms.eastNorthUpToFixedFrame(center);
    const colors = [C.Color.RED, C.Color.LIME, C.Color.CYAN, C.Color.YELLOW];
    let k = 0;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        const local = new C.Cartesian3(ix * 40.0, iy * 40.0, 0.0);
        const pos = C.Matrix4.multiplyByPoint(enu, local, new C.Cartesian3());
        points.add({
          position: pos,
          pixelSize: 18,
          color: colors[k % colors.length],
          outlineColor: C.Color.WHITE,
          outlineWidth: 3,
        });
        k++;
      }
    }
    const bs = new C.BoundingSphere(center, 80.0);
    for (let i = 0; i < 90; i++) {
      v.camera.viewBoundingSphere(
        bs,
        new C.HeadingPitchRange(0.0, -0.6, 300.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    s.canvas.setAttribute("data-pc", "1");
    return { framed: true, rendererType: s.context.rendererType };
  }, sceneKind);

  const png = await page
    .locator('canvas[data-pc="1"]')
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
  await browser.close();
  return { info, errs, decoded };
}

function nonBlack(img) {
  if (!img) return 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4)
    if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 24) n++;
  return n;
}

// 4x4 box downsample to float RGB — feature-scale comparison that forgives
// sub-pixel AA rasterization differences (see header).
function downsample(img, f) {
  const w = Math.floor(img.w / f),
    h = Math.floor(img.h / f);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        bl = 0;
      for (let yy = 0; yy < f; yy++) {
        for (let xx = 0; xx < f; xx++) {
          const i = ((y * f + yy) * img.w + (x * f + xx)) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          bl += img.data[i + 2];
        }
      }
      const n = f * f,
        o = (y * w + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = bl / n;
    }
  }
  return { w, h, data: out };
}

function diffStatsDS(a, b, f) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  const da = downsample(a, f),
    db = downsample(b, f);
  const skip = Math.ceil(60 / f); // toolbar rows
  let model = 0,
    mis = 0;
  for (let y = skip; y < da.h; y++) {
    for (let x = 0; x < da.w; x++) {
      const o = (y * da.w + x) * 3;
      const la = da.data[o] + da.data[o + 1] + da.data[o + 2];
      const lb = db.data[o] + db.data[o + 1] + db.data[o + 2];
      if (la > 24 || lb > 24) {
        model++;
        if (
          Math.abs(da.data[o] - db.data[o]) > 40 ||
          Math.abs(da.data[o + 1] - db.data[o + 1]) > 40 ||
          Math.abs(da.data[o + 2] - db.data[o + 2]) > 40
        )
          mis++;
      }
    }
  }
  return {
    pct: model ? +((100 * mis) / model).toFixed(2) : null,
    model,
  };
}

// Tint-immune variant (the GATE for the two point-cloud scenes): before
// per-cell comparison, image B is rescaled per channel so its mean over
// the union of lit cells matches image A's. A global brightness/tint gain
// (the pre-existing WebGPU point-cloud color residual — see header, which
// also DRIFTS run-to-run) cancels exactly; sprite shape/size/coverage
// errors are spatial and survive normalization (pre-fix round/mis-sized
// points still score 20%+ here). This is the "sprite-footprint assertion"
// the metric gates on — raw diffStatsDS stays reported for tint tracking.
function normalizedDiffStatsDS(a, b, f) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  const da = downsample(a, f),
    db = downsample(b, f);
  const skip = Math.ceil(60 / f); // toolbar rows
  const sumA = [0, 0, 0],
    sumB = [0, 0, 0];
  let model = 0;
  for (let y = skip; y < da.h; y++) {
    for (let x = 0; x < da.w; x++) {
      const o = (y * da.w + x) * 3;
      const la = da.data[o] + da.data[o + 1] + da.data[o + 2];
      const lb = db.data[o] + db.data[o + 1] + db.data[o + 2];
      if (la > 24 || lb > 24) {
        model++;
        for (let c = 0; c < 3; c++) {
          sumA[c] += da.data[o + c];
          sumB[c] += db.data[o + c];
        }
      }
    }
  }
  if (!model) return { pct: null, model: 0, gains: null };
  const gains = [0, 1, 2].map((c) => (sumB[c] > 1e-6 ? sumA[c] / sumB[c] : 1));
  let mis = 0;
  for (let y = skip; y < da.h; y++) {
    for (let x = 0; x < da.w; x++) {
      const o = (y * da.w + x) * 3;
      const la = da.data[o] + da.data[o + 1] + da.data[o + 2];
      const lb = db.data[o] + db.data[o + 1] + db.data[o + 2];
      if (la > 24 || lb > 24) {
        if (
          Math.abs(da.data[o] - gains[0] * db.data[o]) > 40 ||
          Math.abs(da.data[o + 1] - gains[1] * db.data[o + 1]) > 40 ||
          Math.abs(da.data[o + 2] - gains[2] * db.data[o + 2]) > 40
        )
          mis++;
      }
    }
  }
  return {
    pct: +((100 * mis) / model).toFixed(2),
    model,
    gains: gains.map((g) => +g.toFixed(3)),
  };
}

function diffStats(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  let model = 0,
    mis = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const la = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const lb = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (la > 24 || lb > 24) {
      model++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 40 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 40 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 40
      )
        mis++;
    }
  }
  return {
    pct: model ? +((100 * mis) / model).toFixed(2) : null,
    model,
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

const pcGL = await capture("webgl", "pointcloud");
const pcGPU = await capture("webgpu", "pointcloud");
const pcaGL = await capture("webgl", "pcatten");
const pcaGPU = await capture("webgpu", "pcatten");
const ppGL = await capture("webgl", "pointprims");
const ppGPU = await capture("webgpu", "pointprims");

fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const save = (name, cap) => {
  if (cap.decoded)
    fs.writeFileSync(
      `Tools/visual-regression/output/probe-point-sprite-${name}.png`,
      encodePNG(cap.decoded),
    );
};
save("pc-webgl", pcGL);
save("pc-webgpu", pcGPU);
save("pca-webgl", pcaGL);
save("pca-webgpu", pcaGPU);
save("pp-webgl", ppGL);
save("pp-webgpu", ppGPU);

const pcDiff = diffStats(pcGL.decoded, pcGPU.decoded);
const pcaDiff = diffStats(pcaGL.decoded, pcaGPU.decoded);
const ppDiff = diffStats(ppGL.decoded, ppGPU.decoded);
const pcDiffDS = diffStatsDS(pcGL.decoded, pcGPU.decoded, 4);
const pcaDiffDS = diffStatsDS(pcaGL.decoded, pcaGPU.decoded, 4);
const ppDiffDS = diffStatsDS(ppGL.decoded, ppGPU.decoded, 4);
const pcNorm = normalizedDiffStatsDS(pcGL.decoded, pcGPU.decoded, 4);
const pcaNorm = normalizedDiffStatsDS(pcaGL.decoded, pcaGPU.decoded, 4);
const filterErrs = (e) =>
  e.filter((x) => !/AtmosphereLUT|atmosphereLUT|default layout/.test(x));

console.log(
  JSON.stringify(
    {
      px: {
        "pc-webgl": nonBlack(pcGL.decoded),
        "pc-webgpu": nonBlack(pcGPU.decoded),
        "pca-webgl": nonBlack(pcaGL.decoded),
        "pca-webgpu": nonBlack(pcaGPU.decoded),
        "pp-webgl": nonBlack(ppGL.decoded),
        "pp-webgpu": nonBlack(ppGPU.decoded),
      },
      pointcloud_cross_backend_raw: pcDiff,
      pcatten_cross_backend_raw: pcaDiff,
      pointprims_cross_backend_raw: ppDiff,
      pointcloud_cross_backend_ds4: pcDiffDS,
      pcatten_cross_backend_ds4: pcaDiffDS,
      pointprims_cross_backend_ds4: ppDiffDS,
      // Gain-normalized (tint-immune) — the point-cloud GATE metric.
      // `gains` = per-channel WebGL/WebGPU mean ratios (tint tracker).
      pointcloud_cross_backend_nds4: pcNorm,
      pcatten_cross_backend_nds4: pcaNorm,
      errs: {
        pcGPU: filterErrs(pcGPU.errs).slice(0, 3),
        pcaGPU: filterErrs(pcaGPU.errs).slice(0, 3),
        ppGPU: filterErrs(ppGPU.errs).slice(0, 3),
      },
    },
    null,
    2,
  ),
);

const pcRendered =
  nonBlack(pcGL.decoded) > 3000 && nonBlack(pcGPU.decoded) > 3000;
const pcaRendered =
  nonBlack(pcaGL.decoded) > 3000 && nonBlack(pcaGPU.decoded) > 3000;
const ppRendered =
  nonBlack(ppGL.decoded) > 500 && nonBlack(ppGPU.decoded) > 500;
// Point-cloud gates use the gain-NORMALIZED ds4 (tint-immune, see
// header); a broken sprite shape/size (round or mis-sized quads) is
// spatial and survives normalization at 20%+.
const pcPass = pcNorm && pcNorm.pct !== null && pcNorm.pct < 16.0;
const pcaPass = pcaNorm && pcaNorm.pct !== null && pcaNorm.pct < 16.0;
const ppPass = ppDiffDS && ppDiffDS.pct !== null && ppDiffDS.pct < 5.0;
const noErrs =
  filterErrs(pcGPU.errs).length === 0 &&
  filterErrs(pcaGPU.errs).length === 0 &&
  filterErrs(ppGPU.errs).length === 0;

console.log(
  `(A) Both backends render the point cloud: ${pcRendered ? "PASS" : "FAIL"}`,
);
console.log(
  `(B) Point cloud normalized-ds4 ${pcNorm?.pct}% < 16% (ds4 ${pcDiffDS?.pct}%, raw ${pcDiff?.pct}%, gains ${JSON.stringify(pcNorm?.gains)}): ${pcPass ? "PASS" : "FAIL"}`,
);
console.log(
  `(C) Both backends render the attenuation-only cloud: ${pcaRendered ? "PASS" : "FAIL"}`,
);
console.log(
  `(D) Attenuation-only normalized-ds4 ${pcaNorm?.pct}% < 16% (ds4 ${pcaDiffDS?.pct}%, raw ${pcaDiff?.pct}%, gains ${JSON.stringify(pcaNorm?.gains)}): ${pcaPass ? "PASS" : "FAIL"}`,
);
console.log(
  `(E) Both backends render point primitives: ${ppRendered ? "PASS" : "FAIL"}`,
);
console.log(
  `(F) Point primitive ds4 mismatch ${ppDiffDS?.pct}% < 5% (raw ${ppDiff?.pct}%): ${ppPass ? "PASS" : "FAIL"}`,
);
console.log(`(G) 0 WebGPU device errors: ${noErrs ? "PASS" : "FAIL"}`);
const pass =
  pcRendered &&
  pcPass &&
  pcaRendered &&
  pcaPass &&
  ppRendered &&
  ppPass &&
  noErrs;
console.log(pass ? "GATE PASS" : "GATE FAIL");
