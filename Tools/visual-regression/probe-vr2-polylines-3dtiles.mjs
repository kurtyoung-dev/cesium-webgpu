// NEW-VR2-5 reproduction probe — polylines/classification on 3D Tiles.
// @purpose Repro: clampToGround classification polyline on the BIM tileset — quantifies the WebGPU saturated cyan/red shadow-volume panels vs WebGL.
// @status ACTIVE
//
// Symptom (doc): the "Polylines on 3D Tiles" demo (BIM Power Plant tileset,
// ion asset 2464651, + a clampToGround polyline with classificationType
// CESIUM_3D_TILE) renders on WebGPU with bright saturated cyan/red panels +
// scanline z-fight, the BIM building dimmer, polylines bleeding through walls.
// Leading hypothesis: the GroundPolyline shadow-volume FS emits its raw
// volume color without the depth-sample clipping (every fragment passes),
// OR the tileset double-dispatches.
//
// This probe loads the BIM tileset + a clampToGround classification polyline
// in both backends, screenshots them, and quantifies the artifact via a
// "saturated primary-color" pixel count (near-pure cyan or red — the panel
// artifact) + device-error count. WebGL is the reference (no artifact).
//
// Output: Tools/visual-regression/output/vr2poly-{webgl,webgpu}.png + stats.

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message}`),
  );
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev)
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const setup = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const scene = v.scene;
    try {
      const powerPlant = await C.Cesium3DTileset.fromIonAssetId(2464651);
      scene.primitives.add(powerPlant);
      window.__tileset = powerPlant;
      v.entities.add({
        polyline: {
          positions: C.Cartesian3.fromDegreesArray([
            -91.74321, 30.18019, -91.74203, 30.17934, -91.74146, 30.17859,
          ]),
          clampToGround: true,
          width: 8,
          material: new C.PolylineDashMaterialProperty({
            color: C.Color.YELLOW,
          }),
          classificationType: C.ClassificationType.CESIUM_3D_TILE,
        },
      });
      // Instant framing — NO flight (zoomTo flights never advance with
      // useDefaultRenderLoop=false). Wait for the bounding sphere, then
      // viewBoundingSphere directly.
      let bs = powerPlant.boundingSphere;
      for (let i = 0; i < 120 && !(bs && bs.radius > 0); i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        bs = powerPlant.boundingSphere;
      }
      if (!(bs && bs.radius > 0))
        return { err: "tileset boundingSphere never ready" };
      v.camera.viewBoundingSphere(
        bs,
        new C.HeadingPitchRange(0.5, C.Math.toRadians(-25), bs.radius * 1.6),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      // Render enough frames for tiles to stream + settle.
      for (let i = 0; i < 400; i++) {
        scene.requestRender();
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { ok: true, ready: powerPlant.ready === true, radius: bs.radius };
    } catch (e) {
      return { err: String(e) };
    }
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  const out = `${OUT_DIR}/vr2poly-${renderer}.png`;
  await page.screenshot({ path: out });

  // Quantify the artifact: near-pure cyan (low R, high G+B) or near-pure red
  // (high R, low G+B) saturated panels that WebGL does not produce.
  const stats = await page.evaluate(
    async (durl) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let cyan = 0,
            red = 0,
            n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i],
              g = d[i + 1],
              b = d[i + 2];
            n++;
            // saturated cyan: G & B high, R low
            if (g > 150 && b > 150 && r < 90) cyan++;
            // saturated red: R high, G & B low
            if (r > 170 && g < 90 && b < 90) red++;
          }
          resolve({ cyan, red, n });
        };
        img.src = durl;
      });
    },
    `data:image/png;base64,${(await fs.promises.readFile(out)).toString("base64")}`,
  );

  await browser.close();
  return { setup, errs, stats, out };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wgl = await run("webgl");
  const wgpu = await run("webgpu");
  console.log("=== NEW-VR2-5 polylines-on-3DTiles reproduction ===\n");
  for (const [name, r] of [
    ["webgl", wgl],
    ["webgpu", wgpu],
  ]) {
    console.log(`  ${name}: setup=${JSON.stringify(r.setup)}`);
    console.log(
      `    saturated cyan px: ${r.stats.cyan}   saturated red px: ${r.stats.red}   (of ${r.stats.n})`,
    );
    console.log(`    device errors: ${r.errs.length}`);
    r.errs
      .slice(0, 4)
      .forEach((e) => console.log(`      - ${(e ?? "").slice(0, 140)}`));
    console.log(`    png: ${r.out}`);
  }
  console.log("\n  (Artifact present if WebGPU cyan/red >> WebGL.)");
})();
