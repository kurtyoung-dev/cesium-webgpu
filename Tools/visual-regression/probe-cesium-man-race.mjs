#!/usr/bin/env node
// Probe-cesium-man-race — Batch 144 / Item 5 instrumentation.
// @purpose Wraps encoder methods before model load to stack-trace the CesiumMan locked-encoder race at the first offending call
// @status ACTIVE
//
// CesiumMan triggers 2 device errors at startup:
//   "Recording in [CommandEncoder "Scene Frame Command Encoder"] which
//    is locked while [RenderPassEncoder "Scene Main Render Pass"] is
//    open."
//
// The probe wraps `encoder.copyBufferToBuffer`, `copyBufferToTexture`,
// `copyTextureToBuffer`, `copyTextureToTexture`, `beginRenderPass`,
// `beginComputePass`, `clearBuffer`, `resolveQuerySet` BEFORE the
// model loads, so the FIRST offending call captures a JS stack trace
// pointing at the caller. Then prints the trace so we can localize
// the bug source.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
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
    viewport: { width: 800, height: 600 },
  });
  const consoleMessages = [];
  page.on("console", (m) =>
    consoleMessages.push({ t: m.type(), text: m.text() }),
  );
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Install BEFORE loading the model.
  await page.evaluate(() => {
    const ctx = window.viewer?.scene?.context;
    const dev = ctx?._device;
    window.__probeErrors = [];
    window.__suspectCalls = [];
    window.__encoderCount = 0;
    window.__methodCallCounts = {};
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({
        text: ev?.error?.message ?? "",
        when: performance.now(),
        framecount: window.__frame ?? -1,
      });
    };

    // Wrap createCommandEncoder so we can intercept future encoder
    // method calls.
    const originalCreate = dev.createCommandEncoder.bind(dev);
    dev.createCommandEncoder = function (...args) {
      window.__encoderCount++;
      const encoder = originalCreate(...args);
      const passes = [];
      const wrap = (methodName) => {
        const original = encoder[methodName].bind(encoder);
        encoder[methodName] = function (...mArgs) {
          window.__methodCallCounts[methodName] =
            (window.__methodCallCounts[methodName] ?? 0) + 1;
          // Log if a pass is currently open — applies to ALL wrapped
          // methods including beginRenderPass (a "begin pass while
          // pass is open" is exactly the bug we're hunting).
          if (passes.length > 0 && window.__suspectCalls.length < 20) {
            const openPassLabel =
              passes[passes.length - 1]?.label ?? "(unlabeled)";
            const stack = new Error().stack;
            window.__suspectCalls.push({
              method: methodName,
              openPassLabel,
              attemptedPassLabel:
                methodName === "beginRenderPass"
                  ? (mArgs[0]?.label ?? "(unlabeled)")
                  : null,
              encoderLabel: args[0]?.label ?? "(unlabeled)",
              stack: stack ? stack.slice(0, 2500) : "(no stack)",
              frame: window.__frame ?? -1,
              when: performance.now(),
            });
          }
          // beginRenderPass returns a RenderPassEncoder; track open
          // passes so we know whether subsequent calls happen during one.
          if (methodName === "beginRenderPass") {
            const pass = original(...mArgs);
            passes.push(pass);
            const origEnd = pass.end.bind(pass);
            pass.end = function () {
              const idx = passes.indexOf(pass);
              if (idx >= 0) passes.splice(idx, 1);
              return origEnd();
            };
            return pass;
          }
          return original(...mArgs);
        };
      };
      wrap("copyBufferToBuffer");
      wrap("copyBufferToTexture");
      wrap("copyTextureToBuffer");
      wrap("copyTextureToTexture");
      wrap("clearBuffer");
      wrap("resolveQuerySet");
      wrap("beginRenderPass");
      wrap("beginComputePass");
      return encoder;
    };
  });

  // Now load CesiumMan and render for enough frames to capture the
  // startup race.
  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    window.__frame = 0;
    v.entities.add({
      position: C.Cartesian3.fromDegrees(-79.9959, 40.4406, 800),
      model: {
        uri: "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
        scale: 5.0,
        minimumPixelSize: 256,
      },
    });
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-79.9959, 40.4406 - 0.003, 900),
      orientation: { pitch: C.Math.toRadians(-15) },
    });
    for (let i = 0; i < 800; i++) {
      window.__frame = i;
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      errors: window.__probeErrors,
      suspectCalls: window.__suspectCalls,
      encoderCount: window.__encoderCount,
      methodCallCounts: window.__methodCallCounts,
    };
  });

  await browser.close();

  console.log(
    `[probe-cesium-man-race] encoders created: ${result.encoderCount}, method calls: ${JSON.stringify(result.methodCallCounts)}`,
  );
  console.log(`[probe-cesium-man-race] errors: ${result.errors.length}`);
  result.errors
    .slice(0, 5)
    .forEach((e) =>
      console.log(
        `  frame=${e.frame} t=${e.when.toFixed(1)}ms: ${e.text.slice(0, 200)}`,
      ),
    );

  console.log(
    `\n[probe-cesium-man-race] suspect calls (encoder ops during open pass): ${result.suspectCalls.length}`,
  );
  result.suspectCalls.slice(0, 10).forEach((s, i) => {
    console.log(`\n--- suspect #${i} ---`);
    console.log(`  method:    ${s.method}`);
    console.log(`  open pass: "${s.openPassLabel}"`);
    console.log(`  frame=${s.frame} t=${s.when.toFixed(1)}ms`);
    console.log(`  stack (first 30 lines):`);
    s.stack
      .split("\n")
      .slice(0, 30)
      .forEach((line) => console.log(`    ${line}`));
  });
})();
