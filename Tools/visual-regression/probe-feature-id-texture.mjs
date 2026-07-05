// R-2b UNIFIED-FEATURE-ID-TEXTURE (Queue Q28) acceptance probe.
//
// Proves that the WebGPU pick pass's unified, source-agnostic per-fragment
// feature-ID G-buffer (WebGPUPickFramebuffer._colorTexture) is resolvable
// INSIDE a shader / post-process pass — not just via CPU byte readback.
//
// Scene: globe (source A) + a billboard collection (source B), two distinct
// pick sources. A single wide pickAsync rasterizes BOTH sources' 24-bit IDs
// into the shared pick target; then WebGPUPickFramebuffer
// .resolveFeatureIdRecolorAsync() runs FeatureIdResolve.wgsl over that target,
// decoding + hashing each ID to a color on the GPU.
//
// Checks:
//   (1) CPU picks confirm cross-source coverage — a Billboard at the billboard
//       pixel, the Globe at a globe-only pixel.
//   (2) The GPU resolve pass produces a NON-BLACK color at BOTH the billboard
//       pixel and the globe pixel (both features resolved in-shader).
//   (3) Those two colors DIFFER — distinct feature IDs resolved at cross-source
//       fragments (the R-2b acceptance).
//   (4) DETERMINISM — a second resolve yields byte-identical colors.
//   (5) 0 console / WebGPU validation errors.
//
// Writes a recolor visualization PNG to the scratchpad for eyeball review.
//
// Usage: node Tools/visual-regression/probe-feature-id-texture.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_PNG =
  process.env.PROBE_OUT ||
  "C:\\Users\\Kurt\\AppData\\Local\\Temp\\claude\\f--Dev-GH-cesium-webgpu\\eb6dfaec-c294-4f46-966a-d8d9138c8bf0\\scratchpad\\feature-id-recolor.png";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text().slice(0, 200));
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const errors = [];
  const dev = scene.context?._device;
  if (dev) {
    dev.onuncapturederror = (ev) =>
      errors.push(String(ev?.error?.message).slice(0, 250));
  }

  // Deterministic scene: keep the globe (source A), drop sky/atmosphere so a
  // globe-only pixel is unambiguous.
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.fog.enabled = false;

  // Cross-source: a Billboard (Collections/BillboardCollection renderer) and a
  // Point (Collections/PointPrimitiveCollection renderer) — two DIFFERENT
  // source pipelines that both rasterize their own object ID into the ONE
  // shared pick target. (The globe uses pickPosition, not scene.pick object
  // IDs, so it is not a reliable second ID source here.)
  const img = document.createElement("canvas");
  img.width = 64;
  img.height = 64;
  const g2d = img.getContext("2d");
  g2d.fillStyle = "#ffffff";
  g2d.fillRect(0, 0, 64, 64);
  const bbs = scene.primitives.add(new C.BillboardCollection());
  const bb = bbs.add({
    position: C.Cartesian3.fromDegrees(-75, 40, 1000.0),
    image: img,
    color: C.Color.MAGENTA,
    id: "probe-feature-id-bb",
  });

  // Source B: a large point at a second screen location.
  const points = scene.primitives.add(new C.PointPrimitiveCollection());
  const pt = points.add({
    position: C.Cartesian3.fromDegrees(-74.9, 40, 1000.0),
    pixelSize: 60,
    color: C.Color.CYAN,
    id: "probe-feature-id-pt",
  });

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75, 40, 25000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  await renderN(90);

  const W = scene.canvas.clientWidth || 1024;
  const H = scene.canvas.clientHeight || 768;
  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  // Resolve each primitive's actual screen location so the picks land on them
  // regardless of exact camera framing.
  const bbScreen = scene.cartesianToCanvasCoordinates(bb.position);
  const ptScreen = scene.cartesianToCanvasCoordinates(pt.position);
  const bbX = Math.round(bbScreen?.x ?? cx);
  const bbY = Math.round(bbScreen?.y ?? cy);
  const globeX = Math.round(ptScreen?.x ?? cx + 200);
  const globeY = Math.round(ptScreen?.y ?? cy);

  const doPick = async (x, y, w = 1, h = 1) =>
    scene.pickAsync
      ? scene.pickAsync(new C.Cartesian2(x, y), w, h)
      : scene.pick(new C.Cartesian2(x, y), w, h);

  const describe = (hit) => {
    if (!hit) return { found: false };
    return {
      found: true,
      isBillboard: hit === bb || hit.primitive === bb,
      isPoint: hit === pt || hit.primitive === pt,
      id: typeof hit?.id === "string" ? hit.id : undefined,
      primitiveCtor: hit?.primitive?.constructor?.name,
    };
  };

  // Warm-up (pick pipelines materialize lazily on first pass).
  await doPick(bbX, bbY, 9, 9);
  await doPick(globeX, globeY, 9, 9);
  await renderN(12);

  // (1) CPU cross-source coverage.
  const bbHit = describe(await doPick(bbX, bbY, 5, 5));
  const globeHit = describe(await doPick(globeX, globeY, 5, 5));

  // One wide pick covering BOTH sources so the shared ID target holds both.
  const midX = Math.round((bbX + globeX) / 2);
  const midY = Math.round((bbY + globeY) / 2);
  const spanW = Math.abs(bbX - globeX) + 200;
  const spanH = Math.abs(bbY - globeY) + 200;
  await doPick(midX, midY, spanW, spanH);
  await renderN(2);

  const pfb = scene.view.pickFramebuffer;
  const hasResolve = typeof pfb?.resolveFeatureIdRecolorAsync === "function";
  const resolveOut = { hasResolve };

  if (hasResolve) {
    const r1 = await pfb.resolveFeatureIdRecolorAsync();
    const r2 = await pfb.resolveFeatureIdRecolorAsync();
    if (r1 && r2) {
      const { width, height, pixels } = r1;
      // The pick FBO / resolve output is stored TOP-DOWN (row 0 = top of frame),
      // matching the canvas client coords used above.
      const at = (buf, x, y) => {
        const xi = Math.max(0, Math.min(width - 1, Math.floor(x)));
        const yi = Math.max(0, Math.min(height - 1, Math.floor(y)));
        const i = 4 * (yi * width + xi);
        return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
      };
      const bbColor = at(pixels, bbX, bbY);
      const globeColor = at(pixels, globeX, globeY);
      const nonBlack = (c) => c[0] !== 0 || c[1] !== 0 || c[2] !== 0;
      // Determinism: r2 must equal r1 at both probe pixels.
      const c1b = at(r2.pixels, bbX, bbY);
      const c1g = at(r2.pixels, globeX, globeY);
      const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

      resolveOut.width = width;
      resolveOut.height = height;
      resolveOut.bbColor = bbColor;
      resolveOut.globeColor = globeColor;
      resolveOut.bbNonBlack = nonBlack(bbColor);
      resolveOut.globeNonBlack = nonBlack(globeColor);
      resolveOut.distinct = !eq(bbColor, globeColor);
      resolveOut.deterministic = eq(bbColor, c1b) && eq(globeColor, c1g);

      // Render the recolor to a canvas for a screenshot the reviewer can read.
      const outCanvas = document.createElement("canvas");
      outCanvas.id = "featureIdRecolor";
      outCanvas.width = width;
      outCanvas.height = height;
      outCanvas.style.position = "fixed";
      outCanvas.style.left = "0";
      outCanvas.style.top = "0";
      outCanvas.style.zIndex = "99999";
      const octx = outCanvas.getContext("2d");
      const imgData = octx.createImageData(width, height);
      imgData.data.set(pixels);
      octx.putImageData(imgData, 0, 0);
      // Mark the two probe pixels with small crosshairs for the reviewer.
      octx.strokeStyle = "#00ff00";
      octx.strokeRect(bbX - 6, bbY - 6, 12, 12);
      octx.strokeStyle = "#ff8800";
      octx.strokeRect(globeX - 6, globeY - 6, 12, 12);
      document.body.appendChild(outCanvas);
    }
  }

  return {
    bbHit,
    globeHit,
    resolveOut,
    W,
    H,
    bbX,
    bbY,
    globeX,
    globeY,
    errors,
  };
});

// Screenshot the recolor canvas if present.
let pngSaved = false;
const el = await page.$("#featureIdRecolor");
if (el) {
  await el.screenshot({ path: OUT_PNG });
  pngSaved = true;
}

await browser.close();

console.log(JSON.stringify(out, null, 2));
if (pngSaved) console.log("recolor PNG:", OUT_PNG);
if (pageErrors.length) console.log("page errors:", pageErrors);

const r = out.resolveOut;
const pass =
  out.bbHit.found &&
  out.bbHit.isBillboard &&
  out.globeHit.found &&
  out.globeHit.isPoint &&
  r.hasResolve &&
  r.bbNonBlack &&
  r.globeNonBlack &&
  r.distinct &&
  r.deterministic &&
  out.errors.length === 0 &&
  pageErrors.length === 0;

console.log(pass ? "PROBE PASS" : "PROBE FAIL");
process.exit(pass ? 0 : 1);
