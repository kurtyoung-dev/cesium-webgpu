#!/usr/bin/env node
/**
 * CLOUD-MULTIDECK extra views (Batch 443) — confirm correct deck stacking +
 * ordering from several camera positions, multiDeck ON vs OFF.
 * @purpose B443 evidence capture: deck stacking/ordering from above all decks (15 km) and between decks (3.5 km), ON vs OFF; eyeball only.
 * @status INVESTIGATION
 *
 *   above   — camera at 15km (above ALL decks), pitch -25 looking DOWN: should
 *             see the HIGH veil over the MID over the LOW deck (correct top-down
 *             ordering), no z-fighting at the deck boundaries.
 *   between — camera at 3.5km (inside MID, above LOW): LOW deck below, HIGH veil
 *             above — the classic "low cumulus beneath high cirrus" read.
 *
 * Output: output/multideck/<view>-<on|off>.png
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TIME_ISO = "2026-06-21T17:00:00Z";
const VIEWS = {
  above: { lon: -100.0, lat: 36.0, height: 15000, heading: 30, pitch: -25 },
  between: { lon: -100.0, lat: 36.0, height: 3500, heading: 30, pitch: -4 },
};

async function capture(page, view, multiDeck) {
  return page.evaluate(
    async ({ view, timeIso, multiDeck }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const C = await import("/Build/CesiumUnminified/index.js");
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      s.globe.enableLighting = true;
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high";
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.5;
      if ("cloudMultiDeck" in g)
        g.defaultCloudCollection.volumetric.cloudMultiDeck = multiDeck;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(view.heading),
          pitch: C.Math.toRadians(view.pitch),
          roll: 0.0,
        },
      });
      let loadedStreak = 0;
      for (let i = 0; i < 1200; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (g.tilesLoaded === true) {
          loadedStreak++;
          if (loadedStreak > 60) break;
        } else {
          loadedStreak = 0;
        }
      }
      for (let i = 0; i < 60; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return s.canvas.toDataURL("image/png");
    },
    { view, timeIso: TIME_ISO, multiDeck },
  );
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/multideck", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  for (const [name, view] of Object.entries(VIEWS)) {
    for (const [tag, md] of [
      ["off", false],
      ["on", true],
    ]) {
      const dataUrl = await capture(page, view, md);
      const b64 = dataUrl.split(",")[1];
      const path = `Tools/visual-regression/output/multideck/${name}-${tag}.png`;
      fs.writeFileSync(path, Buffer.from(b64, "base64"));
      console.log(`[${name}:${tag}] wrote ${path}`);
    }
  }

  await browser.close();
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(
    newErrs.length
      ? `NEW errs: ${newErrs.slice(0, 4).join(" | ")}`
      : "no new console errors",
  );
})();
