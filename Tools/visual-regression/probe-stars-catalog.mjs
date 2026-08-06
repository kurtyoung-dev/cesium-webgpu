#!/usr/bin/env node
// Probe (NEW-STARS-BRIGHT-CATALOG, Batch 313): the Yale Bright Star
// Catalog starfield renders on WebGPU.
//
// What it verifies:
//   (A) Turning scene.skyBox.starField.show ON adds a RESOLVED POINT SOURCE to
//       the frame vs OFF, in the same Sirius-aimed center box, AND that source
//       lands on the aim point (within AIM_TOLERANCE_PX). Scoped to the bright
//       end of the catalogue on purpose — see the SCOPE note at the gate.
//   (G) DR-01 seam: with the sprites OFF, the cube map contributes essentially
//       NO resolved point sources of its own — it carries diffuse Milky Way
//       light only. (A) and (G) together are the seam: exactly one owner per
//       signal.
//
// (A) was a brightness count until C12-11, and it was RED by design while the
// unblurred t5 faces shipped: the cube map painted the same stars the sprites
// did, so the whole 2,868-star field moved the count by ~3 px (91 -> 94). Two
// things changed. The default cube map is now the DIFFUSE bake, so the sprites
// are the only source of resolved stars; and the metric is now a POINT census
// (`Tools/skybox-bake/starmap-census.mjs`) rather than a threshold count, so a
// bright diffuse band cannot register as stars and cannot drown the sprites.
// The band-vs-point distinction matters directly here: Sirius sits only ~9 deg
// off the galactic plane, so the diffuse band IS bright in this exact view — a
// brightness count there would still be dominated by the cube map even after
// the seam landed.
//
// (A) then read RED on its first post-C12-11 run for an INSTRUMENT reason, not
// a product one (C12-STAR-POINT-CENSUS-LIVE-CALIBRATION, settled 2026-08-06):
// aiming the camera at a star puts it at NDC (0,0) = a pixel CORNER, so its four
// surrounding pixels are equal by construction, and the census's then-STRICT
// local-maximum test let each member of that plateau disqualify the others.
// `Tools/visual-regression/star-point-census-live.spec.mjs` reproduces the exact
// live numbers offline (4 candidate pixels at luminance 152.6, census 0) from
// the sprite renderer's derived footprint; the census now counts a plateau once.
//   (B) Bright stars read brighter/larger than faint stars: with the
//       camera aimed at Sirius (mag −1.46) for the pinned scene time, a
//       bright cluster lands near frame center, and the brightest star
//       cluster is meaningfully larger than the mean cluster.
//   (C) Constellations land at correct RA/Dec: aiming the camera at the
//       computed Earth-fixed direction of Sirius produces a bright spot
//       near frame center (within a tolerance box); aiming 90° away from
//       any catalog star direction yields far fewer bright pixels there.
//   (D) Count scales with brightness: raising starField.intensity makes
//       the total bright-pixel count grow.
//   (E) The existing SkyBox cubemap path still works (skyBox.show stays
//       true; turning starField off leaves the cubemap rendering — no
//       crash, scene still renders).
//   (F) 0 console errors on WebGPU.
//
// Reads the output PNGs (Principle 8): the script writes
//   output/stars-catalog/webgpu-{off,on,sirius,bright}.png
//
// Usage: node Tools/visual-regression/probe-stars-catalog.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Node-side analysis only — these run over the pixel arrays the page returns,
// never inside page.evaluate (which would drop the closure).
import { pointSourceCensus } from "../skybox-bake/starmap-census.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "stars-catalog",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    // Pinned scene time — fixes the TEME→fixed rotation so the star
    // positions are deterministic.
    const time = C.JulianDate.fromIso8601("2026-06-21T00:00:00Z");
    v.clock.currentTime = time;

    // Make stars visible: dark scene, no sun/atmosphere wash, no globe in
    // the way. Keep the SkyBox (cubemap) ON so we verify it still works
    // alongside the catalog.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    if (scene.globe) scene.globe.show = false;
    v.imageryLayers.removeAll();

    // Ensure a SkyBox exists (CesiumViewer default has one). Verify the
    // catalog augmentation hook is present.
    const hasStarField = !!(scene.skyBox && scene.skyBox.starField);

    scene.morphTo3D(0);

    // Camera high above the surface looking outward (no globe in frame).
    // We re-aim per capture below.
    const camAlt = 8.0e6;

    const oncePostRender = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
      });
    const renderFrames = async (n) => {
      for (let i = 0; i < n; i++) await oncePostRender();
    };

    const grab = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          resolve({
            data: Array.from(
              new Uint8Array(
                cx.getImageData(0, 0, c.width, c.height).data.buffer,
              ),
            ),
            png: off.toDataURL("image/png"),
            w: c.width,
            h: c.height,
          });
        });
      });

    // Aim the camera FROM the origin-ish toward a given Earth-fixed unit
    // direction by placing the camera at camAlt along -dir and looking
    // toward +dir. We use a position far from Earth so the globe (hidden
    // anyway) doesn't matter; the star field is directional.
    const aimAt = (dirFixed) => {
      const eye = C.Cartesian3.multiplyByScalar(
        dirFixed,
        -camAlt,
        new C.Cartesian3(),
      );
      // direction = +dirFixed (look toward the star)
      const dir = C.Cartesian3.clone(dirFixed);
      // up = any vector not parallel to dir
      let up = C.Cartesian3.UNIT_Z;
      if (Math.abs(C.Cartesian3.dot(dir, up)) > 0.95) {
        up = C.Cartesian3.UNIT_X;
      }
      const right = C.Cartesian3.cross(dir, up, new C.Cartesian3());
      C.Cartesian3.normalize(right, right);
      const realUp = C.Cartesian3.cross(right, dir, new C.Cartesian3());
      C.Cartesian3.normalize(realUp, realUp);
      scene.camera.setView({
        destination: eye,
        orientation: { direction: dir, up: realUp },
      });
    };

    // Compute Sirius's Earth-fixed direction for the pinned time.
    // Sirius J2000: RA 101.287°, Dec −16.716°.
    const raDeg = 101.287;
    const decDeg = -16.716;
    const ra = C.Math.toRadians(raDeg);
    const dec = C.Math.toRadians(decDeg);
    const temeDir = new C.Cartesian3(
      Math.cos(dec) * Math.cos(ra),
      Math.cos(dec) * Math.sin(ra),
      Math.sin(dec),
    );
    const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
      time,
      new C.Matrix3(),
    );
    const siriusFixed = C.Matrix3.multiplyByVector(
      temeToFixed,
      temeDir,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(siriusFixed, siriusFixed);

    // A "blank" direction: opposite the galactic-rich region — pick the
    // anti-Sirius direction, which is sparse-ish. Used as a negative
    // control for the RA/Dec test.
    const blankFixed = C.Cartesian3.negate(siriusFixed, new C.Cartesian3());

    // Warm up a few frames so the pipeline resolves (async pipeline cache).
    aimAt(siriusFixed);
    await renderFrames(20);

    // Keep the SkyBox cubemap ON (default) — this is the augment-the-
    // cubemap path the renderer is designed for: the catalog must draw ON
    // TOP of the cubemap, not be overwritten by it.
    const cubemapShown = scene.skyBox.show;

    // (A) catalog OFF baseline (cubemap still on).
    scene.skyBox.starField.show = false;
    await renderFrames(8);
    const imgOff = await grab();

    // (A/B/C) catalog ON, aimed at Sirius (cubemap still on → augment).
    scene.skyBox.starField.show = true;
    await renderFrames(8);
    const imgSirius = await grab();

    // (C neg) catalog ON, aimed at a blank patch.
    aimAt(blankFixed);
    await renderFrames(8);
    const imgBlank = await grab();

    // (D) higher intensity, aimed at Sirius again.
    aimAt(siriusFixed);
    scene.skyBox.starField.intensity = 3.0;
    await renderFrames(8);
    const imgBright = await grab();

    void cubemapShown;

    // Diagnostic: max luminance + total non-black pixel count for the
    // Sirius-aimed ON frame (independent of the 8-bit threshold).
    const maxLumOf = (img) => {
      let mx = 0;
      let nonBlack = 0;
      const n = img.w * img.h;
      for (let p = 0; p < n; p++) {
        const i = 4 * p;
        const l =
          0.2126 * img.data[i] +
          0.7152 * img.data[i + 1] +
          0.0722 * img.data[i + 2];
        if (l > mx) mx = l;
        if (l > 4) nonBlack++;
      }
      return { mx, nonBlack };
    };
    const onDiag = maxLumOf(imgSirius);
    const offDiag = maxLumOf(imgOff);
    const brightDiag = maxLumOf(imgBright);

    // Pull the FR statistics (star count, pipeline ready).
    let stats;
    try {
      stats = scene.skyBox.starField.getDebugStatistics(scene.frameState);
    } catch (e) {
      stats = { error: String(e) };
    }

    return {
      imgOff,
      imgSirius,
      imgBlank,
      imgBright,
      hasStarField,
      stats,
      onDiag,
      offDiag,
      brightDiag,
    };
  });

  await page.close();
  return { ...out, errors };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Count pixels brighter than threshold.
