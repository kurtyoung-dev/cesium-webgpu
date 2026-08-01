#!/usr/bin/env node
/**
 * HDR + TAA interaction check.
 *
 * Tests four scenarios:
 *   1. Initial mount with HDR=true + TAA=true (both on from frame 1)
 *   2. HDR-first then TAA toggle on
 *   3. TAA-first then HDR toggle on
 *   4. Both on, then both off (round-trip)
 *
 * Captures GPU validation errors / warnings from the WebGPU validator
 * and screenshots each phase. Exit code 1 on any GPU validation error
 * or empty render.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

const errors = [];
const validationWarnings = [];
const failures = [];

function log(msg) {
  console.log(`[verify] ${msg}`);
}

async function captureSnapshot(page, label) {
  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/verify-hdrtaa-${label}.png`,
    buf,
  );
  return {
    bytes: buf.length,
    hasContent: buf.length > 20_000,
  };
}

async function renderFrames(page, count) {
  await page.evaluate(async (n) => {
    const v = window.viewer;
    for (let i = 0; i < n; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, count);
}

(async () => {
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

  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") {
      errors.push(txt);
      console.log(`[error] ${txt.slice(0, 250)}`);
    }
    if (
      t === "warning" &&
      (txt.includes("Attachment state") ||
        txt.includes("VALIDATION") ||
        txt.includes("validation") ||
        txt.includes("used in submit") ||
        txt.includes("must be "))
    ) {
      validationWarnings.push(txt);
      console.log(`[warn] ${txt.slice(0, 250)}`);
    }
  });
  page.on("pageerror", (e) => {
    errors.push(`pageerror: ${e.message}`);
    console.log(`[pageerror] ${e.message}`);
  });

  // ── Phase 1: initial mount with HDR=true + TAA=true ──
  log("Phase 1: loading viewer with HDR + TAA both enabled from start");
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  // Set both flags BEFORE any scripted render.
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.highDynamicRange = true;
    v.scene.taaEnabled = true;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-119.5383, 37.8651, 12000),
      orientation: { heading: 0, pitch: -0.6, roll: 0 },
    });
  });
  await renderFrames(page, 240);

  const phase1 = await captureSnapshot(page, "phase1-initial-both-on");
  log(`Phase 1 (initial both on): ${JSON.stringify(phase1)}`);
  if (!phase1.hasContent) {
    failures.push(`Phase 1: ${phase1.bytes} bytes (expected > 20KB)`);
  }

  // ── Phase 2: HDR-first, TAA toggle (we already have both on; toggle TAA off then back on) ──
  log("Phase 2: keep HDR on, toggle TAA off then back on");
  await page.evaluate(() => {
    window.viewer.scene.taaEnabled = false;
  });
  await renderFrames(page, 60);
  await page.evaluate(() => {
    window.viewer.scene.taaEnabled = true;
  });
  await renderFrames(page, 60);

  const phase2 = await captureSnapshot(page, "phase2-hdr-first-then-taa");
  log(`Phase 2 (HDR first, TAA cycle): ${JSON.stringify(phase2)}`);
  if (!phase2.hasContent) {
    failures.push(`Phase 2: ${phase2.bytes} bytes`);
  }

  // ── Phase 3: TAA-first then HDR toggle (toggle HDR off then back on, keep TAA on) ──
  log("Phase 3: keep TAA on, toggle HDR off then back on");
  await page.evaluate(() => {
    window.viewer.scene.highDynamicRange = false;
  });
  await renderFrames(page, 60);
  await page.evaluate(() => {
    window.viewer.scene.highDynamicRange = true;
  });
  await renderFrames(page, 60);

  const phase3 = await captureSnapshot(page, "phase3-taa-on-hdr-cycle");
  log(`Phase 3 (TAA on, HDR cycle): ${JSON.stringify(phase3)}`);
  if (!phase3.hasContent) {
    failures.push(`Phase 3: ${phase3.bytes} bytes`);
  }

  // ── Phase 4: both off (round-trip back to defaults) ──
  log("Phase 4: turn both off");
  await page.evaluate(() => {
    window.viewer.scene.highDynamicRange = false;
    window.viewer.scene.taaEnabled = false;
  });
  await renderFrames(page, 120);

  const phase4 = await captureSnapshot(page, "phase4-both-off");
  log(`Phase 4 (both off): ${JSON.stringify(phase4)}`);
  if (!phase4.hasContent) {
    failures.push(`Phase 4: ${phase4.bytes} bytes`);
  }

  await browser.close();

  // ── Report ──
  console.log("\n=== HDR+TAA INTERACTION REPORT ===");
  console.log(`Errors captured: ${errors.length}`);
  console.log(`Validation warnings captured: ${validationWarnings.length}`);
  console.log(`Failures: ${failures.length}`);

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 250)}`);
  }
  if (validationWarnings.length > 0) {
    console.log("\nUnique validation warnings:");
    const unique = [...new Set(validationWarnings)];
    for (const w of unique.slice(0, 10)) console.log(`  - ${w.slice(0, 300)}`);
  }
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  if (errors.length > 0 || validationWarnings.length > 0) {
    console.log("\n⚠ PASSED with warnings/errors — investigate above");
    process.exit(1);
  }

  console.log("\n✓ HDR+TAA INTERACTION CLEAN");
  process.exit(0);
})();
