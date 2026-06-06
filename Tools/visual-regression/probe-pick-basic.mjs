// Minimal pick discriminator: does scene.pickAsync (the WebGPU-correct async
// GPU->CPU readback) return a Box primitive on WebGPU vs WebGL? Uses ONLY
// pickAsync (sync scene.pick leaves the WebGPU pick buffer mapped, breaking
// subsequent picks — a separate finding). Ellipsoid terrain + valid token.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const RENDERER = process.env.PROBE_RENDERER || "webgpu";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 160)));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    scene = v.scene;
  v.terrainProvider = new C.EllipsoidTerrainProvider();

  const cx = Math.floor((scene.canvas.clientWidth || scene.canvas.width || 1024) / 2);
  const cy = Math.floor((scene.canvas.clientHeight || scene.canvas.height || 768) / 2);

  // Add a big Box primitive over -75,40.
  scene.primitives.add(
    new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: C.BoxGeometry.fromDimensions({
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new C.Cartesian3(1.5e6, 1.5e6, 1.5e6),
        }),
        modelMatrix: C.Matrix4.multiplyByTranslation(
          C.Transforms.eastNorthUpToFixedFrame(
            C.Cartesian3.fromDegrees(-75, 40, 0),
          ),
          new C.Cartesian3(0, 0, 1.0e6),
          new C.Matrix4(),
        ),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.RED),
        },
        id: "the-box",
      }),
      appearance: new C.PerInstanceColorAppearance({ closed: true }),
      asynchronous: false,
    }),
  );
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75, 36, 4_000_000),
  });
  for (let i = 0; i < 150; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  // ONLY pickAsync. Try a vertical strip of positions, ONE fully-awaited call
  // at a time (no overlap → no double-map).
  let hit;
  const tried = [];
  for (const dy of [-100, -180, 0, -260, 80, 160]) {
    const pos = new C.Cartesian2(cx, cy + dy);
    scene.render();
    const p = await scene.pickAsync(pos);
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    tried.push({ dy, defined: C.defined(p), id: p?.id });
    if (C.defined(p) && p.id === "the-box") {
      hit = p;
      break;
    }
  }

  return {
    boxPickAsync: {
      pickedDefined: C.defined(hit),
      id: hit?.id,
      primCtor: hit?.primitive?.constructor?.name,
    },
    tried,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
