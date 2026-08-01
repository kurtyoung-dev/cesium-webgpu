// probe-mvt-datasource-parity.mjs
// C4-MVT-WEBGPU-PARITY-PROBE (Q25 / R-4) — diagnostic parity probe.
//
// Verifies the inherited runtime MVT pipeline renders identically on WebGL and
// WebGPU:  MVTDataProvider.fromUrl -> decodeMVT (SYNCHRONOUS) ->
// buildVectorGltfFromMVT -> VectorGltf3DTileContent (BufferPolygon path).
//
// No real .pbf fixtures exist in the repo, so this probe synthesizes a single
// Mapbox Vector Tile (a big white polygon covering most of tile 0/0/0) using the
// same varint/tag encoders the unit specs use, and serves it via Playwright
// request routing for the {z}/{x}/{y} tile URL the provider derives. The globe,
// sky, and atmosphere are all disabled so the polygon renders against black —
// removing the globe-coplanar z-fight confound noted in
// probe-bufferpolygon-vector-tile.mjs. That isolates the MVT decode+build+render
// path so any cross-backend delta is a real MVT parity bug.
//
//   node Tools/visual-regression/probe-mvt-datasource-parity.mjs
//
// PASS: both backends decode 1 layer / 1 polygon feature, render a non-trivial
// white footprint, log 0 device/console errors, and the WebGL vs WebGPU pixel
// diff is at the noise floor (< ~1%).
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

// ---------------------------------------------------------------------------
// Synthesize one MVT tile (protobuf) with a single large polygon.
// Encoders mirror packages/engine/Specs/Scene/decodeMVTSpec.js.
// ---------------------------------------------------------------------------
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
function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}
function encodeUInt(fieldNumber, value) {
  return [...encodeTag(fieldNumber, 0), ...encodeVarint(value)];
}
function encodeBytes(fieldNumber, valueBytes) {
  return [
    ...encodeTag(fieldNumber, 2),
    ...encodeVarint(valueBytes.length),
    ...valueBytes,
  ];
}
function encodeString(fieldNumber, value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) bytes.push(value.charCodeAt(i));
  return encodeBytes(fieldNumber, bytes);
}
function encodePackedVarints(fieldNumber, values) {
  const payload = [];
  for (let i = 0; i < values.length; i++)
    payload.push(...encodeVarint(values[i]));
  return encodeBytes(fieldNumber, payload);
}
function encodeFeature(options) {
  const bytes = [];
  if (options.tags && options.tags.length > 0) {
    bytes.push(...encodePackedVarints(2, options.tags));
  }
  bytes.push(...encodeUInt(3, options.type));
  bytes.push(...encodePackedVarints(4, options.geometryCommands));
  return bytes;
}
function encodeLayer(options) {
  const bytes = [];
  bytes.push(...encodeString(1, options.name));
  for (const f of options.features) bytes.push(...encodeBytes(2, f));
  bytes.push(...encodeUInt(5, options.extent ?? 4096));
  bytes.push(...encodeUInt(15, 2)); // version
  return bytes;
}
function encodeTile(layers) {
  const bytes = [];
  for (const l of layers) bytes.push(...encodeBytes(3, l));
  return new Uint8Array(bytes);
}

