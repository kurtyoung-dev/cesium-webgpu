// probe-geojson-primitive.mjs
// GeoJsonPrimitive WebGPU visual-regression probe (WEBGPU_PARITY_AUDIT_2026-06
// §5 P1 "GeoJsonPrimitive WebGPU visual-regression probe + Sandcastle demo").
// @purpose Loads a mixed GeoJSON FeatureCollection through GeoJsonPrimitive on both backends; gates capacity math (ERR_CAPACITY) and cross-backend pixel diff
// @status ACTIVE
//
//   node Tools/visual-regression/probe-geojson-primitive.mjs
//
// Per CLAUDE.md Principle 8, the GeoJsonPrimitive render path must be Playwright-
// verified before it can be claimed working. This probe loads a single mixed
// `FeatureCollection` — Point + MultiPoint + LineString + MultiLineString +
// Polygon-with-hole + MultiPolygon — through `GeoJsonPrimitive.fromGeoJson` on
// BOTH backends, frames the continental US, captures each canvas, and computes
// a WebGL<->WebGPU pixel diff.
//
// Why this exact feature mix: `parseGeoJson` accumulates per-feature
// polygonVertexCount / polygonHoleCount / polygonTriangleCount
// (GeoJsonPrimitive.js:454-467) and feeds them to the collection capacities at
// L108-118 (`primitiveCountMax` / `vertexCountMax` / `holeCountMax` /
// `triangleCountMax`). A polygon-with-hole drives holeCount > 0 and bumps the
// triangle count past the no-hole earcut result; a MultiPolygon drives
// polygonCount > featureCount and accumulates positions across parts. If the
// allocation math under-counts, `BufferPolygon.add` trips the `ERR_CAPACITY`
// assert ("BufferPrimitiveCollection capacity exceeded.") at LOAD time — which
// this probe catches and reports as a hard FAIL.
//
// This probe is meant to run AFTER batch-bufferprimitive-parity (alpha /
// blendOption / world-space boundingVolume) so the diff also exercises those
// changes end-to-end through the loader. The fill uses an opaque polygon color
// so the OPAQUE-pass selection is exercised.
//
// Expected: both backends load the same feature/geometry counts with zero
// ERR_CAPACITY and zero console/device errors; the diff sits under
// ACCEPT_PCT (coplanar depth-tie behavior differs slightly between the default
// WebGL depth func LESS and WebGPU "less-equal", so a small diff is normal).
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
// Accept threshold for the WebGL<->WebGPU pixel diff. The polygon fills sit on
// the globe surface (GeoJSON 2D coords clamp to height 0), so the two backends
// resolve coplanar depth ties differently — WebGPU's "less-equal" wins ties the
// default WebGL depth func LESS loses, producing a z-fight shimmer on WebGL
// along the filled regions (see the probe-bufferpolygon-vector-tile note for
// the same effect). The geometry footprint is small relative to the 800x600
// frame, so the diff stays modest; this ceiling is intentionally forgiving
// because the PRIMARY acceptance signal is the per-backend count match + zero
// ERR_CAPACITY below, not the pixel delta.
const ACCEPT_PCT = 15.0;

