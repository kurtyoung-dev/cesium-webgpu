#!/usr/bin/env node
/**
 * C2-11 / 376a — polyline APPEARANCE PRIMITIVE pick on WebGPU.
 *
 * Before: createPolylineAppearanceCommands cleared pickCommands → scene.pick over
 * an appearance polyline returned undefined. After: a pick pipeline + per-primitive
 * pick command make it pickable.
 *
 * Builds the same CYAN PolylineColorAppearance Primitive as
 * probe-polyline-appearance-primitive.mjs, finds the on-line window pixel (cyan
 * centroid), warms the pick (WebGPU's first pick can be cold), and asserts
 * scene.pick returns the polyline Primitive. Runs WebGPU (the feature under test)
 * + WebGL (sanity reference).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-appearance-pick.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const res = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.globe.show = false;
    s.skyBox.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.backgroundColor = C.Color.BLACK;

    const positions = C.Cartesian3.fromDegreesArray([
      -75.0, 35.0, -74.0, 36.0, -73.0, 35.0, -72.0, 36.0, -71.0, 35.0,
    ]);
    const primitive = s.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions,
            width: 12.0,
            arcType: C.ArcType.NONE,
            vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0, 1, 1, 1),
            ),
          },
          id: "the-polyline",
        }),
        appearance: new C.PolylineColorAppearance({ translucent: false }),
        asynchronous: false,
        allowPicking: true,
      }),
    );

    const center = C.Cartesian3.fromDegrees(-73.0, 35.5, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 300000.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    for (let i = 0; i < 120; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Collect ACTUAL cyan pixel coords (NOT the centroid — the zig-zag's
    // centroid lands in an empty gap between segments). DEVICE px → CSS px.
    const canvas = s.canvas,
      w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const cx = tmp.getContext("2d");
    cx.drawImage(canvas, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    const cyanPts = [];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 2] > 200 && px[i + 1] > 200 && px[i] < 80) {
        n++;
        const p = i / 4;
        if (n % 200 === 0) cyanPts.push([p % w, Math.floor(p / w)]); // sample
      }
    }
    if (n === 0)
      return {
        ready: !!primitive.ready,
        cyan: 0,
        pickIds: (primitive._pickIds || []).length,
      };
    const sx2css = canvas.clientWidth / w,
      sy2css = canvas.clientHeight / h;
    const samples = cyanPts.map(([dx, dy]) => [dx * sx2css, dy * sy2css]);

    // Warm the pick (WebGPU first pick can be cold), then try EACH on-line
    // sample — succeed if ANY returns the polyline.
    let pickedPrimitive = false,
      pickedId = false,
      lastType = "undefined",
      hits = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (const [pxc, pyc] of samples) {
        const picked = s.pick(new C.Cartesian2(pxc, pyc));
        if (picked) {
          lastType = typeof picked.primitive;
          if (picked.primitive === primitive) {
            pickedPrimitive = true;
            hits++;
          }
          if (picked.id === "the-polyline") pickedId = true;
        }
        s.render();
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      ready: !!primitive.ready,
      cyan: n,
      pickIds: (primitive._pickIds || []).length,
      allowPicking: primitive.allowPicking,
      nSamples: samples.length,
      hits,
      pickCmds: (primitive._pickCommands || []).length,
      hasPickPipeline: !!primitive._webgpuPolylineCache?.pickPipeline,
      pickIdColor: primitive._pickIds?.[0]?.color
        ? [
            primitive._pickIds[0].color.red,
            primitive._pickIds[0].color.green,
            primitive._pickIds[0].color.blue,
          ]
        : null,
      pickedPrimitive,
      pickedId,
      lastType,
    };
  });
  await browser.close();
  return {
    res,
    errs: errs.filter(
      (e) => !/AtmosphereLUT|default layout|atmosphereLUT/.test(e),
    ),
  };
}

const wgpu = await run("webgpu");
const wgl = await run("webgl");
console.log("WEBGPU:", JSON.stringify(wgpu.res));
console.log("  errs:", wgpu.errs.slice(0, 4));
console.log("WEBGL :", JSON.stringify(wgl.res));

const checks = [
  [
    "webgl pick returns the polyline (reference)",
    wgl.res.pickedPrimitive || wgl.res.pickedId,
  ],
  [
    "webgpu line renders (cyan>200) + has pickIds",
    wgpu.res.cyan > 200 && wgpu.res.pickIds > 0,
  ],
  [
    "webgpu pick returns the polyline primitive/id",
    wgpu.res.pickedPrimitive || wgpu.res.pickedId,
  ],
  ["no NEW webgpu errors (AtmosphereLUT filtered)", wgpu.errs.length === 0],
];
let pass = true;
for (const [label, ok] of checks) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) pass = false;
}
console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
process.exit(pass ? 0 : 1);
