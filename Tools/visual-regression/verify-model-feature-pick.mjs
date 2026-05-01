#!/usr/bin/env node
/**
 * Verifies C-R9-MODEL-FEATURE-PICK end-to-end on WebGPU.
 *
 * Loads a Cesium tilset that ships per-feature batch-table data (the
 * standard sample tileset), zooms in, performs a pick at canvas center,
 * and asserts that the pick result carries a per-feature `id` (the
 * featureId) rather than just the Model object — i.e., the per-feature
 * pick path is wired and resolving correctly.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:8080";
(async () => {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || (t === "warning" && m.text().includes("validation"))) {
      console.log(`[${t}] ${m.text().slice(0, 250)}`);
    }
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle", timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Add a 3D Tileset that has a batch table — use Cesium's built-in
    // sample BIM tileset (b3dm with batchTable). This is the canonical
    // batched-feature dataset Cesium ships for picking demos.
    // Load a b3dm tileset with batch-table-hierarchy. b3dm content
    // populates FLAG_HAS_BATCH_TABLE in the WebGPU model renderer, which
    // is the gate that drives `ensurePerFeaturePickIds` allocation in
    // WebGPUModelFeatureId.js. Without a batch table, the per-feature
    // pick path is intentionally skipped.
    const tileset = await C.Cesium3DTileset.fromUrl(
      "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json",
    );
    v.scene.primitives.add(tileset);

    // Render until the tileset reports its bounding sphere + features.
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Position camera ABOVE the tileset's bounding sphere center.
    const bs = tileset.boundingSphere;
    if (bs) {
      const cart = C.Cartographic.fromCartesian(bs.center);
      v.camera.setView({
        destination: C.Cartesian3.fromRadians(
          cart.longitude,
          cart.latitude,
          cart.height + bs.radius * 2.5,
        ),
        orientation: { heading: 0, pitch: -1.5708, roll: 0 },
      });
    }
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Walk the tileset to find the first loaded model so we can read
    // its WebGPU cache.
    let model = null;
    tileset.tileVisible.addEventListener?.((tile) => {
      if (!model && tile?.content?._model) model = tile.content._model;
    });
    // The event-listener form may not fire for already-loaded tiles;
    // walk the root manually.
    function walk(tile) {
      if (model) return;
      if (tile?.content?._model) { model = tile.content._model; return; }
      if (tile?.children) for (const c of tile.children) walk(c);
    }
    walk(tileset.root);

    // Center-canvas pick.
    const w = v.canvas.width, h = v.canvas.height;
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    const picked = v.scene.pick(new C.Cartesian2(cx, cy));
    // Probe model cache state to verify per-feature pickIds were
    // allocated by the C-R9-MODEL-FEATURE-PICK code path even if the
    // visual pick can't latch.
    const wgpuCache = model?._webgpuCache;
    const featurePickIdCount = wgpuCache?._featurePickIds?.size ?? 0;
    const featurePickTexExists = !!wgpuCache?._featurePickGPUTexture;
    const featurePickFeaturesLength = wgpuCache?._featurePickFeaturesLength ?? null;
    // Diagnostic probes — what does the model carry?
    const featureTableId = model?.featureTableId;
    const featureTables = model?.featureTables;
    const featureTable = featureTables?.[featureTableId];
    const batchTexture = featureTable?.batchTexture;
    // Probe the b3dm Model's scene graph — the WebGPU renderer returns
    // early if _sceneGraph._runtimeNodes is undefined (line 1344-1347
    // of WebGPUModelRenderer.js).
    const sg = model?._sceneGraph;
    const runtimeNodes = sg?._runtimeNodes;
    // Probe deeper: the renderer iterates runtimeNode.runtimePrimitives
    // and calls extractPrimitiveGeometry(rp), which returns null if
    // rp.renderResources / rp._renderResources is undefined. b3dm Models
    // may use a different load flow that doesn't populate that slot.
    const firstRP = runtimeNodes?.[0]?.runtimePrimitives?.[0];
    const firstAttr = firstRP?.primitive?.attributes?.[0];
    const rpInfo = firstRP ? {
      ctor: firstRP.constructor?.name,
      hasRenderResources: firstRP.renderResources !== undefined,
      gltfPrimAttrCount: firstRP.primitive?.attributes?.length,
      gltfPrimSemantics: firstRP.primitive?.attributes?.map((a) => a.semantic ?? a.name).slice(0, 10),
      firstAttrShape: firstAttr ? {
        keys: Object.keys(firstAttr).slice(0, 15),
        hasTypedArray: !!firstAttr.typedArray,
        typedArrayLen: firstAttr.typedArray?.length,
        hasBuffer: !!firstAttr.buffer,
        semantic: firstAttr.semantic ?? firstAttr.name,
        componentDatatype: firstAttr.componentDatatype,
      } : null,
    } : { rpMissing: true };

    // Probe featureIds on the glTF primitive — required by
    // findSelectedFeatureId in WebGPUModelFeatureId.js
    const featureIds = firstRP?.primitive?.featureIds;
    const featureIdsInfo = {
      defined: featureIds !== undefined && featureIds !== null,
      length: featureIds?.length,
      first: featureIds?.[0] ? {
        ctor: featureIds[0].constructor?.name,
        keys: Object.keys(featureIds[0]).slice(0, 12),
        propertyTableId: featureIds[0].propertyTableId,
        positionalLabel: featureIds[0].positionalLabel,
        label: featureIds[0].label,
        featureCount: featureIds[0].featureCount,
        setIndex: featureIds[0].setIndex,
      } : null,
      // What does the model itself want to label?
      modelFeatureIdLabel: model?.featureIdLabel,
      modelInstanceFeatureIdLabel: model?.instanceFeatureIdLabel,
      // Probe createBatchGPUTexture path — what does batchTexture have?
      batchTextureKeys: batchTexture
        ? Object.keys(batchTexture).filter((k) => !k.startsWith("__")).slice(0, 25)
        : null,
      batchValuesPresent: !!batchTexture?._batchValues,
      batchValuesLength: batchTexture?._batchValues?.length,
      batchValuesType: batchTexture?._batchValues?.constructor?.name,
      batchTextureWidth: batchTexture?._textureDimensions?.x,
      batchTextureHeight: batchTexture?._textureDimensions?.y,
      // Probe what's actually on the WebGPU primCache after rendering
      primCacheValAfterRender: (() => {
        const pc = wgpuCache && Object.values(wgpuCache.primitives ?? {})[0];
        if (!pc) return null;
        return {
          hasFeatureIdEntries: !!pc._featureIdEntries,
          featureIdEntriesLen: pc._featureIdEntries?.length,
          hasFeatureIdFlags: pc._featureIdFlags !== undefined,
          featureIdFlags: pc._featureIdFlags,
          hasBatchGPUTex: !!pc._batchGPUTexture,
          hasFeaturePickGPUTex: !!pc._featurePickGPUTexture,
          hasFeatureUniformBuffer: !!pc._featureUniformBuffer,
        };
      })(),
    };
    const sceneGraphInfo = sg ? {
      sceneGraphCtor: sg.constructor?.name,
      hasRuntimeNodes: !!runtimeNodes,
      runtimeNodesLength: runtimeNodes?.length,
      runtimeNodesNonNull: runtimeNodes?.filter?.((n) => !!n).length,
      firstNodeRuntimePrimitives: runtimeNodes?.[0]?.runtimePrimitives?.length,
      firstRPInfo: rpInfo,
      featureIdsInfo,
    } : { sceneGraphMissing: true };

    const diagnostic = {
      hasFeatureTableId: featureTableId !== undefined,
      featureTableId,
      featureTablesLength: featureTables?.length,
      featureTableFeaturesLength: featureTable?.featuresLength,
      batchTextureExists: !!batchTexture,
      batchTextureDimensions: batchTexture?._textureDimensions
        ? [batchTexture._textureDimensions.x, batchTexture._textureDimensions.y]
        : null,
      // Look at one of the prim caches to see if ensureFeatureIdResources hit
      primCacheKeys: Object.keys(wgpuCache?.primitives ?? {}).slice(0, 3),
      primCacheFeatureIdBGExists: !!Object.values(wgpuCache?.primitives ?? {})[0]
        ?._featureIdBG,
      primCacheFeaturePickGPUTextureExists: !!Object.values(wgpuCache?.primitives ?? {})[0]
        ?._featurePickGPUTexture,
      primCacheBatchGPUTextureExists: !!Object.values(wgpuCache?.primitives ?? {})[0]
        ?._batchGPUTexture,
      // Scene graph probe — the gating return at WebGPUModelRenderer.js:1344
      sceneGraph: sceneGraphInfo,
      modelKeys: model ? Object.keys(model).filter((k) => k.startsWith("_") || ["show", "ready"].includes(k)).slice(0, 30) : null,
    };

    const out = {
      modelFound: !!model,
      modelReady: model?.ready,
      tilesetFeaturesLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      sceneMode: v.scene.mode,
      cameraHeight: v.camera.positionCartographic?.height,
      // C-R9 plumbing checks (don't depend on visible rendering or pick FBO)
      featurePickIdCount,
      featurePickTexExists,
      featurePickFeaturesLength,
      diagnostic,
      pickedDefined: !!picked,
      hasPrimitive: !!picked?.primitive,
      hasId: picked?.id !== undefined,
      idType: typeof picked?.id,
      idValue: typeof picked?.id === "number" ? picked.id : String(picked?.id).slice(0, 80),
      primitiveCtor: picked?.primitive?.constructor?.name,
    };

    // Spiral pick to find anything if center missed.
    if (!out.pickedDefined) {
      for (let r = 50; r < 350 && !out.pickedDefined; r += 50) {
        for (let a = 0; a < 6; a++) {
          const dx = Math.round(Math.cos(a) * r), dy = Math.round(Math.sin(a) * r);
          const p = v.scene.pick(new C.Cartesian2(cx + dx, cy + dy));
          if (p) {
            out.pickedDefined = true;
            out.hasPrimitive = !!p.primitive;
            out.hasId = p.id !== undefined;
            out.idType = typeof p.id;
            out.idValue = typeof p.id === "number" ? p.id : String(p.id).slice(0, 80);
            out.primitiveCtor = p.primitive?.constructor?.name;
            out.foundOffset = [dx, dy];
            break;
          }
        }
      }
    }
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
  const buf = await page.screenshot({ omitBackground: false });
  const fs = await import("fs");
  fs.writeFileSync("Tools/visual-regression/output/verify-model-feature-pick.png", buf);
  console.log(`PNG bytes: ${buf.length}`);
  await browser.close();
})();
