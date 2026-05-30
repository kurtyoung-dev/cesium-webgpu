// probe-classifier-logdepth-flip.mjs
// Slice 3a payoff validation for the renderer-wide log-depth epic.
//
// Reuses the PROVEN scene from probe-classifier-textured-materials.mjs (a small
// sub-degree Stripe-material GroundPrimitive at 350 km nadir over the central
// US — the exact NEW-GROUNDPRIM-TEXTURED-MATERIALS repro) and captures three
// ways: WebGL (reference), WebGPU flag-OFF (baseline-flat), WebGPU flag-ON
// (_logDepthWriteEnabled set at STARTUP, before the primitive builds, so the
// globe writes log depth and the classifier reverses it via the Slice 3a path).
//
// PAYOFF = WebGPU flag-ON polygon-interior color variance jumps from ~flat
// (flag-OFF) toward the WebGL reference (the stripes become visible because the
// log-depth eye-z reconstruction is precise enough for a smooth UV). Reads the
// PNGs so the pattern can be confirmed visually, not just by the ratio.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const OUT = "Tools/visual-regression/output";
const ROI = { x0: 320, y0: 250, x1: 460, y1: 350 };
const LIT = 160;
const STRIPE = `new C.Material({ fabric: { type: "Stripe", uniforms: {
  evenColor: new C.Color(1.0, 0.05, 0.05, 1.0), oddColor: new C.Color(0.05, 0.05, 1.0, 1.0),
  repeat: 10, horizontal: true } } })`;

async function capture(renderer, logDepthOn) {
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 160)); });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const stats = await page.evaluate(async ({ build, logDepthOn }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;            // stop the auto loop FIRST
    const s = v.scene;
    // STARTUP FLIP: set the master switch before the GroundPrimitive (and thus
    // the classifier pipeline) is created, so it builds with LOG_DEPTH from the
    // start (no mid-session rebuild transient). WebGL ignores the field.
    if (logDepthOn && s.context) s.context._logDepthWriteEnabled = true;
    s.skyBox.show = false; s.skyAtmosphere.show = false; s.globe.showGroundAtmosphere = false;
    s.backgroundColor = C.Color.fromCssColorString("#101014");
    const dev = s.context?._device; const de = [];
    if (dev) dev.onuncapturederror = (ev) => de.push(String(ev?.error?.message ?? "").slice(0, 200));

    const material = new Function("C", `return (${build});`)(C);
    const positions = C.Cartesian3.fromDegreesArray([-97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65]);
    const ground = new C.GroundPrimitive({
      geometryInstances: new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }) }),
      appearance: new C.MaterialAppearance({ material, translucent: true, flat: true }),
      classificationType: C.ClassificationType.TERRAIN, asynchronous: false,
    });
    s.groundPrimitives.add(ground);
    for (let i = 0; i < 240; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); if (ground.ready) break; }
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
    for (let i = 0; i < 90; i++) { s.requestRender(); s.render(); await new Promise((r) => requestAnimationFrame(r)); }
    return { logDepthEnabled: !!s.context?._logDepthWriteEnabled, deviceErrs: de.length, deviceErrSample: de.slice(0, 3), ready: ground.ready };
  }, { build: STRIPE, logDepthOn });

  const png = await page.screenshot({ type: "png" });
  const tag = renderer === "webgl" ? "webgl" : (logDepthOn ? "webgpu-ON" : "webgpu-OFF");
  fs.writeFileSync(`${OUT}/ld-stripe-${tag}.png`, png);
  const variance = await page.evaluate(async ({ durl, roi, lit }) => {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let litN = 0, r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0;
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
          const i = (y * c.width + x) * 4; const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r + g + b < lit) continue; litN++; r1 += r; g1 += g; b1 += b; r2 += r * r; g2 += g * g; b2 += b * b;
        }
        let varc = 0; if (litN > 0) { const rm = r1 / litN, gm = g1 / litN, bm = b1 / litN; varc = Math.round((Math.max(0, r2 / litN - rm * rm) + Math.max(0, g2 / litN - gm * gm) + Math.max(0, b2 / litN - bm * bm)) / 3); }
        resolve({ lit: litN, variance: varc });
      };
      img.src = durl;
    });
  }, { durl: `data:image/png;base64,${png.toString("base64")}`, roi: ROI, lit: LIT });

  await browser.close();
  return { ...stats, ...variance, errs };
}

const wgl = await capture("webgl", false);
const off = await capture("webgpu", false);
const on = await capture("webgpu", true);

console.log("=== Slice 3a payoff — Stripe GroundPrimitive @ 350km nadir, polygon-interior variance ===");
console.log("WebGL  reference :", JSON.stringify(wgl));
console.log("WebGPU flag OFF  :", JSON.stringify(off));
console.log("WebGPU flag ON   :", JSON.stringify(on));
const rOff = wgl.variance > 0 ? off.variance / wgl.variance : 0;
const rOn = wgl.variance > 0 ? on.variance / wgl.variance : 0;
console.log(`\nvarRatio(WebGPU/WebGL): OFF=${rOff.toFixed(2)}  ON=${rOn.toFixed(2)}`);
console.log(`ON device errors: ${on.deviceErrs} | ON console/page errs: ${on.errs.length}`);
console.log(on.errs.slice(0, 4).map((e) => "  " + e).join("\n"));
const payoff = rOn >= 0.3 && on.variance > off.variance * 3 && on.deviceErrs === 0;
console.log(`\nPAYOFF ${payoff ? "CONFIRMED" : "NOT confirmed"} (need ON>=0.3 ratio, ON>>OFF, 0 device errors). READ THE PNGs: ld-stripe-{webgl,webgpu-OFF,webgpu-ON}.png`);
