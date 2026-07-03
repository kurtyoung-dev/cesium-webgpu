// probe-bufferpolygon-2dcv.mjs
// BufferPolygon-family 2D / Columbus-View reproject baseline probe
// (batch-bufferpolygon-2dcv-probe).
//
//   node Tools/visual-regression/probe-bufferpolygon-2dcv.mjs
//
// Loads the sample-us-states vector tileset (which routes through the modern
// buffer-backed BufferPolygon path — the CESIUM_mesh_vector glTF-vector
// pipeline, NOT the classic .vctr Vector3DTilePrimitive) on WebGL and WebGPU,
// then captures each of the three scene modes:
//
//   SCENE3D         — the shipped, verified parity baseline (must be unchanged).
//   COLUMBUS_VIEW   — projected planar view; WebGPU currently lacks a 2D/CV
//                     reprojected position attribute, so its 3D ECEF positions
//                     project to "wandering points" (see DEFERRED_WORK
//                     NEW-CLASSIFIER-2D-CV-MORPH for the same failure mode on
//                     the .vctr classifier). This probe RECORDS that baseline.
//   SCENE2D         — same gap as Columbus View.
//
// For each mode it captures the WebGL and WebGPU canvases and computes a
// pixel-diff. EXPECTED at the time this probe lands:
//   - SCENE3D: a small/explainable diff (z-fight tie-break differences, same
//     as probe-bufferpolygon-vector-tile.mjs — NOT a regression).
//   - COLUMBUS_VIEW / SCENE2D: a LARGE diff because WebGPU draws the polygons
//     in the wrong place (the wandering-points artifact). That large diff IS
//     the documented baseline this batch establishes — it is the symptom the
//     producer-half scaffolding (BufferPolygonMaterial.computeReprojected2DPositions)
//     plus the named follow-up renderer bind (batch-bufferprimitive-parity)
//     will close. Re-run after the renderer batch lands to confirm the 2D/CV
//     diff drops toward the SCENE3D level.
//
// This probe is the producer-half diagnostic only. It does NOT exercise the
// new BufferPolygonMaterial.computeReprojected2DPositions() helper directly
// (that has no GPU consumer yet); it captures the user-visible artifact so the
// follow-up renderer batch has a concrete before/after to diff against.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT = "Tools/visual-regression/output";

// scene.mode setter morphs instantly (duration 0). "3D" is the SCENE3D parity
// baseline; "COLUMBUS_VIEW" and "SCENE2D" are the gapped modes.
const MODES = ["SCENE3D", "COLUMBUS_VIEW", "SCENE2D"];

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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Load the tileset once; keep the viewer alive across mode captures.
  const loadInfo = await page.evaluate(async (base) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.fog.enabled = false;
    window.__C = C;
    try {
      const ts = await C.Cesium3DTileset.fromUrl(
        `${base}/Apps/SampleData/vector/sample-us-states.tileset.json`,
      );
      s.primitives.add(ts);
      window.__ts = ts;
    } catch (e) {
      return { loadError: String(e).slice(0, 200) };
    }
    return { loaded: true };
  }, BASE);

  const perMode = {};
  if (!loadInfo.loadError) {
    for (const mode of MODES) {
      const info = await page.evaluate(async (mode) => {
        const C = window.__C;
        const v = window.viewer;
        const s = v.scene;
        // Set the scene mode (instant morph). Re-frame the continental US in
        // the chosen mode so the polygons fill the viewport.
        s.mode = C.SceneMode[mode];
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(-98, 39, 5000000),
        });
        // Let the morph settle + tiles stream + render.
        for (let i = 0; i < 240; i++) {
          s.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        const st = window.__ts?.statistics ?? {};
        const cl = s.frameState?.commandList ?? [];
        const owners = {};
        for (const c of cl) {
          const n = c?.owner?.constructor?.name ?? "(none)";
          owners[n] = (owners[n] || 0) + 1;
        }
        return {
          mode: C.SceneMode[s.mode] === undefined ? s.mode : mode,
          numberOfFeaturesSelected: st.numberOfFeaturesSelected,
          geometryByteLength: st.geometryByteLength,
          ownerTypes: owners,
          commandCount: cl.length,
        };
      }, mode);

      const canvas = await page.$("canvas");
      const buf = await canvas.screenshot();
      fs.writeFileSync(`${OUT}/_bp2dcv-${renderer}-${mode}.png`, buf);
      perMode[mode] = info;
    }
  }

  await browser.close();
  return { loadInfo, perMode, errs };
}

// Decode two PNGs to RGBA via a headless canvas and diff. Same threshold and
// decode path as probe-bufferpolygon-vector-tile.mjs so the numbers are
// directly comparable.
async function diffPngs(pathA, pathB) {
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
      "data:image/png;base64," + fs.readFileSync(pathA).toString("base64"),
      "data:image/png;base64," + fs.readFileSync(pathB).toString("base64"),
    ],
  );
  await browser.close();
  return diff;
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL ===");
console.log("load:", JSON.stringify(webgl.loadInfo));
console.log("perMode:", JSON.stringify(webgl.perMode, null, 1));
console.log("errs:", webgl.errs.length, webgl.errs.slice(0, 3));
console.log("=== WebGPU ===");
console.log("load:", JSON.stringify(webgpu.loadInfo));
console.log("perMode:", JSON.stringify(webgpu.perMode, null, 1));
console.log("errs:", webgpu.errs.length, webgpu.errs.slice(0, 3));

console.log("=== DIFF (WebGL vs WebGPU, per scene mode) ===");
for (const mode of MODES) {
  const a = `${OUT}/_bp2dcv-webgl-${mode}.png`;
  const b = `${OUT}/_bp2dcv-webgpu-${mode}.png`;
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const d = await diffPngs(a, b);
    const note =
      mode === "SCENE3D"
        ? "SCENE3D parity baseline (small/explainable diff expected)"
        : "2D/CV gap — wandering-points baseline (large diff EXPECTED until the renderer-side bind lands; follow-up: batch-bufferprimitive-parity)";
    console.log(`${mode}: ${JSON.stringify(d)}  // ${note}`);
  } else {
    console.log(`${mode}: (missing PNGs — capture failed)`);
  }
}
