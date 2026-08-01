#!/usr/bin/env node
// Captures the WebGPU globe at orbit with `globe.showGroundAtmosphere`
// toggled ON and OFF. After the Batch 56 per-fragment ground atmosphere
// fix we want to be sure:
//
//   1. With atmosphere ON: limb glow is visible, no mesh-pattern,
//      imagery is recognizable. (The path the Batch 56 fix touches.)
//   2. With atmosphere OFF: imagery renders cleanly with no drape
//      contribution. (Verifies we didn't accidentally make the drape
//      branch mandatory.)
//   3. Both modes match WebGL behavior at the same camera position.
//
// Also captures WebGL for both modes as the reference. Four PNGs:
//   - atmosphere-on-webgl.png
//   - atmosphere-on-webgpu.png
//   - atmosphere-off-webgl.png
//   - atmosphere-off-webgpu.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg, atmosphereOn) {
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

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ atmosphereOn }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.showGroundAtmosphere = atmosphereOn;
      // Camera at 18 Mm — well into the fade ramp where the per-fragment
      // drape is most visible. Looking at North America for a consistent
      // reference frame.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-100, 40, 18_000_000),
      });
      for (let i = 0; i < 800; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 80) break;
      }
    },
    { atmosphereOn },
  );
  await page.waitForTimeout(2000);

  const label = atmosphereOn ? "on" : "off";
  const out = path.join(OUT_DIR, `atmosphere-${label}-${rendererArg}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errors: errs };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-atmosphere-toggle] globe.showGroundAtmosphere ON vs OFF`);

  const results = [];
  for (const atmosphereOn of [true, false]) {
    for (const renderer of ["webgl", "webgpu"]) {
      const label = `${atmosphereOn ? "on" : "off"}-${renderer}`;
      console.log(`  ${label}`);
      const r = await capture(renderer, atmosphereOn);
      console.log(`    out: ${r.out} (${r.errors.length} errors)`);
      results.push({ label, ...r });
    }
  }

  console.log(`\nManual checks:`);
  console.log(
    `  ON:  atmospheric limb glow should be visible on both backends; no mesh-pattern.`,
  );
  console.log(
    `  OFF: clean imagery with no drape contribution; behavior should match WebGL.`,
  );
  console.log(
    `  Both backends should render the same continents in the same orientations.`,
  );
})();