// Compact centered square in tile 0/0/0 (extent 4096, origin top-left):
//   A(1600,1600) B(2500,1600) C(2500,2500) D(1600,2500), closed.
// Centered on tile (2048,2048) == lon 0 / lat 0, ~900/4096 of the world wide so
// it frames as a clear filled quad near screen centre (not a full-world sliver).
// MVT geometry commands (relative, zigzag-encoded params):
//   MoveTo(1)=9 -> zz(1600)=3200, zz(1600)=3200
//   LineTo(3)=26 -> zz(900)=1800,zz(0)=0, 0,1800, zz(-900)=1799,0
//   ClosePath(1)=15
const polygonFeature = encodeFeature({
  type: 3, // POLYGON
  geometryCommands: [9, 3200, 3200, 26, 1800, 0, 0, 1800, 1799, 0, 15],
});
const layer = encodeLayer({
  name: "probe",
  features: [polygonFeature],
  extent: 4096,
});
const MVT_BYTES = encodeTile([layer]);
const MVT_B64 = Buffer.from(MVT_BYTES).toString("base64");

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 160));
  });

  // Serve the synthetic MVT tile for every {z}/{x}/{y}.pbf request.
  const mvtBuf = Buffer.from(MVT_B64, "base64");
  let tileRequests = 0;
  await page.route("**/mvt-probe/**", (route) => {
    tileRequests++;
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
    async ([base, tmpl]) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.useDefaultRenderLoop = false;
      const s = v.scene;
      // Isolate the MVT polygon against black.
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
          { minZoom: 0, maxZoom: 0 },
        );
        // Force refinement to the single content tile regardless of altitude.
        provider.tileset.maximumScreenSpaceError = 1;
        s.primitives.add(provider.tileset);
      } catch (e) {
        return { loadError: String(e).slice(0, 240) };
      }

      // Look straight down at the tile centre.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 0, 9000000),
      });

      for (let i = 0; i < 400; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const ts = provider.tileset;
      const st = ts.statistics ?? {};
      const cl = s.frameState?.commandList ?? [];
      const owners = {};
      for (const c of cl) {
        const n = c?.owner?.constructor?.name ?? "(none)";
        owners[n] = (owners[n] || 0) + 1;
      }
      return {
        tmpl,
        numberOfTilesProcessed: st.numberOfTilesProcessed,
        numberOfTilesWithContentReady: st.numberOfTilesWithContentReady,
        numberOfFeaturesSelected: st.numberOfFeaturesSelected,
        geometryByteLength: st.geometryByteLength,
        ownerTypes: owners,
        commandCount: cl.length,
      };
    },
    [BASE, `${BASE}/mvt-probe/{z}/{x}/{y}.pbf`],
  );
  info.tileRequestsNode = tileRequests;

  const canvas = await page.$("canvas");
  const buf = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_mvt-${renderer}.png`, buf);

  // Count non-black (white polygon) pixels to confirm something rendered.
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
      return { litPct: ((lit / total) * 100).toFixed(2) };
    },
    "data:image/png;base64," + buf.toString("base64"),
  );

  await browser.close();
  return { info, errs, litPct: nonBlack.litPct };
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL ===");
console.log(JSON.stringify(webgl.info, null, 1));
console.log(
  "litPct:",
  webgl.litPct,
  "errs:",
  webgl.errs.length,
  webgl.errs.slice(0, 3),
);
console.log("=== WebGPU ===");
console.log(JSON.stringify(webgpu.info, null, 1));
console.log(
  "litPct:",
  webgpu.litPct,
  "errs:",
  webgpu.errs.length,
  webgpu.errs.slice(0, 3),
);

// Pixel-diff the two canvases.
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
        h: cv.height,
      };
    }
    const A = await decode(a);
    const B = await decode(b);
    // Crop to the polygon interior so the diff reflects render parity and not
    // the live clock text / attribution / right help-panel UI chrome.
    const cx0 = 210,
      cx1 = 530,
      cy0 = 80,
      cy1 = 500;
    const w = A.w;
    let mism = 0,
      total = 0;
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        const i = (y * w + x) * 4;
        total++;
        const dr = Math.abs(A.d[i] - B.d[i]);
        const dg = Math.abs(A.d[i + 1] - B.d[i + 1]);
        const db = Math.abs(A.d[i + 2] - B.d[i + 2]);
        if (dr + dg + db > 60) mism++;
      }
    }
    return {
      mismatchPctCropped: ((mism / total) * 100).toFixed(2),
      crop: [cx0, cy0, cx1, cy1],
      w: A.w,
      h: A.h,
    };
  },
  [
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_mvt-webgl.png`).toString("base64"),
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_mvt-webgpu.png`).toString("base64"),
  ],
);
await browser.close();
console.log("=== DIFF ===");
console.log(JSON.stringify(diff));
