#!/usr/bin/env node
/**
 * COLD-OPTICS-HQ (Batch 442) PARITY capture. Renders the cold-optics frame
 * with the effect ENABLED at its normal trigger and `coldOpticsAdvanced` OFF
 * (the legacy 22 halo + sun-dogs), at a FIXED clock + camera, and writes a
 * single PNG. Run it against the Batch-442 build and against a stashed `main`
 * build; the two PNGs must be byte-identical (the advanced flag's only effect
 * when OFF is to write 0 instead of 1 into an unread uniform slot).
 * @purpose Stash-based parity capture: legacy cold-optics frame must be byte-identical between the B442 build and a stashed main build.
 * @status INVESTIGATION
 *
 * Usage: PARITY_OUT=<name> PROBE_BASE=http://localhost:8080 \
 *        node Tools/visual-regression/probe-cold-optics-parity.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import crypto from "crypto";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
const OUT = "Tools/visual-regression/output";
const NAME = process.env.PARITY_OUT || "cold-optics-parity";

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.viewer && window.viewer.scene),
    null,
    {
      timeout: 60000,
    },
  );
  await page.waitForTimeout(2000);

  // FIXED clock (sun ~28 up at 40N/10E on 2026-06-21) + FIXED camera.
  await page.evaluate(async () => {
    const C = (window.Cesium =
      window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
    const v = window.viewer;
    const s = v.scene;
    s.requestRenderMode = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    if (s.sun) s.sun.show = true;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T16:12:00Z");
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
  });
  await page.waitForTimeout(1500);

  await page.evaluate(async () => {
    const C = window.Cesium;
    const v = window.viewer;
    const s = v.scene;
    const camPos = C.Cartesian3.fromDegrees(10.0, 40.0, 2000.0);
    const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
    const sunDir = C.Cartesian3.normalize(
      s.context.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    const sunUpDot = C.Cartesian3.dot(sunDir, up);
    const horiz = C.Cartesian3.subtract(
      sunDir,
      C.Cartesian3.multiplyByScalar(up, sunUpDot, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(horiz, horiz);
    const aimElevRad = C.Math.toRadians(
      Math.max(2.0, C.Math.toDegrees(Math.asin(Math.min(1, sunUpDot)))) + 18.0,
    );
    const dir = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(
        horiz,
        Math.cos(aimElevRad),
        new C.Cartesian3(),
      ),
      C.Cartesian3.multiplyByScalar(
        up,
        Math.sin(aimElevRad),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(dir, dir);
    v.camera.setView({
      destination: camPos,
      orientation: { direction: dir, up },
    });
    s.camera.frustum.fov = C.Math.toRadians(100.0);
    // Cold optics ENABLED, advanced OFF — the legacy frame.
    s.coldOpticsEnabled = true;
    s.coldOpticsIntensity = 1.0;
    s.coldOpticsAdvanced = false;
  });

  await page
    .waitForFunction(
      () => window.viewer.scene.globe.tilesLoaded === true,
      null,
      {
        timeout: 20000,
      },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);

  const canvas = await page.$(".cesium-widget canvas");
  const file = `${OUT}/${NAME}.png`;
  await canvas.screenshot({ path: file });
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(`[parity] wrote ${file}`);
  console.log(`[parity] sha256 ${hash}`);
  console.log(`[parity] bytes ${buf.length}`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
