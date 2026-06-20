#!/usr/bin/env node
// Azimuthally-averaged blue-excess (B-R) and luminance profile vs radius for
// both disk screenshots. Averaging over all clean spokes cancels surface
// (land/ocean) variation and isolates the atmospheric blue limb contribution.
// Prints, per radius bin (relative to the geometric edge), the mean B-R and
// mean luminance for WebGL and WebGPU side by side so we can see exactly which
// radii diverge and by how much.
import { chromium } from "playwright";
import fs from "fs";

const files = {
  webgl: "Tools/visual-regression/output/probe-limb-skirt-webgl.png",
  webgpu: "Tools/visual-regression/output/probe-limb-skirt-webgpu.png",
};

async function azavg(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const res = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const w = c.width, h = c.height; const data = ctx.getImageData(0,0,w,h).data;
    const at=(x,y)=>{const i=(y*w+x)*4;return [data[i],data[i+1],data[i+2]];};
    const lum=(r,g,b)=>0.2126*r+0.7152*g+0.0722*b;
    const inB=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
    let sx=0,sy=0,n=0;
    for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){const[r,g,b]=at(x,y);if(lum(r,g,b)>4){sx+=x;sy+=y;n++;}}
    const cx=Math.round(sx/n),cy=Math.round(sy/n);
    const inUi=(d)=>{d=((d%360)+360)%360;if(d>=300||d<=15)return true;if(d>=60&&d<=120)return true;return false;};
    const maxR=Math.round(Math.hypot(w,h)/2);
    const N=720;
    // For each spoke find the geometric edge (outermost bright surface lum>150);
    // accumulate B-R and lum into bins indexed by (r - edge).
    const REL_MIN=-8, REL_MAX=60; // bins from 8px outside edge to 60px inside
    const bins={}; for(let k=REL_MIN;k<=REL_MAX;k++) bins[k]={sumBR:0,sumL:0,cnt:0};
    let edges=[];
    for(let a=0;a<N;a++){
      const deg=(a/N)*360; if(inUi(deg)) continue;
      const ang=deg*Math.PI/180,dx=Math.cos(ang),dy=Math.sin(ang);
      // geometric edge
      let edge=-1;
      for(let r=maxR;r>=2;r--){const x=Math.round(cx+dx*r),y=Math.round(cy+dy*r);if(!inB(x,y))continue;if(lum(...at(x,y))>150){edge=r;break;}}
      if(edge<60) continue;
      edges.push(edge);
      for(let k=REL_MIN;k<=REL_MAX;k++){
        const r=edge - k; // k>0 => inside the disk; k<0 => outside (space side)
        const x=Math.round(cx+dx*r),y=Math.round(cy+dy*r);
        if(!inB(x,y))continue;
        const[R,G,B]=at(x,y);
        bins[k].sumBR += (B-R); bins[k].sumL += lum(R,G,B); bins[k].cnt++;
      }
    }
    const edgeMed = edges.sort((p,q)=>p-q)[Math.floor(edges.length/2)];
    const prof=[];
    for(let k=REL_MIN;k<=REL_MAX;k++){
      const b=bins[k]; if(b.cnt<10) continue;
      prof.push({ rel:k, meanBR:+(b.sumBR/b.cnt).toFixed(1), meanL:+(b.sumL/b.cnt).toFixed(1), cnt:b.cnt });
    }
    return { cx, cy, edgeMed, spokes:edges.length, prof };
  }, b64);
  await browser.close();
  return res;
}

(async () => {
  const gl = await azavg(files.webgl);
  const gpu = await azavg(files.webgpu);
  console.log(`webgl center=(${gl.cx},${gl.cy}) edgeMed=${gl.edgeMed} spokes=${gl.spokes}`);
  console.log(`webgpu center=(${gpu.cx},${gpu.cy}) edgeMed=${gpu.edgeMed} spokes=${gpu.spokes}`);
  console.log(`\n rel(px inward from edge) | meanB-R  gl / gpu (Δ) | meanLum gl / gpu (Δ)`);
  const byRel = {};
  gl.prof.forEach(p=>{byRel[p.rel]=byRel[p.rel]||{};byRel[p.rel].gl=p;});
  gpu.prof.forEach(p=>{byRel[p.rel]=byRel[p.rel]||{};byRel[p.rel].gpu=p;});
  const keys = Object.keys(byRel).map(Number).sort((a,b)=>a-b);
  for(const k of keys){
    const g=byRel[k].gl, u=byRel[k].gpu; if(!g||!u) continue;
    const dBR=(u.meanBR-g.meanBR).toFixed(1);
    const dL=(u.meanL-g.meanL).toFixed(1);
    const mark = Math.abs(u.meanBR-g.meanBR)>=8 ? '  <<< B-R diverges' : '';
    console.log(`  ${String(k).padStart(4)}  |  ${String(g.meanBR).padStart(5)} / ${String(u.meanBR).padStart(5)} (${String(dBR).padStart(5)}) | ${String(g.meanL).padStart(6)} / ${String(u.meanL).padStart(6)} (${String(dL).padStart(6)})${mark}`);
  }
})();
