#!/usr/bin/env node
// Focused disk-skirt measurement for NEW-VR2-3b-LIMB-HALO-RESIDUAL.
//
// Frames the FULL globe disk from ~6 Mm with the skybox OFF (black space), so
// the ONLY non-black pixels OUTSIDE the solid globe geometry are the
// SkyAtmosphere limb haze SKIRT. Measures, per radial spoke, the skirt width =
// (outermost non-black radius) - (solid-globe edge radius), where the solid
// edge is the outermost BRIGHT pixel (the lit surface/limb). This is the
// day-lit alpha tail extending past the limb — the quantity that was ~25 px
// too wide on WebGPU.
//
// Usage:  node Tools/visual-regression/probe-limb-skirt.mjs
// Output: probe-limb-skirt-{webgl,webgpu}.png
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const W = 1024, H = 1024;
// Disk centered over the day side (sun over ~0°/+23° at the fixed clock), at
// ~6.2 Mm so the disk nearly fills the frame and the skirt spans many pixels.
const CAM = { lon: 5.0, lat: 18.0, height: 9000000 };

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
  await page.evaluate((cam) => {
    const v = window.viewer;
    v.clock.shouldAnimate = false;
    const JulianDate = v.clock.currentTime.constructor;
    if (JulianDate.fromIso8601) v.clock.currentTime = JulianDate.fromIso8601("2024-06-21T12:00:00Z");
    v.scene.requestRenderMode = false;
    if (v.scene.skyBox) { v.scene.skyBox.show = false; if (v.scene.skyBox.starField) v.scene.skyBox.starField.show = false; }
    if (v.scene.sun) v.scene.sun.show = false;
    if (v.scene.moon) v.scene.moon.show = false;
    const Cartesian3 = v.camera.positionWC.constructor;
    v.camera.setView({
      destination: Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, CAM);
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 240; i++) { v.scene.render(); await new Promise((r) => requestAnimationFrame(r)); }
  });
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `probe-limb-skirt-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) { console.log(`  [${rendererArg}] ${errs.length} errors`); errs.slice(0,2).forEach(e=>console.log("    "+e.text)); }
  return out;
}

async function measure(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const res = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const w = c.width, h = c.height; const data = ctx.getImageData(0,0,w,h).data;
    const at = (x,y) => { const i=(y*w+x)*4; return [data[i],data[i+1],data[i+2]]; };
    const lum = (r,g,b) => 0.2126*r+0.7152*g+0.0722*b;
    const SPACE_LUM = 4;        // black space
    const SURFACE_LUM = 150;    // bright lit globe surface (geometric limb cliff)
    // Center = centroid of ALL non-black pixels. The fully-lit disk dominates
    // the frame so this is a stable geometric center for both backends.
    let sx=0, sy=0, n=0;
    for (let y=0;y<h;y+=2) for (let x=0;x<w;x+=2){const [r,g,b]=at(x,y); if(lum(r,g,b)>SPACE_LUM){sx+=x;sy+=y;n++;}}
    if (n<2000) return { error: "no disk", litPx: n };
    const cx=Math.round(sx/n), cy=Math.round(sy/n);
    // UI sectors to skip (top-right controls; bottom timeline strip)
    const inUi = (d)=>{ d=((d%360)+360)%360; if(d>=300||d<=15) return true; if(d>=60&&d<=120) return true; return false; };
    // Per clean spoke, the OUTERMOST non-black radius = the outer edge of the
    // limb haze. The globe geometry is identical across backends (same camera,
    // same ellipsoid), so a LARGER outer radius on WebGPU ⇒ its haze extends
    // farther past the limb ⇒ a wider ring. We report the median outer radius
    // per backend; the cross-backend delta is the excess haze width.
    // Per spoke, measure the outer radius of the limb haze at several
    // luminance thresholds. A LOW threshold finds the faint fade-to-black
    // tail (same in both backends); a MID/HIGH threshold finds the radius of
    // the *clearly visible* haze ring — which is the perceptual width that the
    // user sees as "~25 px wider". We also detect the solid-globe edge (the
    // steep luminance cliff at the limb) so we can report ring width = visible
    // haze radius − globe edge.
    const THRESHOLDS = [4, 20, 40, 70];
    const maxR=Math.round(Math.hypot(w,h)/2);
    const inB=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
    const N=360;
    const outersByT = THRESHOLDS.map(()=>[]);
    const edges=[];          // solid-globe geometric edge radius per spoke
    for (let a=0;a<N;a++){
      const deg=(a/N)*360; if(inUi(deg)) continue;
      const ang=deg*Math.PI/180, dx=Math.cos(ang), dy=Math.sin(ang);
      // sample the spoke once into an array
      const prof=[];
      for(let r=2;r<=maxR;r++){
        const x=Math.round(cx+dx*r),y=Math.round(cy+dy*r);
        prof.push(inB(x,y)?lum(...at(x,y)):0);
      }
      // outer radius at each threshold
      let ok=true;
      THRESHOLDS.forEach((T,ti)=>{
        let outer=-1;
        for(let r=prof.length-1;r>=0;r--){ if(prof[r]>T){ outer=r+2; break; } }
        if(outer>=40) outersByT[ti].push(outer); else ok=false;
      });
      // solid-globe edge: walk inward from the lum-4 outer edge to the first
      // BRIGHT cliff (lit surface, lum>SURFACE_LUM) — the geometric limb.
      let outer4=-1;
      for(let r=prof.length-1;r>=0;r--){ if(prof[r]>SPACE_LUM){ outer4=r+2; break; } }
      if(outer4>=40){
        let edge=-1;
        for(let r=outer4-2;r>=0;r--){ if(prof[r]>SURFACE_LUM){ edge=r+2; break; } }
        if(edge>=40) edges.push(edge);
      }
    }
    const med=(arr)=>{ if(!arr.length) return -1; const s=[...arr].sort((p,q)=>p-q); return s[Math.floor(s.length/2)]; };
    if(edges.length<40) return { error:"too few spokes", spokes:edges.length, cx, cy };
    const out = { cx, cy, spokes:edges.length, medianEdgeR:med(edges) };
    THRESHOLDS.forEach((T,ti)=>{ out[`outerR_T${T}`]=med(outersByT[ti]); });
    // Visible ring width = median outer radius at the MID threshold (40) minus
    // the median solid-globe edge.
    out.visibleRingWidth = med(outersByT[2]) - med(edges);
    return out;
  }, b64);
  await browser.close();
  return res;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-limb-skirt] capturing webgl …");
  const gl = await capture("webgl");
  console.log("[probe-limb-skirt] capturing webgpu …");
  const gpu = await capture("webgpu");
  console.log(`  webgl  png: ${gl}\n  webgpu png: ${gpu}`);
  const glM = await measure(gl), gpuM = await measure(gpu);
  console.log("\n  WebGL  haze:", JSON.stringify(glM));
  console.log("  WebGPU haze:", JSON.stringify(gpuM));
  if (glM.error || gpuM.error) { console.log("\n  ✗ measurement error"); process.exit(2); }
  // The VISIBLE ring width (mid-threshold haze radius − solid-globe edge) is
  // the perceptual ring thickness. The globe geometry is identical across
  // backends, so a larger visible ring width on WebGPU ⇒ a wider limb halo.
  const d = +(gpuM.visibleRingWidth - glM.visibleRingWidth).toFixed(2);
  const TOL = 6;
  console.log(`\n  visible limb-ring width  WebGL=${glM.visibleRingWidth}px  WebGPU=${gpuM.visibleRingWidth}px`);
  console.log(`  delta (WebGPU - WebGL) = ${d}px  (tolerance ±${TOL}px)`);
  console.log(Math.abs(d) <= TOL ? "  ✓ PASS — visible limb-ring width matches WebGL within tolerance" :
    `  ✗ FAIL — WebGPU limb ring is ${d > 0 ? "WIDER" : "narrower"} than WebGL by ${Math.abs(d)}px`);
})();
