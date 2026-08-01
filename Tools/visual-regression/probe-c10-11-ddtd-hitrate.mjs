// C10-11 diagnostic 3 — hit-rate A/B. Replicate globe-pick-h44's exact ddtd
// point-pick sequence (globe pick first, add point, renderN(5), 8-iter
// pickStable) N times each with the pick-fleet switch FALSE then TRUE (runtime
// toggle, same build/page). If the FALSE and TRUE hit-rates are comparable, the
// occasional miss is a pre-existing async-readback race, NOT a switch-caused
// depth regression.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TRIALS = 8;
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) =>
  errors.push(`PAGEERROR: ${e.message.slice(0, 140)}`),
);
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async (TRIALS) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const ctx = scene.context;
  v.terrainProvider = new C.EllipsoidTerrainProvider();
  const LON = -75,
    LAT = 40;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 2_000_000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  const center = new C.Cartesian2(
    Math.floor(scene.canvas.clientWidth / 2),
    Math.floor(scene.canvas.clientHeight / 2),
  );
  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const pickStable = async () => {
    let last;
    for (let i = 0; i < 8; i++) {
      scene.render();
      const r = await scene.pickAsync(center, 3, 3);
      if (C.defined(r)) return r;
      last = r;
      await new Promise((rr) => requestAnimationFrame(rr));
    }
    return last;
  };
  scene.globe.pickable = false;
  await renderN(150);
  const runGate = async (gate) => {
    ctx._pickLogDepthWriteEnabled = gate;
    await renderN(10);
    let hits = 0;
    const ids = [];
    for (let t = 0; t < TRIALS; t++) {
      // pick globe first (mirror h44), then add point
      await pickStable();
      v.entities.add({
        id: "fg-point",
        position: C.Cartesian3.fromDegrees(LON, LAT, 500_000.0),
        point: {
          pixelSize: 40,
          color: C.Color.YELLOW,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      await renderN(5);
      const r = await pickStable();
      const id = C.defined(r)
        ? typeof r.id === "string"
          ? r.id
          : r.id?.id
        : undefined;
      if (id === "fg-point") hits++;
      ids.push(id ?? null);
      v.entities.removeById("fg-point");
      await renderN(4);
    }
    return { gate, hits, trials: TRIALS, ids };
  };
  const off = await runGate(false);
  const on = await runGate(true);
  return { off, on };
}, TRIALS);
await browser.close();
console.log(JSON.stringify({ ...out, errors }, null, 2));
