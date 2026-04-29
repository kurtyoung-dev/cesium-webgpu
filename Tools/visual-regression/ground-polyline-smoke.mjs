#!/usr/bin/env node
/**
 * Smoke test for Migration Session 4b — WebGPU GroundPolylinePrimitive
 * classifier.
 *
 * Usage:
 *   node Tools/visual-regression/ground-polyline-smoke.mjs
 *
 * Requires the dev server running at http://localhost:8080.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

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
  const page = await browser.newPage();

  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  console.log(`Loading ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });

  // Give the page extra time to finish viewer init.
  await new Promise((r) => setTimeout(r, 12_000));

  const viewerProbe = await page.evaluate(() => ({
    hasViewer: !!window.viewer,
    hasCesium: !!window.Cesium,
    cesiumKeys: window.Cesium
      ? Object.keys(window.Cesium).filter(
          (k) =>
            k.includes("Polyline") ||
            k.includes("Ground") ||
            k === "FeatureRendererKey",
        )
      : [],
    activeCanvas: !!document.querySelector("canvas"),
  }));
  console.log("Viewer probe:", JSON.stringify(viewerProbe, null, 2));
  console.log("\nLast 40 console messages so far:");
  for (const m of consoleMessages.slice(-40)) {
    console.log(`[${m.type}] ${m.text.slice(0, 250)}`);
  }
  console.log(`\nPage errors (${pageErrors.length}):`);
  for (const pe of pageErrors) console.log(pe);

  if (!viewerProbe.hasViewer) {
    await browser.close();
    process.exit(2);
  }

  console.log("\n=== Injecting GroundPolylinePrimitive ===");
  const setupResult = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const positions = C.Cartesian3.fromDegreesArray([
      -122.42, 37.77, -122.4, 37.79, -122.38, 37.8, -122.36, 37.81,
    ]);
    const inst = new C.GeometryInstance({
      geometry: new C.GroundPolylineGeometry({
        positions,
        width: 8.0,
      }),
      attributes: {
        color: C.ColorGeometryInstanceAttribute.fromColor(
          C.Color.fromCssColorString("magenta").withAlpha(0.85),
        ),
      },
      id: "smoke-polyline",
    });
    const prim = new C.GroundPolylinePrimitive({
      geometryInstances: inst,
      appearance: new C.PolylineColorAppearance(),
      classificationType: C.ClassificationType.BOTH,
    });
    v.scene.groundPrimitives.add(prim);

    await C.GroundPolylinePrimitive.initializeTerrainHeights();

    // Wait for the async worker-side geometry build to complete. The
    // primitive flips _ready=true once its inner Primitive has finished
    // creating vertex arrays (which is also when _webgpuGeometryData is
    // populated). Cap at 8s to avoid hanging if something is wrong.
    const start = performance.now();
    while (!prim._ready && performance.now() - start < 8000) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Once ready, render a few more frames so the WebGPU renderer can
    // upload buffers + build pipelines and emit commands.
    for (let i = 0; i < 10; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Smoke-test material variants: Dash, Glow, Outline.
    const matInst = (material) =>
      new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({
          positions: C.Cartesian3.fromDegreesArray([
            -122.5, 37.7, -122.4, 37.75, -122.3, 37.8,
          ]),
          width: 6.0,
        }),
        id: `smoke-mat-${material?.type ?? "color"}`,
      });
    const dashPrim = new C.GroundPolylinePrimitive({
      geometryInstances: matInst({ type: "PolylineDash" }),
      appearance: new C.PolylineMaterialAppearance({
        material: C.Material.fromType("PolylineDash"),
      }),
      classificationType: C.ClassificationType.BOTH,
    });
    const glowPrim = new C.GroundPolylinePrimitive({
      geometryInstances: matInst({ type: "PolylineGlow" }),
      appearance: new C.PolylineMaterialAppearance({
        material: C.Material.fromType("PolylineGlow"),
      }),
      classificationType: C.ClassificationType.BOTH,
    });
    const outlinePrim = new C.GroundPolylinePrimitive({
      geometryInstances: matInst({ type: "PolylineOutline" }),
      appearance: new C.PolylineMaterialAppearance({
        material: C.Material.fromType("PolylineOutline"),
      }),
      classificationType: C.ClassificationType.BOTH,
    });
    v.scene.groundPrimitives.add(dashPrim);
    v.scene.groundPrimitives.add(glowPrim);
    v.scene.groundPrimitives.add(outlinePrim);
    const matStart = performance.now();
    while (
      (!dashPrim._ready || !glowPrim._ready || !outlinePrim._ready) &&
      performance.now() - matStart < 8000
    ) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 10; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Smoke-test 2D / Columbus View by switching scene mode. The
    // sceneMode flag in the polyline UBO should flip and the 2D
    // attribute path of the WGSL VS should take over without crashing.
    let sceneModesPass = 0;
    let sceneModesFail = 0;
    const probeMode = async (mode) => {
      v.scene.morphTo2D?.(0); // immediate
      v.scene.mode = mode;
      for (let i = 0; i < 5; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    try {
      await probeMode(C.SceneMode.SCENE2D);
      sceneModesPass++;
    } catch (e) {
      sceneModesFail++;
    }
    try {
      await probeMode(C.SceneMode.COLUMBUS_VIEW);
      sceneModesPass++;
    } catch (e) {
      sceneModesFail++;
    }
    // Restore SCENE3D
    v.scene.mode = C.SceneMode.SCENE3D;
    for (let i = 0; i < 5; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const ctx = v.scene.context;
    const fr = ctx.getFeatureRenderer
      ? ctx.getFeatureRenderer(41 /* GROUND_POLYLINE */)
      : null;

    const innerPrim = prim._primitive;
    const cache = prim._webgpuPolylineCache;
    const gd0 = innerPrim?._webgpuGeometryData?.[0];
    return {
      gd0_indicesType: gd0?.indices ? gd0.indices.constructor.name : null,
      gd0_indicesLen: gd0?.indices?.length ?? 0,
      gd0_posHighLen: gd0?.attributes?.position3DHigh?.values?.length ?? 0,
      rendererType: ctx.rendererType ?? "unknown",
      featureRendererPresent: !!fr,
      featureRendererCreateCommands: !!(fr && fr.createCommands),
      hasInnerPrimitive: !!innerPrim,
      hasGeomData: !!innerPrim?._webgpuGeometryData,
      geomDataLength: innerPrim?._webgpuGeometryData?.length ?? 0,
      attrNames: innerPrim?._webgpuGeometryData?.[0]
        ? Object.keys(innerPrim._webgpuGeometryData[0].attributes ?? {})
        : [],
      cacheCreated: !!cache,
      cacheHasUniformBuffer: !!cache?.uniformBuffer,
      cacheHasVertexBuffer: !!cache?.vertexGPUBuffer,
      cacheHasIndexBuffer: !!cache?.indexGPUBuffer,
      cacheVertexCount: cache?.vertexCount ?? 0,
      cacheIndexCount: cache?.indexCount ?? 0,
      cacheHasColorPipeline: !!cache?.colorPipeline,
      cacheHasPickPipeline: !!cache?.pickPipeline,
      cacheHasMorphColorPipeline: !!cache?.morphColorPipeline,
      cacheHasMorphPickPipeline: !!cache?.morphPickPipeline,
      cacheHasDepthSampleBindGroup: !!cache?.depthSampleBindGroup,
      cacheBatchInstanceCount: cache?.batchInstanceCount ?? 0,
    };
  });

  await new Promise((r) => setTimeout(r, 1500));
  await browser.close();

  console.log("\n=== Setup probe ===");
  console.log(JSON.stringify(setupResult, null, 2));

  const errs = consoleMessages.filter((m) => m.type === "error");
  const warns = consoleMessages.filter((m) => m.type === "warning");
  const polylineLogs = consoleMessages.filter(
    (m) =>
      m.text.includes("Polyline") ||
      m.text.includes("polyline") ||
      m.text.includes("GROUND_POLYLINE") ||
      m.text.includes("WGSL") ||
      m.text.includes("validation"),
  );

  console.log(`\n=== Console errors (${errs.length}) ===`);
  for (const e of errs) console.log(`[${e.type}] ${e.text}`);

  console.log(`\n=== Console warnings (${warns.length}) ===`);
  for (const w of warns.slice(0, 20)) console.log(`[${w.type}] ${w.text}`);

  console.log(`\n=== Polyline/WGSL/validation logs (${polylineLogs.length}) ===`);
  for (const l of polylineLogs.slice(0, 30))
    console.log(`[${l.type}] ${l.text}`);

  console.log(`\n=== Page errors (${pageErrors.length}) ===`);
  for (const pe of pageErrors) console.log(pe);

  const pass =
    errs.length === 0 &&
    pageErrors.length === 0 &&
    setupResult.featureRendererPresent &&
    setupResult.cacheCreated;
  console.log(`\nResult: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