// Mixed FeatureCollection exercising every parseGeoJson allocation path.
// Geometry is clustered over the continental US so one camera frames it all.
// Distinct feature colors make the hole + MultiPolygon visually confirmable in
// the output PNGs (the inner ring must show the globe through it; the second
// MultiPolygon part must be present).
const FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { kind: "point", color: "#ff3030" },
      geometry: { type: "Point", coordinates: [-118.24, 34.05] },
    },
    {
      type: "Feature",
      properties: { kind: "multipoint", color: "#ff8c00" },
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [-112.07, 33.45],
          [-115.14, 36.17],
          [-111.89, 40.76],
        ],
      },
    },
    {
      type: "Feature",
      properties: { kind: "linestring", color: "#30ff30" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-122.42, 37.77],
          [-104.99, 39.74],
          [-87.65, 41.85],
        ],
      },
    },
    {
      type: "Feature",
      properties: { kind: "multilinestring", color: "#00e5ff" },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-95.37, 29.76],
            [-90.07, 29.95],
          ],
          [
            [-80.19, 25.76],
            [-81.66, 30.33],
          ],
        ],
      },
    },
    {
      // Polygon WITH A HOLE — outer ring CCW, inner ring (hole) defines a
      // cut-out. Drives polygonHoleCount += 1 and a non-trivial triangle count.
      type: "Feature",
      properties: { kind: "polygon-with-hole", color: "#ffe000" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-100.0, 40.0],
            [-94.0, 40.0],
            [-94.0, 45.0],
            [-100.0, 45.0],
            [-100.0, 40.0],
          ],
          [
            [-98.5, 41.5],
            [-95.5, 41.5],
            [-95.5, 43.5],
            [-98.5, 43.5],
            [-98.5, 41.5],
          ],
        ],
      },
    },
    {
      // MultiPolygon — two parts; the SECOND part also carries a hole. Drives
      // polygonCount += 2 for one feature and accumulates positions/holes/
      // triangles across both parts (the multi-part accumulation path).
      type: "Feature",
      properties: { kind: "multipolygon", color: "#c030ff" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-90.0, 32.0],
              [-85.0, 32.0],
              [-85.0, 36.0],
              [-90.0, 36.0],
              [-90.0, 32.0],
            ],
          ],
          [
            [
              [-83.0, 33.0],
              [-78.0, 33.0],
              [-78.0, 37.0],
              [-83.0, 37.0],
              [-83.0, 33.0],
            ],
            [
              [-81.5, 34.2],
              [-79.5, 34.2],
              [-79.5, 35.8],
              [-81.5, 35.8],
              [-81.5, 34.2],
            ],
          ],
        ],
      },
    },
  ],
};

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const info = await page.evaluate(async (featureCollection) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    // Strip atmosphere/sky/fog so the diff isolates the loaded geometry and
    // matches the deterministic capture used by the other buffer probes.
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.fog.enabled = false;

    let loader;
    try {
      loader = C.GeoJsonPrimitive.fromGeoJson(featureCollection);
      s.primitives.add(loader);
    } catch (e) {
      // ERR_CAPACITY ("BufferPrimitiveCollection capacity exceeded.") or any
      // other load-time throw surfaces here — this is the allocation-math
      // failure the probe is built to catch.
      return { loadError: String(e).slice(0, 240) };
    }

    // Color each feature so the hole + MultiPolygon parts are confirmable in
    // the PNG. setMaterial copies the material into the packed buffer, so this
    // must happen before the first render. Reuse a scratch primitive per
    // collection per the BufferPolygonCollection docstring pattern.
    const applyColors = (collection, PrimitiveClass, MaterialClass) => {
      if (!C.defined(collection)) {
        return;
      }
      const scratch = new PrimitiveClass();
      for (let i = 0; i < collection.primitiveCount; i++) {
        const prim = collection.get(i, scratch);
        const fid = prim.featureId;
        const props = loader.getProperties(fid);
        const css = (props && props.color) || "#ffffff";
        prim.setMaterial(
          new MaterialClass({ color: C.Color.fromCssColorString(css) }),
        );
      }
    };
    applyColors(loader.points, C.BufferPoint, C.BufferPointMaterial);
    applyColors(loader.polylines, C.BufferPolyline, C.BufferPolylineMaterial);
    applyColors(loader.polygons, C.BufferPolygon, C.BufferPolygonMaterial);

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98, 38, 6500000),
    });
    // Settle a few hundred frames so imagery + the loader collections render.
    for (let i = 0; i < 240; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Walk the command list, count buffer-primitive owners by class name so we
    // can confirm each collection actually produced draw commands.
    const cl = s.frameState?.commandList ?? [];
    const owners = {};
    for (const c of cl) {
      const n = c?.owner?.constructor?.name ?? "(none)";
      owners[n] = (owners[n] || 0) + 1;
    }

    return {
      rendererType: s._context?.rendererType,
      featureCount: loader.featureCount,
      pointPrimitiveCount: C.defined(loader.points)
        ? loader.points.primitiveCount
        : 0,
      polylinePrimitiveCount: C.defined(loader.polylines)
        ? loader.polylines.primitiveCount
        : 0,
      polygonPrimitiveCount: C.defined(loader.polygons)
        ? loader.polygons.primitiveCount
        : 0,
      polygonVertexCount: C.defined(loader.polygons)
        ? loader.polygons.vertexCount
        : 0,
      polygonHoleCount: C.defined(loader.polygons)
        ? loader.polygons.holeCount
        : 0,
      polygonTriangleCount: C.defined(loader.polygons)
        ? loader.polygons.triangleCount
        : 0,
      ownerTypes: owners,
      commandCount: cl.length,
    };
  }, FEATURE_COLLECTION);

  // Screenshot the canvas only (no UI chrome).
  const canvas = await page.$("canvas");
  const buf = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_geojson-${renderer}.png`, buf);
  await browser.close();
  return { info, errs };
}

if (!fs.existsSync(OUT)) {
  fs.mkdirSync(OUT, { recursive: true });
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL ===");
console.log(JSON.stringify(webgl.info, null, 1));
console.log("errs:", webgl.errs.length, webgl.errs.slice(0, 5));
console.log("=== WebGPU ===");
console.log(JSON.stringify(webgpu.info, null, 1));
console.log("errs:", webgpu.errs.length, webgpu.errs.slice(0, 5));

// Decode both PNGs to RGBA via a headless canvas and diff (no Node PNG dep).
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
    if (A.w !== B.w || A.h !== B.h) {
      return { error: "size mismatch" };
    }
    const n = Math.min(A.d.length, B.d.length);
    let mism = 0,
      total = 0;
    for (let i = 0; i < n; i += 4) {
      total++;
      const dr = Math.abs(A.d[i] - B.d[i]);
      const dg = Math.abs(A.d[i + 1] - B.d[i + 1]);
      const db = Math.abs(A.d[i + 2] - B.d[i + 2]);
      if (dr + dg + db > 60) mism++;
    }
    return { mismatchPct: ((mism / total) * 100).toFixed(2), w: A.w, h: A.h };
  },
  [
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_geojson-webgl.png`).toString("base64"),
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_geojson-webgpu.png`).toString("base64"),
  ],
);
await browser.close();

console.log("=== DIFF ===");
console.log(JSON.stringify(diff));

// Verdict: hard FAIL on any ERR_CAPACITY / load error, console/page errors, a
// count mismatch between backends, or a diff over ACCEPT_PCT. The expected
// counts are derived from FEATURE_COLLECTION above: 4 points (1 Point + 3
// MultiPoint), 3 polylines (1 LineString + 2 MultiLineString parts), 3
// polygons (1 hole-polygon + 2 MultiPolygon parts).
const EXPECTED = {
  featureCount: 6,
  pointPrimitiveCount: 4,
  polylinePrimitiveCount: 3,
  polygonPrimitiveCount: 3,
};
const fails = [];
for (const [side, r] of [
  ["webgl", webgl],
  ["webgpu", webgpu],
]) {
  if (r.info.loadError) {
    fails.push(`${side}: load error: ${r.info.loadError}`);
    continue;
  }
  if (r.errs.length) {
    fails.push(`${side}: ${r.errs.length} console/page errors`);
  }
  for (const k of Object.keys(EXPECTED)) {
    if (r.info[k] !== EXPECTED[k]) {
      fails.push(`${side}: ${k} ${r.info[k]} != expected ${EXPECTED[k]}`);
    }
  }
}
if (diff.error) {
  fails.push(`diff: ${diff.error}`);
} else if (parseFloat(diff.mismatchPct) > ACCEPT_PCT) {
  fails.push(`diff: ${diff.mismatchPct}% > accept ${ACCEPT_PCT}%`);
}

console.log("=== VERDICT ===");
if (fails.length === 0) {
  console.log(
    `PASS — both backends loaded the mixed FeatureCollection (hole + MultiPolygon) ` +
      `with no ERR_CAPACITY and a ${diff.mismatchPct}% diff (< ${ACCEPT_PCT}%). ` +
      `Read _geojson-webgl.png / _geojson-webgpu.png to confirm the hole shows ` +
      `the globe through it and both MultiPolygon parts are present.`,
  );
  process.exitCode = 0;
} else {
  console.log("FAIL:");
  fails.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
}
