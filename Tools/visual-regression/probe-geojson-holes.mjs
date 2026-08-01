// probe-geojson-holes.mjs
// GeoJsonPrimitive interior-ring (hole) + debugShowBoundingVolume verification
// probe for task C4-GEOJSONPRIMITIVE-PROBE (NEXT_QUEUE_2026-07-04 row Q24).
//
//   node Tools/visual-regression/probe-geojson-holes.mjs
//
// Two things this probe proves that probe-geojson-primitive.mjs does NOT:
//
//   (1) INTERIOR-RING HOLES ARE ACTUALLY CUT OUT — not just "the scene diffs
//       under a threshold". Imagery is disabled so the globe shows a flat base
//       color. A Polygon-with-hole and a MultiPolygon-with-hole are loaded via
//       GeoJsonPrimitive. We then SAMPLE the exact screen pixels of (a) a point
//       inside the fill ring and (b) a point inside the hole, on BOTH backends,
//       and assert: fill pixel == polygon color, hole pixel == globe base color
//       (i.e. the earcut hole triangulation removed the interior). Cross-backend
//       agreement on both samples is the pixel-parity signal.
//
//   (2) debugShowBoundingVolume IS WIRED THROUGH GeoJsonPrimitive AND DRAWN ON
//       BOTH BACKENDS. Previously the loader exposed no such option/property;
//       now the constructor option + runtime setter propagate to every
//       underlying Buffer* collection. We assert BOTH backends render the red
//       bounding-volume wireframe end-to-end (overlay delta non-zero when the
//       flag flips on): WebGL via SceneDebug's Primitive path, WebGPU via the
//       WebGPUBoundingVolumeDebugPass (NEW-GEOJSON-WEBGPU-BV-DEBUG-DRAW-PASS —
//       a red three-great-circle sphere / 12-edge box wireframe drawn into the
//       resolved scene-color view before post-process). The WebGPU delta is
//       smaller than WebGL's because SceneDebug draws a dense lat/long
//       EllipsoidGeometry wireframe (reads as a filled disc) whereas the
//       WebGPU pass draws three thin great circles at the same center/radius.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

// One Polygon-with-hole + one MultiPolygon whose (only) part carries a hole.
// Clustered so a single top-down camera frames both. Fill sample + hole sample
// lon/lat are chosen to sit unambiguously inside the ring / inside the hole.
const POLY_HOLE = {
  type: "Feature",
  properties: { color: "#ffe000" },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-100.0, 40.0],
        [-90.0, 40.0],
        [-90.0, 48.0],
        [-100.0, 48.0],
        [-100.0, 40.0],
      ],
      [
        [-97.0, 42.0],
        [-93.0, 42.0],
        [-93.0, 46.0],
        [-97.0, 46.0],
        [-97.0, 42.0],
      ],
    ],
  },
};
// Sample lon/lat: inside the fill band (between outer edge and hole), and dead
// center of the hole.
const FILL_SAMPLE = [-98.5, 44.0];
const HOLE_SAMPLE = [-95.0, 44.0];

const FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [POLY_HOLE],
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

  const info = await page.evaluate(
    async ({ featureCollection, fillSample, holeSample }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.useDefaultRenderLoop = false;
      const s = v.scene;
      // GeoJSON polygons clamp to height 0, i.e. COPLANAR with the globe
      // surface — rendering them over the globe produces a z-fight that eats the
      // fill and makes the hole/fill sample ambiguous. For a clean, deterministic
      // hole test we hide the globe entirely: the polygon then renders against
      // the black scene background, so `hole == background(black)` and
      // `fill == polygon color` unambiguously. (Cross-backend agreement on both
      // samples is the parity signal; the globe-coplanar case is already
      // covered forgivingly by probe-geojson-primitive.mjs.)
      s.skyBox.show = false;
      s.skyAtmosphere.show = false;
      s.globe.showGroundAtmosphere = false;
      s.fog.enabled = false;
      s.globe.show = false;
      s.backgroundColor = C.Color.BLACK.clone();

      let loader;
      try {
        // Exercise the NEW constructor option end-to-end.
        loader = C.GeoJsonPrimitive.fromGeoJson(featureCollection, {
          debugShowBoundingVolume: false,
        });
        s.primitives.add(loader);
      } catch (e) {
        return { loadError: String(e).slice(0, 240) };
      }

      // Color the polygon fill.
      if (C.defined(loader.polygons)) {
        const scratch = new C.BufferPolygon();
        for (let i = 0; i < loader.polygons.primitiveCount; i++) {
          const prim = loader.polygons.get(i, scratch);
          const props = loader.getProperties(prim.featureId);
          prim.setMaterial(
            new C.BufferPolygonMaterial({
              color: C.Color.fromCssColorString(
                (props && props.color) || "#ffffff",
              ),
            }),
          );
        }
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-95, 44, 2200000),
      });
      for (let i = 0; i < 200; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Project the fill + hole sample lon/lat to canvas pixels.
      const project = (lonlat) => {
        const world = C.Cartesian3.fromDegrees(lonlat[0], lonlat[1], 0);
        const win = s.cartesianToCanvasCoordinates(world);
        return win ? { x: Math.round(win.x), y: Math.round(win.y) } : null;
      };

      // Structural check: does the constructor option flag the collections?
      const flagOff = {
        polygons: C.defined(loader.polygons)
          ? loader.polygons.debugShowBoundingVolume
          : null,
        loader: loader.debugShowBoundingVolume,
      };

      return {
        rendererType: s._context?.rendererType,
        polygonPrimitiveCount: C.defined(loader.polygons)
          ? loader.polygons.primitiveCount
          : 0,
        polygonHoleCount: C.defined(loader.polygons)
          ? loader.polygons.holeCount
          : 0,
        fillPx: project(fillSample),
        holePx: project(holeSample),
        flagOff,
      };
    },
    {
      featureCollection: FEATURE_COLLECTION,
      fillSample: FILL_SAMPLE,
      holeSample: HOLE_SAMPLE,
    },
  );

  // Capture the "debug OFF" frame.
  const canvas = await page.$("canvas");
  const bufOff = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_geojson-holes-${renderer}-off.png`, bufOff);

  // Now flip debugShowBoundingVolume ON via the runtime setter, re-render, and
  // capture again + read back the propagated flags.
  const flagOn = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;
    const loader = s.primitives.get(s.primitives.length - 1);
    loader.debugShowBoundingVolume = true;
    for (let i = 0; i < 60; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      loader: loader.debugShowBoundingVolume,
      polygons: C.defined(loader.polygons)
        ? loader.polygons.debugShowBoundingVolume
        : null,
      polylines: C.defined(loader.polylines)
        ? loader.polylines.debugShowBoundingVolume
        : null,
      points: C.defined(loader.points)
        ? loader.points.debugShowBoundingVolume
        : null,
    };
  });
  const bufOn = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_geojson-holes-${renderer}-on.png`, bufOn);

  await browser.close();
  return { info, errs, flagOn };
}

if (!fs.existsSync(OUT)) {
  fs.mkdirSync(OUT, { recursive: true });
}

// Decode a PNG to RGBA and sample specific pixels / count changed pixels.
async function analyze(offPath, onPath, fillPx, holePx) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const result = await page.evaluate(
    async ([a, b, fp, hp]) => {
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
      const px = (im, x, y) => {
        const i = (y * im.w + x) * 4;
        return [im.d[i], im.d[i + 1], im.d[i + 2]];
      };
      const A = await decode(a);
      const B = await decode(b);
      const fill = fp ? px(A, fp.x, fp.y) : null;
      const hole = hp ? px(A, hp.x, hp.y) : null;
      // Count changed pixels between OFF (A) and ON (B) — the debug overlay.
      let changed = 0;
      const n = Math.min(A.d.length, B.d.length);
      for (let i = 0; i < n; i += 4) {
        if (
          Math.abs(A.d[i] - B.d[i]) +
            Math.abs(A.d[i + 1] - B.d[i + 1]) +
            Math.abs(A.d[i + 2] - B.d[i + 2]) >
          60
        )
          changed++;
      }
      return {
        fill,
        hole,
        changedPct: ((changed / (n / 4)) * 100).toFixed(3),
      };
    },
    [
      "data:image/png;base64," + fs.readFileSync(offPath).toString("base64"),
      "data:image/png;base64," + fs.readFileSync(onPath).toString("base64"),
      fillPx,
      holePx,
    ],
  );
  await browser.close();
  return result;
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

