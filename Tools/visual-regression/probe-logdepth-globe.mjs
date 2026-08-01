// Slice 2a verification — globe log-depth producer.
// Renders the WebGPU globe with _logDepthWriteEnabled OFF (default, must be
// inert) then flips it ON (must recompile the LOG_DEPTH shader variant + still
// render the globe). Confirms: flag-off identical, flag-on 0 device errors +
// globe visible + ~unchanged (log2 is monotonic so depth ordering is preserved).
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const OUT = "Tools/visual-regression/output";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 200));
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

async function setupAndRender(flag) {
  return await page.evaluate(async (logDepthOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.fog.enabled = false;
    const ctx = s.context;
    const dev = ctx?._device;
    const de = [];
    if (dev)
      dev.onuncapturederror = (e) =>
        de.push(String(e?.error?.message ?? "").slice(0, 300));
    // Frame a regional globe view (terrain precision regime).
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-105.0, 40.0, 350000.0),
    });
    ctx._logDepthWriteEnabled = logDepthOn; // flip the master switch
    for (let i = 0; i < 60; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      logDepthEnabled: ctx._logDepthWriteEnabled,
      deviceErrs: de.length,
      deviceErrSample: de.slice(0, 4),
    };
  }, flag);
}

const off = await setupAndRender(false);
const offPng = await (await page.$("canvas")).screenshot();
fs.writeFileSync(`${OUT}/_logdepth-globe-OFF.png`, offPng);

const on = await setupAndRender(true);
const onPng = await (await page.$("canvas")).screenshot();
fs.writeFileSync(`${OUT}/_logdepth-globe-ON.png`, onPng);

console.log("FLAG OFF:", JSON.stringify(off));
console.log("FLAG ON :", JSON.stringify(on));
console.log("console/page errs:", errs.length);
errs.slice(0, 6).forEach((e) => console.log("  ", e));

// Diff OFF vs ON + measure non-black coverage (globe present) for each.
const diff = await page.evaluate(
  async ([a, b]) => {
    async function dec(u) {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = u;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const cx = cv.getContext("2d");
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, cv.width, cv.height).data;
    }
    const A = await dec(a),
      B = await dec(b);
    let mism = 0,
      litA = 0,
      litB = 0,
      tot = 0;
    for (let i = 0; i < Math.min(A.length, B.length); i += 4) {
      tot++;
      if (A[i] + A[i + 1] + A[i + 2] > 30) litA++;
      if (B[i] + B[i + 1] + B[i + 2] > 30) litB++;
      if (
        Math.abs(A[i] - B[i]) +
          Math.abs(A[i + 1] - B[i + 1]) +
          Math.abs(A[i + 2] - B[i + 2]) >
        40
      )
        mism++;
    }
    return {
      mismatchPct: ((mism / tot) * 100).toFixed(2),
      litPctOFF: ((litA / tot) * 100).toFixed(1),
      litPctON: ((litB / tot) * 100).toFixed(1),
    };
  },
  [
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_logdepth-globe-OFF.png`).toString("base64"),
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_logdepth-globe-ON.png`).toString("base64"),
  ],
);
console.log("OFF-vs-ON:", JSON.stringify(diff));
await browser.close();
