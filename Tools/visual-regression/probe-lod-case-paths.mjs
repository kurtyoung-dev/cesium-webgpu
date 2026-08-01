#!/usr/bin/env node
// Sweep camera altitude over the north pole. For each altitude:
//   1. Dump every `_tilesToRender` tile with:
//      - terrain level/x/y, latitude range
//      - per-imagery-skeleton: useWebMercatorT, reprojected?, ancestor level
//      - which of the 4 case paths the tile takes
//   2. Capture WebGL + WebGPU PNGs
//   3. Compute pixel diff
// Goal: find the LOD where adjacent tiles take different case paths,
// which is the suspected source of the LOD-dependent residual.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Altitude sweep: 0.5 Mm to 20 Mm in 1.5x steps. Roughly one terrain
// LOD per step at high latitudes.
const ALTITUDES = [
  500_000, 1_000_000, 2_000_000, 3_500_000, 6_000_000, 9_000_000, 13_000_000,
  18_000_000,
];

async function capture(renderer, alt) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const data = await page.evaluate(
    async ({ alt }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 85, alt),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }

      const tiles = v.scene._globe?._surface?._tilesToRender ?? [];

      // Bucket tiles by case path: (useWMT, reproj) → count
      const cases = { "1:T-noR": 0, "2:T-R": 0, "3:F-R": 0, "4:F-noR": 0 };
      const perTile = [];
      for (const t of tiles) {
        const skel = t.data?.imagery ?? [];
        const r = t.rectangle;
        const south = ((r?.south ?? 0) * 180) / Math.PI;
        const north = ((r?.north ?? 0) * 180) / Math.PI;
        for (const ti of skel) {
          if (!ti?.readyImagery?.imageryLayer) continue;
          const useWMT = !!ti.useWebMercatorT;
          const reproj = !!ti.readyImagery._webgpuReprojectedTexture;
          const cse = useWMT
            ? reproj
              ? "2:T-R"
              : "1:T-noR"
            : reproj
              ? "3:F-R"
              : "4:F-noR";
          cases[cse] = (cases[cse] || 0) + 1;
          perTile.push({
            L: t.level,
            X: t.x,
            Y: t.y,
            latRange: `${south.toFixed(1)}..${north.toFixed(1)}`,
            straddles85: south < 85.05 && north > 85.05,
            useWMT,
            reproj,
            case: cse,
            imgLevel: ti.readyImagery.level,
          });
        }
      }
      // Sort by latitude
      perTile.sort((a, b) => parseFloat(a.latRange) - parseFloat(b.latRange));
      return {
        tileCount: tiles.length,
        skelCount: perTile.length,
        cases,
        // Per-tile detail for the first few highest-latitude tiles
        highLatTiles: perTile.slice(-10),
      };
    },
    { alt },
  );
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `lod-sweep-alt${alt}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { png: out, data };
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(
  "[lod-case-paths] camera at lat=85°N. Cases: 1:T-noR, 2:T-R, 3:F-R, 4:F-noR",
);
console.log(
  "  case 2 = useWMT=true + reprojected (Batch 62 recalc applies, NO fixup)",
);
console.log(
  "  case 3 = useWMT=false + reprojected (Batch 62 uses cached geographic, WITH fixup)",
);
console.log();

for (const alt of ALTITUDES) {
  for (const renderer of ["webgl", "webgpu"]) {
    const r = await capture(renderer, alt);
    if (renderer === "webgl") {
      console.log(
        `alt=${alt.toLocaleString().padStart(11)} m  tiles=${r.data.tileCount}  skel=${r.data.skelCount}  cases=${JSON.stringify(r.data.cases)}`,
      );
      // Show the highest-lat tiles to see case-path transitions
      for (const t of r.data.highLatTiles) {
        console.log(
          `   L${t.L}_X${t.X}_Y${t.Y} lat[${t.latRange}] straddles85=${t.straddles85 ? 1 : 0} useWMT=${t.useWMT ? 1 : 0} reproj=${t.reproj ? 1 : 0} case=${t.case} imgL=${t.imgLevel}`,
        );
      }
    }
  }
}
