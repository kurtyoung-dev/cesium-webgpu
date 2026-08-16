/**
 * Q1-KTX2-TRANSCODER-FORMATS regression probe.
 * @purpose Standing regression guard that loadKTX2 requires the per-context immutable ktx2TranscodeTargets record and resolves a real .ktx2 on WebGPU
 * @status ACTIVE
 *
 * Premise (FAR-104): KTX2 target selection must come from the consuming
 * context. A process-global "last renderer" format set races when WebGL and
 * WebGPU contexts coexist, so loadKTX2 deliberately requires the immutable
 * context.graphicsCapabilities.ktx2TranscodeTargets record.
 *
 * This probe is the standing REGRESSION guard for that gate. It:
 *   1. Boots the WebGPU CesiumViewer and captures its target record.
 *   2. Calls loadKTX2() with that record on a real .ktx2 asset and asserts it
 *      resolves to a CompressedTextureBuffer (width/height/bufferView).
 *
 * Gates:
 *   (A) viewer is WebGPU (scene.context.isWebGPU === true).
 *   (B) loadKTX2 resolves; result has width/height/bufferView.
 *   (C) An immutable, keyed target record was supplied with no target error.
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
  const targets = scene.context.graphicsCapabilities.ktx2TranscodeTargets;

  let loaded = null;
  let err = null;
  try {
    const res = await C.loadKTX2(ktx2Url, targets);
    // loadKTX2 shape varies with the source:
    //   - plain 2D:        a single CompressedTextureBuffer
    //   - 2D + mips:       an array of CompressedTextureBuffers (per mip)
    //   - cubemap (+mips): an array of per-mip objects keyed by cube face
    //     (positiveX/negativeX/…), each value a CompressedTextureBuffer.
    // Dig to one real CompressedTextureBuffer leaf and read its getters.
    const findLeaf = (o) => {
      if (
        o &&
        typeof o.bufferView !== "undefined" &&
        typeof o.width === "number"
      ) {
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
      : {
          shape,
          width: 0,
          height: 0,
          internalFormat: "none",
          hasBufferView: false,
        };
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }
  return {
    isWebGPU,
    targetKey: targets.cacheKey,
    targetsFrozen: Object.isFrozen(targets),
    loaded,
    err,
  };
}, KTX2);

await browser.close();

console.log(JSON.stringify(result, null, 2));

const a = result.isWebGPU === true;
const b =
  result.loaded !== null &&
  result.loaded.width > 0 &&
  result.loaded.height > 0 &&
  result.loaded.hasBufferView;
const c =
  result.targetsFrozen === true &&
  /^ktx2-[0-9a-f]+$/.test(result.targetKey) &&
  !(result.err && /supportedTargetFormats/i.test(result.err));

console.log(`(A) context is WebGPU: ${a ? "PASS" : "FAIL"}`);
console.log(
  `(B) loadKTX2 resolved with a valid buffer: ${b ? "PASS" : "FAIL"}`,
);
console.log(
  `(C) immutable keyed context targets supplied: ${c ? "PASS" : "FAIL"}`,
);
if (result.err) console.log(`    (loadKTX2 error was: ${result.err})`);

const pass = a && b && c;
console.log(
  pass
    ? "GATE PASS — loadKTX2 transcodes with explicit WebGPU context targets"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
