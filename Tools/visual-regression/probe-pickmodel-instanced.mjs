#!/usr/bin/env node
// Probe (Batch 238 — upstream #13433 port): CPU `pickModel` on instanced
// models + `ModelReader.octDecode` argument order.
//
// Three sections:
//
//   [0] NODE — `ModelReader.octDecode` round-trip (imports straight from
//       packages/engine/Source, no build needed). Upstream #13433 fixed the
//       argument order of `AttributeCompression.octDecodeInRange` (takes
//       `(x, y, rangeMax, result)`, was called `(cart3, range, cart3)`) and
//       `Cartesian3.pack` (takes `(value, array, index)`, was called
//       `(array, value, index)`). Pre-fix this THROWS "result is required".
//
//   [1] WEBGL — BoxInstanced (EXT_mesh_gpu_instancing, TRANSLATION+ROTATION
//       +SCALE → matrix path → WebGL2 buffer readback). Ground truth is the
//       RASTERIZED image: scan the frame for interior lit pixels, then at
//       each one compare `scene.pickPosition` (GPU depth) against
//       `model.pick` (CPU — the code under test). Upstream #13433 fixed the
//       non-worldspace instance composition from `transform *
//       computedModelMatrix` to `computedModelMatrix * transform`; pre-fix
//       the CPU thinks the cubes are at un-axis-corrected glTF positions and
//       misses where the GPU rendered them.
//
//   [2] WEBGPU (GATED: set PROBE_WEBGPU=1 — currently expected-fail) —
//       BoxInstancedNoNormals (TRANSLATION-only instancing). On WebGPU
//       `keepTypedArray` is always true (`supportsSynchronousReadback`
//       is false), and pre-fix `InstancingPipelineStage` routed translation-
//       only models down the vec3 path which stuffs 2D-PROJECTED vec3
//       translations into `runtimeNode.transformsTypedArray` — pickModel
//       reads that as 12-float matrices → NaN transforms → every pick
//       undefined. The #13433 one-liner (`defined(rotationAttribute) ||
//       keepTypedArray`) routes these models through the matrix path, so
//       picks hit at exact, deterministic positions (instances at glTF
//       (±2,±2,0) → axis-corrected Cesium (0,±2,±2); a -X ray through an
//       instance center hits the +X face at x=0.5 — same expectations as
//       upstream's pickModelSpec). Also render-smokes BOTH models on WebGPU.
//
//       WHY GATED: ANY instanced model currently crashes the WebGPU render
//       loop in `VertexArray` bind — `context._vertexAttribDivisors[index]`
//       is undefined on `WebGPUContext` (the `glVertexAttribDivisor` compat
//       stub exists at WebGPUContext.ts:756 but the divisors array was never
//       initialized). Pre-existing on main (came in with the v1.140 upstream
//       merge), hits BOTH the vec3 and matrix instancing paths, so the model
//       never reaches `ready` and pickModel can't be driven. Tracked as
//       NEW-WEBGPU-INSTANCED-VA-DIVISORS in migration_doc/DEFERRED_WORK.md —
//       flip this section on (and make it a required gate) when that lands.
//
// Usage: node Tools/visual-regression/probe-pickmodel-instanced.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
//        PROBE_WEBGPU=1 to run the gated WebGPU section

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];
const note = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// ─────────────────────────────────────────────────────────────────────────
// [0] Node-side: ModelReader.octDecode round-trip (source import)
// ─────────────────────────────────────────────────────────────────────────
{
  const toUrl = (p) => `file:///${path.join(ROOT, p).replace(/\\/g, "/")}`;
  const { default: AttributeCompression } = await import(
    toUrl("packages/engine/Source/Core/AttributeCompression.js")
  );
  const { default: Cartesian3 } = await import(
    toUrl("packages/engine/Source/Core/Cartesian3.js")
  );
  const { default: ModelReader } = await import(
    toUrl("packages/engine/Source/Scene/Model/ModelReader.js")
  );

  const vectors = [
    new Cartesian3(1, 0, 0),
    new Cartesian3(0, 1, 0),
    new Cartesian3(0, 0, 1),
    Cartesian3.normalize(new Cartesian3(1, 2, 3), new Cartesian3()),
    Cartesian3.normalize(new Cartesian3(-1, -1, 1), new Cartesian3()),
    Cartesian3.normalize(new Cartesian3(0.3, -0.9, -0.4), new Cartesian3()),
  ];
  const range = 65535;
  const encoded = new Float32Array(vectors.length * 3);
  const scratch2 = { x: 0, y: 0 };
  for (let i = 0; i < vectors.length; i++) {
    AttributeCompression.octEncodeInRange(vectors[i], range, scratch2);
    encoded[i * 3] = scratch2.x;
    encoded[i * 3 + 1] = scratch2.y;
  }
  try {
    const decoded = ModelReader.octDecode(
      encoded,
      vectors.length,
      range,
      undefined,
    );
    let maxErr = 0;
    for (let i = 0; i < vectors.length; i++) {
      const d = new Cartesian3(
        decoded[i * 3],
        decoded[i * 3 + 1],
        decoded[i * 3 + 2],
      );
      maxErr = Math.max(maxErr, Cartesian3.distance(d, vectors[i]));
    }
    note(
      maxErr < 1e-4,
      "octDecode round-trip",
      `maxErr=${maxErr.toExponential(3)} over ${vectors.length} unit vectors`,
    );
  } catch (e) {
    note(false, "octDecode round-trip", `threw: ${String(e.message).split("\n")[0]}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Browser sections
// ─────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function openViewer(renderer) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  return { page, errors };
}

// Shared in-page bootstrap: continuous rendering, bare scene, fixed camera.
const PAGE_PRELUDE = `
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  scene.globe.show = false;
  scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.screenSpaceCameraController.enableCollisionDetection = false;

  const loadModel = async (url) => {
    const model = await C.Model.fromGltfAsync({ url, enablePick: true });
    scene.primitives.add(model);
    // Fail loudly (don't hang the probe) if the model errors or stalls.
    await new Promise((resolve, reject) => {
      const removeReady = model.readyEvent.addEventListener(() => {
        removeReady();
        removeError();
        clearTimeout(timer);
        resolve();
      });
      const removeError = model.errorEvent.addEventListener((e) => {
        removeReady();
        removeError();
        clearTimeout(timer);
        reject(new Error("model errorEvent: " + (e && e.message ? e.message : e)));
      });
      const timer = setTimeout(
        () => reject(new Error("model ready timeout (45s): " + url)),
        45000,
      );
    });
    // A few extra frames so buildDrawCommands + instancing buffers settle.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    return model;
  };

  // Canvas readback must run inside postRender (WebGPU present clears the
  // texture; WebGL drawing buffer is only valid in-task after render).
  const grabFrame = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = document.createElement("canvas");
        c.width = scene.canvas.width;
        c.height = scene.canvas.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(scene.canvas, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      });
    });
  const litCount = (img) => {
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 24) n++;
    }
    return n;
  };
