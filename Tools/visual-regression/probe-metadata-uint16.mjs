#!/usr/bin/env node
// probe-metadata-uint16 — METADATA-UINT16-32 proof: wide-integer (UINT16 /
// UINT32) property-TEXTURE metadata round-trips through the WGSL multi-byte
// channel unpack (little-endian across 2/4 RGBA8 channels, the
// czm_unpackTexture convention) on WebGPU, matching WebGL.
//
// Asset: Tools/visual-regression/assets/PropertyTextureUint16.gltf (authored by
//   this task) — a unit quad whose 16x16 property texture has 4 vertical
//   stripes with per-texel bytes [b0, b1, b2, b3]:
//     intensity16 (UINT16, channels [0,1])     = b0 | b1<<8
//     code32      (UINT32, channels [0,1,2,3]) = b0 | b1<<8 | b2<<16 | b3<<24
//   Stripe 1 has b0=240 (nonzero LOW byte) so the little-endian weight-1
//   contribution of channel 0 is provable through the pick quantization
//   (13040 → byte 51, whereas a decode ignoring the low byte gives 50).
//
// pickMetadata expectations — the RGBA8 pick-FBO path is LOSSY for wide
//   unnormalized integers BY WEBGL'S OWN CONVENTION (documented in
//   DP-H46_METADATA_DESIGN.md "from e"): the shader packs value/max into ONE
//   byte channel and `MetadataPicking.decodeRawMetadataValue` reads the bytes
//   back LITTLE-endian, so a UINT16 value v decodes to round(v*255/65535)
//   (the quantized byte, in the low byte position). Parity = both backends
//   produce this EXACT deterministic value. Pre-fix WGSL read only the first
//   channel byte (0 for stripes 0/2/3) → decoded 0, so the expected values
//   are a sharp test of the full multi-byte decode.
//
// What we prove:
//   (1) pickMetadata(intensity16) decodes EXACTLY round(v*255/65535) per
//       authored stripe on BOTH backends (>=3 of 4 stripes) + backends agree.
//   (2) pickMetadata(code32) decodes EXACTLY round(v*255/(2^32-1)) per stripe
//       on BOTH backends. (Also exercises this task's WebGL fix: the GLSL
//       `float(4294967295)` int-literal overflow made WebGL UINT32 pick
//       decode to 0 before.)
//   (3) DISPLAY (WebGPU): with CesiumWebGPUMetadataDebug the generated
//       metadataDebugScalar paints s = intensity16/65535 → red ==
//       round(v*255/65535) per stripe; canvas-sampled at stripe centers.
//   (4) 0 console / device-validation errors.
//
// Usage: node Tools/visual-regression/probe-metadata-uint16.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL_URL = "/Tools/visual-regression/assets/PropertyTextureUint16.gltf";
const CLASS_NAME = "wideValues";

