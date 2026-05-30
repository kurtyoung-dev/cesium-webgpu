// Decisive (no-rebuild) check for the flat textured-material classifier:
// does packExtents() find the planar-extent batch-table attributes it needs?
// If NOT, packUniforms forces materialMeta.x = 0 -> dsColorFS flat-color fast
// path -> flat polygon, INSENSITIVE to every windowToEye/invProj edit (the
// "byte-identical variance" symptom). Inspects the live GroundPrimitive's
// inner batch table the same way packExtents does, plus the resolved material
// type, WITHOUT touching the shader.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
p.on("pageerror", (e) => errs.push("PAGE:" + e.message.slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error") errs.push("ERR:" + m.text().slice(0, 160)); });
await p.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
await p.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const info = await p.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer; v.useDefaultRenderLoop = false; const s = v.scene;
  s.skyBox.show = false; s.skyAtmosphere.show = false; s.globe.showGroundAtmosphere = false;
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
  const material = new C.Material({ fabric: { type: "Stripe", uniforms: {
    evenColor: new C.Color(1, 0.05, 0.05, 1), oddColor: new C.Color(0.05, 0.05, 1, 1),
    repeat: 10, horizontal: true } } });
  const positions = C.Cartesian3.fromDegreesArray([-97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65]);
  const ground = new C.GroundPrimitive({
    geometryInstances: new C.GeometryInstance({ geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(positions) }) }),
    appearance: new C.MaterialAppearance({ material, translucent: true, flat: true }),
    classificationType: C.ClassificationType.TERRAIN, asynchronous: false });
  s.groundPrimitives.add(ground);
  let f = 0, streak = 0;
  while (f < 2500) { s.render(); await new Promise(r => requestAnimationFrame(r)); f++; const st = s.globe.tilesLoaded && ground.ready; streak = st ? streak + 1 : 0; if (streak >= 30) break; }
  for (let i = 0; i < 10; i++) { s.render(); await new Promise(r => requestAnimationFrame(r)); }

  const out = { frames: f, ready: ground.ready, appearanceMatType: ground.appearance?.material?.type };
  // Walk the chain exactly like packExtents: GroundPrimitive -> _primitive (ClassificationPrimitive) -> _primitive (Primitive)
  const cp = ground._primitive;
  const inner = cp?._primitive;
  out.haveCP = !!cp; out.haveInner = !!inner;
  out.instanceIds = inner?._instanceIds?.length;
  const bt = inner?._batchTable;
  const idx = inner?._batchTableAttributeIndices;
  out.haveBatchTable = !!bt; out.haveIndices = !!idx;
  if (idx) {
    out.indexKeys = Object.keys(idx);
    out.planar = {
      southWest_HIGH: idx.southWest_HIGH, southWest_LOW: idx.southWest_LOW,
      eastward: idx.eastward, northward: idx.northward };
    out.spherical = {
      sphericalExtents: idx.sphericalExtents,
      planar2D_HIGH: idx.planar2D_HIGH, planar2D_LOW: idx.planar2D_LOW };
  }
  if (bt && idx && idx.eastward !== undefined) {
    try {
      const sw = bt.getBatchedAttribute(0, idx.southWest_HIGH);
      const e = bt.getBatchedAttribute(0, idx.eastward);
      const n = bt.getBatchedAttribute(0, idx.northward);
      out.sampleSWHigh = sw && [sw.x, sw.y, sw.z];
      out.sampleEast = e && [e.x, e.y, e.z];
      out.sampleNorth = n && [n.x, n.y, n.z];
    } catch (e) { out.sampleErr = e.message; }
  }
  // What does the WebGL side attach? Check ShadowVolumeAppearance decision: planar vs spherical.
  try { out.svaUsesGeodeticSurfaceNormals = cp?._sp ? "n/a" : "n/a"; } catch (e) {}
  return out;
});

console.log("extents inspection:", JSON.stringify(info, null, 2));
console.log("page/device errs:", errs.length, errs.slice(0, 4));
await b.close();
