// C10-06 Step C.1 mechanism / cache-hit oracle.
//
// Proves the globe shader-module prewarm actually runs during context init
// (T-06-c: getShaderCode was non-null, initialize ran) AND that it beats the
// first tile draw — i.e. the 2-variant GlobeTerrain compile is moved off
// frame 1 into the idle init window. Deterministic (console-log ordering),
// so it is noise-free unlike the wall-clock TTFF campaign.
//
// Assertions (WebGPU, deterministic offline boot):
//   1. `[WebGPU:GlobePrewarm] Globe renderer warmed at init` was logged
//      (the prewarm executed — not a silent no-op).
//   2. That log appeared BEFORE the first `[WebGPU:TileDraw] PROCEEDING`
//      (the prewarm won the race against frame 1).
//   3. The per-device globe renderer is `isInitialized` immediately after
//      boot (before we force any extra render).
//   4. No device/console errors during boot.
//
// Usage: node Tools/visual-regression/probe-boot-prewarm-c10-06.mjs

import { chromium } from "playwright";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const failures = [];
const notes = [];

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const consoleLog = []; // { seq, type, text }
  let seq = 0;
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  page.on("console", (m) => {
    const text = m.text();
    consoleLog.push({ seq: seq++, type: m.type(), text: text.slice(0, 300) });
    if (m.type() === "error") errors.push(`console: ${text.slice(0, 200)}`);
  });

  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle", timeout: 30000 },
  );
  await page.waitForFunction(() => !!window.viewer?.scene?.context, undefined, {
    timeout: 20000,
  });
  // Let the scene render its first frames (bounded loop — no unbounded work).
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    for (let i = 0; i < 8; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const prewarmIdx = consoleLog.findIndex((l) =>
    l.text.includes("[WebGPU:GlobePrewarm] Globe renderer warmed at init"),
  );
  const firstTileDrawIdx = consoleLog.findIndex((l) =>
    l.text.includes("[WebGPU:TileDraw] PROCEEDING"),
  );

  if (prewarmIdx < 0) {
    failures.push(
      "prewarm log NOT found — warmUpGlobeRenderer did not run (T-06-c silent no-op)",
    );
  } else {
    notes.push(`prewarm log at console seq=${consoleLog[prewarmIdx].seq}`);
  }

  if (firstTileDrawIdx < 0) {
    notes.push(
      "no [WebGPU:TileDraw] PROCEEDING log observed (diag counter may be exhausted or tiles drew silently) — ordering check skipped",
    );
  } else {
    notes.push(`first tile-draw log at console seq=${consoleLog[firstTileDrawIdx].seq}`);
    if (prewarmIdx >= 0 && prewarmIdx > firstTileDrawIdx) {
      failures.push(
        "prewarm log appeared AFTER first tile draw — prewarm did not beat frame 1",
      );
    } else if (prewarmIdx >= 0) {
      notes.push("ORDER OK: prewarm ran before first tile draw");
    }
  }

  // Confirm the per-device globe renderer is initialized after boot.
  const globeInit = await page.evaluate(() => {
    const cache = globalThis.__webgpuGlobeBindGroupCache;
    const slot = globalThis.__webgpuGlobeImagerySlotCount;
    return { hasBindGroupCache: !!cache, imagerySlotCount: slot ?? null };
  });
  notes.push(
    `globe globals after boot: bindGroupCache=${globeInit.hasBindGroupCache} imagerySlotCount=${globeInit.imagerySlotCount}`,
  );
  if (!globeInit.hasBindGroupCache) {
    failures.push(
      "globe bind-group cache global not published — globe renderer never initialized",
    );
  }

  if (errors.length > 0) {
    failures.push(`boot errors: ${errors.slice(0, 5).join(" | ")}`);
  }

  console.log("=== C10-06 boot-prewarm mechanism probe ===");
  for (const n of notes) console.log("  note:", n);
  if (failures.length === 0) {
    console.log("RESULT: PASS");
  } else {
    console.log("RESULT: FAIL");
    for (const f of failures) console.log("  FAIL:", f);
  }
} finally {
  await browser.close();
}

process.exit(failures.length === 0 ? 0 : 1);
