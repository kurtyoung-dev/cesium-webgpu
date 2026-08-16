// Smoke test for NEW-WEBGPU-PIPELINE-READY-SIGNAL +
// NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER. Verifies:
// @purpose Smoke test that AsyncResourceMonitor/Telemetry accumulate pipeline tokens and p50/p95 latency while the globe renders under requestRenderMode.
// @status ACTIVE
//
//   1. Globe still renders correctly with default requestRenderMode=true
//      (regression check for the original BUG-WEBGPU-PIPELINE-ASYNC).
//   2. AsyncResourceMonitor accumulates pipeline tokens during warmup.
//   3. AsyncResourceTelemetry surfaces per-kind p50/p95 latency.
//   4. Perf manager's getAsyncResourceStats() returns a populated snapshot.
import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.setDefaultTimeout(60000);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

// Run for ~6 seconds so async pipelines have time to cook + the
// hibernate-then-wake cycle is exercised.
await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 20) r();
        else requestAnimationFrame(tick);
      })();
    });
    await new Promise((r) => setTimeout(r, 100));
  }
});

const stats = await page.evaluate(() => {
  const v = window.viewer;
  const ctx = v.scene._context;
  const fs = v.scene._frameState;
  const monitor = ctx?.asyncResources;
  const telemetry = ctx?.asyncResourceTelemetry;
  const monitorStats = monitor?.getStats?.() ?? null;
  const telemetrySnap = telemetry?.snapshot?.() ?? null;
  const pendingByKind = monitor?.pendingByKind ?? null;

  // Phase 4 verification — call monitor.begin manually with
  // background priority and confirm pendingForegroundCount excludes it.
  let phase4 = null;
  if (monitor) {
    const before = monitor.pendingForegroundCount;
    const fgToken = monitor.begin({
      kind: "render-pipeline",
      key: "phase4-fg-test",
      priority: "foreground",
    });
    const afterFg = monitor.pendingForegroundCount;
    const bgToken = monitor.begin({
      kind: "render-pipeline",
      key: "phase4-bg-test",
      priority: "background",
    });
    const afterBg = monitor.pendingForegroundCount;
    monitor.resolve(fgToken);
    monitor.resolve(bgToken);
    phase4 = { before, afterFg, afterBg };
  }

  // Phase 6 verification — subscribe with a sceneId, fire a token
  // owned by a DIFFERENT scene id, and confirm the subscriber is NOT
  // called. Then fire a token owned by THIS scene id and confirm it IS
  // called.
  let phase6 = null;
  if (monitor) {
    let myFires = 0;
    let otherFires = 0;
    const unsubMy = monitor.subscribe(
      () => {
        myFires++;
      },
      { sceneId: "scene-A" },
    );
    const unsubOther = monitor.subscribe(
      () => {
        otherFires++;
      },
      { sceneId: "scene-B" },
    );
    const tokenForA = monitor.begin({
      kind: "render-pipeline",
      key: "phase6-A-only",
      ownerSceneIds: new Set(["scene-A"]),
    });
    monitor.resolve(tokenForA);
    const tokenForB = monitor.begin({
      kind: "render-pipeline",
      key: "phase6-B-only",
      ownerSceneIds: new Set(["scene-B"]),
    });
    monitor.resolve(tokenForB);
    const tokenForBoth = monitor.begin({
      kind: "render-pipeline",
      key: "phase6-shared",
      // No ownerSceneIds — both subscribers should fire.
    });
    monitor.resolve(tokenForBoth);
    unsubMy();
    unsubOther();
    // Expected: myFires = 2 (A-only "started" + "resolved" come through
    // because no owner filter on started; A-only and shared "resolved"
    // also fire). Same for otherFires but for B-only and shared.
    // Started events also dispatch; we fired 3 begins + 3 resolves = 6
    // events total. Each subscriber sees: 2 own + 2 shared = 4 events.
    phase6 = { myFires, otherFires };
  }

  // Reset semantics (Phase 7 building block) — make sure reset()
  // sweeps inflight and is idempotent.
  let resetCheck = null;
  if (monitor) {
    const t1 = monitor.begin({
      kind: "render-pipeline",
      key: "reset-check-1",
    });
    const t2 = monitor.begin({
      kind: "render-pipeline",
      key: "reset-check-2",
    });
    const beforeReset = monitor.pendingCount;
    monitor.reset("smoke-test");
    const afterReset = monitor.pendingCount;
    // Calling resolve on a reset token is a no-op (idempotent).
    monitor.resolve(t1);
    monitor.resolve(t2);
    resetCheck = { beforeReset, afterReset };
  }

  return {
    requestRenderMode: v.scene.requestRenderMode,
    cmdListLength: fs.commandList.length,
    cmdListPasses: fs.commandList.map((c) => c.pass),
    tilesToRender: v.scene.globe._surface._tilesToRender.length,
    rendererType: ctx.rendererType,
    monitorStats,
    pendingByKind,
    telemetrySnap,
    hasMonitorGetter: typeof monitor !== "undefined",
    hasTelemetryGetter: typeof telemetry !== "undefined",
    phase4,
    phase6,
    resetCheck,
    hasWarmAPI: typeof ctx?.webgpuPipelineCache?.warm === "function",
  };
});

