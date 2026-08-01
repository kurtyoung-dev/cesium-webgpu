// C10-07 premise + mechanism probe: async model pipeline compile.
//
// Wraps GPUDevice.prototype.createRenderPipeline / createRenderPipelineAsync
// BEFORE any device exists, then boots the WebGPU viewer with a glTF model and
// records, per pipeline, whether it was compiled synchronously (blocking the
// main thread) or asynchronously, plus the synchronous wall-time (the stall).
//
// PRE  (sync model cache):  Model PBR color pipelines appear under `sync`.
// POST (async model cache): Model PBR color pipelines appear under `async`,
//                           `sync` count for "Model PBR" is 0, and the model
//                           still renders (non-black) once warm.
//
// Also dumps the central render-pipeline-cache getStats() after boot so the
// deterministic-boot-prewarm (Part 2) can be observed as `created` (compiled
// ahead) vs first-compiled-in-draw.
//
// Usage: node Tools/visual-regression/probe-c10-07-async-model-pipelines.mjs
//   PROBE_BASE (default http://localhost:8080)
//   RENDERER   (default webgpu)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.RENDERER || "webgpu";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

const initScript = () => {
  const stats = {
    sync: [], // { label, ms }
    async: [], // { label, ms }
  };
  window.__pipeStats = stats;
  const proto = GPUDevice.prototype;
  const origSync = proto.createRenderPipeline;
  proto.createRenderPipeline = function (desc) {
    const t0 = performance.now();
    const p = origSync.call(this, desc);
    const ms = performance.now() - t0;
    stats.sync.push({ label: (desc && desc.label) || "(unlabeled)", ms });
    return p;
  };
  const origAsync = proto.createRenderPipelineAsync;
  if (origAsync) {
    proto.createRenderPipelineAsync = function (desc) {
      const t0 = performance.now();
      const pr = origAsync.call(this, desc);
      pr.then(
        () =>
          stats.async.push({
            label: (desc && desc.label) || "(unlabeled)",
            ms: performance.now() - t0,
          }),
        () => {},
      );
      return pr;
    };
  }
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const failures = [];
const notes = [];

try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.addInitScript(initScript);

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}&offline=true`,
    {
      waitUntil: "networkidle",
      timeout: 60000,
    },
  );
  await page.waitForFunction(() => !!window.viewer?.scene, { timeout: 30000 });

  const result = await page.evaluate(
    async ({ modelUrl }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4.0,
      });
      scene.primitives.add(model);

      // Snapshot the pipeline stats at the exact moment the model is `ready`
      // (geometry/textures uploaded) but BEFORE we drive extra frames — this is
      // the window where the first-model-draw pipeline compile happens.
      let framesToReady = 0;
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        framesToReady++;
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(0.6, -0.3, model.boundingSphere.radius * 3.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      // Drive frames until the model renders (the async color pipeline lands)
      // or a wall-clock deadline. The 215 KB ModelPBRComplete monolith's async
      // compile can take 100s of ms in DXC — the model is correctly SKIPPED
      // (invisible, never wrong) while it cooks, matching the globe's
      // resolveGlobePipelineEntry. This measures how many frames the warmup
      // skip lasts + confirms no half-compiled/wrong draw appears.
      const measureNonBlack = () => {
        const gl = document.createElement("canvas");
        gl.width = scene.canvas.width;
        gl.height = scene.canvas.height;
        const ctx2d = gl.getContext("2d");
        ctx2d.drawImage(scene.canvas, 0, 0);
        const w = gl.width;
        const h = gl.height;
        const data = ctx2d.getImageData(0, 0, w, h).data;
        let nb = 0;
        for (let p = 0; p < data.length; p += 4) {
          if (data[p] > 8 || data[p + 1] > 8 || data[p + 2] > 8) nb++;
        }
        return nb / (w * h);
      };
      // Main-thread responsiveness during the async compile: a lightweight
      // loop (NO per-frame readback) measuring the max gap between successive
      // rAF callbacks. If async truly moved the ~2s DXC compile off the main
      // thread, these gaps stay small (frames keep ticking); a sync first-draw
      // stall would show one ~compile-duration gap. Run BEFORE the readback
      // loop so readback cost doesn't pollute the gap measurement.
      let maxFrameGapMs = 0;
      {
        let prev = performance.now();
        const t0 = prev;
        while (performance.now() - t0 < 2500) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          maxFrameGapMs = Math.max(maxFrameGapMs, now - prev);
          prev = now;
        }
      }

      // Capture the first few warmup frames to confirm nothing wrong draws
      // (each should be black-until-ready, then the model — never magenta/half).
      const warmupSamples = [];
      let firstDrawFrame = -1;
      let firstDrawMs = -1;
      let nonBlackFrac = 0;
      const loopStart = performance.now();
      const deadline = loopStart + 8000;
      let frame = 0;
      while (performance.now() < deadline) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        const nb = measureNonBlack();
        if (frame < 6) warmupSamples.push(Number(nb.toFixed(4)));
        if (firstDrawFrame < 0 && nb > 0.01) {
          firstDrawFrame = frame;
          firstDrawMs = performance.now() - loopStart;
        }
        nonBlackFrac = nb;
        frame++;
        if (nb > 0.01 && frame > firstDrawFrame + 3) break;
      }

      const ctx = scene.context;
      const cache = ctx.webgpuPipelineCache;
      const cacheStats = cache && cache.getStats ? cache.getStats() : null;
      // C10-07 Part 2 — deterministic-boot prewarm counter (set by the
      // resources-ready hook in WebGPUSceneRendererEnsureResources).
      const deterministicPrewarmCount = ctx._deterministicPrewarmCount ?? null;

      return {
        ready: !!model.ready,
        framesToReady,
        nonBlackFrac,
        firstDrawFrame,
        firstDrawMs,
        maxFrameGapMs,
        warmupSamples,
        pipe: window.__pipeStats,
        cacheStats,
        deterministicPrewarmCount,
      };
    },
    { modelUrl: MODEL },
  );

  const modelSync = result.pipe.sync.filter((e) => /Model PBR/i.test(e.label));
  const modelAsync = result.pipe.async.filter((e) =>
    /Model PBR/i.test(e.label),
  );
  const modelColorSync = modelSync.filter(
    (e) => /alpha=/.test(e.label) && !/ERROR/.test(e.label),
  );
  const maxSyncMs = result.pipe.sync.reduce((m, e) => Math.max(m, e.ms), 0);
  const modelSyncMs = modelSync.reduce((s, e) => s + e.ms, 0);

  notes.push(
    `framesToReady=${result.framesToReady}, nonBlackFrac=${result.nonBlackFrac.toFixed(4)}, firstDrawFrame=${result.firstDrawFrame} firstDrawMs=${result.firstDrawMs?.toFixed?.(1)}`,
  );
  notes.push(
    `max main-thread frame gap during compile: ${result.maxFrameGapMs?.toFixed?.(1)}ms (async keeps main thread responsive if small)`,
  );
  notes.push(
    `warmup nonBlack per early frame: [${result.warmupSamples.join(", ")}]`,
  );
  notes.push(
    `total sync createRenderPipeline=${result.pipe.sync.length}, total async=${result.pipe.async.length}`,
  );
  notes.push(
    `Model PBR async compile wall-times(ms): [${modelAsync.map((e) => e.ms.toFixed(1)).join(", ")}]`,
  );
  notes.push(
    `Model PBR sync=${modelSync.length} (color=${modelColorSync.length}), Model PBR async=${modelAsync.length}`,
  );
  notes.push(
    `Model PBR sync total wall-time=${modelSyncMs.toFixed(2)}ms; max single sync compile=${maxSyncMs.toFixed(2)}ms`,
  );
  notes.push(`central cache stats: ${JSON.stringify(result.cacheStats)}`);
  notes.push(
    `deterministic prewarm counter: ${result.deterministicPrewarmCount}`,
  );
  notes.push(
    `sync labels: ${result.pipe.sync
      .map((e) => e.label)
      .slice(0, 40)
      .join(" | ")}`,
  );
  notes.push(
    `async labels: ${result.pipe.async
      .map((e) => e.label)
      .slice(0, 40)
      .join(" | ")}`,
  );

  // Correctness: model must render once warm.
  if (result.nonBlackFrac < 0.01) {
    failures.push(
      `model did not render (nonBlackFrac=${result.nonBlackFrac.toFixed(4)})`,
    );
  }
  // Part 2: the deterministic-boot prewarm hook must have fired at the
  // resources-ready step (null = field never set → hook did not run).
  if (RENDERER === "webgpu" && !(result.deterministicPrewarmCount > 0)) {
    failures.push(
      `deterministic-prewarm hook did not fire (counter=${result.deterministicPrewarmCount})`,
    );
  }
  if (errors.length > 0) {
    failures.push(`device/console errors: ${errors.slice(0, 5).join(" | ")}`);
  }

  console.log("=== C10-07 async-model-pipeline probe ===");
  for (const n of notes) console.log("  note:", n);
  console.log(failures.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  for (const f of failures) console.log("  FAIL:", f);
} finally {
  await browser.close();
}

process.exit(failures.length === 0 ? 0 : 1);
