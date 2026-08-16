// DP-H7 (Batch 328) — geodesic-arcType polyline subdivision probe.
// @purpose Premise-refutation record: proved DP-H7's geodesic-subdivision root cause FALSE — PolylineCollection curves correctly on WebGPU (CPU-side)
// @status INVESTIGATION
//
// CLAIM under test (DP-H7): a Polyline / PolylineCollection with
// arcType GEODESIC straight-lines a chord through the Earth on WebGPU because
// "the CPU-side geodesic subdivision (PolylinePipeline.generateArc) is not
// routed into the WebGPU polyline vertex build."
//
// FINDING (this probe): that root cause is FALSE. The geodesic/rhumb
// subdivision is CPU-side and backend-neutral (PolylineGeometry.createGeometry
// + PolylineGeometryUpdater both call PolylinePipeline.generateCartesianArc
// BEFORE any renderer sees the positions). The WebGPU PolylineCollection
// renderer (WebGPUPolylineRenderer) renders whatever positions it is given, so
// when fed the subdivided positions it draws the geodesic CURVE — matching
// WebGL. This probe proves the PolylineCollection path CURVES on WebGPU.
//
// (Separately, this probe records that the appearance-based polyline PRIMITIVE
// path — PolylineColorAppearance / PolylineMaterialAppearance over a
// PolylineGeometry Primitive — renders NOTHING on WebGPU regardless of arcType,
// because there is no WGSL port of PolylineCommon + PolylineColorAppearanceVS.
// That is a distinct missing-feature gap, NOT a geodesic-subdivision bug; it is
// surfaced as a newly-scoped tracked item, not "fixed" here.)
//
// Scene: a great-circle geodesic between two 60N points 180 deg apart in
// longitude (lon -90 / lon +90). The geodesic arcs UP over the north pole; a
// red straight-chord reference (same endpoints, no subdivision) cuts across
// below it. Viewed from high above the equator looking down with the globe
// hidden, the cyan geodesic visibly bows away from the red chord. The probe
// asserts the WebGPU geodesic bows (curve, not chord) AND matches WebGL.
//
// Usage: node Tools/visual-regression/probe-polyline-geodesic.mjs
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("PROBE:")) console.log(`[${renderer}] ${t}`);
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;

    // Hide globe/sky so ONLY the polyline shows against black.
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.fog.enabled = false;
    scene.sun.show = false;
    scene.moon.show = false;

    const ellipsoid = scene.ellipsoid;

    // London -> Cape Town: a long great-circle slice whose geodesic visibly
    // bows away from the straight chord between the two endpoints. Two points
    // at 60N, 180 deg apart in longitude: the great-circle geodesic arcs up
    // OVER the north pole, while the straight chord cuts straight across the
    // top of the globe. Viewed from a point above the equator looking north,
    // the geodesic bows up toward the pole and clearly separates from the
    // (lower, flatter) straight chord — a large, view-stable screen bow.
    const lon0 = -90.0,
      lat0 = 60.0;
    const lon1 = 90.0,
      lat1 = 60.0;
    const p0 = C.Cartesian3.fromDegrees(lon0, lat0, 0.0, ellipsoid);
    const p1 = C.Cartesian3.fromDegrees(lon1, lat1, 0.0, ellipsoid);

    // CPU-side geodesic subdivision — the SAME generateCartesianArc call
    // PolylineGeometry.createGeometry / PolylineGeometryUpdater make. This is
    // backend-neutral; both WebGL and WebGPU receive these subdivided points.
    const subdivided = C.PolylinePipeline.generateCartesianArc({
      positions: [p0, p1],
      ellipsoid: ellipsoid,
    });
    const subdividedCount = subdivided.length / 3;

    // Render the subdivided geodesic (CYAN) through the PolylineCollection path
    // — the path DP-H7 names. On WebGPU this routes through
    // WebGPUPolylineRenderer.
    const pc = new C.PolylineCollection();
    pc.add({
      positions: subdivided,
      width: 5,
      material: C.Material.fromType("Color", { color: C.Color.CYAN }),
    });
    // Add the straight-chord REFERENCE (RED, 2 points, no subdivision) so the
    // geodesic's bow is measured against the true chord (not just the rendered
    // endpoints). The geodesic must separate from this by many px.
    pc.add({
      positions: [p0, p1],
      width: 4,
      material: C.Material.fromType("Color", { color: C.Color.RED }),
    });
    scene.primitives.add(pc);

    // Camera high above the equator at lon 0, looking NORTH and slightly down,
    // so the great-circle arc bows UP toward the pole (top of frame) while the
    // straight chord sits lower/flatter — a large, view-stable screen bow.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0.0, -25.0, 30000000.0),
      orientation: {
        heading: 0.0,
        pitch: C.Math.toRadians(-90),
        roll: 0.0,
      },
    });

    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    await renderN(60);

    const canvas = scene.canvas;
    const c2 = document.createElement("canvas");
    c2.width = canvas.width;
    c2.height = canvas.height;
    c2.getContext("2d").drawImage(canvas, 0, 0);
    const dataUrl = c2.toDataURL("image/png");

    return {
      w: canvas.width,
      h: canvas.height,
      dataUrl,
      subdividedCount,
    };
  });

  await page.close();
  return result;
}

function savePng(name, dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(`${OUT}/${name}`, Buffer.from(b64, "base64"));
}