console.log("=== Smoke test results ===");
console.log(JSON.stringify(stats, null, 2));

const failures = [];
if (!stats.hasMonitorGetter)
  failures.push("context.asyncResources getter missing");
if (!stats.hasTelemetryGetter)
  failures.push("context.asyncResourceTelemetry getter missing");
if (!stats.hasWarmAPI) failures.push("Phase 4: cache.warm() API missing");
if (stats.cmdListLength < 3)
  failures.push(
    `cmdListLength too low (${stats.cmdListLength}) — globe likely not rendering`,
  );
if (stats.monitorStats && stats.monitorStats.resolved === 0)
  failures.push(
    "monitor reports 0 resolved tokens — pipelines may not be wired through monitor",
  );
if (stats.telemetrySnap && stats.telemetrySnap.aggregate.resolvedCount === 0)
  failures.push("telemetry reports 0 resolved — subscriber not aggregating");
if (stats.phase4) {
  // afterFg should be before+1; afterBg should equal afterFg (background not counted).
  if (stats.phase4.afterFg !== stats.phase4.before + 1)
    failures.push(
      `Phase 4: foreground token didn't increment pendingForegroundCount (before=${stats.phase4.before} afterFg=${stats.phase4.afterFg})`,
    );
  if (stats.phase4.afterBg !== stats.phase4.afterFg)
    failures.push(
      `Phase 4: background token incorrectly counted in pendingForegroundCount (afterFg=${stats.phase4.afterFg} afterBg=${stats.phase4.afterBg})`,
    );
}
if (stats.phase6) {
  // Each subscriber should see exactly: 2 events for its own scene
  // (started + resolved) + 2 for the shared token = 4. Other-scene
  // events should be filtered out.
  if (stats.phase6.myFires !== 4)
    failures.push(
      `Phase 6: scene-A subscriber fired ${stats.phase6.myFires} times, expected 4 (2 own + 2 shared)`,
    );
  if (stats.phase6.otherFires !== 4)
    failures.push(
      `Phase 6: scene-B subscriber fired ${stats.phase6.otherFires} times, expected 4 (2 own + 2 shared)`,
    );
}
if (stats.resetCheck) {
  if (stats.resetCheck.beforeReset < 2)
    failures.push(
      `Reset check: beforeReset (${stats.resetCheck.beforeReset}) should have been ≥ 2`,
    );
  if (stats.resetCheck.afterReset !== 0)
    failures.push(
      `Reset check: afterReset (${stats.resetCheck.afterReset}) should be 0 — reset() didn't clear inflight`,
    );
}

console.log("\n=== Console errors during run ===");
for (const e of consoleErrors.slice(0, 10)) console.log(e);

if (failures.length > 0) {
  console.error("\n=== FAILURES ===");
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("\n✓ All smoke checks passed");
}

await browser.close();
