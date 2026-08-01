// One-shot orchestrator check for C13-06: cloud cast shadows at high latitude.
// Pre-fix the shadow pass marched empty space (spherical footprint 21 km off at
// the pole) so the cast shadow silently vanished at high latitude; post-fix an
// ON/OFF pair must differ on the ground band.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:8080";
const OUT = "Tools/visual-regression/output/cloud-shadows";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push("PE:" + e.message));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const shot = (castOn, tag) =>
  page.evaluate(
    async ({ castOn, tag }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const vol = g.defaultCloudCollection.volumetric;
      g.defaultCloudCollection.enableVolumetric = true;
      vol.cloudCoverage = 0.7;
      vol.cloudDensity = 1.0;
      vol.cloudLayerBottom = 1200;
      vol.cloudLayerTop = 3500;
      vol.cloudCastShadows = castOn;
      s.skyBox.show = false;
      if (s.sun) s.sun.show = false;
      // 82N, oblique view, midsummer low sun (always up at 82N in June).
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T12:00:00Z");
      v.clock.shouldAnimate = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(15.0, 82.0, 12000.0),
        orientation: {
          heading: C.Math.toRadians(30.0),
          pitch: C.Math.toRadians(-35.0),
          roll: 0.0,
        },
      });
      for (let i = 0; i < 120; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
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
      // Ground band: lower 40% of frame (terrain under the deck at this pitch).
      let sum = 0,
        n = 0;
      for (let y = Math.floor(h * 0.6); y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
          n++;
        }
      }
      return { mean: sum / n, png: t.toDataURL("image/png"), tag };
    },
    { castOn, tag },
  );

await shot(true, "warmup"); // discard (async prewarm)
const on = await shot(true, "polar-shadows-on");
const off = await shot(false, "polar-shadows-off");
for (const r of [on, off]) {
  fs.writeFileSync(
    `${OUT}/${r.tag}.png`,
    Buffer.from(r.png.split(",")[1], "base64"),
  );
}
const delta = off.mean - on.mean;
console.log(
  `polar 82N ground band: shadowsON mean ${on.mean.toFixed(2)}  shadowsOFF mean ${off.mean.toFixed(2)}  delta ${delta.toFixed(2)}`,
);
console.log(`console errors: ${errs.length}`);
await browser.close();
// ON must darken the ground: pre-fix the pass marched empty space and delta ~ 0.
if (delta > 0.5 && errs.length === 0) {
  console.log("PASS — cast shadows present at 82N");
} else {
  console.log("FAIL — no measurable polar cast shadow (or console errors)");
  process.exit(1);
}
