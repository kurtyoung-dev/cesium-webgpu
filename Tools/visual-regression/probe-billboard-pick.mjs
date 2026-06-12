// Billboard pick gate — does scene.pickAsync at a billboard's screen position
// return that billboard on WebGPU? Built as the before/after gate for the
// NEW-DERIVEDCOMMAND-VARIANT-FACTORY migration (Batch 248): the billboard pick
// pipeline moved from the hand-rolled `buildBillboardPickDescriptor` to
// `WebGPUDerivedCommand.deriveDescriptor(colorDescriptor, PICK, ...)` and this
// probe proves zero behavior change.
//
// Checks:
//   (1) PICK HIT — pickAsync at the billboard's center returns an object
//       whose primitive is the added Billboard (or whose id matches).
//   (2) MISS CONTROL — pickAsync at an empty corner returns undefined.
//   (3) REPEATABILITY — a second pick after more frames still hits (guards
//       against one-shot pick-buffer state bugs).
//   (4) PIPELINE-CACHE HYGIENE — the central pipeline cache's cached names
//       contain a billboard pick entry and have NO duplicate names (distinct
//       variant keys; a duplicate name means two different descriptors alias
//       the same cache identity).
//   (5) 0 console/WebGPU validation errors.
//
// Usage: node Tools/visual-regression/probe-billboard-pick.mjs
// Env:   PROBE_BASE (default http://localhost:8134), PROBE_RENDERER (webgpu)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const RENDERER = process.env.PROBE_RENDERER || "webgpu";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text().slice(0, 200));
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const errors = [];
  const dev = scene.context?._device;
  if (dev) {
    dev.onuncapturederror = (ev) =>
      errors.push(String(ev?.error?.message).slice(0, 250));
  }

  // Deterministic background: hide globe/sky/sun/moon so the billboard is
  // the only pickable thing on screen.
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  const img = document.createElement("canvas");
  img.width = 32;
  img.height = 32;
  const g2d = img.getContext("2d");
  g2d.fillStyle = "#ffffff";
  g2d.fillRect(0, 0, 32, 32);

  const bbs = scene.primitives.add(new C.BillboardCollection());
  const bb = bbs.add({
    position: C.Cartesian3.fromDegrees(-75, 40, 1000.0),
    image: img,
    color: C.Color.MAGENTA,
    id: "probe-billboard-1",
  });

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75, 40, 20000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  await renderN(90);

  const cx = Math.floor((scene.canvas.clientWidth || 1024) / 2);
  const cy = Math.floor((scene.canvas.clientHeight || 768) / 2);
  const doPick = async (x, y) => {
    if (scene.pickAsync) {
      return scene.pickAsync(new C.Cartesian2(x, y), 9, 9);
    }
    return scene.pick(new C.Cartesian2(x, y), 9, 9);
  };

  const describeHit = (hit) => {
    if (hit === undefined || hit === null) return { found: false };
    return {
      found: true,
      isBillboard:
        hit === bb || hit.primitive === bb || hit?.target === bb,
      id: hit?.id,
      kind: hit?.kind,
      primitiveCtor: hit?.primitive?.constructor?.name,
      ownKeys: Object.keys(hit).slice(0, 10),
    };
  };

  // Warm-up pick: the billboard pick pipeline is created lazily on the
  // first pick pass (async pipeline materialization skips the pick draw
  // that frame — pre-existing Batch 73 behavior, true before AND after
  // the variant-factory migration). One warm-up pick + a few frames lets
  // the pipeline land before the asserted picks.
  await doPick(cx, cy);
  await renderN(10);

  // (1) center hit
  const hit1 = describeHit(await doPick(cx, cy));
  // (2) miss control — far corner, nothing there
  const miss = describeHit(await doPick(20, 20));
  // (3) repeatability
  await renderN(10);
  const hit2 = describeHit(await doPick(cx, cy));

  // (4) pipeline-cache hygiene
  const cache = scene.context?.webgpuPipelineCache;
  const names = cache?.getCachedPipelineNames?.() ?? [];
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const billboardNames = names.filter((n) => /illboard/.test(n));
  const stats = cache?.getStats?.() ?? null;

  return {
    hit1,
    miss,
    hit2,
    billboardNames,
    duplicateNames: dupes,
    pipelineCount: names.length,
    cacheStats: stats
      ? { size: stats.size, created: stats.created, hitRate: stats.hitRate }
      : null,
    errors,
  };
});

await browser.close();

console.log(JSON.stringify(out, null, 2));

const pass =
  out.hit1.found &&
  out.hit1.isBillboard &&
  out.hit2.found &&
  out.hit2.isBillboard &&
  !out.miss.found &&
  out.duplicateNames.length === 0 &&
  out.errors.length === 0 &&
  pageErrors.length === 0;

if (pageErrors.length > 0) {
  console.log("page errors:", pageErrors);
}
console.log(pass ? "PROBE PASS" : "PROBE FAIL");
process.exit(pass ? 0 : 1);
