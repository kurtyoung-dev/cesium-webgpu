// Runtime gate for the per-primitive WebGPU model group-2 bind-group cache.
// Loads static, instanced, and morphed glTF assets, warms all lazy resources,
// then verifies a settled render window creates no new merged instance groups
// and retains the exact cached group identities.
//
// Usage:
//   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-model-instance-bg-cache.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const viewer = window.viewer;
    const scene = viewer.scene;
    const device = scene.context._device;
    const deviceErrors = [];
    device.addEventListener("uncapturederror", (event) => {
      deviceErrors.push(event.error?.message ?? String(event.error));
    });

    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.show = false;
    scene.requestRenderMode = false;
    scene.msaaSamples = 1;
    scene.taaEnabled = true;

    let mergedCreates = 0;
    let mergedMaterialCreates = 0;
    let allBindGroupCreates = 0;
    // C9-17 Slice A — attribute every settled createBindGroup by its label, or
    // by an entry-count signature when the descriptor is unlabeled, so the
    // remaining creates after group-1 caching can be named in the ledger row.
    let labelCounts = {};
    const originalCreateBindGroup = device.createBindGroup.bind(device);
    device.createBindGroup = function (descriptor) {
      allBindGroupCreates++;
      const entryCount = descriptor?.entries?.length ?? 0;
      const bucket = descriptor?.label ?? `unlabeled:entries-${entryCount}`;
      labelCounts[bucket] = (labelCounts[bucket] ?? 0) + 1;
      if (descriptor?.label === "Model merged instance bind group") {
        mergedCreates++;
      }
      if (descriptor?.label === "Model merged material bind group") {
        mergedMaterialCreates++;
      }
      return originalCreateBindGroup(descriptor);
    };

    const base = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
    );
    function translatedModelMatrix(east) {
      return C.Matrix4.multiplyByTranslation(
        base,
        new C.Cartesian3(east, 0.0, 300_000.0),
        new C.Matrix4(),
      );
    }

    const specs = [
      {
        name: "static",
        url: "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
        east: -500_000.0,
      },
      {
        name: "instanced",
        url: "/Specs/Data/Models/glTF-2.0/BoxInstanced/glTF/box-instanced.gltf",
        east: 0.0,
      },
      {
        name: "morph",
        url: "/Specs/Data/Models/glTF-2.0/AnimatedMorphCube/glTF/AnimatedMorphCube.gltf",
        east: 500_000.0,
      },
    ];
    const models = [];
    for (const spec of specs) {
      const model = await C.Model.fromGltfAsync({
        url: spec.url,
        modelMatrix: translatedModelMatrix(spec.east),
        scale: 300_000.0,
      });
      scene.primitives.add(model);
      models.push({ name: spec.name, model });
    }

    viewer.camera.viewBoundingSphere(
      new C.BoundingSphere(C.Cartesian3.fromDegrees(-75.0, 40.0, 300_000.0), 1_500_000.0),
      new C.HeadingPitchRange(0.0, -0.4, 5_000_000.0),
    );
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);

    async function renderFrames(count) {
      for (let i = 0; i < count; i++) {
        scene.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    await renderFrames(80);
    const ready = models.map(({ name, model }) => ({ name, ready: model.ready }));

    function cacheSnapshot() {
      return models.map(({ name, model }) => {
        const primitives = Object.values(model._webgpuCache?.primitives ?? {});
        const privateGroups = primitives
          .map((primitive) => primitive._mergedInstanceBindGroupCache?.bindGroup)
          .filter(Boolean);
        return {
          name,
          primitiveCount: primitives.length,
          privateGroupCount: privateGroups.length,
          privateGroups,
        };
      });
    }

    // C9-17 Slice B — geometry-cache positive-path attribution. On settled
    // frames of fully-instrumented glTF primitives the loader revision tokens
    // should let extractPrimitiveGeometry short-circuit the deep signature walk,
    // so revisionHits climb while walkHits stay flat.
    const geomDiagBefore =
      C.ModelPrimitiveGeometry.getPrimitiveGeometryCacheDiagnostics();
    const before = cacheSnapshot();
    mergedCreates = 0;
    mergedMaterialCreates = 0;
    allBindGroupCreates = 0;
    labelCounts = {};
    await renderFrames(40);
    const after = cacheSnapshot();
    const geomDiagAfter =
      C.ModelPrimitiveGeometry.getPrimitiveGeometryCacheDiagnostics();

    const identitiesStable = before.every((entry, modelIndex) => {
      const next = after[modelIndex];
      return (
        entry.privateGroups.length === next.privateGroups.length &&
        entry.privateGroups.every(
          (bindGroup, bindGroupIndex) =>
            bindGroup === next.privateGroups[bindGroupIndex],
        )
      );
    });

    return {
      ready,
      before: before.map(({ privateGroups: _privateGroups, ...entry }) => entry),
      after: after.map(({ privateGroups: _privateGroups, ...entry }) => entry),
      settledFrames: 40,
      settledMergedInstanceBindGroupCreates: mergedCreates,
      settledMergedMaterialBindGroupCreates: mergedMaterialCreates,
      settledAllBindGroupCreates: allBindGroupCreates,
      settledBindGroupCreatesByBucket: labelCounts,
      settledGeometryHits: geomDiagAfter.hitCount - geomDiagBefore.hitCount,
      settledGeometryRevisionHits:
        geomDiagAfter.revisionHitCount - geomDiagBefore.revisionHitCount,
      settledGeometryWalkHits:
        geomDiagAfter.walkHitCount - geomDiagBefore.walkHitCount,
      identitiesStable,
      deviceErrors,
    };
  });

  result.pageErrors = pageErrors;
  console.log(JSON.stringify(result, null, 2));
  const hasCustomCoverage = result.before.some(
    (entry) => entry.privateGroupCount > 0,
  );
  const pass =
    result.ready.every((entry) => entry.ready) &&
    hasCustomCoverage &&
    result.settledMergedInstanceBindGroupCreates === 0 &&
    result.settledMergedMaterialBindGroupCreates === 0 &&
    // C9-17 Slice B — settled geometry validation is via the revision fast path
    // (walk hits stay flat) and the fast path is actually exercised.
    result.settledGeometryWalkHits === 0 &&
    result.settledGeometryRevisionHits > 0 &&
    result.identitiesStable &&
    result.deviceErrors.length === 0 &&
    result.pageErrors.length === 0;
  if (!pass) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
