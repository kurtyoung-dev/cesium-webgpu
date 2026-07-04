/**
 * Q1-KTX2-TRANSCODER-FORMATS regression probe.
 *
 * Premise (ROADMAP s3 #1 / s4.3): loadKTX2() throws
 * "supportedTargetFormats is required" for ANY KTX2 on a WebGPUContext because
 * the transcoder guards on a module-level format set that historically only the
 * WebGL Context.js populated. The fix (Batch 370, C2-1) calls
 * loadKTX2.setKTX2SupportedFormats(...) from WebGPUContext._updateFeatureFlags()
 * after device creation, mirroring WebGL Context.js init.
 *
 * This probe is the standing REGRESSION guard for that gate. It:
 *   1. Boots the WebGPU CesiumViewer (proves a WebGPUContext initialized →
 *      _updateFeatureFlags ran → setKTX2SupportedFormats registered).
 *   2. Calls loadKTX2() on a real .ktx2 asset and asserts it RESOLVES to a
 *      CompressedTextureBuffer (width/height/bufferView) with NO
 *      "supportedTargetFormats is required" rejection.
 *
 * Gates:
 *   (A) viewer is WebGPU (scene.context.isWebGPU === true).
 *   (B) loadKTX2 resolves; result has width/height/bufferView.
 *   (C) NO "supportedTargetFormats" error surfaced.
 *
 * Usage: node Tools/visual-regression/probe-ktx2-transcoder-formats.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const KTX2 = "/Specs/Data/EnvironmentMap/kiara_6_afternoon_2k_ibl.ktx2";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const result = await page.evaluate(async (ktx2Url) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const scene = window.viewer.scene;
  // Ensure the context finished init (feature flags updated on device create).
  scene.render();
  const isWebGPU = !!scene.context.isWebGPU;

  let loaded = null;
  let err = null;
  try {
    const res = await C.loadKTX2(ktx2Url);
    // loadKTX2 shape varies with the source:
    //   - plain 2D:        a single CompressedTextureBuffer
    //   - 2D + mips:       an array of CompressedTextureBuffers (per mip)
    //   - cubemap (+mips): an array of per-mip objects keyed by cube face
    //     (positiveX/negativeX/…), each value a CompressedTextureBuffer.
    // Dig to one real CompressedTextureBuffer leaf and read its getters.
    const findLeaf = (o) => {
      if (o && typeof o.bufferView !== "undefined" && typeof o.width === "number") {
        return o;
      }
      if (Array.isArray(o)) {
        return o.length ? findLeaf(o[0]) : null;
      }
      if (o && typeof o === "object") {
        for (const k of Object.keys(o)) {
          const hit = findLeaf(o[k]);
          if (hit) return hit;
        }
      }
      return null;
    };
    const leaf = findLeaf(res);
    const shape = Array.isArray(res)
      ? `array[${res.length}]${res[0] && !Array.isArray(res[0]) && typeof res[0] === "object" ? " of face-objects" : ""}`
      : "single";
    loaded = leaf
      ? {
          shape,
          width: leaf.width,
          height: leaf.height,
          internalFormat: String(leaf.internalFormat),
          hasBufferView: !!leaf.bufferView,
        }
      : { shape, width: 0, height: 0, internalFormat: "none", hasBufferView: false };
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }
  return { isWebGPU, loaded, err };
}, KTX2);

await browser.close();

console.log(JSON.stringify(result, null, 2));

const a = result.isWebGPU === true;
const b =
  result.loaded !== null &&
  result.loaded.width > 0 &&
  result.loaded.height > 0 &&
  result.loaded.hasBufferView;
const c = !(result.err && /supportedTargetFormats/i.test(result.err));

console.log(`(A) context is WebGPU: ${a ? "PASS" : "FAIL"}`);
console.log(`(B) loadKTX2 resolved with a valid buffer: ${b ? "PASS" : "FAIL"}`);
console.log(`(C) no "supportedTargetFormats is required" throw: ${c ? "PASS" : "FAIL"}`);
if (result.err) console.log(`    (loadKTX2 error was: ${result.err})`);

const pass = a && b && c;
console.log(
  pass
    ? "GATE PASS — loadKTX2 transcodes on a WebGPU context (transcode formats registered)"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
