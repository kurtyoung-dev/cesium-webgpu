import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(
  "http://localhost:8080/Apps/Sandcastle/gallery/Hello%20World.html",
  {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  },
);
await page.waitForFunction(
  () => {
    const c = document.querySelector(".cesium-widget canvas");
    return c && c.width > 0;
  },
  { timeout: 60000 },
);
await page.waitForTimeout(8000);

await page.evaluate(async () => {
  const v =
    window.viewer1 ||
    (Object.keys(window).find((k) => window[k]?.scene?.canvas)
      ? window[Object.keys(window).find((k) => window[k]?.scene?.canvas)]
      : null);
  if (!v) return;
  v.scene.skyAtmosphere.show = false;
  v.scene.globe.showGroundAtmosphere = false;
  v.scene.fog.enabled = false;
  v.scene.skyBox.show = false;
  for (let i = 0; i < 30; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});
await page.waitForTimeout(2000);

const dataUrl = await page.evaluate(() => {
  const c = document.querySelector(".cesium-widget canvas");
  return c.toDataURL("image/png");
});
const fs = await import("node:fs/promises");
await fs.writeFile(
  "Tools/visual-regression/output/probe-sc-wgl-clean.png",
  Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
);
await browser.close();

const sharp = (await import("sharp")).default;
const { data, info } = await sharp(
  "Tools/visual-regression/output/probe-sc-wgl-clean.png",
)
  .raw()
  .toBuffer({ resolveWithObject: true });
for (const [n, x, y] of [
  ["mid-Pacific", 230, 320],
  ["continent", 360, 280],
]) {
  const idx = (info.width * y + x) * info.channels;
  console.log(n, data[idx], data[idx + 1], data[idx + 2]);
}
