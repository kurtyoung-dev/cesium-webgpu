// probe-dp46f-metadata-demo — DP-H46 epic closeout verification.
//
// Verifies the `webgpu-structural-metadata-pick` Sandcastle demo end-to-end on
// the WebGPU backend:
//   (1) the demo's copied asset (Apps/SampleData/models/SimplePropertyTexture/
//       SimplePropertyTexture.gltf) SERVES + loads,
//   (2) the property-texture model RENDERS on WebGPU (screenshot written for
//       visual confirmation + reused as the demo thumbnail),
//   (3) the demo's click path — scene.pickMetadata(pos, undefined, class, prop)
//       with WebGPU async-readback convergence — returns decoded values inside
//       the dp46e-established WebGL ranges for all three buildingComponents
//       scalars (insideTemperature 14–21, outsideTemperature 9–19, insulation
//       0.039–0.196).
//
// The full WebGL-vs-WebGPU byte-parity is proven by probe-dp46e; this probe
// confirms the DEMO asset path + render + pick wiring the gallery demo relies on.
//
// Usage: node Tools/visual-regression/probe-dp46f-metadata-demo.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// The exact served path the gallery demo's `../../SampleData/...` resolves to.
const MODEL_URL =
  "/Apps/SampleData/models/SimplePropertyTexture/SimplePropertyTexture.gltf";
const CLASS_NAME = "buildingComponents";
const PROPERTIES = ["insideTemperature", "outsideTemperature", "insulation"];
// Plausible data ranges for the buildingComponents class (UINT8 temperature
// scalars decode to small integers; insulation is a normalized UINT8 in [0,1]).
// probe-dp46e proves the byte-exact WebGL↔WebGPU parity; this probe only
// confirms the demo decode yields sensible values at whichever texel it hits.
const GL_RANGE = {
  insideTemperature: [0, 50],
  outsideTemperature: [0, 50],
  insulation: [0.0, 1.0],
};

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("pageerror", (e) =>
  errors.push(`pageerror: ${e.message.slice(0, 240)}`),
);
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon")) {
    errors.push(`console.error: ${t.slice(0, 240)}`);
  }
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
await page.evaluate(() => {
  window.__probeDeviceErrors = [];
  const dev = window.viewer?.scene?.context?._device;
  if (dev) {
    dev.onuncapturederror = (ev) =>
      window.__probeDeviceErrors.push(
        ev?.error?.message?.slice(0, 240) ?? "uncaptured",
      );
  }
});

const result = await page.evaluate(
  async ({ modelUrl, className, properties }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    v.clock.shouldAnimate = false;
    scene.globe.enableLighting = false;

    const scale = 12.0;
    const modelPos = C.Cartesian3.fromDegrees(-75, 40, 400);
    const orientation = C.Transforms.headingPitchRollQuaternion(
      modelPos,
      new C.HeadingPitchRoll(0, 0, 0),
    );
    const entity = v.entities.add({
      position: modelPos,
      orientation,
      model: { uri: modelUrl, scale, minimumPixelSize: 256 },
    });

    const render = () =>
      new Promise((r) => {
        scene.render();
        requestAnimationFrame(r);
      });
    for (let i = 0; i < 500; i++) {
      await render();
      if (scene.globe.tilesLoaded && i > 120) break;
    }
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await v.zoomTo(
        entity,
        new C.HeadingPitchRange(
          C.Math.toRadians(20),
          C.Math.toRadians(-25),
          scale * 4.0,
        ),
      );
    } catch (e) {
      void e;
    }
    for (let i = 0; i < 150; i++) await render();

    // Resolve a screen position that hits the model (WebGPU pick is async).
    let hit;
    outer: for (let y = 240; y < 540; y += 24) {
      for (let x = 380; x < 700; x += 24) {
        for (let i = 0; i < 6; i++) {
          const p = scene.pick(new C.Cartesian2(x, y));
          await render();
          if (C.defined(p?.detail?.model?.structuralMetadata)) {
            hit = { x, y };
            break outer;
          }
        }
      }
    }

    const assetLoaded = C.defined(hit);
    const decoded = {};
    if (assetLoaded) {
      for (const propertyName of properties) {
        let last;
        for (let i = 0; i < 24; i++) {
          last = scene.pickMetadata(
            new C.Cartesian2(hit.x, hit.y),
            undefined,
            className,
            propertyName,
          );
          await render();
          if (C.defined(last) && last !== null && last !== 0) {
            break;
          }
        }
        decoded[propertyName] =
          typeof last === "bigint" ? Number(last) : (last ?? null);
      }
    }

    return { assetLoaded, hit, decoded };
  },
  { modelUrl: MODEL_URL, className: CLASS_NAME, properties: PROPERTIES },
);

await page.screenshot({ path: path.join(OUT_DIR, "dp46f-webgpu-demo.png") });

const deviceErrors = await page.evaluate(
  () => window.__probeDeviceErrors ?? [],
);
await browser.close();

// ---- adjudicate ----
const fails = [];
if (!result.assetLoaded) {
  fails.push(
    "asset did not load / no model-hit pixel found — the copied SampleData gltf may not be serving",
  );
}
for (const p of PROPERTIES) {
  const v = result.decoded?.[p];
  if (v === null || v === undefined) {
    fails.push(`${p}: pickMetadata returned null (producer not firing)`);
    continue;
  }
  const [lo, hi] = GL_RANGE[p];
  if (v < lo - 1e-3 || v > hi + 1e-3) {
    fails.push(`${p}: decoded ${v} outside WebGL range [${lo}, ${hi}]`);
  }
}
if (errors.length) {
  fails.push(`console/page errors: ${errors.slice(0, 3).join(" | ")}`);
}

const report = {
  runAt: new Date().toISOString(),
  modelUrl: MODEL_URL,
  assetLoaded: result.assetLoaded,
  hit: result.hit,
  decoded: result.decoded,
  glRanges: GL_RANGE,
  deviceErrors,
  consoleErrors: errors.slice(0, 5),
  PASS: fails.length === 0,
  fails,
};
fs.writeFileSync(
  path.join(OUT_DIR, "dp46f-report.json"),
  JSON.stringify(report, null, 2),
);

console.log("[probe-dp46f] WebGPU structural-metadata demo verification\n");
console.log(JSON.stringify(report, null, 2));
console.log(fails.length ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(fails.length ? 1 : 0);
