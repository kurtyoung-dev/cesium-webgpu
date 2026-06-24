// C2-3 NEW-WEBGPU-KHR-MATERIALS-UNLIT-BLACK regression sentinel.
//
// The original report claimed KHR_materials_unlit glTF models render BLACK on
// WebGPU. Investigation (Campaign 2) proved the WebGPU unlit path already exists
// end-to-end (shipped git Batch 119): GltfLoader sets material.unlit,
// ModelMaterialInfo computes IS_UNLIT (also forced when a primitive has no
// NORMAL), WebGPUModelRenderer plumbs FLAG_IS_UNLIT, and ModelPBRComplete.wgsl
// has an unlit early-out that outputs baseColor*vertexColor. So the bug is STALE.
//
// This probe is the permanent guard: it loads an unlit KHR_materials_unlit quad
// with a VEC3 COLOR_0 gradient on both backends and FAILS (nonzero exit) if
// WebGPU ever goes black again, or diverges from WebGL.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-unlit-vertexcolor.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Tools/visual-regression/assets/unlit-vec3color-quad.gltf";

async function capture(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle", timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(async ({ modelUrl }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer; const s = v.scene;
    s.requestRenderMode = false;
    s.globe.show = false; s.skyBox.show = false; s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    s.backgroundColor = C.Color.BLACK;
    for (const sel of [".cesium-viewer-toolbar", ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer", ".cesium-viewer-bottom", ".cesium-viewer-fullscreenContainer"]) {
      document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
    }
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(-75, 40, 0));
    const model = await C.Model.fromGltfAsync({ url: modelUrl, modelMatrix, scale: 6.0 });
    s.primitives.add(model);
    for (let i = 0; i < 500 && !model.ready; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); }
    v.camera.viewBoundingSphere(model.boundingSphere, new C.HeadingPitchRange(0.6, -0.5, model.boundingSphere.radius * 3.0));
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    for (let i = 0; i < 60; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); }
    return { ready: !!model.ready, rendererType: s.context.rendererType };
  }, { modelUrl: MODEL });

  const decoded = await page.evaluate(async () => {
    const v = window.viewer;
    const b64 = await new Promise((res) => {
      const rm = v.scene.postRender.addEventListener(() => { rm(); try { res(v.scene.canvas.toDataURL("image/png").split(",")[1]); } catch (e) { res(null); } });
      v.scene.requestRender(); v.scene.render();
    });
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = off.getContext("2d"); cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d), b64 };
  });
  await browser.close();
  return { info, errs, decoded };
}

function meanColor(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
    if (lum <= 12) continue;
    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
  }
  return { px: n, r: n ? +(r / n).toFixed(1) : 0, g: n ? +(g / n).toFixed(1) : 0, b: n ? +(b / n).toFixed(1) : 0 };
}

const wgpu = await capture("webgpu");
const wgl = await capture("webgl");
const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
if (wgpu.decoded?.b64) fs.writeFileSync("Tools/visual-regression/output/unlit-vertexcolor-webgpu.png", Buffer.from(wgpu.decoded.b64, "base64"));
if (wgl.decoded?.b64) fs.writeFileSync("Tools/visual-regression/output/unlit-vertexcolor-webgl.png", Buffer.from(wgl.decoded.b64, "base64"));

const mGpu = meanColor(wgpu.decoded), mGl = meanColor(wgl.decoded);
const lumGpu = mGpu.r + mGpu.g + mGpu.b;
const dChan = Math.max(Math.abs(mGpu.r - mGl.r), Math.abs(mGpu.g - mGl.g), Math.abs(mGpu.b - mGl.b));

// Gates: (A) WebGPU not black, (B) cross-backend parity.
const notBlack = mGpu.px > 20000 && lumGpu > 30;
const parity = dChan < 25;
const pass = notBlack && parity && wgpu.info.ready;

console.log(JSON.stringify({
  webgpu: { ready: wgpu.info.ready, mean: mGpu, lum: +lumGpu.toFixed(1), errs: wgpu.errs.slice(0, 3) },
  webgl: { ready: wgl.info.ready, mean: mGl },
  maxChannelDelta: +dChan.toFixed(1),
}, null, 2));
console.log(`(A) WebGPU unlit NOT black (px>20000 && lum>30): ${notBlack ? "PASS" : "FAIL"}`);
console.log(`(B) parity maxChannelDelta < 25 (${dChan.toFixed(1)}): ${parity ? "PASS" : "FAIL"}`);
console.log(pass
  ? "GATE PASS — KHR_materials_unlit renders correctly on WebGPU (matches WebGL); the 'unlit black' bug is resolved."
  : "GATE FAIL — KHR_materials_unlit REGRESSED on WebGPU.");
process.exit(pass ? 0 : 1);
