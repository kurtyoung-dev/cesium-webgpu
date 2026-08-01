// C10-11 design-ruling proof — BLEND/translucent picks still function under the
// pick-fleet switch, and the switch does not change their behavior (the ruling:
// OPAQUE picks write log depth; BLEND picks keep depth-test-only / no depth
// write, so they neither self-occlude nor lose pickability). A translucent Model
// (the Model BLEND pick lane — createPickPipeline `isBlend`, depthWriteEnabled
// forced to `!isBlend` = false) and an opaque object are each picked via
// scene.pick at their own pixels, A/B'd with the switch OFF vs ON. Both must
// remain pickable in BOTH states with zero errors — proving the blend pick
// pipeline is preserved (depth-test-only) across the switch. WebGPU only.
//
// (drillPick layer-peel over a shared pixel is NOT used — it does not peel
// reliably on the WebGPU single-target pick FBO, a separate limitation.)
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });
const LON = -75,
  LAT = 40,
  CAM_H = 9000;
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) =>
  errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`),
);
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(
  async ({ LON, LAT, CAM_H }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const ctx = scene.context;
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    const errs = [];
    const dev = ctx?._device;
    if (dev)
      dev.onuncapturederror = (ev) =>
        errs.push(String(ev?.error?.message).slice(0, 200));

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(LON, LAT, CAM_H),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };

    // Opaque box (left).
    const boxInst = new C.GeometryInstance({
      geometry: C.BoxGeometry.fromDimensions({
        vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        dimensions: new C.Cartesian3(800, 800, 800),
      }),
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(LON - 0.02, LAT, 0),
      ),
      attributes: {
        color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.ORANGE),
      },
      id: "opaque-box",
    });
    const boxPrim = new C.Primitive({
      geometryInstances: boxInst,
      appearance: new C.PerInstanceColorAppearance({
        closed: true,
        translucent: false,
      }),
      asynchronous: false,
      allowPicking: true,
    });
    scene.primitives.add(boxPrim);

    // Translucent Model (right) — color alpha < 1 → ALPHA_BLEND → Model BLEND pick lane.
    let model;
    try {
      model = await C.Model.fromGltfAsync({
        url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(LON + 0.02, LAT, 0),
        ),
        scale: 400,
        id: "translucent-model",
      });
      model.color = C.Color.WHITE.withAlpha(0.4);
      model.colorBlendMode = C.ColorBlendMode.MIX;
      scene.primitives.add(model);
    } catch (e) {
      return { fatal: `model load: ${e}` };
    }
    for (let i = 0; i < 240; i++) {
      scene.render();
      await new Promise((r) => setTimeout(r, 8));
      if (model.ready) break;
    }
    await renderN(40);

    const boxWin = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      C.Cartesian3.fromDegrees(LON - 0.02, LAT, 400),
    );
    const mdWin = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      C.Cartesian3.fromDegrees(LON + 0.02, LAT, 500),
    );
    const pickConverge = async (win, wantPred) => {
      if (!win) return { hit: false, note: "no-win" };
      const pos = new C.Cartesian2(Math.round(win.x), Math.round(win.y));
      let last = { hit: false };
      for (let i = 0; i < 18; i++) {
        scene.render();
        const p = await scene.pickAsync(pos, 6, 6);
        if (C.defined(p)) {
          last = {
            hit: true,
            ok: wantPred(p),
            id: typeof p.id === "string" ? p.id : (p.id?.id ?? null),
            isModel: p.primitive === model || p.detail?.model === model,
          };
          if (last.ok) return last;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return last;
    };
    const runGate = async (gate) => {
      ctx._pickLogDepthWriteEnabled = gate;
      await renderN(24);
      const box = await pickConverge(
        boxWin,
        (p) => (typeof p.id === "string" ? p.id : p.id?.id) === "opaque-box",
      );
      const md = await pickConverge(
        mdWin,
        (p) => p.primitive === model || p.detail?.model === model,
      );
      return { gate, box, md };
    };
    // Warm BOTH pick pipelines (hyperbolic OFF + log ON are distinct cache
    // entries) and the armed-async readback before measuring, so neither leg
    // suffers a cold-start miss.
    await runGate(true);
    await runGate(false);
    await runGate(true);
    const off = await runGate(false);
    ctx._pickLogDepthWriteEnabled = true;
    await renderN(10);
    const on = await runGate(true);
    return { off, on, modelTranslucent: model.color?.alpha < 1.0, errs };
  },
  { LON, LAT, CAM_H },
);
const buf = await page.screenshot();
fs.writeFileSync(`${OUT}/probe-c10-11-blend-pickability.png`, buf);
await browser.close();

console.log(
  "=== C10-11 BLEND pickability (translucent Model + opaque both pickable under switch) ===",
);
console.log("model translucent:", out.modelTranslucent);
console.log("  OFF:", JSON.stringify(out.off));
console.log("  ON :", JSON.stringify(out.on));
const errTotal = errors.length + (out.errs?.length ?? 0);
const offOk = out.off?.box?.ok && out.off?.md?.ok;
const onOk = out.on?.box?.ok && out.on?.md?.ok;
const pass = out.modelTranslucent && offOk && onOk && errTotal === 0;
if (errTotal)
  console.log(
    "errors:",
    errTotal,
    errors.slice(0, 4),
    (out.errs || []).slice(0, 4),
  );
console.log(
  `  blend(model)+opaque pickable: OFF=${offOk} ON=${onOk} (switch-independent blend behavior)`,
);
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