// Authored per-stripe texel bytes (see gen script header in the asset task).
const STRIPE_BYTES = [
  [0, 20, 10, 40],
  [240, 50, 11, 60],
  [0, 77, 12, 80],
  [0, 100, 13, 100],
];
const U16_AUTHORED = STRIPE_BYTES.map(([b0, b1]) => b0 | (b1 << 8));
const U32_AUTHORED = STRIPE_BYTES.map(
  ([b0, b1, b2, b3]) => (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0,
);
// Expected pick decodes: one quantized byte, read back little-endian (the
// byte IS the decoded value). Deterministic on both backends.
const U16_PICK = U16_AUTHORED.map((v) => Math.round((v * 255) / 65535));
const U32_PICK = U32_AUTHORED.map((v) => Math.round((v * 255) / 4294967295));
// Debug-paint red level = round(s*255), s = intensity16/65535 → same as U16_PICK.
const DISPLAY_RED = U16_PICK;

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
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
    async ({ modelUrl, className, rendererName }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.clock.shouldAnimate = false;
      scene.globe.enableLighting = false;

      const scale = 12.0;
      const modelPos = C.Cartesian3.fromDegrees(-75, 40, 400);
      const enu = C.Transforms.eastNorthUpToFixedFrame(modelPos);
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix: enu,
        scale,
      });
      scene.primitives.add(model);

      const render = () =>
        new Promise((r) => {
          scene.render();
          requestAnimationFrame(r);
        });
      for (let i = 0; i < 400; i++) {
        await render();
        if (model.ready && scene.globe.tilesLoaded && i > 60) break;
      }

      // Deterministic framing: the glTF Y-up → Z-up axis correction makes the
      // quad VERTICAL in the ENU frame (it spans north/up at east=0, normal
      // along east — bs.center is local (0, 6, 6)). View it FACE-ON: heading
      // 90° places the camera west of the quad looking east (doubleSided).
      scene.camera.lookAt(
        model.boundingSphere.center,
        new C.HeadingPitchRange(
          C.Math.toRadians(90),
          C.Math.toRadians(-10),
          45.0,
        ),
      );
      for (let i = 0; i < 120; i++) await render();

      // Sample a horizontal line across the quad at mid-height: local ENU
      // (0, t*scale, 0.5*scale) for t in [0.05, 0.95]. The texture's u axis
      // runs along the local north span, so stripe(t) = floor(t*4). The t
      // values are chosen so no sample sits on a stripe boundary texel.
      const positions = [];
      for (let k = 0; k < 16; k++) {
        const t = 0.05 + (0.9 * k) / 15;
        const stripe = Math.min(3, Math.floor(t * 4));
        const world = C.Matrix4.multiplyByPoint(
          enu,
          new C.Cartesian3(0, t * scale, 0.5 * scale),
          new C.Cartesian3(),
        );
        const win = C.SceneTransforms.worldToWindowCoordinates(scene, world);
        if (!C.defined(win)) {
          continue;
        }
        let ok = false;
        for (let i = 0; i < 10; i++) {
          const p = scene.pick(new C.Cartesian2(win.x, win.y));
          await render();
          const hit =
            p?.detail?.model?.structuralMetadata ??
            p?.primitive?.structuralMetadata;
          if (C.defined(hit)) {
            ok = true;
            break;
          }
        }
        if (ok) {
          positions.push({ stripe, k, x: win.x, y: win.y });
        }
      }

      async function pickMetadataConverged(pos, propertyName) {
        let last;
        for (let i = 0; i < 26; i++) {
          last = scene.pickMetadata(
            new C.Cartesian2(pos.x, pos.y),
            undefined,
            className,
            propertyName,
          );
          await render();
          if (C.defined(last) && last !== null && last !== 0) {
            const n = typeof last === "bigint" ? Number(last) : last;
            if (typeof n === "number" && n !== 0) return last;
          }
        }
        return last;
      }

      const perProperty = {};
      for (const propertyName of ["intensity16", "code32"]) {
        const values = [];
        for (const pos of positions) {
          const val = await pickMetadataConverged(pos, propertyName);
          let serial;
          if (typeof val === "bigint") serial = Number(val);
          else if (typeof val === "number") serial = val;
          else serial = null;
          values.push({
            stripe: pos.stripe,
            k: pos.k,
            x: pos.x,
            y: pos.y,
            value: serial,
          });
        }
        perProperty[propertyName] = { values };
      }

      // DISPLAY proof (WebGPU only): flip the metadata debug paint and sample
      // canvas pixels at the stripe positions via a 2D-canvas copy.
      let display;
      let displayOff;
      if (scene.context?.isWebGPU) {
        // Sample the SAME stripe positions from a same-task canvas copy.
        const sampleStripes = () => {
          const src = scene.canvas;
          const c2d = document.createElement("canvas");
          c2d.width = src.width;
          c2d.height = src.height;
          const ctx = c2d.getContext("2d");
          ctx.drawImage(src, 0, 0);
          const dpr = src.width / src.clientWidth;
          return positions.map((p) => {
            const d = ctx.getImageData(
              Math.round(p.x * dpr),
              Math.round(p.y * dpr),
              1,
              1,
            ).data;
            return {
              stripe: p.stripe,
              k: p.k,
              x: p.x,
              y: p.y,
              r: d[0],
              g: d[1],
              b: d[2],
            };
          });
        };
        globalThis.CesiumWebGPUMetadataDebug = true;
        for (let i = 0; i < 60; i++) await render();
        display = sampleStripes();
        globalThis.CesiumWebGPUMetadataDebug = false;
        for (let i = 0; i < 20; i++) await render();
        // LATENT VACUITY, closed 2026-08-07 (NEW-PROBE-VACUOUS-REACHABILITY-
        // ASSERTION item 5). The debug paint was flipped ON and back OFF and
        // NOTHING was ever asserted on the OFF frame — unlike both sibling
        // metadata probes, which each carry an explicit off-gate cell. Without
        // it, a display path that paints those stripes for a reason unrelated
        // to the metadata debug flag reads as proof the flag works.
        displayOff = sampleStripes();
      }

      return {
        renderer: rendererName,
        isWebGPU: !!scene.context?.isWebGPU,
        positions,
        perProperty,
        display,
        displayOff,
        deviceErrors: window.__probeDeviceErrors ?? [],
      };
    },
    { modelUrl: MODEL_URL, className: CLASS_NAME, rendererName: renderer },
  );

  if (renderer === "webgpu") {
    await page.evaluate(async () => {
      globalThis.CesiumWebGPUMetadataDebug = true;
      const scene = window.viewer.scene;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => {
          scene.render();
          requestAnimationFrame(r);
        });
      }
    });
    await page.screenshot({
      path: path.join(OUT_DIR, `metadata-uint16-${renderer}-debug.png`),
    });
    await page.evaluate(async () => {
      globalThis.CesiumWebGPUMetadataDebug = false;
      const scene = window.viewer.scene;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => {
          scene.render();
          requestAnimationFrame(r);
        });
      }
    });
  }
  await page.screenshot({
    path: path.join(OUT_DIR, `metadata-uint16-${renderer}.png`),
  });
  await browser.close();
  return { ...result, consoleErrors: errors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-metadata-uint16] UINT16/UINT32 property-texture round-trip\n",
  );
  console.log(
    `  authored u16: ${JSON.stringify(U16_AUTHORED)} → expected pick ${JSON.stringify(U16_PICK)}`,
  );
  console.log(
    `  authored u32: ${JSON.stringify(U32_AUTHORED)} → expected pick ${JSON.stringify(U32_PICK)}\n`,
  );

  const webgpu = await runBackend("webgpu");
  const webgl = await runBackend("webgl");

  const fails = [];
  const notes = [];

  for (const b of [webgpu, webgl]) {
    const covered = new Set((b.positions ?? []).map((p) => p.stripe));
    if ((b.positions?.length ?? 0) < 12 || covered.size < 4) {
      fails.push(
        `${b.renderer}: only ${b.positions?.length ?? 0}/16 sample points picked the model (stripes covered: ${covered.size}/4)`,
      );
    }
    for (const e of [...(b.consoleErrors ?? []), ...(b.deviceErrors ?? [])]) {
      fails.push(`${b.renderer} error: ${e}`);
    }
  }

  // OFF-GATE (added 2026-08-07). Turning the metadata debug paint off must
  // CHANGE the sampled stripes — a mechanism-toggle control, matching the
  // explicit off-gate cells `probe-metadata-mat` (scene E) and
  // `probe-metadata-table-texture` (cell D) already carry. Zero margin: the
  // requirement is only that at least one sampled point moved, which is the
  // weakest statement that still excludes a paint the flag does not drive.
  if (webgpu.isWebGPU && webgpu.display && webgpu.displayOff) {
    const moved = webgpu.display.filter((on, k) => {
      const off = webgpu.displayOff[k];
      return off && (on.r !== off.r || on.g !== off.g || on.b !== off.b);
    });
    if (moved.length === 0) {
      fails.push(
        `webgpu off-gate: switching CesiumWebGPUMetadataDebug off changed NONE of ` +
          `the ${webgpu.display.length} sampled stripe pixels, so the debug paint ` +
          `the display proof reads is not driven by the flag`,
      );
    } else {
      notes.push(
        `off-gate: ${moved.length}/${webgpu.display.length} sampled stripes changed when the debug paint was switched off`,
      );
    }
  }

  // (1)+(2) Per-stripe EXACT pick decode on both backends.
  const expectations = [
    { prop: "intensity16", expected: U16_PICK },
    { prop: "code32", expected: U32_PICK },
  ];
  for (const { prop, expected } of expectations) {
    for (const b of [webgpu, webgl]) {
      const vals = b.perProperty?.[prop]?.values ?? [];
      const rendered = vals
        .map((d) => `s${d.stripe}=${d.value} (want ${expected[d.stripe]})`)
        .join(", ");
      console.log(`  ${b.renderer} ${prop}: ${rendered || "(no positions)"}`);
      const exactStripes = new Set();
      for (const d of vals) {
        if (d.value === null) {
          fails.push(
            `${b.renderer} ${prop} stripe ${d.stripe} (k=${d.k}): pickMetadata returned null`,
          );
        } else if (d.value !== expected[d.stripe]) {
          fails.push(
            `${b.renderer} ${prop} stripe ${d.stripe} (k=${d.k}): decoded ${d.value}, expected EXACTLY ${expected[d.stripe]}`,
          );
        } else {
          exactStripes.add(d.stripe);
        }
      }
      if (exactStripes.size < 4) {
        fails.push(
          `${b.renderer} ${prop}: only ${exactStripes.size}/4 stripes decoded exactly`,
        );
      }
    }
    // Cross-backend agreement on shared sample points.
    const gp = new Map(
      (webgpu.perProperty?.[prop]?.values ?? []).map((d) => [d.k, d.value]),
    );
    const gl = new Map(
      (webgl.perProperty?.[prop]?.values ?? []).map((d) => [d.k, d.value]),
    );
    for (const [k, gv] of gp) {
      if (gl.has(k) && gl.get(k) !== gv) {
        fails.push(`${prop} sample k=${k}: WebGPU=${gv} != WebGL=${gl.get(k)}`);
      }
    }
  }

  // (3) DISPLAY (WebGPU): debug-paint red == expected per stripe (±3).
  const display = webgpu.display ?? [];
  const TOL = 3;
  const displayStripes = new Set();
  for (const d of display) {
    const want = DISPLAY_RED[d.stripe];
    const ok = Math.abs(d.r - want) <= TOL;
    console.log(
      `  webgpu display stripe ${d.stripe} (k=${d.k ?? "?"}): rgb(${d.r},${d.g},${d.b}) — want red ~${want} ${ok ? "OK" : "MISMATCH"}`,
    );
    if (ok) displayStripes.add(d.stripe);
    else {
      fails.push(
        `display stripe ${d.stripe}: red=${d.r}, expected ~${want} (±${TOL})`,
      );
    }
  }
  if (displayStripes.size < 4) {
    fails.push(
      `display: only ${displayStripes.size}/4 stripes painted the expected red level`,
    );
  }

  const report = {
    runAt: new Date().toISOString(),
    authored: { u16: U16_AUTHORED, u32: U32_AUTHORED },
    expected: { u16Pick: U16_PICK, u32Pick: U32_PICK, displayRed: DISPLAY_RED },
    webgpu: {
      positions: webgpu.positions,
      intensity16: webgpu.perProperty?.intensity16?.values,
      code32: webgpu.perProperty?.code32?.values,
      display: webgpu.display,
      errors: [...(webgpu.consoleErrors ?? []), ...(webgpu.deviceErrors ?? [])],
    },
    webgl: {
      positions: webgl.positions,
      intensity16: webgl.perProperty?.intensity16?.values,
      code32: webgl.perProperty?.code32?.values,
      errors: [...(webgl.consoleErrors ?? []), ...(webgl.deviceErrors ?? [])],
    },
    notes,
    PASS: fails.length === 0,
    fails,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "metadata-uint16-report.json"),
    JSON.stringify(report, null, 2),
  );

  if (notes.length) {
    console.log("\n  Notes:");
    notes.forEach((n) => console.log(`    - ${n}`));
  }
  console.log(`\n  PASS=${report.PASS}`);
  if (fails.length) {
    console.log("  FAILS:");
    fails.forEach((f) => console.log(`    - ${f}`));
  }
  console.log(
    `\n  report: ${path.join(OUT_DIR, "metadata-uint16-report.json")}`,
  );
  process.exit(report.PASS ? 0 : 1);
})();
