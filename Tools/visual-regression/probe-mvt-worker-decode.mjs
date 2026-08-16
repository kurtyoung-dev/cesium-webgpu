// probe-mvt-worker-decode.mjs
// NS-MVT-SYNC-DECODE-OFFTHREAD-WASM — acceptance probe for off-thread MVT decode.
// @purpose Acceptance for the opt-in decodeInWorker MVT path: a dedicated worker is actually created and the tile still renders at cross-backend parity.
// @status ACTIVE
//
// Verifies the opt-in `decodeInWorker: true` path on MVTDataProvider:
//   1. A dedicated web worker (Workers/decodeMVTTile.js) is actually created —
//      i.e. the decode + GLB build no longer run on the main thread.
//   2. The tile still renders (1 polygon feature) on BOTH backends, and the
//      WebGL vs WebGPU pixel diff stays at the noise floor (parity preserved).
//
// Reuses the synthetic single-polygon MVT tile from
// probe-mvt-datasource-parity.mjs, served via Playwright request routing.
//
//   node Tools/visual-regression/probe-mvt-worker-decode.mjs
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

// --- Synthesize one MVT tile (mirrors probe-mvt-datasource-parity.mjs) ------
function encodeVarint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return bytes;
}
const encodeTag = (f, w) => encodeVarint((f << 3) | w);
const encodeUInt = (f, v) => [...encodeTag(f, 0), ...encodeVarint(v)];
function encodeBytes(f, vb) {
  return [...encodeTag(f, 2), ...encodeVarint(vb.length), ...vb];
}
function encodeString(f, v) {
  const bytes = [];
  for (let i = 0; i < v.length; i++) bytes.push(v.charCodeAt(i));
  return encodeBytes(f, bytes);
}
function encodePackedVarints(f, values) {
  const payload = [];
  for (let i = 0; i < values.length; i++)
    payload.push(...encodeVarint(values[i]));
  return encodeBytes(f, payload);
}
function encodeFeature(o) {
  const bytes = [];
  if (o.tags && o.tags.length > 0)
    bytes.push(...encodePackedVarints(2, o.tags));
  bytes.push(...encodeUInt(3, o.type));
  bytes.push(...encodePackedVarints(4, o.geometryCommands));
  return bytes;
}
function encodeLayer(o) {
  const bytes = [];
  bytes.push(...encodeString(1, o.name));
  for (const f of o.features) bytes.push(...encodeBytes(2, f));
  bytes.push(...encodeUInt(5, o.extent ?? 4096));
  bytes.push(...encodeUInt(15, 2));
  return bytes;
}
function encodeTile(layers) {
  const bytes = [];
  for (const l of layers) bytes.push(...encodeBytes(3, l));
  return new Uint8Array(bytes);
}
const polygonFeature = encodeFeature({
  type: 3,
  geometryCommands: [9, 3200, 3200, 26, 1800, 0, 0, 1800, 1799, 0, 15],
});
const MVT_BYTES = encodeTile([
  encodeLayer({ name: "probe", features: [polygonFeature], extent: 4096 }),
]);
const MVT_B64 = Buffer.from(MVT_BYTES).toString("base64");

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  const workerUrls = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 160));
  });
  // Signal that decode moved off the main thread: a dedicated worker is spawned.
  page.on("worker", (w) => workerUrls.push(w.url()));

  const mvtBuf = Buffer.from(MVT_B64, "base64");
  await page.route("**/mvt-probe/**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/x-protobuf",
      body: mvtBuf,
    });
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const info = await page.evaluate(
    async ([base]) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.useDefaultRenderLoop = false;
      const s = v.scene;
      s.globe.show = false;
      s.skyBox.show = false;
      s.skyAtmosphere.show = false;
      s.sun.show = false;
      s.moon.show = false;
      s.fog.enabled = false;
      s.backgroundColor = C.Color.BLACK.clone();

      let provider;
      try {
        provider = await C.MVTDataProvider.fromUrl(
          `${base}/mvt-probe/{z}/{x}/{y}.pbf`,
          { minZoom: 0, maxZoom: 0, decodeInWorker: true }, // <-- opt-in off-thread
        );
        provider.tileset.maximumScreenSpaceError = 1;
        s.primitives.add(provider.tileset);
      } catch (e) {
        return { loadError: String(e).slice(0, 240) };
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 0, 9000000),
      });

      for (let i = 0; i < 400; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const st = provider.tileset.statistics ?? {};
      return {
        decodeInWorker: provider._decodeInWorker,
        numberOfTilesWithContentReady: st.numberOfTilesWithContentReady,
        numberOfFeaturesSelected: st.numberOfFeaturesSelected,
        geometryByteLength: st.geometryByteLength,
      };
    },
    [BASE],
  );

  const canvas = await page.$("canvas");
  const buf = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_mvt-worker-${renderer}.png`, buf);

  const nonBlack = await page.evaluate(
    async (dataUrl) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0,
        total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
      }
      return ((lit / total) * 100).toFixed(2);
    },
    "data:image/png;base64," + buf.toString("base64"),
  );

  await browser.close();
  const decodeWorkerSpawned = workerUrls.some((u) =>
    u.includes("decodeMVTTile"),
  );
  return { info, errs, litPct: nonBlack, decodeWorkerSpawned, workerUrls };
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL (decodeInWorker) ===");
console.log(JSON.stringify(webgl.info));
console.log(
  "litPct:",
  webgl.litPct,
  "decodeWorkerSpawned:",
  webgl.decodeWorkerSpawned,
  "errs:",
  webgl.errs.length,
  webgl.errs.slice(0, 3),
);
console.log("=== WebGPU (decodeInWorker) ===");
console.log(JSON.stringify(webgpu.info));
console.log(
  "litPct:",
  webgpu.litPct,
  "decodeWorkerSpawned:",
  webgpu.decodeWorkerSpawned,
  "errs:",
  webgpu.errs.length,
  webgpu.errs.slice(0, 3),
);

// Pixel-diff the two canvases (same crop as the parity probe).
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const diff = await page.evaluate(
  async ([a, b]) => {
    async function decode(dataUrl) {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        d: ctx.getImageData(0, 0, cv.width, cv.height).data,
        w: cv.width,
      };
    }
    const A = await decode(a);
    const B = await decode(b);
    const cx0 = 210,
      cx1 = 530,
      cy0 = 80,
      cy1 = 500;
    let mism = 0,
      total = 0;
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        const i = (y * A.w + x) * 4;
        total++;
        const dr = Math.abs(A.d[i] - B.d[i]);
        const dg = Math.abs(A.d[i + 1] - B.d[i + 1]);
        const db = Math.abs(A.d[i + 2] - B.d[i + 2]);
        if (dr + dg + db > 60) mism++;
      }
    }
    return { mismatchPctCropped: ((mism / total) * 100).toFixed(2) };
  },
  [
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_mvt-worker-webgl.png`).toString("base64"),
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_mvt-worker-webgpu.png`).toString("base64"),
  ],
);
await browser.close();
console.log("=== DIFF ===");
console.log(JSON.stringify(diff));

// PASS gate.
const pass =
  webgl.decodeWorkerSpawned &&
  webgpu.decodeWorkerSpawned &&
  webgl.info.numberOfFeaturesSelected === 1 &&
  webgpu.info.numberOfFeaturesSelected === 1 &&
  webgl.errs.length === 0 &&
  webgpu.errs.length === 0 &&
  parseFloat(diff.mismatchPctCropped) < 1.0;
console.log(pass ? "\nPROBE PASS" : "\nPROBE FAIL");
process.exit(pass ? 0 : 1);
