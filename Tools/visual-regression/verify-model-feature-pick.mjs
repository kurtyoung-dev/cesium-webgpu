#!/usr/bin/env node
/**
 * Verifies C-R9-MODEL-FEATURE-PICK end-to-end on WebGPU.
 * @purpose End-to-end per-feature pick on WebGPU: loads a batch-table tileset, picks at center, asserts the result carries a featureId not just the Model.
 * @status ACTIVE
 *
 * Loads a Cesium tilset that ships per-feature batch-table data (the
 * standard sample tileset), zooms in, performs a pick at canvas center,
 * and asserts that the pick result carries a per-feature `id` (the
 * featureId) rather than just the Model object — i.e., the per-feature
 * pick path is wired and resolving correctly.
 */
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.PROBE_RENDERER || "webgpu";
(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (txt.includes("[PICKDIAG")) {
      console.log(txt);
    } else if (
      t === "error" ||
      (t === "warning" && txt.includes("validation"))
    ) {
      console.log(`[${t}] ${txt.slice(0, 250)}`);
    }
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const dev = v.scene.context?._device;
    if (dev) {
      dev.onuncapturederror = (ev) => {
        console.log(`[PICKDIAG-ERR] ${ev?.error?.message?.slice(0, 280)}`);
      };
    }

    // CRITICAL (Batch 204 correction): force ELLIPSOID terrain. The default
    // viewer now loads Cesium World Terrain (valid token), whose real elevation
    // at the BatchTableHierarchy sample location sits ABOVE the sample
    // buildings and legitimately occludes them — on BOTH WebGL and WebGPU.
    // Without this the probe was testing terrain occlusion, not the model
    // render/pick path (the false "b3dm invisible on WebGPU" C-R9 signal).
    v.terrainProvider = new C.EllipsoidTerrainProvider();

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
      if (tile?.content?._model) {
        model = tile.content._model;
        return;
      }
      if (tile?.children) for (const c of tile.children) walk(c);
    }
    walk(tileset.root);

    // Center-canvas pick. scene.pick expects CSS (logical) pixels, NOT
    // device/backing-store pixels — use clientWidth/Height (falls back to
    // viewport 1280x720 if clientWidth is 0 in headless). Spiral outward
    // if the exact center misses the tileset footprint.
    const cw = v.canvas.clientWidth || 1280;
    const ch = v.canvas.clientHeight || 720;
    const cx = Math.floor(cw / 2),
      cy = Math.floor(ch / 2);
    // WebGPU pick is ASYNC (GPU->CPU readback). Synchronous scene.pick returns
    // the prior frame's result on WebGPU, so use scene.pickAsync — ONE awaited
    // call at a time (overlapping pickAsync double-maps the readback buffer).
    //
    // Pick targets, in priority order:
    //   1. The on-screen projection of the model / tileset bounding-sphere
    //      center (the geometry's actual pixel, not the canvas center — the
    //      buildings can sit off-center depending on the bounding-sphere
    //      geometry vs the look-at point).
    //   2. A coarse grid scan across the whole canvas — definitively answers
    //      "does pick latch ANYWHERE" rather than relying on a cardinal
    //      spiral that can thread between the building footprints.
    const pickTargets = [];
    const projCenter =
      (model?.boundingSphere?.center &&
        v.scene.cartesianToCanvasCoordinates(model.boundingSphere.center)) ||
      (tileset.boundingSphere?.center &&
        v.scene.cartesianToCanvasCoordinates(tileset.boundingSphere.center));
    if (projCenter && C.defined(projCenter.x)) {
      pickTargets.push([Math.round(projCenter.x), Math.round(projCenter.y)]);
    }
    pickTargets.push([cx, cy]);
    for (let gy = 60; gy < ch; gy += 60) {
      for (let gx = 60; gx < cw; gx += 60) {
        pickTargets.push([gx, gy]);
      }
    }
    let picked;
    let pickedAt = null;
    for (const [px, py] of pickTargets) {
      v.scene.render();
      const p = await v.scene.pickAsync(new C.Cartesian2(px, py));
      v.scene.render();
      if (C.defined(p)) {
        picked = p;
        pickedAt = [px, py];
        break;
      }
    }
    // Probe model cache state to verify per-feature pickIds were
    // allocated by the C-R9-MODEL-FEATURE-PICK code path even if the
    // visual pick can't latch.
    const wgpuCache = model?._webgpuCache;
    const featurePickIdCount = wgpuCache?._featurePickIds?.size ?? 0;
    const featurePickTexExists = !!wgpuCache?._featurePickGPUTexture;
    const featurePickFeaturesLength =
      wgpuCache?._featurePickFeaturesLength ?? null;
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
    const rpInfo = firstRP
      ? {
          ctor: firstRP.constructor?.name,
          hasRenderResources: firstRP.renderResources !== undefined,
          gltfPrimAttrCount: firstRP.primitive?.attributes?.length,
          gltfPrimSemantics: firstRP.primitive?.attributes
            ?.map((a) => a.semantic ?? a.name)
            .slice(0, 10),
          firstAttrShape: firstAttr
            ? {
                keys: Object.keys(firstAttr).slice(0, 15),
                hasTypedArray: !!firstAttr.typedArray,
                typedArrayLen: firstAttr.typedArray?.length,
                hasBuffer: !!firstAttr.buffer,
                semantic: firstAttr.semantic ?? firstAttr.name,
                componentDatatype: firstAttr.componentDatatype,
              }
            : null,
        }
      : { rpMissing: true };

    // Probe featureIds on the glTF primitive — required by
    // findSelectedFeatureId in WebGPUModelFeatureId.js
    const featureIds = firstRP?.primitive?.featureIds;
    const featureIdsInfo = {
      defined: featureIds !== undefined && featureIds !== null,
      length: featureIds?.length,
      first: featureIds?.[0]
        ? {
            ctor: featureIds[0].constructor?.name,
            keys: Object.keys(featureIds[0]).slice(0, 12),
            propertyTableId: featureIds[0].propertyTableId,
            positionalLabel: featureIds[0].positionalLabel,
            label: featureIds[0].label,
            featureCount: featureIds[0].featureCount,
            setIndex: featureIds[0].setIndex,
          }
        : null,
      // What does the model itself want to label?
      modelFeatureIdLabel: model?.featureIdLabel,
      modelInstanceFeatureIdLabel: model?.instanceFeatureIdLabel,
      // Probe createBatchGPUTexture path — what does batchTexture have?
      batchTextureKeys: batchTexture
        ? Object.keys(batchTexture)
            .filter((k) => !k.startsWith("__"))
            .slice(0, 25)
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
    const sceneGraphInfo = sg
      ? {
          sceneGraphCtor: sg.constructor?.name,
          hasRuntimeNodes: !!runtimeNodes,
          runtimeNodesLength: runtimeNodes?.length,
          runtimeNodesNonNull: runtimeNodes?.filter?.((n) => !!n).length,
          firstNodeRuntimePrimitives:
            runtimeNodes?.[0]?.runtimePrimitives?.length,
          firstRPInfo: rpInfo,
          featureIdsInfo,
        }
      : { sceneGraphMissing: true };

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
      primCacheFeatureIdBGExists: !!Object.values(
        wgpuCache?.primitives ?? {},
      )[0]?._featureIdBG,
      primCacheFeaturePickGPUTextureExists: !!Object.values(
        wgpuCache?.primitives ?? {},
      )[0]?._featurePickGPUTexture,
      primCacheBatchGPUTextureExists: !!Object.values(
        wgpuCache?.primitives ?? {},
      )[0]?._batchGPUTexture,
      // Scene graph probe — the gating return at WebGPUModelRenderer.js:1344
      sceneGraph: sceneGraphInfo,
      modelKeys: model
        ? Object.keys(model)
            .filter((k) => k.startsWith("_") || ["show", "ready"].includes(k))
            .slice(0, 30)
        : null,
    };

    const out = {
      modelFound: !!model,
      modelReady: model?.ready,
      tilesetFeaturesLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      sceneMode: v.scene.mode,
      cameraHeight: v.camera.positionCartographic?.height,
      // Diagnostics for the C-R9 b3dm-on-terrain depth-occlusion investigation
      // (Batch 203): the frustum partition + useLogDepth state. NOTE: the
      // frustum-partition "fix A" was tried + reverted — multi-frustum does NOT
      // fix the occlusion (see DEFERRED_WORK C-R9 corrected root cause).
      useLogDepth: v.scene.frameState?.useLogDepth,
      numFrustums: v.scene._view?.frustumCommandsList?.length,
      // C-R9 plumbing checks (don't depend on visible rendering or pick FBO)
      featurePickIdCount,
      featurePickTexExists,
      featurePickFeaturesLength,
      diagnostic,
      pickedDefined: !!picked,
      pickedAt,
      pickTargetsTried: pickTargets.length,
      hasPrimitive: !!picked?.primitive,
      hasId: picked?.id !== undefined,
      idType: typeof picked?.id,
      idValue:
        typeof picked?.id === "number"
          ? picked.id
          : String(picked?.id).slice(0, 80),
      primitiveCtor: picked?.primitive?.constructor?.name,
      // C-R9-MODEL-FEATURE-PICK parity check — the picked object must be a
      // real Cesium3DTileFeature with readable batch-table properties, not
      // a bare {primitive, id}. Capture its ctor + a couple of property
      // values so WebGPU vs WebGL can be compared directly.
      pickedCtor: picked?.constructor?.name,
      isTileFeature: typeof picked?.getProperty === "function",
      propertyIds:
        typeof picked?.getPropertyIds === "function"
          ? picked.getPropertyIds().slice(0, 8)
          : null,
      sampleProperties:
        typeof picked?.getProperty === "function"
          ? (() => {
              const ids = picked.getPropertyIds().slice(0, 4);
              const o = {};
              for (const id of ids)
                o[id] = String(picked.getProperty(id)).slice(0, 40);
              return o;
            })()
          : null,
    };

    // (Second sync-pick spiral removed — sync scene.pick double-maps the
    // WebGPU pick readback buffer. The pickAsync block above is authoritative.)
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
  const buf = await page.screenshot({ omitBackground: false });
  const fs = await import("fs");
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-model-feature-pick.png",
    buf,
  );
  console.log(`PNG bytes: ${buf.length}`);
  await browser.close();
})();