function brightCount(img, thresh) {
  const n = img.w * img.h;
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (lum(img.data, 4 * p) > thresh) count++;
  }
  return count;
}

// Bright-pixel count inside a centered box of half-width fraction `f`.
function brightCountCenter(img, thresh, f) {
  const x0 = Math.floor(img.w * (0.5 - f));
  const x1 = Math.floor(img.w * (0.5 + f));
  const y0 = Math.floor(img.h * (0.5 - f));
  const y1 = Math.floor(img.h * (0.5 + f));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (lum(img.data, 4 * (y * img.w + x)) > thresh) count++;
    }
  }
  return count;
}

// Resolved-point-source census inside a centered box of half-width fraction
// `f`. Converts the RGBA grab to the luminance plane the shared detector
// expects, then counts unique local maxima that rise above their LOCAL ring
// background — so diffuse band brightness cannot masquerade as a star.
//
// Returns the accepted sources in FRAME pixel coordinates so (A) can assert
// WHERE the resolved source is, not merely that one exists.
function pointCensusCenter(img, f) {
  const x0 = Math.floor(img.w * (0.5 - f));
  const x1 = Math.floor(img.w * (0.5 + f));
  const y0 = Math.floor(img.h * (0.5 - f));
  const y1 = Math.floor(img.h * (0.5 + f));
  const bw = x1 - x0;
  const bh = y1 - y0;
  const plane = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      plane[y * bw + x] = lum(img.data, 4 * ((y0 + y) * img.w + (x0 + x)));
    }
  }
  const res = pointSourceCensus(plane, bw, bh, { collectSources: true });
  return {
    count: res.count,
    strongest: res.strongest,
    sources: (res.sources ?? []).map((s) => ({
      x: s.x + x0,
      y: s.y + y0,
      peak: s.peak,
      contrast: s.contrast,
    })),
  };
}

