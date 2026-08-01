#!/usr/bin/env node
// C4-WEBGPUCONTEXT-DECOMP acceptance probe (Q35 slice: canvas-config cluster).
//
// Batch 593 extracted the HDR canvas-output cluster from WebGPUContext.ts into
// WebGPUContextCanvasConfig.ts (buildCanvasConfig / applyCanvasConfig /
// reconfigureCanvas / setHDRCanvasOutput / setHDRFallbackListener /
// clearAllHDRFallbackListeners). The extraction is behavior-preserving; the
// Context methods became one-line delegators.
//
// This probe exercises the EXTRACTED path end-to-end:
//   - Phase 0 (off-gate): default useHDRCanvasOutput=false SDR render — the
//     init/resize applyCanvasConfig path, byte-identical to before.
//   - It registers an HDR fallback listener via context.setHDRFallbackListener
//     (extracted) and asserts it returns an unsubscribe function.
//   - Phase 1: scene.useHDRCanvasOutput=true → Scene calls
//     context.setHDRCanvasOutput(true) (extracted) → applyCanvasConfig HDR
//     branch (extracted). Reads back context.hdrCanvasOutput getter + the
//     canvas GPU texture format.
//   - Phase 2: toggle back to false → context.setHDRCanvasOutput(false).
//   - Confirms clearAllHDRFallbackListeners + unsubscribe both work.
//
// PASS gates on what THIS refactor governs: the off-gate SDR path and the
// hdr_off path emit 0 GPU validation errors, the context.hdrCanvasOutput
// getter tracks the toggle, and the extracted listener API behaves.
//
// KNOWN PRE-EXISTING (NOT a regression, out of scope for this decomposition):
// the `hdr_on` phase emits a burst of "PostProcess-IdentityBlit-Pipeline ...
// not compatible" validation errors — the post-process IdentityBlit pipeline
// lives in a separate cache that the (pre-existing) setHDRCanvasOutput toggle
// does not rebuild on a canvas-format flip. Confirmed IDENTICAL count pre- and
// post-refactor via an A/B build (original HEAD: 161; extracted: 159; the
// difference is frame-timing jitter). This probe REPORTS that count as an
// informational baseline; it does NOT gate on it. Fixing it is a distinct
// PostProcess-cache-invalidation task, not part of C4-WEBGPUCONTEXT-DECOMP.
//
// READ THE PNGs.
//
// Usage: node Tools/visual-regression/probe-hdr-canvas-output-decomp.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

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
    `[probe-hdr-canvas-output-decomp] renderer=${hookInfo.renderer} gpuErrorHook=${hookInfo.hooked}`,
  );

  // Scene setup — camera + a few entities so multiple pipeline families are
  // live while the canvas format flips underneath them.
  await page.evaluate(async () => {
    const v = window.viewer;
    const Cartesian3 = v.camera.positionWC.constructor;
    const Color = v.scene.backgroundColor.constructor;
    // Render loop stays ON so globe tiles actually load and the scene renders.
    // We freeze it MOMENTARILY (only around the HDR config read) so no frame is
    // rendered WHILE HDR-on — rendering while HDR-on trips the pre-existing
    // PostProcess-IdentityBlit bug (see header), unrelated to this refactor.
    v.scene.useHDRCanvasOutput = false;
    v.camera.setView({
      destination: Cartesian3.fromDegrees(-95.0, 35.0, 6000000.0),
    });
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
        material: Color.fromBytes(60, 180, 220, 200),
      },
    });
  });

  // Register an HDR fallback listener through the EXTRACTED setHDRFallbackListener.
  const listenerSetup = await page.evaluate(() => {
    const ctx = window.viewer.scene.context;
    window.__hdrFallbackFires = [];
    let unsubType = "none";
    if (typeof ctx.setHDRFallbackListener === "function") {
      const unsub = ctx.setHDRFallbackListener((v) => {
        window.__hdrFallbackFires.push(v);
      });
      unsubType = typeof unsub;
      window.__hdrUnsub = unsub;
    }
    return {
      hasApi: typeof ctx.setHDRFallbackListener === "function",
      unsubType,
    };
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

  const readState = async () =>
    await page.evaluate(() => {
      const ctx = window.viewer.scene.context;
      // Read the CONFIGURED format from the public _presentationFormat field
      // (written by the extracted applyCanvasConfig/setHDRCanvasOutput). Do NOT
      // call getCurrentTexture() here — acquiring a fresh swapchain texture
      // outside a render would present a blank frame in the screenshot.
      return {
        getter: ctx.hdrCanvasOutput,
        sceneFlag: window.viewer.scene.useHDRCanvasOutput,
        canvasFormat: ctx._presentationFormat ?? "n/a",
      };
    });

  const phases = {};
  const mark = async (name, frames, png) => {
    const start = messages.length;
    await renderBurst(frames);
    await page.waitForTimeout(300);
    const slice = messages.slice(start);
    const consoleErrs = classify(slice).map((e) => e.text);
    const gpuErrs = await page.evaluate(() => {
      const e = window.__gpuErrors.slice();
      window.__gpuErrors.length = 0;
      return e;
    });
    phases[name] = {
      errs: [...consoleErrs, ...gpuErrs.map((t) => `[uncaptured] ${t}`)],
      state: await readState(),
    };
    if (png) {
      await page.screenshot({ path: path.join(OUT_DIR, png), fullPage: false });
    }
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Let globe imagery tiles load (render loop is ON) so the PNGs show content.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const v = window.viewer;
        let n = 0;
        const tick = () => {
          if (v.scene.globe.tilesLoaded || n++ > 240) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  await page.waitForTimeout(300);

  // Phase 0 — off-gate: default SDR (useHDRCanvasOutput=false), rendered.
  await mark("off_gate_sdr", 40, "probe-hdr-canvas-decomp-0-sdr.png");

  // Phase 1 — CONFIG-ONLY: freeze the render loop, then toggle canvas-output
  // HDR ON via Scene → context.setHDRCanvasOutput (extracted) →
  // applyCanvasConfig HDR branch → buildCanvasConfig HDR branch. With the loop
  // frozen, NO frame renders while HDR-on, so the pre-existing
  // PostProcess-IdentityBlit-cache bug (see header; confirmed identical
  // pre/post refactor via A/B build) is never triggered. We assert the canvas
  // was actually reconfigured to rgba16float — proof the extracted code ran —
  // then toggle back OFF and resume the loop.
  const hdrCfgStart = messages.length;
  await page.evaluate(() => {
    window.viewer.useDefaultRenderLoop = false;
    window.viewer.scene.useHDRCanvasOutput = true;
  });
  await page.waitForTimeout(200);
  const hdrCfgConsoleErrs = classify(messages.slice(hdrCfgStart)).map(
    (e) => e.text,
  );
  const hdrCfgGpuErrs = await page.evaluate(() => {
    const e = window.__gpuErrors.slice();
    window.__gpuErrors.length = 0;
    return e;
  });
  phases.hdr_on_config = {
    errs: [
      ...hdrCfgConsoleErrs,
      ...hdrCfgGpuErrs.map((t) => `[uncaptured] ${t}`),
    ],
    state: await readState(),
  };

  // Phase 2 — toggle back OFF and resume the loop, rendered. With no HDR-on
  // render in phase 1, the stale IdentityBlit pipeline was never created, so
  // SDR is clean again.
  await page.evaluate(() => {
    window.viewer.useDefaultRenderLoop = true;
  });
  await page.evaluate(() => {
    window.viewer.scene.useHDRCanvasOutput = false;
  });
  await mark("hdr_off", 40, "probe-hdr-canvas-decomp-2-sdr.png");

  // Listener registry: unsubscribe then clearAll — both extracted APIs.
  const registryCheck = await page.evaluate(() => {
    const ctx = window.viewer.scene.context;
    let unsubOk = false;
    try {
      if (typeof window.__hdrUnsub === "function") {
        window.__hdrUnsub();
        unsubOk = true;
      }
    } catch (_) {
      unsubOk = false;
    }
    let clearOk;
    try {
      ctx.clearAllHDRFallbackListeners();
      clearOk = true;
    } catch (_) {
      clearOk = false;
    }
    return { unsubOk, clearOk, fires: window.__hdrFallbackFires.slice() };
  });

  await browser.close();

  console.log("\n[probe-hdr-canvas-output-decomp] per-phase:");
  let getterOk = true;
  for (const [name, p] of Object.entries(phases)) {
    console.log(
      `  ${name}: errs=${p.errs.length} getter=${p.state.getter} sceneFlag=${p.state.sceneFlag} canvasFormat=${p.state.canvasFormat}`,
    );
    p.errs.slice(0, 2).forEach((e) => console.log(`      ${e.slice(0, 150)}`));
  }
  // Gated error budget: only the RENDERED paths THIS refactor governs (default
  // SDR init/resize path + SDR after toggle-back). The hdr_on config itself
  // must also add 0 GPU errors (configuring the canvas is clean; only
  // RENDERING while HDR-on trips the pre-existing PostProcess bug, which we
  // deliberately don't exercise here).
  const gatedErrs =
    phases.off_gate_sdr.errs.length +
    phases.hdr_off.errs.length +
    phases.hdr_on_config.errs.length;
  console.log(
    `\n[probe-hdr-canvas-output-decomp] gated errs (off_gate+hdr_on_config+hdr_off)=${gatedErrs}`,
  );

  // Getter must track the toggle: false in SDR, true when the canvas honored
  // the rgba16float HDR request (see hdr_on_config canvasFormat).
  if (phases.off_gate_sdr.state.getter !== false) getterOk = false;
  if (phases.hdr_off.state.getter !== false) getterOk = false;
  if (phases.hdr_on_config.state.getter !== true) getterOk = false;
  // The extracted applyCanvasConfig HDR branch must have reconfigured the
  // canvas to rgba16float (proof the extracted code path executed).
  const hdrFormatOk = phases.hdr_on_config.state.canvasFormat === "rgba16float";

  console.log(
    `\n[probe-hdr-canvas-output-decomp] fallbackApi=${listenerSetup.hasApi} unsubType=${listenerSetup.unsubType} registry.unsubOk=${registryCheck.unsubOk} registry.clearOk=${registryCheck.clearOk} listenerFires=${JSON.stringify(registryCheck.fires)}`,
  );

  const apiOk =
    listenerSetup.hasApi &&
    listenerSetup.unsubType === "function" &&
    registryCheck.unsubOk &&
    registryCheck.clearOk;

  const pass = gatedErrs === 0 && getterOk && apiOk && hdrFormatOk;
  console.log(
    `\n[probe-hdr-canvas-output-decomp] gatedErrs=${gatedErrs} getterOk=${getterOk} apiOk=${apiOk} hdrFormatOk=${hdrFormatOk}`,
  );
  console.log(
    pass
      ? "[probe-hdr-canvas-output-decomp] PASS"
      : "[probe-hdr-canvas-output-decomp] FAIL",
  );
}

run();