`;

// ─── [1] WebGL: GPU-render-anchored CPU pick on BoxInstanced ────────────
{
  const { page, errors } = await openViewer("webgl");
  let r;
  try {
    r = await page.evaluate(`(async () => {
    ${PAGE_PRELUDE}
    const model = await loadModel(
      "/Specs/Data/Models/glTF-2.0/BoxInstanced/glTF/box-instanced.gltf",
    );
    // Instances at axis-corrected (0, ±2, ±2); look down -X from outside.
    scene.camera.setView({
      destination: new C.Cartesian3(6.5, 0, 0),
      orientation: {
        direction: new C.Cartesian3(-1, 0, 0),
        up: new C.Cartesian3(0, 0, 1),
      },
    });
    for (let i = 0; i < 5; i++) await new Promise((r2) => requestAnimationFrame(r2));

    const img = await grabFrame();
    const lit = (x, y) => {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
      const i = (y * img.width + x) * 4;
      return img.data[i] + img.data[i + 1] + img.data[i + 2] > 24;
    };
    // Interior lit grid points: lit, with a 10px cross-neighborhood also lit
    // (keeps us off silhouettes where rasterization vs exact-ray disagree).
    const pts = [];
    for (let y = 16; y < img.height - 16; y += 8) {
      for (let x = 16; x < img.width - 16; x += 8) {
        if (
          lit(x, y) &&
          lit(x - 10, y) && lit(x + 10, y) &&
          lit(x, y - 10) && lit(x, y + 10)
        ) {
          pts.push([x, y]);
        }
      }
    }
    // Cap pickPosition cost: stride-sample down to ~40 points.
    const stride = Math.max(1, Math.floor(pts.length / 40));
    const sampled = pts.filter((_, i) => i % stride === 0);

    let gpuHits = 0, cpuHits = 0, maxDist = -1, sumDist = 0;
    for (const [x, y] of sampled) {
      const win = new C.Cartesian2(x, y);
      const gpu = scene.pickPosition(win);
      if (!gpu) continue;
      gpuHits++;
      const cpu = model.pick(scene.camera.getPickRay(win), scene.frameState);
      if (!cpu) continue;
      cpuHits++;
      const d = C.Cartesian3.distance(gpu, cpu);
      sumDist += d;
      maxDist = Math.max(maxDist, d);
    }
    // Deterministic miss: no instance anywhere near the origin (centers at
    // (0,±2,±2), max reach ~0.75) — a -X ray through (0,0,0) must miss.
    const missRay = new C.Ray(new C.Cartesian3(6.5, 0, 0), new C.Cartesian3(-1, 0, 0));
    const missPick = model.pick(missRay, scene.frameState);

    return {
      litPixels: litCount(img),
      interior: pts.length,
      sampled: sampled.length,
      gpuHits,
      cpuHits,
      maxDist,
      meanDist: cpuHits ? sumDist / cpuHits : -1,
      missIsUndefined: missPick === undefined,
      pickPositionSupported: scene.pickPositionSupported,
    };
  })()`);
  } catch (e) {
    note(false, "webgl: section crashed", String(e.message).split("\n")[0]);
    console.log("[webgl console errors]", JSON.stringify(errors.slice(0, 5)));
    r = { litPixels: 0, interior: 0, sampled: 0, gpuHits: 0, cpuHits: 0,
          maxDist: -1, meanDist: -1, missIsUndefined: false };
  }
  console.log("[webgl/BoxInstanced]", JSON.stringify(r));
  note(r.litPixels > 500, "webgl: BoxInstanced renders", `litPixels=${r.litPixels}`);
  note(
    r.gpuHits >= 10,
    "webgl: enough GPU-anchored sample points",
    `interior=${r.interior} gpuHits=${r.gpuHits} (pickPositionSupported=${r.pickPositionSupported})`,
  );
  note(
    r.cpuHits >= Math.ceil(r.gpuHits * 0.95),
    "webgl: CPU pick hits where GPU rendered",
    `cpuHits=${r.cpuHits}/${r.gpuHits}`,
  );
  note(
    r.cpuHits > 0 && r.maxDist >= 0 && r.maxDist < 0.05,
    "webgl: CPU pick position matches GPU depth",
    `maxDist=${r.maxDist?.toFixed?.(4)} meanDist=${r.meanDist?.toFixed?.(4)}`,
  );
  note(r.missIsUndefined, "webgl: ray through empty center misses");
  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  note(realErrors.length === 0, "webgl: no console errors", realErrors.slice(0, 3).join(" | "));
  await page.close();
}

// ─── [2] WebGPU: translation-only instancing render + exact CPU picks ───
if (process.env.PROBE_WEBGPU !== "1") {
  console.log(
    "SKIP  webgpu section (set PROBE_WEBGPU=1) — blocked by " +
      "NEW-WEBGPU-INSTANCED-VA-DIVISORS (instanced models crash the WebGPU " +
      "render loop in VertexArray bind; see header)",
  );
} else {
  const { page, errors } = await openViewer("webgpu");
  let r;
  try {
    r = await page.evaluate(`(async () => {
    ${PAGE_PRELUDE}
    scene.camera.setView({
      destination: new C.Cartesian3(6.5, 0, 0),
      orientation: {
        direction: new C.Cartesian3(-1, 0, 0),
        up: new C.Cartesian3(0, 0, 1),
      },
    });

    // (2a) Matrix-path render baseline: BoxInstanced (has ROTATION).
    const rotated = await loadModel(
      "/Specs/Data/Models/glTF-2.0/BoxInstanced/glTF/box-instanced.gltf",
    );
    for (let i = 0; i < 5; i++) await new Promise((r2) => requestAnimationFrame(r2));
    const litRotated = litCount(await grabFrame());
    scene.primitives.remove(rotated);
    for (let i = 0; i < 3; i++) await new Promise((r2) => requestAnimationFrame(r2));

    // (2b) Translation-only model: render + deterministic CPU picks.
    const model = await loadModel(
      "/Specs/Data/Models/glTF-2.0/BoxInstancedNoNormals/glTF/BoxInstancedNoNormals.gltf",
    );
    for (let i = 0; i < 5; i++) await new Promise((r2) => requestAnimationFrame(r2));
    const litTranslated = litCount(await grabFrame());

    // Unit cubes (±0.5, identity rotation/scale) at glTF (±2,±2,0) →
    // axis-corrected Cesium centers (0,±2,±2). A -X ray through a center
    // hits the +X face at exactly x=0.5 (same as upstream pickModelSpec).
    const centers = [
      [0, -2, 2],
      [0, -2, -2],
      [0, 2, -2],
      [0, 2, 2],
    ];
    const picks = [];
    for (const [cx, cy, cz] of centers) {
      const ray = new C.Ray(
        new C.Cartesian3(10, cy, cz),
        new C.Cartesian3(-1, 0, 0),
      );
      const hit = model.pick(ray, scene.frameState);
      picks.push(
        hit
          ? {
              hit: true,
              err: C.Cartesian3.distance(hit, new C.Cartesian3(0.5, cy, cz)),
            }
          : { hit: false },
      );
    }
    const missRay = new C.Ray(new C.Cartesian3(10, 0, 0), new C.Cartesian3(-1, 0, 0));
    const missPick = model.pick(missRay, scene.frameState);

    return {
      litRotated,
      litTranslated,
      picks,
      missIsUndefined: missPick === undefined,
    };
  })()`);
  } catch (e) {
    note(false, "webgpu: section crashed", String(e.message).split("\n")[0]);
    console.log("[webgpu console errors]", JSON.stringify(errors.slice(0, 5)));
    r = { litRotated: 0, litTranslated: 0, picks: [], missIsUndefined: false };
  }
  console.log("[webgpu]", JSON.stringify(r));
  note(
    r.litRotated > 500,
    "webgpu: matrix-path instancing renders (BoxInstanced)",
    `litPixels=${r.litRotated}`,
  );
  note(
    r.litTranslated > 500,
    "webgpu: translation-only instancing renders (BoxInstancedNoNormals)",
    `litPixels=${r.litTranslated}`,
  );
  const allHit = r.picks.length === 4 && r.picks.every((p) => p.hit);
  const maxErr = Math.max(
    ...r.picks.map((p) => (p.hit ? p.err : Infinity)),
    -Infinity,
  );
  note(
    allHit && maxErr < 1e-6,
    "webgpu: CPU picks hit all 4 instances at exact +X faces",
    `picks=${JSON.stringify(r.picks)}`,
  );
  note(r.missIsUndefined, "webgpu: ray through empty center misses");
  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  note(realErrors.length === 0, "webgpu: no console errors", realErrors.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log(
  failures.length === 0
    ? "\nPROBE PASS — all checks green"
    : `\nPROBE FAIL — ${failures.length} failing: ${failures.join(", ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