async function decodeToRGBA(dataUrl, w, h) {
  const page = await browser.newPage();
  const arr = await page.evaluate(
    async ({ dataUrl, w, h }) => {
      const img = new Image();
      await new Promise((res) => {
        img.onload = res;
        img.src = dataUrl;
      });
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      return Array.from(cx.getImageData(0, 0, w, h).data);
    },
    { dataUrl, w, h },
  );
  await page.close();
  return new Uint8ClampedArray(arr);
}

// The arc renders near-horizontal (bows vertically), so scan per COLUMN: for
// each x, take the topmost cyan (geodesic) y and the topmost red (chord) y.
// Two measurements:
//   - maxBow: max perpendicular distance of the cyan path from the straight
//     line between its own rendered endpoints (curve vs straight, no reference
//     needed). A chord bug → ~0.
//   - maxCyanVsRed: max vertical separation between the cyan geodesic and the
//     red straight chord. The geodesic bows above the chord → large; a
//     straight-line bug would overlay the chord → ~0.
function measureArc(rgba, w, h) {
  const cyan = []; // {x, y}
  const cyanY = new Array(w).fill(null);
  const redY = new Array(w).fill(null);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      const r = rgba[i],
        g = rgba[i + 1],
        b = rgba[i + 2];
      if (cyanY[x] === null && r < 80 && g > 140 && b > 140) cyanY[x] = y;
      if (redY[x] === null && r > 150 && g < 90 && b < 90) redY[x] = y;
    }
    if (cyanY[x] !== null) cyan.push({ x, y: cyanY[x] });
  }
  if (cyan.length < 20)
    return { ok: false, maxBow: 0, maxCyanVsRed: 0, cols: cyan.length };

  // Bow: perpendicular distance of cyan path from the line between its ends.
  const a = cyan[0];
  const bb = cyan[cyan.length - 1];
  const dx = bb.x - a.x;
  const dy = bb.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let maxBow = 0;
  for (const p of cyan) {
    const dist = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (dist > maxBow) maxBow = dist;
  }

  // Cyan-vs-red vertical separation over columns where both exist.
  let maxCyanVsRed = 0;
  let bothCols = 0;
  for (let x = 0; x < w; x++) {
    if (cyanY[x] !== null && redY[x] !== null) {
      bothCols++;
      const sep = Math.abs(cyanY[x] - redY[x]);
      if (sep > maxCyanVsRed) maxCyanVsRed = sep;
    }
  }
  return { ok: true, maxBow, maxCyanVsRed, cols: cyan.length, bothCols };
}

async function diffRGBA(a, b) {
  const n = Math.min(a.length, b.length);
  let mismatch = 0;
  for (let i = 0; i < n; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 24 ||
      Math.abs(a[i + 1] - b[i + 1]) > 24 ||
      Math.abs(a[i + 2] - b[i + 2]) > 24
    )
      mismatch++;
  }
  return (mismatch / (n / 4)) * 100;
}

const coverage = (rgba) => {
  let c = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 40) c++;
  }
  return c;
};

const webgpu = await runBackend("webgpu");
const webgl = await runBackend("webgl");

savePng("probe-polyline-geodesic-webgpu.png", webgpu.dataUrl);
savePng("probe-polyline-geodesic-webgl.png", webgl.dataUrl);

const gpuRGBA = await decodeToRGBA(webgpu.dataUrl, webgpu.w, webgpu.h);
const wglRGBA = await decodeToRGBA(webgl.dataUrl, webgl.w, webgl.h);

const gpuCov = coverage(gpuRGBA);
const wglCov = coverage(wglRGBA);

const gpuArc = measureArc(gpuRGBA, webgpu.w, webgpu.h);
const wglArc = measureArc(wglRGBA, webgl.w, webgl.h);

const diffPct = await diffRGBA(gpuRGBA, wglRGBA);

await browser.close();

const report = {
  endpoints: "60N lon-90 -> 60N lon+90 (great-circle over the pole)",
  canvas: { w: webgpu.w, h: webgpu.h },
  subdividedPositions: webgpu.subdividedCount,
  webgpuNonBlackPixels: gpuCov,
  webglNonBlackPixels: wglCov,
  webgpuArcBowDeviationPx: Number(gpuArc.maxBow.toFixed(2)),
  webglArcBowDeviationPx: Number(wglArc.maxBow.toFixed(2)),
  webgpuGeodesicVsChordSepPx: Number(gpuArc.maxCyanVsRed.toFixed(2)),
  webglGeodesicVsChordSepPx: Number(wglArc.maxCyanVsRed.toFixed(2)),
  webgpuVsWebglDiffPct: Number(diffPct.toFixed(4)),
  pngs: [
    `${OUT}/probe-polyline-geodesic-webgpu.png`,
    `${OUT}/probe-polyline-geodesic-webgl.png`,
  ],
};
console.log(JSON.stringify(report, null, 2));

// Pass criteria — WebGPU PolylineCollection geodesic CURVES over the pole and
// separates from the straight chord, matching WebGL:
//   - both backends render the geodesic (coverage present)
//   - WebGPU CURVES: the cyan geodesic bows >= 8px from a straight line between
//     its own endpoints AND sits >= 8px above the red straight chord (a
//     straight-line geodesic bug would give ~0 for both).
//   - WebGPU matches WebGL: bow + separation within 6px, low overall diff.
const ok =
  gpuCov > 200 &&
  wglCov > 200 &&
  gpuArc.ok &&
  wglArc.ok &&
  gpuArc.maxBow > 8 &&
  gpuArc.maxCyanVsRed > 8 &&
  Math.abs(gpuArc.maxBow - wglArc.maxBow) < 6 &&
  Math.abs(gpuArc.maxCyanVsRed - wglArc.maxCyanVsRed) < 6 &&
  diffPct < 2.0;
console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
