import { chromium } from "playwright";
const SHIM = `(function(){
  const FORCED_RENDERER="webgpu"; window.__capturedViewer=null;
  function captureViewer(v){if(!window.__capturedViewer&&v)window.__capturedViewer=v;return v;}
  function patchOptions(o){if(!o||typeof o!=="object")return o;const c=o.contextOptions||(o.contextOptions={});if(!c.renderer)c.renderer=FORCED_RENDERER;return o;}
  function buildPatched(C){if(!C||!C.Viewer)return C;const O=C.Viewer;const OCA=O.createAsync;
    function PV(c,o){return captureViewer(new O(c,patchOptions(o||{})));}
    PV.prototype=O.prototype;Object.assign(PV,O);
    if(typeof OCA==="function")PV.createAsync=(c,o)=>OCA.call(O,c,patchOptions(o||{})).then(captureViewer);
    return new Proxy(C,{get(t,p){if(p==="Viewer")return PV;return t[p];}});}
  let _c;Object.defineProperty(window,"Cesium",{configurable:true,enumerable:true,get(){return _c;},set(v){_c=buildPatched(v);Object.defineProperty(window,"Cesium",{value:_c,writable:true,configurable:true,enumerable:true});}});
  let _s,_sp=null;Object.defineProperty(window,"startup",{configurable:true,enumerable:true,get(){return _s;},set(v){if(typeof v==="function"){_s=function(_oc,...r){const x=v.call(this,window.Cesium,...r);if(!_sp&&x&&typeof x.then==="function")_sp=x;return x;}}else _s=v;}});
  let _flC=false,_flP=false,_oFL=null;function rFL(){if(_flC||!_oFL)return;_flC=true;try{_oFL.call(window.Sandcastle);}catch(e){}}
  function dFL(){if(_flP||_flC)return;_flP=true;function tc(r){if(_sp){Promise.resolve(_sp).then(()=>Promise.resolve()).then(rFL).catch(rFL);return;}if(r<=0){rFL();return;}Promise.resolve().then(()=>tc(r-1));}tc(20);}
  function pSC(){const SC=window.Sandcastle;if(!SC||_oFL)return;_oFL=SC.finishedLoading;SC.finishedLoading=function(){if(_sp||typeof _s==="function"){dFL();return;}_oFL.call(SC);_flC=true;};}
  function tp(){if(window.Sandcastle)pSC();else requestAnimationFrame(tp);}tp();
})();`;
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const logs = [];
page.on("console", (m) => {
  if (m.text().includes("[diag") || m.type() === "error") logs.push(m.text());
});
page.on("pageerror", (e) => logs.push("err: " + e.message));
await page.addInitScript({ content: SHIM });
await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
  const r = await route.fetch();
  const t = await r.text();
  await route.fulfill({
    status: r.status(),
    headers: r.headers(),
    body: t.replace(
      /new\s+Cesium\.Viewer\s*\(/g,
      "await Cesium.Viewer.createAsync(",
    ),
  });
});
await page.goto("http://localhost:8080/Apps/Sandcastle/gallery/Mars.html", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(
  () => {
    const c = document.querySelector(".cesium-widget canvas");
    return c && c.width > 0;
  },
  { timeout: 60000 },
);
await page.waitForTimeout(15000);
await browser.close();
console.log(logs.slice(0, 20).join("\n"));
