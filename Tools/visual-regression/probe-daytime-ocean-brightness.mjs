#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for NEW-GLOBE-DAYTIME-OCEAN-BRIGHTNESS (Q10).
// Pins the viewer clock to a DAYTIME and a NIGHT sun position over the
// Caribbean and captures WebGL vs WebGPU, plus per-term WebGPU bypasses
// (glint / drape / fog) to attribute the day-side ocean-brightness gap.
//
// PASS (caribbean-mid, view -70.1037,18.485,2000000):
//   DAY   gpu-vs-gl mismatch < ~5%  (was 91%; WebGPU ocean was ~4x darker —
//         the diffuseHighlight was zeroed because the WGSL passed the
//         day/night terminator fade instead of WebGL's atmosphere fade).
//   NIGHT gpu-vs-gl mismatch < ~3%  (must stay at parity — the fix must not
//         let nonDiffuseHighlight blow the night ocean out to cyan).
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const VIEW = "view=-70.1037,18.485,2000000";
const DAY_ISO = "2026-07-03T14:00:00Z"; // Caribbean local ~10am, sun up
const NIGHT_ISO = "2026-07-04T04:00:00Z"; // Caribbean local ~midnight

async function capture(rendererArg, { clockIso, bypass, label }) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}&${VIEW}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ clockIso, bypass }) => {
      const v = window.viewer;
      const JulianDate = v.clock.currentTime.constructor;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JulianDate.fromIso8601(clockIso);
      if (
        bypass &&
        window.CesiumDebug &&
        window.CesiumDebug.globeFragmentDebug
      ) {
        window.CesiumDebug.globeFragmentDebug(bypass);
      }
      for (let i = 0; i < 300; i++) {
        v.clock.currentTime = JulianDate.fromIso8601(clockIso);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { clockIso, bypass },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `diag-daytime-${label}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length)
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  return out;
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba),
        B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const total = A.w * A.h;
      let mismatch = 0,
        sum = 0,
        nonBg = 0,
        sumRatio = 0,
        lumASum = 0,
        lumBSum = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const ra = A.data[i],
          ga = A.data[i + 1],
          ba2 = A.data[i + 2];
        const rb = B.data[i],
          gb = B.data[i + 1],
          bb2 = B.data[i + 2];
        const d = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba2 - bb2);
        sum += d;
        if (d > 30) mismatch++;
        const lumA = 0.2126 * ra + 0.7152 * ga + 0.0722 * ba2;
        const lumB = 0.2126 * rb + 0.7152 * gb + 0.0722 * bb2;
        lumASum += lumA;
        lumBSum += lumB;
        if (lumA > 5 || lumB > 5) {
          nonBg++;
          sumRatio += (lumB + 1) / (lumA + 1);
        }
      }
      return {
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
        meanDelta: (sum / total).toFixed(2),
        meanBrightnessRatio_BoverA: (sumRatio / Math.max(1, nonBg)).toFixed(3),
        meanLumA: (lumASum / total).toFixed(1),
        meanLumB: (lumBSum / total).toFixed(1),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Night baseline (should be ~1% parity per the tracked entry).
  console.log("== NIGHT baseline ==");
  const nGl = await capture("webgl", { clockIso: NIGHT_ISO, label: "night" });
  const nGpu = await capture("webgpu", { clockIso: NIGHT_ISO, label: "night" });
  console.log("  night gpu-vs-gl:", JSON.stringify(await diffPngs(nGpu, nGl)));

  // 2. Day baseline.
  console.log("== DAY baseline ==");
  const dGl = await capture("webgl", { clockIso: DAY_ISO, label: "day" });
  const dGpu = await capture("webgpu", {
    clockIso: DAY_ISO,
    label: "day",
    bypass: "bypass-none",
  });
  console.log(
    "  day gpu(none)-vs-gl:",
    JSON.stringify(await diffPngs(dGpu, dGl)),
  );

  // 3. Per-term WebGPU bypasses (day) — how much each WebGPU term contributes.
  for (const bypass of ["bypass-glint", "bypass-drape", "bypass-fog"]) {
    const b = await capture("webgpu", {
      clockIso: DAY_ISO,
      label: bypass,
      bypass,
    });
    console.log(
      `  day ${bypass}-vs-gl:`,
      JSON.stringify(await diffPngs(b, dGl)),
    );
    console.log(
      `  day ${bypass}-vs-none:`,
      JSON.stringify(await diffPngs(b, dGpu)),
    );
  }
  console.log("done");
})();
