// C10-05 PRE/POST evidence — inspect model MATERIAL texture mip chains + path.
// Loads textured glTF assets in WebGPU, walks each primitive's matInfo readers
// to the stub-backed GPUTexture, and reports:
//   - path: "stub" (reader.texture._texture._webgpuTexture present) or "fallback"
//   - mipLevelCount / dims of the baseColor (and other) material textures
//   - the glTF sampler min-filter (whether mipmaps are expected for parity)
//
// This proves whether a mip chain already EXISTS on the live allocation path
// (the shader-prong precondition) and which createGPUTextureFromReader branch
// real model textures take (STOP-AND-BLOCK #3).
//
//   node Tools/visual-regression/probe-model-mip-inspect.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

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
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.show = false;
    scene.requestRenderMode = false;

    const base = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
    );
    const mm = (east) =>
      C.Matrix4.multiplyByTranslation(
        base,
        new C.Cartesian3(east, 0.0, 300_000.0),
        new C.Matrix4(),
      );

    const specs = [
      {
        name: "BoxTextured",
        url: "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
        east: -500_000,
      },
      {
        name: "Duck",
        url: "/Specs/Data/Models/glTF-2.0/Duck/glTF-Binary/Duck.glb",
        east: 0,
      },
    ];
    const models = [];
    for (const spec of specs) {
      try {
        const model = await C.Model.fromGltfAsync({
          url: spec.url,
          modelMatrix: mm(spec.east),
          scale: 300_000.0,
        });
        scene.primitives.add(model);
        models.push({ name: spec.name, model });
      } catch (e) {
        models.push({ name: spec.name, error: String(e) });
      }
    }

    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    function minFilterName(f) {
      const map = {
        9728: "NEAREST",
        9729: "LINEAR",
        9984: "NEAREST_MIPMAP_NEAREST",
        9985: "LINEAR_MIPMAP_NEAREST",
        9986: "NEAREST_MIPMAP_LINEAR",
        9987: "LINEAR_MIPMAP_LINEAR",
      };
      return map[f] ?? String(f);
    }

    const out = [];
    for (const { name, model, error } of models) {
      if (error) {
        out.push({ name, error });
        continue;
      }
      const prims = Object.values(model._webgpuCache?.primitives ?? {});
      const primInfo = prims.map((pc) => {
        const mi = pc.matInfo || {};
        const slots = {};
        const readerSlots = {
          baseColor: mi.baseColorTextureReader || mi.diffuseTextureReader,
          normal: mi.normalTextureReader,
          metallicRoughness:
            mi.metallicRoughnessTextureReader || mi.specGlossTextureReader,
          emissive: mi.emissiveTextureReader,
          occlusion: mi.occlusionTextureReader,
        };
        for (const [slot, reader] of Object.entries(readerSlots)) {
          if (!reader || !reader.texture) {
            continue;
          }
          const cesiumTex = reader.texture;
          const stub = cesiumTex._texture && cesiumTex._texture._webgpuTexture;
          const sampler = cesiumTex._sampler || cesiumTex.sampler;
          slots[slot] = {
            path: stub ? "stub" : "fallback",
            mipLevelCount: stub ? stub.mipLevelCount : undefined,
            width: stub ? stub.width : undefined,
            height: stub ? stub.height : undefined,
            minFilter: sampler
              ? minFilterName(sampler.minificationFilter ?? sampler.minFilter)
              : "?",
          };
        }
        return { ready: model.ready, defines: pc.materialDefines | 0, slots };
      });
      out.push({ name, ready: model.ready, primitives: primInfo });
    }
    return out;
  });

  console.log(JSON.stringify({ models: result, pageErrors }, null, 2));
} finally {
  await browser.close();
}
