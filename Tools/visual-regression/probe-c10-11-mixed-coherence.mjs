// C10-11 acceptance — MIXED-FAMILY pick-fleet log-depth coherence + 3-altitude.
// @purpose Acceptance that the native pick fleet writes coherent log depth: mixed families occlude/reveal monotonically at 20/500/5000 km.
// @status ACTIVE
//
// Proves the whole native pick fleet writes COHERENT log depth into the shared
// pick FBO across DIFFERENT families: a near opaque geometry Primitive (Box,
// PrimitivePick family) and a near PointPrimitive (collection-pick family) each
// occlude the FAR globe tile (globe-pick family) at their pixel; hiding the
// nearer producer REVEALS the globe (monotonic front-to-back ordering). Run at
// three camera altitudes (20 / 500 / 5,000 km) — the front markers must resolve
// at all three. Saves a PNG per altitude for visual read.
//
// Gate is forced ON at runtime (independent of the shipped default) AND the
// shipped default is reported so both are on record. WebGPU only.
import { chromium } from "playwright";
import fs from "fs";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output";
fs.mkdirSync(OUT, { recursive: true });
const LON = -75,
  LAT = 40;
const ALTS = [
  { km: 20, m: 20_000 },
  { km: 500, m: 500_000 },
  { km: 5000, m: 5_000_000 },
];

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) =>
  consoleErrors.push(`PAGEERROR: ${String(e).slice(0, 200)}`),
);
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

async function runAlt(alt) {
  const result = await page.evaluate(
    async ({ LON, LAT, altM }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const ctx = scene.context;
      const shippedDefault = ctx._pickLogDepthWriteEnabled;
      ctx._pickLogDepthWriteEnabled = true; // force gate on for the coherence proof
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.pickable = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      const errors = [];
      const dev = ctx?._device;
      if (dev)
        dev.onuncapturederror = (ev) =>
          errors.push(String(ev?.error?.message).slice(0, 200));

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, altM),
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
      const waitTiles = async (maxFrames) => {
        for (let i = 0; i < maxFrames; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          if (scene.globe.tilesLoaded) return i;
        }
        return -1;
      };
      const idOf = (p) =>
        !C.defined(p)
          ? null
          : typeof p.id === "string"
            ? p.id
            : (p.id?.id ??
              (p.primitive === scene.globe
                ? "GLOBE"
                : (p.primitive?.constructor?.name ?? "?")));
      const isGlobe = (p) => C.defined(p) && p.primitive === scene.globe;
      const pickStable = async (want) => {
        let last;
        for (let i = 0; i < 16; i++) {
          scene.render();
          const r = await scene.pickAsync(center, 3, 3);
          if (C.defined(r)) {
            last = r;
            if (idOf(r) === want) return r;
          }
          await new Promise((rr) => requestAnimationFrame(rr));
        }
        return last;
      };

      // Producer heights scale with camera altitude so the stack is always in front.
      const hFront = altM * 0.45; // PointPrimitive (nearest)
      const hMid = altM * 0.22; // Box primitive (mid)
      const boxDim = Math.max(altM * 0.12, 200); // box world size ~ screen-visible

      // MID: opaque Box geometry Primitive (PrimitivePick family).
      const boxInst = new C.GeometryInstance({
        geometry: C.BoxGeometry.fromDimensions({
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new C.Cartesian3(boxDim, boxDim, boxDim),
        }),
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(LON, LAT, hMid),
        ),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.ORANGE),
        },
        id: "mix-box",
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

      // FRONT: PointPrimitive collection (collection-pick family), no ddtd so it
      // genuinely depth-tests against box + globe.
      const points = scene.primitives.add(new C.PointPrimitiveCollection());
      const frontPt = points.add({
        position: C.Cartesian3.fromDegrees(LON, LAT, hFront),
        pixelSize: 46,
        color: C.Color.CYAN,
        id: "mix-point",
      });

      const tilesLoadedAt = await waitTiles(400);
      await renderN(80);

      // Step 1: all three stacked → nearest (point) wins.
      const p1 = await pickStable("mix-point");
      const step1 = { id: idOf(p1), isGlobe: isGlobe(p1) };

      // stash handles for the second-phase evaluate (after the stacked screenshot)
      window.__c10 = {
        points,
        frontPt,
        boxPrim,
        pickStable,
        idOf,
        isGlobe,
        renderN,
      };
      return {
        shippedDefault,
        gate: ctx._pickLogDepthWriteEnabled,
        step1,
        errors,
        tilesLoadedAt,
      };
    },
    { LON, LAT, altM: alt.m },
  );

  // screenshot while the point (cyan) + box (orange) are stacked over the globe
  const buf = await page.screenshot();
  fs.writeFileSync(`${OUT}/probe-c10-11-mixed-${alt.km}km.png`, buf);

  const phase2 = await page.evaluate(async () => {
    const _C = await import("/Build/CesiumUnminified/index.js");
    const scene = window.viewer.scene;
    const { points, frontPt, boxPrim, pickStable, idOf, isGlobe, renderN } =
      window.__c10;

    // Step 2: hide the point → box (mid family) should win over globe.
    frontPt.show = false;
    await renderN(20);
    const p2 = await pickStable("mix-box");
    const step2 = { id: idOf(p2), isGlobe: isGlobe(p2) };

    // Step 3: hide the box too → globe (far family) revealed.
    boxPrim.show = false;
    await renderN(20);
    const p3 = await pickStable("GLOBE");
    const step3 = { id: idOf(p3), isGlobe: isGlobe(p3) };

    // cleanup for next altitude
    scene.primitives.remove(boxPrim);
    scene.primitives.remove(points);
    await renderN(4);
    return { step2, step3 };
  });

  return { ...result, ...phase2 };
}

const results = {};
for (const alt of ALTS) {
  results[`${alt.km}km`] = await runAlt(alt);
}
await browser.close();

console.log(
  "=== C10-11 MIXED-FAMILY pick-fleet log-depth coherence (gate ON) ===",
);
let pass = true;
for (const alt of ALTS) {
  const r = results[`${alt.km}km`];
  const k = `${alt.km}km`;
  const s1 = r.step1.id === "mix-point"; // point (near) wins over box+globe
  const s2 = r.step2.id === "mix-box"; // box (mid) wins over globe after point hidden
  const s3 = r.step3.isGlobe === true; // globe revealed after box hidden
  const ok = s1 && s2 && s3 && (r.errors?.length ?? 0) === 0;
  if (!ok) pass = false;
  console.log(
    `  [${k}] default=${r.shippedDefault} gate=${r.gate} | near-point=${r.step1.id}(${s1 ? "ok" : "X"}) mid-box=${r.step2.id}(${s2 ? "ok" : "X"}) globe-revealed=${r.step3.id}(${s3 ? "ok" : "X"}) errors=${r.errors?.length ?? 0} => ${ok ? "PASS" : "FAIL"}`,
  );
}
if (consoleErrors.length) {
  pass = false;
  console.log("console errors:", consoleErrors.slice(0, 6));
}
console.log(`PNGs: probe-c10-11-mixed-{20,500,5000}km.png`);
console.log(pass ? "PROBE VERDICT: PASS" : "PROBE VERDICT: FAIL");
process.exit(pass ? 0 : 1);
