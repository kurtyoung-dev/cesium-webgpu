#!/usr/bin/env node
// Smoke-test the three new WebGPU Sandcastles added in Batch 91.
// @purpose Smoke test of the three Batch-91 WebGPU demos in the legacy Sandcastle gallery: load, finishedLoading, screenshot, console errors.
// @status INVESTIGATION
//
// Loads each demo, waits for `Sandcastle.finishedLoading()`, captures
// a screenshot, and reports any console errors.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const DEMOS = [
  "WebGPU Dual-Light Atmosphere",
  "WebGPU Custom Scene Light Color",
  "WebGPU Deferred Lighting",
];

async function capture(demoName) {
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
    viewport: { width: 1280, height: 720 },
  });

  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/Sandcastle/gallery/${encodeURIComponent(demoName)}.html`;
  await page.goto(url, { waitUntil: "networkidle" });

  // Wait for Sandcastle's loading overlay to disappear
  try {
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".sandcastle-loading")
          ?.classList.contains("sandcastle-loading") ||
        document.querySelector(".sandcastle-loaded"),
      { timeout: 15000 },
    );
  } catch (_e) {
    // even if the loading class didn't flip cleanly, let's still grab
    // a screenshot to inspect.
  }
  // Settle a bit longer for tiles + the first frame
  await page.waitForTimeout(2500);

  const out = path.join(
    OUT_DIR,
    `sandcastle-${demoName.replace(/[^A-Za-z0-9]+/g, "-")}.png`,
  );
  await page.screenshot({ path: out });

  await browser.close();

  const errors = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errorCount: errors.length, errors: errors.slice(0, 3) };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-new-sandcastles] smoke-testing 3 new demos");
  let totalErrors = 0;
  for (const demo of DEMOS) {
    console.log(`\n  ${demo}`);
    const { out, errorCount, errors } = await capture(demo);
    console.log(`    screenshot: ${out}`);
    console.log(`    errors: ${errorCount}`);
    if (errors.length) {
      errors.forEach((e) =>
        console.log(`      ${e.t}: ${e.text.slice(0, 200)}`),
      );
    }
    totalErrors += errorCount;
  }
  console.log(
    `\n[probe-new-sandcastles] total errors across 3 demos: ${totalErrors}`,
  );
  process.exit(totalErrors === 0 ? 0 : 1);
})();
