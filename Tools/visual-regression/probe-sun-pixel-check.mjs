#!/usr/bin/env node
// BUG-1: no-drift, sun centered (Earth behind). Sample the canvas center pixels
// directly to quantify the sun. Capture ALL console messages (validation errors).
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8134";

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

  const res = await page.evaluate(async (renderer) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer; const s = v.scene;
    v.useDefaultRenderLoop = false;
    s.screenSpaceCameraController.enableInputs = false;
    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone(); v.clock.shouldAnimate = false;
    s.sun.show = true; if (s.skyBox) s.skyBox.show = false; s.backgroundColor = C.Color.BLACK;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(0,0,8.0e7) });
    s.render();
    const sunPos = C.Cartesian3.clone(s.context.uniformState.sunPositionWC, new C.Cartesian3());
    const dir = C.Cartesian3.normalize(sunPos, new C.Cartesian3());
    const camPos = C.Cartesian3.multiplyByScalar(dir, 3.0e8, new C.Cartesian3());
    const setIt = () => v.camera.setView({ destination: camPos, orientation: { direction: dir, up: C.Cartesian3.UNIT_Z } });
    setIt();
    // Render loop is OFF, so rAF won't move the camera. Await between renders so
    // async pipeline-creation promises can resolve. Re-lock defensively.
    for (let i = 0; i < 90; i++) { setIt(); s.render(); await new Promise((r)=>setTimeout(r, 5)); }
    setIt(); s.render();

    // Sample canvas center 60x60.
    const cv = s.canvas;
    const w = cv.width, h = cv.height;
    const tmp = document.createElement("canvas"); tmp.width=w; tmp.height=h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(cv, 0, 0);
    let maxLum=0, sumLum=0, n=0, cx=Math.floor(w/2), cy=Math.floor(h/2), R=40;
    let data;
    try { data = ctx.getImageData(cx-R, cy-R, 2*R, 2*R).data; } catch(e){ return {err:String(e)}; }
    for (let i=0;i<data.length;i+=4){ const l=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2]; maxLum=Math.max(maxLum,l); sumLum+=l; n++; }
    // Measure the sun's bright-pixel bounding box across the whole frame.
    const full = ctx.getImageData(0,0,w,h).data;
    let minX=w,maxX=-1,minY=h,maxY=-1,brightCount=0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){
      // skip the UI panel region (top + right)
      if (y<40 || x>1000) continue;
      const i=(y*w+x)*4; const l=0.2126*full[i]+0.7152*full[i+1]+0.0722*full[i+2];
      if (l>=200){ brightCount++; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    }
    const sunBox = brightCount>0 ? { w: maxX-minX+1, h: maxY-minY+1, count: brightCount, cx:(minX+maxX)/2, cy:(minY+maxY)/2 } : null;
    // Glow halo extent (lum>=40) — captures the soft corona/flare WebGL bakes.
    let gMinX=w,gMaxX=-1,gMinY=h,gMaxY=-1,glowCount=0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){
      if (y<40 || x>1000) continue;
      const i=(y*w+x)*4; const l=0.2126*full[i]+0.7152*full[i+1]+0.0722*full[i+2];
      if (l>=40){ glowCount++; if(x<gMinX)gMinX=x; if(x>gMaxX)gMaxX=x; if(y<gMinY)gMinY=y; if(y>gMaxY)gMaxY=y; }
    }
    const glowBox = glowCount>0 ? { w:gMaxX-gMinX+1, h:gMaxY-gMinY+1, count:glowCount } : null;

    // Check pipeline target format vs scene format.
    let pipeInfo=null;
    if (renderer==="webgpu" && s.sun._webgpuCache){
      const sc=s.sun._webgpuCache;
      pipeInfo={ hasPipeline:!!sc.pipeline, hasCommand:!!sc.command,
        scenePipelineFormat: s.context.scenePipelineFormat,
        msaa: s.context._msaaSamples ?? 1,
        mrt: (await import("/Build/CesiumUnminified/index.js")) ? undefined : undefined };
    }
    return { renderer:s.context.rendererType, canvasWH:[w,h], centerMaxLum:+maxLum.toFixed(1), centerMeanLum:+(sumLum/n).toFixed(2), sunBox, glowBox, pipeInfo };
  }, renderer);

  await page.screenshot({ path: `Tools/visual-regression/output/sun-pixcheck-${renderer}.png` });
  await browser.close();
  return { res, logs };
}

(async () => {
  for (const r of ["webgl","webgpu"]) {
    const { res, logs } = await run(r);
    console.log(`\n=== ${r} ===`);
    console.log(JSON.stringify(res, null, 2));
    const interesting = logs.filter((l)=>/error|warn|fail|invalid|pipeline|sun|Sun|validation|GPU/i.test(l));
    console.log("interesting logs:", interesting.length);
    interesting.slice(0,25).forEach((l)=>console.log("  "+l));
  }
})();
