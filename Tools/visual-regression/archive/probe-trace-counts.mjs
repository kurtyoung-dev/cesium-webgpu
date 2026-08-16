// Read instrumented draw counters added in WebGPUSceneRenderer.ts +
// WebGPUDrawCommand.ts. Initializes window.__dbgDrawCounts BEFORE the
// page scripts run via addInitScript.
// @purpose Reads window.__dbgDrawCounts draw counters described as instrumented into WebGPUSceneRenderer.ts + WebGPUDrawCommand.ts.
// @status INVESTIGATION

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  globalThis.__dbgDrawCounts = {};
  globalThis.__dbgGPUValidationErrors = [];
  globalThis.__dbgRenderPasses = [];
  globalThis.__dbgViewToTag = new WeakMap();
  globalThis.__dbgNextViewTag = 1;
  // Patch GPUCommandEncoder.beginRenderPass to log descriptor + draw counts.
  if (typeof window.GPUCommandEncoder !== "undefined") {
    const proto = window.GPUCommandEncoder.prototype;
    const origBegin = proto.beginRenderPass;
    if (typeof origBegin === "function") {
      proto.beginRenderPass = function (desc) {
        const pass = origBegin.call(this, desc);
        // Tag each color attachment view with a unique ID so we can
        // see if scene-FB passes target different texture views.
        const tagView = (v) => {
          if (!v) return null;
          let t = globalThis.__dbgViewToTag.get(v);
          if (!t) {
            t = globalThis.__dbgNextViewTag++;
            globalThis.__dbgViewToTag.set(v, t);
          }
          return t;
        };
        const colorViews = (desc?.colorAttachments ?? []).map((a) =>
          tagView(a?.view),
        );
        const info = {
          label: desc?.label ?? null,
          colorAttachmentCount: desc?.colorAttachments?.length ?? 0,
          firstColorAttachment: desc?.colorAttachments?.[0]
            ? {
                hasView: !!desc.colorAttachments[0].view,
                loadOp: desc.colorAttachments[0].loadOp,
                storeOp: desc.colorAttachments[0].storeOp,
              }
            : null,
          colorViews,
          hasDepthStencil: !!desc?.depthStencilAttachment,
          drawsInPass: 0,
        };
        globalThis.__dbgRenderPasses.push(info);
        // Wrap drawIndexed/draw to count per-pass.
        const passProto = pass.constructor.prototype;
        if (!passProto.__dbgInstrumented) {
          const wrapDraw = (name) => {
            const orig = passProto[name];
            if (typeof orig === "function") {
              passProto[name] = function (...args) {
                if (this.__dbgInfo) this.__dbgInfo.drawsInPass++;
                return orig.apply(this, args);
              };
            }
          };
          wrapDraw("draw");
          wrapDraw("drawIndexed");
          wrapDraw("drawIndirect");
          wrapDraw("drawIndexedIndirect");
          wrapDraw("executeBundles");
          passProto.__dbgInstrumented = true;
        }
        pass.__dbgInfo = info;
        return pass;
      };
    }
  }
  // Hook GPUDevice.requestDevice to install uncapturederror listener
  // so we see validation/internal errors that are normally silent.
  if (typeof navigator !== "undefined" && navigator.gpu) {
    const origRequest = navigator.gpu.requestAdapter;
    navigator.gpu.requestAdapter = async function (...args) {
      const adapter = await origRequest.apply(this, args);
      if (adapter) {
        const origReq = adapter.requestDevice;
        adapter.requestDevice = async function (...rargs) {
          const dev = await origReq.apply(this, rargs);
          if (dev) {
            dev.addEventListener("uncapturederror", (ev) => {
              const e = ev && ev.error;
              globalThis.__dbgGPUValidationErrors.push({
                type: e?.constructor?.name ?? "unknown",
                msg: e?.message ?? String(e),
              });
            });
          }
          return dev;
        };
      }
      return adapter;
    };
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      function tick() {
        if (n++ > 180) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(() => {
  const passes = globalThis.__dbgRenderPasses ?? [];
  // Just the last 30 passes — that's about 1 frame's worth in
  // sequence.
  const recent = passes.slice(-30).map((p) => ({
    label: p.label,
    loadOp: p.firstColorAttachment?.loadOp,
    draws: p.drawsInPass,
  }));
  // Look for "Scene Framebuffer Render Pass" entries with 0 draws.
  const sceneFBOpens = passes.filter(
    (p) => p.label === "Scene Framebuffer Render Pass",
  );
  const sceneFBLoadOps = sceneFBOpens.reduce((acc, p) => {
    const k = p.firstColorAttachment?.loadOp || "?";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const sceneFBNoDraws = sceneFBOpens.filter((p) => p.drawsInPass === 0).length;
  // Sequence of scene FB passes — show INDEX within passes array.
  const sceneFBSeq = passes
    .map((p, i) => ({
      i,
      loadOp: p.firstColorAttachment?.loadOp,
      draws: p.drawsInPass,
    }))
    .filter((e, _, all) => {
      const p = passes[e.i];
      return p?.label === "Scene Framebuffer Render Pass";
    });
  // Find clear-loadOp scene FB passes and report their relative
  // position (e.g., "1st in sequence", "last in sequence")
  const clearIndices = sceneFBSeq
    .map((e, idx) => ({ ...e, idx }))
    .filter((e) => e.loadOp === "clear");
  // Show the first 5 clears AND the last 5 clears.
  const firstClears = clearIndices.slice(0, 5);
  const lastClears = clearIndices.slice(-5);
  const sceneFBWithDraws = passes
    .map((p, i) => ({ p, i }))
    .filter(
      (e) =>
        e.p.label === "Scene Framebuffer Render Pass" && e.p.drawsInPass > 0,
    );
  const firstWithDrawsIdx = sceneFBWithDraws[0]?.i ?? -1;
  const aroundFirst =
    firstWithDrawsIdx >= 0
      ? passes
          .slice(Math.max(0, firstWithDrawsIdx - 5), firstWithDrawsIdx + 15)
          .map((p, idx) => ({
            ord: idx + Math.max(0, firstWithDrawsIdx - 5),
            label: p.label,
            loadOp: p.firstColorAttachment?.loadOp,
            draws: p.drawsInPass,
          }))
      : [];
  return {
    counts: globalThis.__dbgDrawCounts,
    frameNumber: window.viewer?.scene?._frameState?.frameNumber ?? null,
    gpuErrors: (globalThis.__dbgGPUValidationErrors ?? []).slice(0, 20),
    gpuErrorCount: (globalThis.__dbgGPUValidationErrors ?? []).length,
    sceneFBLoadOps,
    sceneFBOpensTotal: sceneFBOpens.length,
    sceneFBOpensWithZeroDraws: sceneFBNoDraws,
    sceneFBWithDrawsCount: sceneFBWithDraws.length,
    sceneFBSeqLen: sceneFBSeq.length,
    firstClears,
    lastClears,
    // For one stable mid-test frame, dump every scene-FB pass + the
    // post-process passes around it.
    midSequence: passes.slice(400, 440).map((p, idx) => ({
      ord: 400 + idx,
      label: p.label,
      loadOp: p.firstColorAttachment?.loadOp,
      draws: p.drawsInPass,
      views: p.colorViews,
    })),
    // Distinct color views used per pass label.
    viewDistByLabel: (() => {
      const dist = {};
      for (const p of passes) {
        const k = p.label || "(unlabeled)";
        const tag = (p.colorViews && p.colorViews[0]) ?? "?";
        dist[k] = dist[k] || {};
        dist[k][tag] = (dist[k][tag] || 0) + 1;
      }
      return dist;
    })(),
    aroundFirstSceneFBWithDraws: aroundFirst,
    last30Passes: recent,
  };
});
console.log(JSON.stringify(result, null, 2));

await browser.close();
