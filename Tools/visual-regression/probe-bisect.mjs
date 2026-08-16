// @purpose Generic bisection harness: toggles sky/ground atmosphere, fog, skybox per label and captures a PNG of the WebGPU frame for each combo.
// @status ACTIVE

import { chromium } from "playwright";

async function probe(label, mods) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(
    "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu",
    {
      waitUntil: "networkidle",
      timeout: 60000,
    },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });

  await page.evaluate(async (m) => {
    const v = window.viewer;
    if (m.skyOff) v.scene.skyAtmosphere.show = false;
    if (m.groundOff) v.scene.globe.showGroundAtmosphere = false;
    if (m.fogOff) v.scene.fog.enabled = false;
    if (m.skyBoxOff) v.scene.skyBox.show = false;
    for (let i = 0; i < 30; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, mods);
  await page.waitForTimeout(2000);

  const dataUrl = await page.evaluate(() =>
    window.viewer.scene.canvas.toDataURL("image/png"),
  );
  const fs = await import("node:fs/promises");
  const path = `Tools/visual-regression/output/probe-${label}.png`;
  await fs.writeFile(
    path,
    Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
  );

  await browser.close();

  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(path)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const samples = [
    ["mid-Pacific", 230, 320],
    ["continent", 360, 280],
  ];
  console.log(label);
  for (const [n, x, y] of samples) {
    const idx = (info.width * y + x) * info.channels;
    console.log("  " + n.padEnd(15), data[idx], data[idx + 1], data[idx + 2]);
  }
}

await probe("all-on", {});
await probe("fog-off", { fogOff: true });
await probe("sky-off", { skyOff: true });
await probe("ground-off", { groundOff: true });
await probe("all-off", { fogOff: true, skyOff: true, groundOff: true });