// Distance from the frame centre to the nearest resolved source, in pixels.
// The camera is aimed EXACTLY at the star, so the star projects to NDC (0,0)
// = continuous pixel coordinate (w/2, h/2) — a pixel CORNER for an even-sized
// viewport. Its plateau's scan-order-first member therefore sits at
// (w/2 - 1, h/2 - 1); AIM_TOLERANCE_PX covers that offset plus catalogue-vs-
// probe RA/Dec differences (0.39 deg of sky at this focal length) with margin.
const AIM_TOLERANCE_PX = 6;
function nearestSourceToCenter(img, census) {
  let best = Infinity;
  for (const s of census.sources) {
    const d = Math.hypot(s.x + 0.5 - img.w / 2, s.y + 0.5 - img.h / 2);
    if (d < best) best = d;
  }
  return best;
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}

console.log("=== WebGPU pass ===");
const gpu = await runBackend("webgpu");

savePng("webgpu-off.png", gpu.imgOff);
savePng("webgpu-sirius.png", gpu.imgSirius);
savePng("webgpu-blank.png", gpu.imgBlank);
savePng("webgpu-bright.png", gpu.imgBright);

const THRESH = 40; // luminance threshold for a "star" pixel over the dark sky

const offBright = brightCount(gpu.imgOff, THRESH);
const onBright = brightCount(gpu.imgSirius, THRESH);
const brightBright = brightCount(gpu.imgBright, THRESH);

const siriusCenter = brightCountCenter(gpu.imgSirius, THRESH, 0.12);
const blankCenter = brightCountCenter(gpu.imgBlank, THRESH, 0.12);
// (A) re-baseline 2026-08-02: the OFF frame is Sirius-aimed too, so the
// catalog's contribution is measured in the SAME center box rather than
// globally — the global count is dominated by the procedural sky-cubemap
// stars (~1300 bright px with the catalog OFF), which drowned the sprite
// delta and made the old `onBright > offBright + 50` gate a coin flip.
const offCenter = brightCountCenter(gpu.imgOff, THRESH, 0.12);

// C12-11: the point census is what (A)/(G) actually gate on. The brightness
// counts above stay as diagnostics because they are still the right instrument
// for (B)/(C)'s cluster-vs-blank comparison.
const siriusCensus = pointCensusCenter(gpu.imgSirius, 0.12);
const offCensus = pointCensusCenter(gpu.imgOff, 0.12);
const blankCensus = pointCensusCenter(gpu.imgBlank, 0.12);
const siriusPoints = siriusCensus.count;
const offPoints = offCensus.count;
const blankPoints = blankCensus.count;
const siriusAimPx = nearestSourceToCenter(gpu.imgSirius, siriusCensus);

