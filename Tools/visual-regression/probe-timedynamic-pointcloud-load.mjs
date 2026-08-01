// Q5-TIMEDYNAMIC-POINTCLOUD-ZERO — regression probe for the B377 diagnostic.
//
// Diagnostic claim (B377): `TimeDynamicPointCloud` loads ZERO content on WebGPU
//   (`boundingSphere` never ready, `totalMemoryUsageInBytes === 0` after many
//   frames) while WebGL loads at frame 1.
//
// This probe animates the clock (LOOP_STOP) over the 5-frame PointCloudTimeDynamic
// sample for ~300 render frames on each backend and reports:
//   - boundingSphere readiness (defined + finite radius)
//   - totalMemoryUsageInBytes after the run
//   - non-black pixel count (content actually renders)
//
// PASS: WebGPU renders content, boundingSphere ready, AND totalMemoryUsageInBytes>0
//       (the memory accounting drives frame eviction, so 0 = leak / stale symptom).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-timedynamic-pointcloud-load.mjs
import { chromium } from "playwright";
import zlib from "zlib";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function capture(renderer) {
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

  const info = await page.evaluate(async () => {
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
    v.clock.multiplier = 1.0;
    v.clock.canAnimate = true;
    v.clock.shouldAnimate = true;
    const pc = new C.TimeDynamicPointCloud({
      intervals,
      clock: v.clock,
      style: new C.Cesium3DTileStyle({ pointSize: 8 }),
    });
    s.primitives.add(pc);

    const fixedBS = new C.BoundingSphere(
      new C.Cartesian3(1215012.9, -4736312.85, 4081606.1),
      4.1,
    );

    let bsReadyFrame = -1;
    let memFirstNonZeroFrame = -1;
    const N = 320;
    for (let i = 0; i < N; i++) {
      // advance the clock so multiple frames get requested/loaded/unloaded
      v.clock.tick();
      v.camera.viewBoundingSphere(
        fixedBS,
        new C.HeadingPitchRange(0.3, -0.25, fixedBS.radius * 4.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (bsReadyFrame < 0 && pc.boundingSphere) {
        bsReadyFrame = i;
      }
      if (memFirstNonZeroFrame < 0 && pc.totalMemoryUsageInBytes > 0) {
        memFirstNonZeroFrame = i;
      }
    }
    s.canvas.setAttribute("data-pc", "1");
    const bs = pc.boundingSphere;
    return {
      rendererType: s.context.rendererType,
      bsReady: !!bs,
      bsReadyFrame,
      radius: bs ? bs.radius : 0,
      radiusFinite: bs ? isFinite(bs.radius) && bs.radius > 0 : false,
      totalMemoryUsageInBytes: pc.totalMemoryUsageInBytes,
      memFirstNonZeroFrame,
    };
  });

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

const gpu = await capture("webgpu");
const gl = await capture("webgl");

fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/probe-tdpc-webgpu.png",
  encodePNG(gpu.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/probe-tdpc-webgl.png",
  encodePNG(gl.decoded),
);

const filterErrs = (e) =>
  e.filter((x) => !/AtmosphereLUT|atmosphereLUT|default layout/.test(x));

const gpuPx = nonBlack(gpu.decoded);
const glPx = nonBlack(gl.decoded);

console.log(
  JSON.stringify(
    {
      webgpu: { ...gpu.info, nonBlackPx: gpuPx },
      webgl: { ...gl.info, nonBlackPx: glPx },
      errs: {
        gpu: filterErrs(gpu.errs).slice(0, 4),
        gl: filterErrs(gl.errs).slice(0, 4),
      },
    },
    null,
    2,
  ),
);

// The B377 diagnostic: WebGPU must load content (not zero).
const renders = gpuPx > 2000;
const bsReady = gpu.info.bsReady && gpu.info.radiusFinite;
const memAccounted = gpu.info.totalMemoryUsageInBytes > 0;
const noErrs = filterErrs(gpu.errs).length === 0;

console.log(
  `(A) WebGPU renders content (px=${gpuPx}): ${renders ? "PASS" : "FAIL"}`,
);
console.log(
  `(B) WebGPU boundingSphere ready (frame ${gpu.info.bsReadyFrame}, r=${gpu.info.radius}): ${bsReady ? "PASS" : "FAIL"}`,
);
console.log(
  `(C) WebGPU totalMemoryUsageInBytes>0 (${gpu.info.totalMemoryUsageInBytes}, firstFrame ${gpu.info.memFirstNonZeroFrame}): ${memAccounted ? "PASS" : "FAIL"}`,
);
console.log(`(D) 0 WebGPU device errors: ${noErrs ? "PASS" : "FAIL"}`);
const pass = renders && bsReady && memAccounted && noErrs;
console.log(pass ? "GATE PASS" : "GATE FAIL");
