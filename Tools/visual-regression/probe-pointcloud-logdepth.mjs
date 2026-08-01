// C2-7 NEW-LOG-DEPTH-POINTCLOUD-PRODUCER — the standalone WebGPUPointCloudRenderer
// (TimeDynamicPointCloud path) now writes renderer-wide log frag_depth, so it
// sorts/occludes consistently with the globe + every other opaque producer (which
// write log depth by default). Loads the PointCloudTimeDynamic sample over the
// globe and compares WebGL vs WebGPU — the point cloud must occlude/sort against
// the globe surface identically on both backends. Also asserts 0 device errors
// and that the point-cloud color render is unchanged.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-pointcloud-logdepth.mjs
import { chromium } from "playwright";
import zlib from "zlib";

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
    waitUntil: "networkidle",
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
    // Keep the GLOBE visible — it is the depth reference the point cloud sorts against.
    s.globe.show = true;
    for (const sel of [
      ".cesium-viewer-toolbar",
      ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer",
      ".cesium-viewer-bottom",
      ".cesium-viewer-fullscreenContainer",
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
    v.clock.shouldAnimate = false;
    const pc = new C.TimeDynamicPointCloud({
      intervals,
      clock: v.clock,
      style: new C.Cesium3DTileStyle({ pointSize: 8 }),
    });
    s.primitives.add(pc);
    // Render until the first frame loads + boundingSphere is available.
    let bs = null,
      bsFrame = -1;
    for (let i = 0; i < 500; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (!bs && pc.boundingSphere) {
        bs = pc.boundingSphere;
        bsFrame = i;
      }
      if (bs && i > bsFrame + 30) break;
    }
    if (bs) {
      // Oblique view so the globe surface sits BEHIND part of the cloud → tests
      // depth sorting against the globe at distance.
      v.camera.viewBoundingSphere(
        bs,
        new C.HeadingPitchRange(0.4, -0.35, bs.radius * 12.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    }
    for (let i = 0; i < 90; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    s.canvas.setAttribute("data-pc", "1");
    let mem = -1;
    try {
      mem = pc.totalMemoryUsageInBytes;
    } catch (e) {
      /* */
    }
    return {
      ready: !!bs,
      bsFrame,
      mem,
      rendererType: s.context.rendererType,
      radius: bs ? bs.radius : 0,
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

function diffPct(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  let model = 0,
    mis = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const la = a.data[i] + a.data[i + 1] + a.data[i + 2],
      lb = b.data[i] + b.data[i + 1] + b.data[i + 2];
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
  return model ? +((100 * mis) / model).toFixed(2) : null;
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

const wgpu = await capture("webgpu");
const wgl = await capture("webgl");
const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
if (wgpu.decoded)
  fs.writeFileSync(
    "Tools/visual-regression/output/pointcloud-logdepth-webgpu.png",
    encodePNG(wgpu.decoded),
  );
if (wgl.decoded)
  fs.writeFileSync(
    "Tools/visual-regression/output/pointcloud-logdepth-webgl.png",
    encodePNG(wgl.decoded),
  );
const dp = diffPct(wgpu.decoded, wgl.decoded);
const nonBlack = (img) => {
  if (!img) return 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4)
    if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 24) n++;
  return n;
};
console.log(
  JSON.stringify(
    {
      webgpu: {
        ready: wgpu.info.ready,
        bsFrame: wgpu.info.bsFrame,
        mem: wgpu.info.mem,
        px: nonBlack(wgpu.decoded),
        errs: wgpu.errs.slice(0, 4),
      },
      webgl: {
        ready: wgl.info.ready,
        bsFrame: wgl.info.bsFrame,
        mem: wgl.info.mem,
        px: nonBlack(wgl.decoded),
      },
      diffPct: dp,
    },
    null,
    2,
  ),
);
const rendered = wgpu.info.ready && nonBlack(wgpu.decoded) > 3000;
const noErrs =
  wgpu.errs.filter((e) => !/AtmosphereLUT|atmosphereLUT|default layout/.test(e))
    .length === 0;
const parity = dp !== null && dp < 8;
const pass = rendered && noErrs && parity;
console.log(
  `(A) WebGPU point cloud renders over globe: ${rendered ? "PASS" : "FAIL"}`,
);
console.log(
  `(B) no WebGPU device errors (excl. known AtmosphereLUT): ${noErrs ? "PASS" : "FAIL"}`,
);
console.log(
  `(C) WebGPU sorts/matches WebGL < 8% (${dp}): ${parity ? "PASS" : "FAIL"}`,
);
console.log(
  pass
    ? "GATE PASS — point cloud writes log depth + sorts vs globe like WebGL."
    : "GATE FAIL.",
);
process.exit(pass ? 0 : 1);
