// Settle-based classifier log-depth comparison. Renders until the globe is
// FULLY loaded (scene.globe.tilesLoaded) + the GroundPrimitive is ready, so the
// classifier coverage is reproducible (no partial-tile-streaming variance), for
// WebGL (ref) / WebGPU flag-OFF / WebGPU flag-ON (startup flip). Same Stripe
// scene as probe-classifier-textured-materials.mjs.
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const OUT = "Tools/visual-regression/output";
const STRIPE = `new C.Material({ fabric: { type: "Stripe", uniforms: {
  evenColor: new C.Color(1.0,0.05,0.05,1.0), oddColor: new C.Color(0.05,0.05,1.0,1.0),
  repeat: 10, horizontal: true } } })`;

async function capture(renderer, logDepthOn) {
  const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push("PAGE:" + e.message.slice(0, 120)));
  p.on("console", (m) => { if (m.type() === "error") errs.push("ERR:" + m.text().slice(0, 120)); });
  await p.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await p.waitForFunction(() => !!window.viewer, { timeout: 90000 });
  const info = await p.evaluate(async ({ build, logDepthOn }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer; v.useDefaultRenderLoop = false; const s = v.scene;
    if (logDepthOn && s.context) s.context._logDepthWriteEnabled = true; // startup flip
    s.skyBox.show = false; s.skyAtmosphere.show = false; s.globe.showGroundAtmosphere = false;
    s.backgroundColor = C.Color.fromCssColorString("#101014");
    const dev = s.context?._device; const de = []; if (dev) dev.onuncapturederror = (e) => de.push(String(e?.error?.message ?? "").slice(0, 160));
    // Frame the target FIRST so the right tiles stream in.
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
    const material = new Function("C", `return (${build});`)(C);
    const positions = C.Cartesian3.fromDegreesArray([-97.85,41.35, -97.15,41.35, -97.15,41.65, -97.85,41.65]);
    const ground = new C.GroundPrimitive({ geometryInstances: new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }) }), appearance: new C.MaterialAppearance({ material, translucent: true, flat: true }), classificationType: C.ClassificationType.TERRAIN, asynchronous: false });
    s.groundPrimitives.add(ground);
    // SETTLE: render until tiles fully loaded AND the primitive is ready, with a
    // generous cap (~2500 frames). tilesLoaded must hold for a few consecutive
    // frames (it can flicker false as new tiles enqueue).
    let frames = 0, settledStreak = 0;
    while (frames < 2500) {
      s.render(); await new Promise((r) => requestAnimationFrame(r)); frames++;
      const settled = s.globe.tilesLoaded && ground.ready;
      settledStreak = settled ? settledStreak + 1 : 0;
      if (settledStreak >= 30) break;
    }
    // a few more stable frames
    for (let i = 0; i < 20; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); }
    return { frames, tilesLoaded: s.globe.tilesLoaded, ready: ground.ready, deviceErrs: de.length, deviceErrSample: de.slice(0, 2) };
  }, { build: STRIPE, logDepthOn });
  const png = await p.screenshot({ type: "png" });
  const tag = renderer === "webgl" ? "webgl" : (logDepthOn ? "webgpu-ON" : "webgpu-OFF");
  fs.writeFileSync(`${OUT}/settle-stripe-${tag}.png`, png);
  const stat = await p.evaluate(async (durl) => new Promise((res) => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const cx = c.getContext("2d"); cx.drawImage(img, 0, 0); const d = cx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, r1=0,g1=0,b1=0,r2=0,g2=0,b2=0;
      for (let y = 250; y < 350; y++) for (let x = 320; x < 460; x++) { const i = (y*c.width+x)*4; if (d[i]+d[i+1]+d[i+2] < 160) continue; n++; r1+=d[i];g1+=d[i+1];b1+=d[i+2]; r2+=d[i]*d[i];g2+=d[i+1]*d[i+1];b2+=d[i+2]*d[i+2]; }
      let vv = 0; if (n > 0) { const rm=r1/n,gm=g1/n,bm=b1/n; vv=Math.round((Math.max(0,r2/n-rm*rm)+Math.max(0,g2/n-gm*gm)+Math.max(0,b2/n-bm*bm))/3); }
      res({ lit: n, variance: vv });
    }; img.src = durl;
  }), `data:image/png;base64,${png.toString("base64")}`);
  await b.close();
  return { ...info, ...stat, errs: errs.length };
}

const wgl = await capture("webgl", false);
const off = await capture("webgpu", false);
const on = await capture("webgpu", true);
console.log("WebGL  ref  :", JSON.stringify(wgl));
console.log("WebGPU OFF  :", JSON.stringify(off));
console.log("WebGPU ON   :", JSON.stringify(on));
console.log(`\nvarRatio(ON/WebGL)=${(on.variance/(wgl.variance||1)).toFixed(2)}  ON-vs-OFF: ${off.variance}->${on.variance}`);
console.log("PNGs: settle-stripe-{webgl,webgpu-OFF,webgpu-ON}.png");
