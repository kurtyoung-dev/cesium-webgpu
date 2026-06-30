#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 448) — full-res readback of all 6 cube faces for
// the 3D TILESET capture, so the captured BUILDINGS are visible by eye (the tiled
// 32x32 thumbnails downsample them away). Confirms occlusion: buildings sit OVER
// the terrain, terrain OVER the sky. ON vs OFF written side by side.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TILESET_URL =
  "/Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/tileset.json";

async function capture(captureOn) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const dataUrl = await page.evaluate(async ({ TILESET_URL, captureOn }) => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const scene = window.viewer.scene;
    const ctx = scene.context;
    if (!ctx._options) ctx._options = {};
    ctx._options.webgpu = Object.assign({}, ctx._options.webgpu, { sceneCaptureReflections: captureOn });

    const lon = -75.61209, lat = 40.04253;
    const eyeLon = -75.6149;
    const eyeSurface = Cesium.Cartesian3.fromDegrees(eyeLon, lat, 60);

    const tileset = await Cesium.Cesium3DTileset.fromUrl(TILESET_URL, { maximumScreenSpaceError: 1 });
    scene.primitives.add(tileset);
    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1500),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    for (let i = 0; i < 360; i++) { scene.render(); await new Promise((r) => requestAnimationFrame(r)); }
    const manager = tileset.environmentMapManager;
    manager.enableSceneCapture = true; manager.enabled = true; manager.shouldUpdate = true;
    manager._position = eyeSurface;
    for (let i = 0; i < 90; i++) { scene.render(); manager.update(scene._frameState); await new Promise((r) => requestAnimationFrame(r)); }

    const cache = manager._webgpuCache;
    const device = ctx.device;
    const size = cache.size;
    const arrayView = cache.cubemapTexture.createView({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 6, baseMipLevel: 0, mipLevelCount: 1 });
    const outBuf = device.createBuffer({ size: 6 * size * size * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const wgsl = `
@group(0) @binding(0) var cubeArr: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<u32>;
const SIZE: u32 = ${size}u;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= SIZE || gid.y >= SIZE || gid.z >= 6u) { return; }
  let c = textureLoad(cubeArr, vec2<i32>(i32(gid.x), i32(gid.y)), i32(gid.z), 0);
  let r = u32(clamp(c.r, 0.0, 1.0) * 255.0);
  let g = u32(clamp(c.g, 0.0, 1.0) * 255.0);
  let b = u32(clamp(c.b, 0.0, 1.0) * 255.0);
  let idx = gid.z * SIZE * SIZE + gid.y * SIZE + gid.x;
  outBuf[idx] = r | (g << 8u) | (b << 16u) | (255u << 24u);
}`;
    const module = device.createShaderModule({ code: wgsl });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: arrayView }, { binding: 1, resource: { buffer: outBuf } }] });
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(pipeline); cp.setBindGroup(0, bg);
    cp.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
    cp.end();
    const readBuf = device.createBuffer({ size: 6 * size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 6 * size * size * 4);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const u32 = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    const cols = 6;
    const c = document.createElement("canvas");
    c.width = cols * (size + 2);
    c.height = size + 14;
    const g2 = c.getContext("2d");
    g2.fillStyle = "#000"; g2.fillRect(0, 0, c.width, c.height);
    const names = ["+X E", "-X W", "+Y up", "-Y dn", "+Z N", "-Z S"];
    for (let f = 0; f < 6; f++) {
      const img = g2.createImageData(size, size);
      const u8 = new Uint8ClampedArray(img.data.buffer);
      for (let p = 0; p < size * size; p++) {
        const v = u32[f * size * size + p];
        u8[p * 4] = v & 0xff; u8[p * 4 + 1] = (v >> 8) & 0xff; u8[p * 4 + 2] = (v >> 16) & 0xff; u8[p * 4 + 3] = 255;
      }
      const tmp = document.createElement("canvas"); tmp.width = size; tmp.height = size;
      tmp.getContext("2d").putImageData(img, 0, 0);
      g2.drawImage(tmp, f * (size + 2), 0);
      g2.fillStyle = "#0ff"; g2.font = "11px monospace"; g2.fillText(names[f], f * (size + 2) + 4, size + 11);
    }
    return { url: c.toDataURL("image/png"), records: ctx._webgpuSceneCaptureModels?.models?.reduce((a, m) => a + (m.records?.length ?? 0), 0) ?? 0, entries: ctx._webgpuSceneCaptureModels?.models?.length ?? 0 };
  }, { TILESET_URL, captureOn });

  const b64 = dataUrl.url.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(path.join(OUT_DIR, `probe-tileset-capture-face-zoom-${captureOn ? "on" : "off"}.png`), Buffer.from(b64, "base64"));
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { errs, records: dataUrl.records, entries: dataUrl.entries };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const on = await capture(true);
  const off = await capture(false);
  console.log(`[tileset-face-zoom] ON: entries=${on.entries} records=${on.records} errors=${on.errs.length}`);
  on.errs.slice(0, 6).forEach((e) => console.log("   ", e.t, e.text));
  console.log(`[tileset-face-zoom] OFF: entries=${off.entries} records=${off.records} errors=${off.errs.length}`);
  console.log("  wrote probe-tileset-capture-face-zoom-on.png / -off.png");
})();
