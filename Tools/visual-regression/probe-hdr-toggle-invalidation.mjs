#!/usr/bin/env node
// Q14-HDR-TOGGLE-INVALIDATION acceptance probe.
//
// Toggling `scene.highDynamicRange` mid-session flips the scene color target
// format (rgba8unorm <-> rgba16float / rg11b10ufloat). Any cached pipeline or
// render bundle still keyed to (or holding a ref to) the previous format fails
// WebGPU's color-attachment format-match validation on the next pass — the
// symptom is a burst of device errors every frame after the toggle.
//
// This probe loads the WebGPU viewer, renders a warmup burst in SDR, toggles
// HDR ON (render burst), toggles HDR OFF (render burst), toggles ON again, and
// counts GPU validation / device console errors seen in each phase. A clean
// implementation rebuilds/rekeys the affected pipelines so post-toggle frames
// emit ZERO validation errors.
//
// PASS: 0 GPU validation errors in every post-toggle phase. READ THE PNGs.
//
// Usage: node Tools/visual-regression/probe-hdr-toggle-invalidation.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Console text that indicates a real GPU/device validation failure.
const ERR_RE =
  /(validation|format|attachment|bind group|pipeline|GPUValidationError|device.*lost|invalid|colorAttachment|sampleCount|texture format)/i;

function classify(messages) {
  return messages.filter(
    (m) => (m.t === "error" || m.t === "pageerror") && ERR_RE.test(m.text),
  );
}

async function run() {
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

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  // Install a direct GPU uncapturederror listener so real validation errors
  // surface even if Dawn doesn't route them to console.error. Errors are
  // pushed into window.__gpuErrors with a monotonically increasing count.
  await page.evaluate(() => {
    window.__gpuErrors = [];
    const dev = window.viewer?.scene?.context?.device;
    if (dev && typeof dev.addEventListener === "function") {
      dev.addEventListener("uncapturederror", (ev) => {
        window.__gpuErrors.push(String(ev.error?.message ?? ev.error ?? ev));
      });
      window.__gpuErrorHooked = true;
    } else {
      window.__gpuErrorHooked = false;
    }
    window.__rendererType = window.viewer?.scene?.context?.rendererType;
  });
  const hookInfo = await page.evaluate(() => ({
    hooked: window.__gpuErrorHooked,
    renderer: window.__rendererType,
  }));
  console.log(
    `[probe-hdr-toggle-invalidation] renderer=${hookInfo.renderer} gpuErrorHook=${hookInfo.hooked}`,
  );

  // Fixed camera + a billboard + a point so multiple pipeline families are
  // live (globe surface, billboard collection, point collection) — these are
  // the caches most likely to hold a stale-format pipeline.
  await page.evaluate(async () => {
    const v = window.viewer;
    const Cartesian3 = v.camera.positionWC.constructor;
    const Color = v.scene.backgroundColor.constructor;
    v.scene.highDynamicRange = false;
    v.camera.setView({
      destination: Cartesian3.fromDegrees(-95.0, 35.0, 6000000.0),
    });
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const g = c.getContext("2d");
    g.fillStyle = "rgb(220,120,40)";
    g.fillRect(0, 0, 32, 32);
    v.entities.add({
      position: Cartesian3.fromDegrees(-95.0, 35.0, 100.0),
      billboard: { image: c.toDataURL(), scale: 2.0 },
    });
    v.entities.add({
      position: Cartesian3.fromDegrees(-90.0, 35.0, 100.0),
      point: { pixelSize: 40, color: Color.fromBytes(220, 120, 40, 255) },
    });
    // Geometry primitives (Box + Ellipsoid) drive the generic Primitive
    // pipeline path ("Primitive pipeline (cull=back)") — the cache the premise
    // names as failing on HDR toggle. PerInstanceColor (opaque) + a translucent
    // material box exercise both the color and material sub-paths.
    v.entities.add({
      position: Cartesian3.fromDegrees(-100.0, 40.0, 300000.0),
      box: {
        dimensions: new Cartesian3(400000, 400000, 400000),
        material: Color.fromBytes(220, 120, 40, 255),
      },
    });
    v.entities.add({
      position: Cartesian3.fromDegrees(-88.0, 40.0, 300000.0),
      ellipsoid: {
        radii: new Cartesian3(250000, 250000, 250000),
        material: Color.fromBytes(60, 180, 220, 200), // translucent → material path
      },
    });
  });

  const renderBurst = async (frames) => {
    await page.evaluate(async (n) => {
      const v = window.viewer;
      for (let i = 0; i < n; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, frames);
  };

  const setHdr = async (val) => {
    await page.evaluate((v) => {
      window.viewer.scene.highDynamicRange = v;
    }, val);
  };

  const phases = {};
  const mark = async (name, frames, png) => {
    const start = messages.length;
    await renderBurst(frames);
    await page.waitForTimeout(400);
    const slice = messages.slice(start);
    const consoleErrs = classify(slice).map((e) => e.text);
    const gpuErrs = await page.evaluate(() => {
      const e = window.__gpuErrors.slice();
      window.__gpuErrors.length = 0;
      return e;
    });
    phases[name] = [...consoleErrs, ...gpuErrs.map((t) => `[uncaptured] ${t}`)];
    if (png) {
      await page.screenshot({
        path: path.join(OUT_DIR, png),
        fullPage: false,
      });
    }
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Phase 0: SDR warmup (baseline — should be clean).
  await mark("warmup_sdr", 60, "probe-hdr-toggle-0-sdr.png");
  // Phase 1: toggle HDR ON.
  await setHdr(true);
  await mark("after_toggle_on", 60, "probe-hdr-toggle-1-hdr.png");
  // Phase 2: toggle HDR OFF.
  await setHdr(false);
  await mark("after_toggle_off", 60, "probe-hdr-toggle-2-sdr.png");
  // Phase 3: toggle HDR ON again (second flip stresses re-rebuild).
  await setHdr(true);
  await mark("after_toggle_on_again", 60, "probe-hdr-toggle-3-hdr.png");

  await browser.close();

  console.log(
    "\n[probe-hdr-toggle-invalidation] GPU-validation errors per phase:",
  );
  let totalPostToggle = 0;
  for (const [name, errs] of Object.entries(phases)) {
    console.log(`  ${name}: ${errs.length}`);
    errs.slice(0, 3).forEach((e) => console.log(`      ${e.slice(0, 160)}`));
    if (name !== "warmup_sdr") totalPostToggle += errs.length;
  }
  console.log(
    `\n[probe-hdr-toggle-invalidation] total post-toggle validation errors: ${totalPostToggle}`,
  );
  console.log(
    totalPostToggle === 0
      ? "[probe-hdr-toggle-invalidation] PASS (0 post-toggle validation errors)"
      : "[probe-hdr-toggle-invalidation] FAIL (toggle still invalidates pipelines)",
  );
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(totalPostToggle === 0 ? 0 : 1);
}

run();
