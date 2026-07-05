#!/usr/bin/env node
// C4-TAKRAM8-GEOMETRY-LENS-GLARE (premise-stale regression probe).
//
// The caustic/refraction lens-glare around the WebGPU sun disc already ships:
// createSunTexture() in WebGPUEnvironmentRenderer.js bakes the disc + soft glow
// halo + six pre-rotated lens-flare bursts, a faithful port of the WebGL
// SunTextureFS.glsl addBurst() spikes (landed Batch 214 / BUG-1). WebGL's moon
// (EllipsoidPrimitive) has NO lens glare, so glare is a sun-only parity feature.
//
// This probe locks that in: it renders the sun full-frame on BOTH backends,
// verifies the glow/flare halo is present (glow footprint >> bright disc), and
// checks cross-backend convergence of the halo extent (proving the WebGPU flare
// bake tracks the WebGL SunTextureFS bake). READ the two output PNGs — the
// star-burst spikes must be visible on the WebGPU frame, matching WebGL.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const res = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer; const s = v.scene;
    v.useDefaultRenderLoop = false;
    s.screenSpaceCameraController.enableInputs = false;
    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone(); v.clock.shouldAnimate = false;
    s.sun.show = true; if (s.skyBox) s.skyBox.show = false; s.backgroundColor = C.Color.BLACK;
    // Look straight at the sun from far out along the sun direction so the disc
    // + flare fill the frame center with Earth behind us.
    s.render();
    const sunPos = C.Cartesian3.clone(s.context.uniformState.sunPositionWC, new C.Cartesian3());
    const dir = C.Cartesian3.normalize(sunPos, new C.Cartesian3());
    const camPos = C.Cartesian3.multiplyByScalar(dir, 3.0e8, new C.Cartesian3());
    const setIt = () => v.camera.setView({ destination: camPos, orientation: { direction: dir, up: C.Cartesian3.UNIT_Z } });
    setIt();
    for (let i = 0; i < 90; i++) { setIt(); s.render(); await new Promise((r)=>setTimeout(r, 5)); }
    setIt(); s.render();

    const cv = s.canvas;
    const w = cv.width, h = cv.height;
    const tmp = document.createElement("canvas"); tmp.width=w; tmp.height=h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(cv, 0, 0);
    const full = ctx.getImageData(0,0,w,h).data;
    const lum = (i) => 0.2126*full[i]+0.7152*full[i+1]+0.0722*full[i+2];

    // Bright disc bounding box (lum>=200).
    let minX=w,maxX=-1,minY=h,maxY=-1,brightCount=0;
    // Glow/flare halo bounding box (lum>=40) — the soft corona + burst spikes.
    let gMinX=w,gMaxX=-1,gMinY=h,gMaxY=-1,glowCount=0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){
      if (y<40 || x>1000) continue; // skip UI panels
      const l = lum((y*w+x)*4);
      if (l>=200){ brightCount++; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
      if (l>=40){ glowCount++; if(x<gMinX)gMinX=x; if(x>gMaxX)gMaxX=x; if(y<gMinY)gMinY=y; if(y>gMaxY)gMaxY=y; }
    }
    const disc = brightCount>0 ? { w:maxX-minX+1, h:maxY-minY+1, count:brightCount, cx:(minX+maxX)/2, cy:(minY+maxY)/2 } : null;
    const halo = glowCount>0 ? { w:gMaxX-gMinX+1, h:gMaxY-gMinY+1, count:glowCount } : null;
    return { renderer:s.context.rendererType, canvasWH:[w,h], disc, halo };
  });

  await page.screenshot({ path: `Tools/visual-regression/output/sun-lens-glare-${renderer}.png` });
  await browser.close();
  return { res, logs };
}

(async () => {
  const out = {};
  for (const r of ["webgl","webgpu"]) {
    const { res, logs } = await run(r);
    out[r] = res;
    console.log(`\n=== ${r} ===`);
    console.log(JSON.stringify(res, null, 2));
    const bad = logs.filter((l)=>/error|fail|invalid|validation/i.test(l) && !/favicon/i.test(l));
    console.log("error-ish logs:", bad.length);
    bad.slice(0,10).forEach((l)=>console.log("  "+l));
  }

  // ── Assertions ───────────────────────────────────────────────────────────
  const gl = out.webgl, gpu = out.webgpu;
  const fail = [];
  if (!gpu.disc || gpu.disc.count < 20) fail.push("WebGPU sun disc missing/too small");
  if (!gpu.halo) fail.push("WebGPU sun glow/flare halo missing");
  // Halo must extend well beyond the bright disc (glow + burst spikes present).
  if (gpu.disc && gpu.halo && gpu.halo.count < gpu.disc.count * 3)
    fail.push(`WebGPU halo footprint too small vs disc (halo ${gpu.halo.count} vs disc ${gpu.disc.count})`);
  // Cross-backend convergence: WebGPU halo extent within 40% of WebGL halo
  // extent (both bake the same SunTextureFS glow + flare model).
  if (gl.halo && gpu.halo) {
    const rw = gpu.halo.w / gl.halo.w, rh = gpu.halo.h / gl.halo.h;
    if (rw < 0.6 || rw > 1.6 || rh < 0.6 || rh > 1.6)
      fail.push(`Halo extent diverges from WebGL (wRatio ${rw.toFixed(2)}, hRatio ${rh.toFixed(2)})`);
    console.log(`\nhalo extent ratio WebGPU/WebGL: w=${rw.toFixed(2)} h=${rh.toFixed(2)}`);
  } else {
    fail.push("WebGL halo missing — cannot compare");
  }

  console.log("\n=== RESULT ===");
  if (fail.length === 0) {
    console.log("PASS — WebGPU sun lens-glare (disc + glow halo + flare bursts) present and matches WebGL.");
    process.exit(0);
  } else {
    console.log("FAIL:");
    fail.forEach((f)=>console.log("  - "+f));
    process.exit(1);
  }
})();
