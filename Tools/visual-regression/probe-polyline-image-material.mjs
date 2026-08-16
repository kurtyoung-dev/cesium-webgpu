#!/usr/bin/env node
/**
 * REPRODUCTION probe (probe-FIRST): does an Image-material polyline render the
 * TEXTURE on WebGPU, or a solid color? (C2-14 / 376d)
 * @purpose Acceptance: Image-material polyline samples its texture along the line on WebGPU (red->blue gradient split), not a solid color
 * @status ACTIVE
 *
 * Premise: selectPolylineMaterialShader routes Image/DiffuseMap → polylineMatColor
 * (FS returns material.color), and the polyline material pipeline has no
 * texture+sampler bind group. So an Image material on a polyline renders SOLID
 * (or garbage from reading the image UBO as a color) instead of the texture.
 * WebGL's PolylineMaterialAppearance samples the image along the line via st.
 *
 * The probe builds a horizontal polyline with an Image material whose texture is
 * RED (left half) → BLUE (right half). On WebGL the line should run red→blue
 * along its length (2 distinct color regions). On WebGPU (pre-fix) it should be
 * a single solid region. Counts red-vs-blue pixel split.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-image-material.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(renderer, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

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

    // Build a RED|BLUE split texture (left half red, right half blue).
    const tex = document.createElement("canvas");
    tex.width = 64;
    tex.height = 8;
    const tctx = tex.getContext("2d");
    tctx.fillStyle = "rgb(255,0,0)";
    tctx.fillRect(0, 0, 32, 8);
    tctx.fillStyle = "rgb(0,0,255)";
    tctx.fillRect(32, 0, 32, 8);
    const dataUri = tex.toDataURL("image/png");

    const positions = C.Cartesian3.fromDegreesArray([-78.0, 35.0, -68.0, 35.0]);
    const primitive = s.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions,
            width: 20.0,
            arcType: C.ArcType.NONE,
            vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new C.PolylineMaterialAppearance({
          material: C.Material.fromType("Image", { image: dataUri }),
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    const center = C.Cartesian3.fromDegrees(-73.0, 35.0, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 900000.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    for (let i = 0; i < 150; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const canvas = s.canvas,
      w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const cx = tmp.getContext("2d");
    cx.drawImage(canvas, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    let red = 0,
      blue = 0,
      redSumX = 0,
      blueSumX = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      const X = (i / 4) % w;
      if (r > 150 && g < 90 && b < 90) {
        red++;
        redSumX += X;
      } else if (b > 150 && g < 90 && r < 90) {
        blue++;
        blueSumX += X;
      }
    }
    return {
      renderer: s.context?.rendererType,
      ready: primitive.ready,
      red,
      blue,
      redMeanX: red ? Math.round(redSumX / red) : -1,
      blueMeanX: blue ? Math.round(blueSumX / blue) : -1,
      width: w,
      height: h,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/polyline-image-${renderer}.png`,
    buf,
  );
  await browser.close();
  return res;
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const wgl = await run("webgl", fs);
const wgpu = await run("webgpu", fs);
console.log("WEBGL :", JSON.stringify(wgl));
console.log("WEBGPU:", JSON.stringify(wgpu));
console.log("\n=== DIAGNOSIS ===");
console.log(
  `webgl: red=${wgl.red}@x${wgl.redMeanX} blue=${wgl.blue}@x${wgl.blueMeanX} → ${wgl.red > 100 && wgl.blue > 100 ? "TEXTURED (red+blue split)" : "solid/other"}`,
);
console.log(
  `webgpu: red=${wgpu.red}@x${wgpu.redMeanX} blue=${wgpu.blue}@x${wgpu.blueMeanX} → ${wgpu.red > 100 && wgpu.blue > 100 ? "TEXTURED (red+blue split)" : "solid/other (NOT textured)"}`,
);
