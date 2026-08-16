// Diagnostic: hook createShaderModule, dump getCompilationInfo() error
// messages (with line numbers + the offending source line) for any Model PBR
// shader variant that fails to compile. Loads TestKhrSpecular (the 0x8200
// variant that regressed). Run: node Tools/visual-regression/probe-wgsl-compile-error.mjs
// @purpose Diagnostic: hooks createShaderModule and dumps WGSL compile errors with source context for Model PBR variants (built for 0x8200 regression).
// @status INVESTIGATION
//
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const out = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("WGSLDIAG:")) out.push(t.slice(9));
});

await page.addInitScript(() => {
  const orig = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = orig.call(this, desc);
    const label = desc.label || "(unlabeled)";
    const code = desc.code || "";
    mod.getCompilationInfo().then((info) => {
      const errs = info.messages.filter((x) => x.type === "error");
      if (errs.length) {
        const lines = code.split("\n");
        for (const e of errs) {
          const ln = e.lineNum | 0;
          const ctx = [];
          for (
            let i = Math.max(1, ln - 2);
            i <= Math.min(lines.length, ln + 2);
            i++
          ) {
            ctx.push(`${i === ln ? ">>" : "  "}${i}: ${lines[i - 1]}`);
          }
          console.log(
            `WGSLDIAG: [${label}] L${ln}:${e.linePos} ${e.message}\n${ctx.join("\n")}`,
          );
        }
      }
    });
    return mod;
  };
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

await page.evaluate(
  async ({ modelUrl }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;
    s.globe.show = false;
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(-75, 40, 0),
    );
    const model = await C.Model.fromGltfAsync({
      url: modelUrl,
      modelMatrix,
      scale: 1.0,
    });
    s.primitives.add(model);
    for (let i = 0; i < 400 && !model.ready; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 60; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  },
  { modelUrl: MODEL },
);

await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
await browser.close();

if (!out.length) console.log("No WGSL compile errors captured.");
else console.log(out.join("\n----\n"));
