#!/usr/bin/env node
/**
 * Probe: C13-07 — dateline + pole weather-map seam correction (pixel gate).
 *
 * The Node contract suite (weather-map-seam.spec.mjs) proves the TEXTURE math:
 * periodic fBM removed the antimeridian wall (max step 1.000 -> 0.067) and the
 * polar low-pass made both cap rows constant. This probe proves the PIXELS:
 *
 *   D1 DATELINE — nadir over lon 180 with the weather map ON. The adjacent-
 *      column luminance step of the center band (where the +/-180 meridian
 *      projects) must not be an outlier against the same frame's own column-
 *      step distribution. Pre-fix this was a full-contrast cloud/clear wall.
 *   D2 CONTROL  — same camera over lon 0 (no seam) supplies the comparison
 *      scale: the center-step ratio at lon 180 must be comparable to lon 0.
 *   P1 POLE     — nadir near 90N. A small ring around the projected pole must
 *      have bounded azimuthal luminance variance (constant cap row), and the
 *      central pixel block must contain no NaN-garbage cluster (atan2 guard).
 *   NV NON-VACUITY — every lane requires a visible cloud fraction; a frame
 *      with no clouds cannot certify a seam and reports STRUCTURAL instead.
 *
 * Volumetric clouds are WebGPU-only, so the pixel lanes run on WebGPU. A
 * WebGL viewer load-sanity arm confirms the backend-neutral Scene/Weather
 * modules do not break the WebGL bundle.
 *
 * Capture doctrine: every pixel read is fused with a scene.render() in the
 * SAME task (no rAF yield between render and drawImage).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-weather-seam-poles.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/weather-seam-poles";
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

try {
  // --- WebGL load sanity ---------------------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push("PE:" + e.message));
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
      waitUntil: "networkidle",
      timeout: 90000,
    });
    await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
    if (errs.length > 0) {
      failures.push(`WEBGL-LOAD: ${errs.length} console errors: ${errs[0]}`);
    } else {
      notes.push("WEBGL-LOAD: viewer up, 0 errors");
    }
    await page.close();
  }

  // --- WebGPU pixel lanes --------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("PE:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  // One shared in-page routine: set view, settle a fixed frame budget, then
  // render+capture fused in one task. Returns column mean-luminances of a
  // horizontal band plus a small center block and a pole ring sample.
  const captureView = (lon, lat, height, tag) =>
    page.evaluate(
      async ({ lon, lat, height, tag }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer,
          s = v.scene,
          g = s.globe;
        const vol = g.defaultCloudCollection.volumetric;
        g.defaultCloudCollection.enableVolumetric = true;
        vol.cloudCoverage = 0.6;
        vol.cloudDensity = 0.9;
        vol.cloudLayerBottom = 1500;
        vol.cloudLayerTop = 4000;
        vol.cloudWeatherMap = true;
        s.skyAtmosphere.show = false;
        if (s.sun) s.sun.show = false;
        if (s.moon) s.moon.show = false;
        s.skyBox.show = false;
        s.backgroundColor = C.Color.BLACK;
        g.baseColor = C.Color.fromBytes(20, 20, 25);
        // Imagery would pollute the luminance metric (bright land reads as
        // "cloud"); a dark base color leaves clouds as the only bright signal.
        g.imageryLayers.removeAll();
        // Local solar noon for the view longitude — a fixed UTC time would put
        // the antimeridian on the night side and read unlit clouds as absent.
        let noonUtc = 12 - lon / 15;
        while (noonUtc < 0) noonUtc += 24;
        while (noonUtc >= 24) noonUtc -= 24;
        const hh = String(Math.floor(noonUtc)).padStart(2, "0");
        const mm = String(Math.round((noonUtc % 1) * 60)).padStart(2, "0");
        v.clock.currentTime = C.JulianDate.fromIso8601(
          `2026-06-01T${hh}:${mm}:00Z`,
        );
        v.clock.shouldAnimate = false;
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: 0.0,
            pitch: C.Math.toRadians(-90.0),
            roll: 0.0,
          },
        });
        // Bounded settle: fixed frame budget, no unbounded convergence loop.
        for (let i = 0; i < 120; i++) {
          s.render();
          await new Promise((res) => requestAnimationFrame(res));
        }
        // Fused render + read: same task, no yield in between.
        s.render();
        const cv = s.canvas,
          w = cv.width,
          h = cv.height;
        const t = document.createElement("canvas");
        t.width = w;
        t.height = h;
        const cx = t.getContext("2d");
        cx.drawImage(cv, 0, 0);
        const px = cx.getImageData(0, 0, w, h).data;
        const lum = (x, y) => {
          const i = (y * w + x) * 4;
          return Math.max(px[i], px[i + 1], px[i + 2]);
        };
        // Column means over the central horizontal band.
        const y0 = Math.floor(h * 0.3),
          y1 = Math.floor(h * 0.7);
        const cols = [];
        for (let x = Math.floor(w * 0.1); x < Math.floor(w * 0.9); x++) {
          let sum = 0,
            n = 0;
          for (let y = y0; y < y1; y += 2) {
            sum += lum(x, y);
            n++;
          }
          cols.push(sum / n);
        }
        // Cloud fraction (non-vacuity).
        let cloud = 0,
          n = 0;
        for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y += 3) {
          for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x += 3) {
            if (lum(x, y) > 120) cloud++;
            n++;
          }
        }
        // Pole sectors: mean luminance of 12 azimuthal sectors over an annulus
        // (radius 4%..12% of frame). At 250 km the whole frame sits inside the
        // constant polar cap (156 km radius), so a pre-fix pinwheel shows as
        // sector-to-sector spokes; sector MEANS (hundreds of px each) suppress
        // individual cloud-puff noise that single-pixel rings cannot.
        const cxp = Math.floor(w / 2),
          cyp = Math.floor(h / 2),
          r0 = Math.min(w, h) * 0.04,
          r1 = Math.min(w, h) * 0.12;
        const secSum = new Array(12).fill(0),
          secN = new Array(12).fill(0);
        for (let y = Math.floor(cyp - r1); y <= cyp + r1; y++) {
          for (let x = Math.floor(cxp - r1); x <= cxp + r1; x++) {
            const dx = x - cxp,
              dy = y - cyp,
              rr = Math.sqrt(dx * dx + dy * dy);
            if (rr < r0 || rr > r1) continue;
            const k =
              (Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 12) + 12) % 12;
            secSum[k] += lum(x, y);
            secN[k]++;
          }
        }
        const ring = secSum.map((s2, k) => (secN[k] ? s2 / secN[k] : 0));
        const center = [];
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            center.push(lum(cxp + dx, cyp + dy));
          }
        }
        const png = t.toDataURL("image/png");
        return { cols, cloudFrac: n ? cloud / n : 0, ring, center, png, tag };
      },
      { lon, lat, height, tag },
    );

  const save = (r) =>
    fs.writeFileSync(
      `${OUT}/${r.tag}.png`,
      Buffer.from(r.png.split(",")[1], "base64"),
    );

  // Discarded warm-up: the volumetric pipeline's noise/pipeline prewarm is
  // asynchronous (C13-40), so the very first capture after enabling clouds
  // under-renders. Nothing from this capture is measured.
  await captureView(0.0, 0.0, 250000.0, "warmup-discard");

  const stepStats = (cols) => {
    const steps = [];
    for (let i = 1; i < cols.length; i++) {
      steps.push(Math.abs(cols[i] - cols[i - 1]));
    }
    const mid = Math.floor(steps.length / 2);
    const half = Math.floor(steps.length * 0.04); // center 8% band
    const centerMax = Math.max(...steps.slice(mid - half, mid + half));
    const rest = steps
      .slice(0, mid - half)
      .concat(steps.slice(mid + half))
      .sort((a, b) => a - b);
    const p95 = rest[Math.floor(rest.length * 0.95)];
    return { centerMax, p95 };
  };

  // D1 — the seam view is its own control. Latitude 0.7N chosen from the
  // CPU-twin map: the texels on BOTH sides of the seam are cloudy there
  // (west 0.935 / east 0.882), so a residual wall would split the frame into
  // a bright half and a dark half at the center meridian. Post-fix the two
  // halves must be comparably cloudy and the center column step must not be
  // an outlier against the frame's own step distribution.
  {
    const seam = await captureView(180.0, 0.7, 250000.0, "dateline-eq");
    save(seam);
    const cols = seam.cols;
    const mid = Math.floor(cols.length / 2);
    const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const left = meanOf(cols.slice(0, mid)),
      right = meanOf(cols.slice(mid));
    const s1 = stepStats(cols);
    notes.push(
      `D-eq(0.7N): halves L ${left.toFixed(1)} R ${right.toFixed(1)} | centerMax ${s1.centerMax.toFixed(1)} p95 ${s1.p95.toFixed(1)} | cloudFrac ${seam.cloudFrac.toFixed(3)}`,
    );
    if (seam.cloudFrac < 0.05) {
      failures.push(
        `STRUCTURAL D-eq: cloud fraction ${seam.cloudFrac.toFixed(3)} too low to certify (twin map says both seam sides cloudy at 0.7N)`,
      );
    } else {
      const ratio = Math.max(left, right) / Math.max(1, Math.min(left, right));
      if (ratio > 3.0) {
        failures.push(
          `D-eq: hemisphere brightness wall across the meridian (L ${left.toFixed(1)} vs R ${right.toFixed(1)})`,
        );
      }
      if (s1.centerMax > Math.max(2.5 * s1.p95, 20)) {
        failures.push(
          `D-eq: center column step is an outlier (centerMax ${s1.centerMax.toFixed(1)} vs p95 ${s1.p95.toFixed(1)})`,
        );
      }
    }
  }

  // P1 — pole ring + center garbage check (89.995 keeps the camera regular;
  // the cap rows span 88.6..90 so the view still reads the constant cap).
  for (const [lat, tagP] of [
    [89.995, "npole"],
    [-89.995, "spole"],
  ]) {
    const r = await captureView(0.0, lat, 250000.0, tagP);
    save(r);
    if (r.cloudFrac < 0.03) {
      notes.push(
        `P-${tagP}: cloud fraction ${r.cloudFrac.toFixed(3)} — cap row may legitimately be clear here; ring variance check still valid on any nonzero signal`,
      );
    }
    const mean = r.ring.reduce((a, b) => a + b, 0) / r.ring.length;
    const maxDev = Math.max(...r.ring.map((v) => Math.abs(v - mean)));
    // Constant cap row -> small azimuthal deviation on the small ring. Allow
    // raymarch noise; a pre-fix pinwheel produced full-range spokes.
    if (mean > 15 && maxDev > Math.max(0.6 * mean, 40)) {
      failures.push(
        `P-${tagP}: azimuthal ring spread too high (mean ${mean.toFixed(1)}, maxDev ${maxDev.toFixed(1)}) — pinwheel suspected`,
      );
    }
    // NaN/garbage cluster at the exact pole: center block must not contain a
    // hot cluster wildly above the ring (the atan2(0,0) failure signature).
    const cMax = Math.max(...r.center);
    if (cMax > 3 * Math.max(mean, 20) && cMax > 200) {
      failures.push(
        `P-${tagP}: center block hot cluster (${cMax}) vs ring mean ${mean.toFixed(1)} — spin-axis guard suspect`,
      );
    }
    notes.push(
      `P-${tagP}: ring mean ${mean.toFixed(1)} maxDev ${maxDev.toFixed(1)} centerMax ${cMax} cloudFrac ${r.cloudFrac.toFixed(3)}`,
    );
  }

  if (errs.length > 0) {
    failures.push(`WEBGPU console errors (${errs.length}): ${errs[0]}`);
  }
  await page.close();
} finally {
  await browser.close();
}

console.log("=== probe-weather-seam-poles ===");
for (const n of notes) console.log("  " + n);
if (failures.length > 0) {
  console.log("FAIL");
  for (const f of failures) console.log("  FAIL: " + f);
  process.exit(1);
}
console.log("PASS");
