// One-off diagnostic: dump the planar texture-coordinate batch attributes
// (southWest, eastward, northward, uvMinAndExtents, uMaxVmax) for the
// probe's GroundPrimitive polygon, plus the eye-space eastExtent the
// WebGPU classifier would compute. Tells us where the WebGPU-vs-WebGL
// surfaceUV frequency mismatch (~4x) actually lives.
import { chromium } from "playwright";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  v.useDefaultRenderLoop = false;
  const scene = v.scene;
  v.terrainProvider = new C.EllipsoidTerrainProvider();

  const positions = C.Cartesian3.fromDegreesArray([
    -97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65,
  ]);
  const ground = new C.GroundPrimitive({
    geometryInstances: new C.GeometryInstance({
      geometry: new C.PolygonGeometry({
        polygonHierarchy: new C.PolygonHierarchy(positions),
      }),
    }),
    appearance: new C.MaterialAppearance({
      material: new C.Material({
        fabric: { type: "Stripe", uniforms: { repeat: 10 } },
      }),
      translucent: true,
      flat: true,
    }),
    classificationType: C.ClassificationType.TERRAIN,
    asynchronous: false,
  });
  scene.groundPrimitives.add(ground);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350_000),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
  });
  for (let i = 0; i < 400; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (ground.ready && scene.globe.tilesLoaded && i > 30) break;
  }

  // Walk the wrapper chain to the inner Primitive carrying the batch table.
  let inner = ground;
  for (let d = 0; d < 4 && inner && !inner._batchTable; d++) {
    inner = inner._primitive;
  }
  const bt = inner?._batchTable;
  const idx = inner?._batchTableAttributeIndices;
  if (!bt || !idx) {
    return { error: "no batch table", innerCtor: inner?.constructor?.name };
  }
  const get = (name) =>
    idx[name] !== undefined ? bt.getBatchedAttribute(0, idx[name]) : undefined;
  const toArr = (a) =>
    a === undefined
      ? undefined
      : [a.x, a.y, a.z, a.w].filter((n) => n !== undefined);

  const swH = get("southWest_HIGH");
  const swL = get("southWest_LOW");
  const east = get("eastward");
  const north = get("northward");
  const uvMin = get("uvMinAndExtents");
  const uMaxVmax = get("uMaxVmax");

  const mag = (a) => (a ? Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) : undefined);

  return {
    attrNames: Object.keys(idx),
    southWest_HIGH: toArr(swH),
    southWest_LOW: toArr(swL),
    eastward: toArr(east),
    northward: toArr(north),
    eastwardWorldMag: mag(east),
    northwardWorldMag: mag(north),
    uvMinAndExtents: toArr(uvMin),
    uMaxVmax: toArr(uMaxVmax),
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
