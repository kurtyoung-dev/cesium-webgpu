// Wave B de-risk: does flipping the renderer-wide log-depth master switch fix
// the Checkerboard far-corner reconstruction-precision artifact (NEW-GROUNDPRIM-
// CLASSIFIER-RECON-PRECISION)? Globe-only scene (only the globe writes depth, so
// no z-fight from non-logging geometry). Capture switch-OFF (baseline artifact)
// vs switch-ON (log depth). Measure local variance in the FAR (upper-right)
// quadrant of the polygon — solid => artifact; patterned => fixed. Nothing is
// committed; this only reads pixels.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
p.on("pageerror", (e) => errs.push("PAGE:" + e.message.slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error") errs.push("ERR:" + m.text().slice(0, 160)); });
await p.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
await p.waitForFunction(() => !!window.viewer, { timeout: 90000 });

// Build the scene + a Checkerboard ground primitive; settle.
const setup = await p.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer; v.useDefaultRenderLoop = false; const s = v.scene;
  s.skyBox.show = false; s.skyAtmosphere.show = false; s.globe.showGroundAtmosphere = false;
  s.backgroundColor = C.Color.fromCssColorString("#101014");
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
  const material = new C.Material({ fabric: { type: "Checkerboard", uniforms: { lightColor: new C.Color(1, .05, .05, 1), darkColor: new C.Color(.05, .05, 1, 1), repeat: new C.Cartesian2(8, 8) } } });
  const positions = C.Cartesian3.fromDegreesArray([-97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65]);
  const ground = new C.GroundPrimitive({ geometryInstances: new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }) }), appearance: new C.MaterialAppearance({ material, translucent: true, flat: true }), classificationType: C.ClassificationType.TERRAIN, asynchronous: false });
  s.groundPrimitives.add(ground);
  window.__ground = ground;
  let f = 0, streak = 0;
  while (f < 2500) { s.render(); await new Promise(r => requestAnimationFrame(r)); f++; const st = s.globe.tilesLoaded && ground.ready; streak = st ? streak + 1 : 0; if (streak >= 30) break; }
  for (let i = 0; i < 10; i++) { s.render(); await new Promise(r => requestAnimationFrame(r)); }
  return { settled: s.globe.tilesLoaded && ground.ready, frames: f };
});

const png1 = await p.screenshot({ type: "png" });

// Flip the master switch ON + enable scene log depth, render, capture.
const flip = await p.evaluate(async () => {
  const s = window.viewer.scene;
  const before = !!s.context._logDepthWriteEnabled;
  s.context._logDepthWriteEnabled = true;
  try { s.logarithmicDepthBuffer = true; } catch (e) {}
  for (let i = 0; i < 20; i++) { s.render(); await new Promise(r => requestAnimationFrame(r)); }
  // Report whether log depth actually engaged this frame.
  let useLogDepth;
  try { useLogDepth = (s._view?.frameState ?? s._frameState ?? s.frameState)?.useLogDepth; } catch (e) { useLogDepth = "err"; }
  return { before, after: !!s.context._logDepthWriteEnabled, useLogDepth, logarithmicDepthBuffer: s.logarithmicDepthBuffer };
});

const png2 = await p.screenshot({ type: "png" });

// Decode both, measure local variance in the polygon's far (upper-right) quadrant
// vs the near (lower-left) quadrant.
async function quadVar(durl) {
  return await p.evaluate((d) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, c.width, c.height).data;
      const region = (x0, x1, y0, y1) => {
        const rs = [];
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * c.width + x) * 4; rs.push(data[i], data[i + 1], data[i + 2]); }
        const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
        const varc = rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rs.length;
        return Math.round(varc);
      };
      // polygon ~ x[348..452] y[268..332]; far/NE quadrant = right+top, near/SW = left+bottom
      res({ farUR: region(404, 450, 270, 300), nearLL: region(350, 396, 302, 330) });
    };
    img.src = d;
  }), durl);
}
const vOff = await quadVar("data:image/png;base64," + png1.toString("base64"));
const vOn = await quadVar("data:image/png;base64," + png2.toString("base64"));

const fs = await import("node:fs");
fs.writeFileSync("Tools/visual-regression/output/logdepth-payoff-off.png", png1);
fs.writeFileSync("Tools/visual-regression/output/logdepth-payoff-on.png", png2);

console.log("setup:", JSON.stringify(setup));
console.log("flip:", JSON.stringify(flip));
console.log("variance far-UR (artifact corner): OFF =", vOff.farUR, " ON =", vOn.farUR, "  (higher = checkerboard present; ~0 = solid/artifact)");
console.log("variance near-LL (good corner):     OFF =", vOff.nearLL, " ON =", vOn.nearLL, "  (sanity: should be high both)");
console.log("errs:", errs.length, errs.slice(0, 4));
await b.close();
