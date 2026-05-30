// Ground-truth diagnostic for the WebGPU classifier log-depth chain. The
// classifier dsColorFS has a TEMP DIAG that (when logDepthActive) outputs
//   R = storedDepth (sampled globe depth)
//   G = decoded eyeDist / 1e6  (clamped 0..1)
//   B = encodeFrustum.y / 1e10 (clamped 0..1)
// for textured-material fragments. Reads the polygon-center pixels and prints
// median RGB so we can tell EXACTLY where the chain breaks:
//   R~0.55 -> globe wrote LOG; R~0.97+ -> globe wrote STANDARD ndc z (producer bug)
//   G~0.35 -> decode correct (350km); G~1.0 -> garbage (~1e12) decode
//   B~1.0  -> encFar==1e10 captured; B~0 -> encode frustum not delivered
// If we instead see STRIPE material colors (red/blue, NOT a flat diag color),
// logDepthActive is FALSE -> the log path is inert (gate/flip-invalidation bug).
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const STRIPE = `new C.Material({ fabric: { type: "Stripe", uniforms: {
  evenColor: new C.Color(1.0,0.05,0.05,1.0), oddColor: new C.Color(0.05,0.05,1.0,1.0),
  repeat: 10, horizontal: true } } })`;

const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
p.on("pageerror", (e) => errs.push("PAGE:" + e.message.slice(0, 140)));
p.on("console", (m) => { if (m.type() === "error") errs.push("ERR:" + m.text().slice(0, 140)); });
await p.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
await p.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const info = await p.evaluate(async ({ build }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer; v.useDefaultRenderLoop = false; const s = v.scene;
  if (s.context) s.context._logDepthWriteEnabled = true;
  s.skyBox.show = false; s.skyAtmosphere.show = false; s.globe.showGroundAtmosphere = false;
  s.backgroundColor = C.Color.fromCssColorString("#101014");
  const out = {
    useLogDepth: undefined, logDepthWriteEnabled: s.context?._logDepthWriteEnabled,
  };
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
  const material = new Function("C", `return (${build});`)(C);
  const positions = C.Cartesian3.fromDegreesArray([-97.85,41.35, -97.15,41.35, -97.15,41.65, -97.85,41.65]);
  const ground = new C.GroundPrimitive({ geometryInstances: new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }) }), appearance: new C.MaterialAppearance({ material, translucent: true, flat: true }), classificationType: C.ClassificationType.TERRAIN, asynchronous: false });
  s.groundPrimitives.add(ground);
  let frames = 0, settledStreak = 0;
  while (frames < 2500) {
    s.render(); await new Promise((r) => requestAnimationFrame(r)); frames++;
    const settled = s.globe.tilesLoaded && ground.ready;
    settledStreak = settled ? settledStreak + 1 : 0;
    if (settledStreak >= 30) break;
  }
  for (let i = 0; i < 15; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); }
  // try to read frameState.useLogDepth post-render
  try { out.useLogDepth = (s._view?.frameState ?? s._frameState ?? s.frameState)?.useLogDepth; } catch (e) { out.useLogDepth = "err:" + e.message; }
  // GPU readback of the U buffer's frustum region (bytes 624-687) to see the
  // ACTUAL buffer bytes vs what the shader reads. Sentinel = 11,22,33,44.
  try {
    const dev = s.context._dbgDev, ubuf = s.context._dbgUBuf;
    if (dev && ubuf) {
      const rb = dev.createBuffer({ size: 256, usage: 0x0001 | 0x0008 }); // MAP_READ | COPY_DST
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(ubuf, 624, rb, 0, 64);
      dev.queue.submit([enc.finish()]);
      await rb.mapAsync(1); // GPUMapMode.READ
      const fl = new Float32Array(rb.getMappedRange().slice(0));
      out.uBufFrustum = Array.from(fl.slice(0, 8));
      rb.unmap();
    }
  } catch (e) { out.uBufFrustum = "err:" + e.message; }
  out.frames = frames; out.tilesLoaded = s.globe.tilesLoaded; out.ready = ground.ready;
  try { out.encodeNearFar = Array.from(s.context._logDepthEncodeNearFar || []); } catch (e) { out.encodeNearFar = "err"; }
  try { out.usEnc = Array.from(s.context.uniformState._logDepthEncodeNearFar || []); } catch (e) { out.usEnc = "err"; }
  try { out.fsUsEnc = Array.from((s._frameState?.context?.uniformState?._logDepthEncodeNearFar) || []); } catch (e) { out.fsUsEnc = "err"; }
  try { out.sameUS = s.context.uniformState === s._frameState?.context?.uniformState; } catch (e) {}
  try { const ip = s.context.uniformState.inverseProjection; out.invProj = [ip[0], ip[5], ip[10], ip[15]]; } catch (e) { out.invProj = "err:" + e.message; }
  try { const p = s.context.uniformState.projection; out.proj = [p[0], p[5], p[10], p[15]]; } catch (e) {}
  try { out.camFrustumFar = s.camera.frustum.far; out.camFrustumNear = s.camera.frustum.near; } catch (e) {}
  return out;
}, { build: STRIPE });

// Read the polygon-center pixels straight off the canvas via screenshot decode.
const png = await p.screenshot({ type: "png" });
const samples = await p.evaluate(async (durl) => new Promise((res) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const pts = [];
    // GLOBE-AREA samples (away from the polygon) to read the globe diagnostic color.
    const globePts = [[120, 120], [680, 120], [120, 480], [680, 480], [400, 90], [400, 510]];
    for (const [x, y] of globePts) { const i = (y * c.width + x) * 4; pts.push(["GLOBE", x, y, d[i], d[i + 1], d[i + 2]]); }
    // POLYGON-area samples (center ROI).
    const rs = [], gs = [], bs = [];
    for (let y = 270; y <= 330; y += 20) for (let x = 360; x <= 440; x += 25) {
      const i = (y * c.width + x) * 4;
      pts.push(["POLY", x, y, d[i], d[i + 1], d[i + 2]]);
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    const med = (a) => { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    res({ medRGB: [med(rs), med(gs), med(bs)], pts });
  };
  img.src = durl;
}), "data:image/png;base64," + png.toString("base64"));

console.log("scene state:", JSON.stringify(info));
console.log("page/device errs:", errs.length, errs.slice(0, 3));
console.log("median polygon RGB (0-255):", samples.medRGB);
console.log("  -> R/255 =", (samples.medRGB[0] / 255).toFixed(3), "(storedDepth: ~0.55 LOG / ~0.97+ STD)");
console.log("  -> G/255 =", (samples.medRGB[1] / 255).toFixed(3), "(eyeDist/1e6: ~0.35 OK / ~1.0 garbage)");
console.log("  -> B/255 =", (samples.medRGB[2] / 255).toFixed(3), "(encFar/1e10: ~1.0 OK)");
console.log("sample grid [x,y,R,G,B]:");
for (const pt of samples.pts) console.log("   ", JSON.stringify(pt));
await b.close();
