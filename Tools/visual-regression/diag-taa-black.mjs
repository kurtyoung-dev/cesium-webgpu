#!/usr/bin/env node
// One-off diagnostic for Batch 244: TAA resolve runs (counter advances,
// 0 console *errors*) but the canvas goes black while TAA is on.
// @purpose One-off diagnostic capturing all console message types + per-frame TAA stats while the canvas went black with TAA enabled.
// @status INVESTIGATION
//
// Captures ALL console message types + per-frame TAA stats.
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const msgs = [];
page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on("pageerror", (e) => msgs.push(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;

  const img = document.createElement("canvas");
  img.width = 16;
  img.height = 16;
  img.getContext("2d").fillStyle = "#ff00ff";
  img.getContext("2d").fillRect(0, 0, 16, 16);
  const bb = scene.primitives.add(new C.BillboardCollection({ scene }));
  for (let i = 0; i < 10; i++) {
    bb.add({
      image: img,
      position: C.Cartesian3.fromDegrees(-0.3 + i * 0.07, 0, 120000.0),
    });
  }
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(0, 0, 2.0e6) });

  const once = () =>
    new Promise((r) => {
      const rm = scene.postRender.addEventListener(() => {
        rm();
        r();
      });
    });

  for (let i = 0; i < 15; i++) await once();

  // Push a device error scope across some TAA frames.
  const device = scene.context._device;

  scene.taaEnabled = true;
  const stats = [];
  device.pushErrorScope("validation");
  for (let i = 0; i < 12; i++) {
    await once();
    const pp = scene._alternateSceneRenderer?._postProcess;
    const taa = pp?.taaEffect;
    stats.push(
      taa
        ? {
            i,
            enabled: taa.enabled,
            ...taa.getStatistics(),
            skipNext: taa._skipNextBlend,
            projectionJitterNdc: [
              taa.projectionJitterNdcX,
              taa.projectionJitterNdcY,
            ],
            resolveJitterUv: [taa.resolveJitterUvX, taa.resolveJitterUvY],
            mvValid: taa._motionVectorsValid,
            histFmt: taa._format,
            pipelineNull: !taa._pipeline,
          }
        : { i, taa: null },
    );
  }
  const scopeErr = await device.popErrorScope();
  return {
    stats,
    scopeErr: scopeErr ? scopeErr.message.slice(0, 500) : null,
    intermediateFormat:
      scene._alternateSceneRenderer?._postProcess?._intermediateFormat,
    hasActive: scene._alternateSceneRenderer?._postProcess?.hasActiveStages,
    tonemapEnabled:
      scene._alternateSceneRenderer?._postProcess?._tonemapStage?.enabled,
    fxaaEnabled:
      scene._alternateSceneRenderer?._postProcess?._fxaaStage?.enabled,
    autoExpEnabled:
      scene._alternateSceneRenderer?._postProcess?._autoExposure?.enabled,
  };
});

console.log(JSON.stringify(out, null, 1));
console.log("--- console messages (non-log):");
msgs
  .filter((m) => !m.startsWith("[log]") && !m.startsWith("[debug]"))
  .slice(0, 40)
  .forEach((m) => console.log(m));
await browser.close();
