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
    let allBindGroupCreates = 0;
    const originalCreateBindGroup = device.createBindGroup.bind(device);
    device.createBindGroup = function (descriptor) {
      allBindGroupCreates++;
      if (descriptor?.label === "Model merged instance bind group") {
        mergedCreates++;
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

    const before = cacheSnapshot();
    mergedCreates = 0;
    allBindGroupCreates = 0;
    await renderFrames(40);
    const after = cacheSnapshot();

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
      settledAllBindGroupCreates: allBindGroupCreates,
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
    result.identitiesStable &&
    result.deviceErrors.length === 0 &&
    result.pageErrors.length === 0;
  if (!pass) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
