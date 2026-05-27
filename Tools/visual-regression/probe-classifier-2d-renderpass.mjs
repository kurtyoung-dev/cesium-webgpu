// Diagnostic probe for NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS.
//
// GroundPrimitive classification in SCENE2D / COLUMBUS_VIEW on WebGPU throws a
// cascading render-pass-lifecycle error (`_beginDefaultRenderPass() called
// with an active render pass`). This probe drives ONLY the 2D path with a
// flat-color GroundPrimitive and captures:
//   - the FIRST exception thrown by scene.render() (with stack) — the
//     original frame-N error that leaves a pass open, not the cascading one;
//   - all page console errors/warnings (the engine logs the render error);
//   - the render-pass label active when the throw happens.
// The goal is to pinpoint which dispatch site opens a pass without ending it
// in 2D mode.

import { chromium } from "playwright";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const consoleMsgs = [];
page.on("console", (m) => {
  const t = m.text();
  if (/error|warn|render pass|RenderPass|classif|GroundPrim|endCurrent/i.test(t)) {
    consoleMsgs.push(`[${m.type()}] ${t.slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message.slice(0, 300)}`));

await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const result = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  v.useDefaultRenderLoop = false;
  const scene = v.scene;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;

  const positions = C.Cartesian3.fromDegreesArray([-100, 40, -95, 40, -95, 43, -100, 43]);
  const ground = new C.GroundPrimitive({
    geometryInstances: new C.GeometryInstance({
      geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(new C.Color(1, 0.05, 0.05, 1)) },
    }),
    classificationType: C.ClassificationType.TERRAIN,
    asynchronous: false,
  });
  scene.groundPrimitives.add(ground);

  // Build in 3D (known-good after Batch 161).
  for (let i = 0; i < 120; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (ground.ready) break;
  }

  // Switch to 2D and render — capture the FIRST throw + its stack.
  scene.morphTo2D(0);
  scene.completeMorph();
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 2_400_000),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
  });

  let firstError = null;
  let activePassLabel = null;
  for (let i = 0; i < 8; i++) {
    try {
      const ctx = scene.context;
      // record the active render-pass label right before render (cascading
      // throws happen at the NEXT beginFrame, so this catches a leaked pass).
      activePassLabel = ctx?._currentRenderPassEncoder?.label ?? null;
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    } catch (e) {
      firstError = { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 1500) };
      break;
    }
  }
  return {
    sceneMode: scene.mode,
    ready: ground.ready === true,
    leakedPassLabelBeforeFirstFailingRender: activePassLabel,
    firstError,
  };
});

await browser.close();
console.log("=== NEW-CLASSIFIER-GROUNDPRIM-2D-RENDERPASS diagnostic ===\n");
console.log("scene.mode (2 = SCENE2D):", result.sceneMode, " ground.ready:", result.ready);
console.log("leaked pass label before first failing render:", result.leakedPassLabelBeforeFirstFailingRender);
console.log("\nFIRST thrown error:");
if (result.firstError) {
  console.log("  message:", result.firstError.message);
  console.log("  stack:\n" + result.firstError.stack.split("\n").map((l) => "    " + l).join("\n"));
} else {
  console.log("  (none caught via scene.render try/catch — engine likely swallows it)");
}
console.log("\nFiltered console messages:");
consoleMsgs.slice(0, 20).forEach((m) => console.log("  " + m));