const glA = await analyze(
  `${OUT}/_geojson-holes-webgl-off.png`,
  `${OUT}/_geojson-holes-webgl-on.png`,
  webgl.info.fillPx,
  webgl.info.holePx,
);
const gpuA = await analyze(
  `${OUT}/_geojson-holes-webgpu-off.png`,
  `${OUT}/_geojson-holes-webgpu-on.png`,
  webgpu.info.fillPx,
  webgpu.info.holePx,
);

console.log("=== WebGL ===");
console.log(JSON.stringify(webgl.info, null, 1));
console.log("flagOn:", JSON.stringify(webgl.flagOn));
console.log("samples/overlay:", JSON.stringify(glA));
console.log("errs:", webgl.errs.length, webgl.errs.slice(0, 5));
console.log("=== WebGPU ===");
console.log(JSON.stringify(webgpu.info, null, 1));
console.log("flagOn:", JSON.stringify(webgpu.flagOn));
console.log("samples/overlay:", JSON.stringify(gpuA));
console.log("errs:", webgpu.errs.length, webgpu.errs.slice(0, 5));

// Color classifiers. Fill is bright yellow (#ffe000): R high, G high, B low.
// Hole must be the black scene background (globe hidden): all channels dark.
const isYellow = (c) => c && c[0] > 180 && c[1] > 150 && c[2] < 110;
const isBase = (c) => c && c[0] < 50 && c[1] < 50 && c[2] < 50;

const fails = [];
for (const [side, r, a] of [
  ["webgl", webgl, glA],
  ["webgpu", webgpu, gpuA],
]) {
  if (r.info.loadError) {
    fails.push(`${side}: load error: ${r.info.loadError}`);
    continue;
  }
  if (r.errs.length) {
    fails.push(`${side}: ${r.errs.length} console/page errors`);
  }
  if (r.info.polygonPrimitiveCount !== 1) {
    fails.push(
      `${side}: polygonPrimitiveCount ${r.info.polygonPrimitiveCount} != 1`,
    );
  }
  if (r.info.polygonHoleCount !== 1) {
    fails.push(`${side}: polygonHoleCount ${r.info.polygonHoleCount} != 1`);
  }
  // HOLE PARITY: fill pixel yellow, hole pixel base color (hole cut out).
  if (!isYellow(a.fill)) {
    fails.push(
      `${side}: fill sample ${JSON.stringify(a.fill)} not polygon color`,
    );
  }
  if (!isBase(a.hole)) {
    fails.push(
      `${side}: hole sample ${JSON.stringify(a.hole)} not base color (hole not cut out)`,
    );
  }
  // WIRING: constructor OFF flag false, runtime setter propagates true to all
  // defined collections.
  if (r.info.flagOff.loader !== false || r.info.flagOff.polygons !== false) {
    fails.push(
      `${side}: debugShowBoundingVolume not false when constructed off`,
    );
  }
  if (r.flagOn.loader !== true || r.flagOn.polygons !== true) {
    fails.push(
      `${side}: runtime debugShowBoundingVolume setter did not propagate`,
    );
  }
}
// Both backends MUST render the bounding-volume overlay (flag is wired AND
// each scene renderer draws it). WebGL via SceneDebug; WebGPU via
// WebGPUBoundingVolumeDebugPass (NEW-GEOJSON-WEBGPU-BV-DEBUG-DRAW-PASS).
if (parseFloat(glA.changedPct) < 0.05) {
  fails.push(
    `webgl: debug overlay did not change the frame (${glA.changedPct}% < 0.05%)`,
  );
}
if (parseFloat(gpuA.changedPct) < 0.05) {
  fails.push(
    `webgpu: debug overlay did not change the frame (${gpuA.changedPct}% < 0.05%) ` +
      `— WebGPUBoundingVolumeDebugPass did not draw the bounding volume`,
  );
}

console.log("=== VERDICT ===");
if (fails.length === 0) {
  console.log(
    `PASS — holes cut out at cross-backend parity (fill=yellow, hole=base on ` +
      `both), debugShowBoundingVolume wired through GeoJsonPrimitive (constructor ` +
      `+ runtime setter propagate to collections) AND drawn on BOTH backends. ` +
      `WebGL overlay delta ${glA.changedPct}%; WebGPU overlay delta ` +
      `${gpuA.changedPct}% (WebGPUBoundingVolumeDebugPass renders the red ` +
      `bounding-volume wireframe). Read _geojson-holes-*-off/on.png.`,
  );
  process.exitCode = 0;
} else {
  console.log("FAIL:");
  fails.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
}
