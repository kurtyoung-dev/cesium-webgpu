// DIAG (item 375): dump the loadKTX2 cube buffer shape + the IBL load-chain
// intermediate state, to pin why the KTX2 specular cube never goes ready.
// @purpose Dumps loadKTX2 cube buffer shape + IBL load-chain intermediate state to pin why the KTX2 specular cube never went ready.
// @status INVESTIGATION
//
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const KTX2 = "/Specs/Data/EnvironmentMap/kiara_6_afternoon_2k_ibl.ktx2";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(
  async ({ modelUrl, ktx2 }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.globe.show = false;
    s.skyBox.show = false;
    s.backgroundColor = C.Color.BLACK;
    // Direct loadKTX2 to inspect the raw resolved shape.
    let rawShape;
    try {
      const buffers = await C.loadKTX2(ktx2);
      const describe = (x) =>
        x && typeof x === "object"
          ? {
              keys: Object.keys(x).slice(0, 12),
              isArray: Array.isArray(x),
              len: Array.isArray(x) ? x.length : undefined,
            }
          : { typeof: typeof x };
      rawShape = {
        top: describe(buffers),
        el0: Array.isArray(buffers)
          ? describe(buffers[0])
          : describe(buffers?.positiveX),
        px: Array.isArray(buffers)
          ? describe(buffers[0]?.positiveX)
          : Array.isArray(buffers?.positiveX)
            ? describe(buffers.positiveX[0])
            : describe(buffers?.positiveX),
        pxFields: (() => {
          const p = Array.isArray(buffers)
            ? buffers[0]?.positiveX
            : Array.isArray(buffers?.positiveX)
              ? buffers.positiveX[0]
              : buffers?.positiveX;
          if (!p) return null;
          return {
            width: p.width,
            height: p.height,
            hasABV: !!p.arrayBufferView,
            abvCtor: p.arrayBufferView?.constructor?.name,
            abvLen: p.arrayBufferView?.byteLength,
            pixelDatatype: p.pixelDatatype,
            internalFormat: p.internalFormat,
          };
        })(),
      };
    } catch (e) {
      rawShape = { error: String(e) };
    }

    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(-75, 40, 0),
    );
    const model = await C.Model.fromGltfAsync({
      url: modelUrl,
      modelMatrix,
      scale: 1.0,
    });
    const ibl = model.imageBasedLighting;
    ibl.imageBasedLightingFactor = new C.Cartesian2(1.0, 1.0);
    ibl.specularEnvironmentMaps = ktx2;
    s.primitives.add(model);
    for (let i = 0; i < 600 && !model.ready; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 320; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const sec = ibl._specularEnvironmentCubeMap;
    return {
      rawShape,
      chain: {
        specularEnvironmentMaps: ibl._specularEnvironmentMaps,
        hasCubeInstance: !!sec,
        cubeReady: sec?.ready,
        cube_ready: sec?._ready,
        loading: ibl._webgpuSpecularKTX2Loading,
        hasBuffers: !!ibl._webgpuSpecularKTX2Buffers,
        hasTexture: !!sec?._texture,
        hasWebgpuView: !!sec?._texture?._webgpuTexture?.view,
        webgpuMaxMipLevel: ibl._webgpuMaxMipLevel,
      },
    };
  },
  { modelUrl: MODEL, ktx2: KTX2 },
);

console.log(JSON.stringify(out, null, 2));
console.log("errors:", errs.length, errs.slice(0, 4));
await browser.close();