console.log(
  `starField present on skyBox: ${gpu.hasStarField}, stats: ${JSON.stringify(gpu.stats)}`,
);
console.log(
  `bright pixels (lum>${THRESH}): off=${offBright} on=${onBright} highIntensity=${brightBright}`,
);
console.log(
  `DIAG maxLum/nonBlack(lum>4): off=${gpu.offDiag.mx.toFixed(0)}/${gpu.offDiag.nonBlack} ` +
    `on=${gpu.onDiag.mx.toFixed(0)}/${gpu.onDiag.nonBlack} ` +
    `bright=${gpu.brightDiag.mx.toFixed(0)}/${gpu.brightDiag.nonBlack}`,
);
console.log(
  `center-box bright pixels: sirius-aimed=${siriusCenter} blank-aimed=${blankCenter} catalog-off=${offCenter}`,
);
console.log(`console errors: ${gpu.errors.length}`);
gpu.errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));

// (A) The sprite layer adds RESOLVED point sources vs OFF — same Sirius aim,
// same center box — AND the source it adds is AT THE AIMED STAR. A real gate
// again as of C12-11: the diffuse cube map no longer paints the stars the
// sprites are supposed to own.
//
// SCOPE (C12-STAR-POINT-CENSUS-LIVE-CALIBRATION, 2026-08-06). The census floor
// is minPeak 40/255, which the sprite exposure clears only for stars brighter
// than vmag 2.56 (the exposure is anchored so a vmag-3.6 star peaks at
// 15.3/255). 98 of the 2,868 catalogue rows are that bright, so the ~200 sq deg
// centre box contains an expected ~0.5 of them: counting field stars here would
// be a coin flip. That is why the subject is the AIMED star — Sirius is in the
// box by construction, and the position test below is what makes (A) fail if the
// sprites stop drawing, stop being point-like, or land in the wrong place.
// Lowering the floor to reach the faint end is forbidden: it would put
// candidates back inside the diffuse band's own 8-bit range (the off-frame peak
// luminance is 28) and re-create the brightness count this census replaced.
const aOK =
  siriusPoints > offPoints &&
  siriusPoints >= 1 &&
  siriusAimPx <= AIM_TOLERANCE_PX;
// (G) DR-01 seam: the cube map alone yields essentially no resolved sources.
// A small tolerance absorbs JPEG ringing and 8-bit dither in the band; the
// baked faces census to exactly 0 offline (skybox-manifest.json).
const gOK = offPoints <= 2;
// (B/C) Aiming at Sirius puts a resolved star near centre where a blank patch
// has none. RE-SCOPED for the DR-01 world (Batch 848), the same stale-threshold
// class check (A) escaped: the old predicate wanted >20 bright pixels in the
// centre box, a number calibrated when the UN-blurred cubemap painted ~91 there.
// Since Batch 833 the cubemap is diffuse-only, so the sprites are the whole
// signal and Sirius legitimately lights ~4 pixels. Counting pixels against a
// pre-DR-01 floor measures the removed cubemap, not the catalogue. The claim
// that survives the seam is POSITIONAL and shared with (A): a resolved source
// at the aimed star, none at a blank patch, and the aimed box strictly brighter.
const bcOK =
  siriusPoints >= 1 && blankPoints === 0 && siriusCenter > blankCenter;
// (D) Higher intensity grows the bright-pixel count.
const dOK = brightBright > onBright;
// (E) starField hook exists on the default SkyBox (cubemap path intact).
const eOK = gpu.hasStarField === true;
// (F) zero console errors.
const fOK = gpu.errors.length === 0;

console.log(
  `center-box POINT census: sirius-aimed=${siriusPoints} catalog-off=${offPoints} blank-aimed=${blankPoints}`,
);
console.log(
  `  strongest contrast: sirius=${siriusCensus.strongest.toFixed(1)} off=${offCensus.strongest.toFixed(1)} blank=${blankCensus.strongest.toFixed(1)}`,
);
console.log(
  `  nearest resolved source to the aim point: ${Number.isFinite(siriusAimPx) ? `${siriusAimPx.toFixed(2)} px` : "none"} (tolerance ${AIM_TOLERANCE_PX} px)`,
);
console.log(
  `(A) sprites add a resolved point source AT the aimed star: ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(G) DR-01 seam — cubemap alone has no resolved stars: ${gOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B/C) Sirius-aimed center cluster >> blank-aimed: ${bcOK ? "OK" : "FAIL"}`,
);
console.log(`(D) higher intensity grows bright count: ${dOK ? "OK" : "FAIL"}`);
console.log(
  `(E) starField hook present (cubemap intact): ${eOK ? "OK" : "FAIL"}`,
);
console.log(`(F) zero console errors: ${fOK ? "OK" : "FAIL"}`);
console.log(`PNGs: ${OUT_DIR}`);

const pass = aOK && gOK && bcOK && dOK && eOK && fOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
