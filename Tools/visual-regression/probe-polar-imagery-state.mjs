#!/usr/bin/env node
// Batch 62 — for polar tiles (south < -85°), dump per-tile imagery
// state on both WebGL and WebGPU.
//
// Hypothesis under test: on WebGPU, `layerCount=0` for polar tiles
// because either (a) no TileImagery skeletons exist, (b) readyImagery
// is undefined (state machine stuck at TEXTURE_LOADED), or (c)
// readyImagery exists but `imageryLayer` is null.
//
// Output columns per polar tile:
//   - L/X/Y/rect (geographic)
//   - tile.data.imagery.length (skeleton count)
//   - per skeleton:
//       useWebMercatorT
//       loadingImagery.state  (UNLOADED/TRANSITIONING/RECEIVED/TEXTURE_LOADED/READY/FAILED/INVALID)
//       readyImagery defined? state? hasTexture? hasReprojectedTexture? hasImage?
//       readyImagery.imageryLayer defined?

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

const VIEWS = [
  { name: "southpole-close", lat: -89, alt: 3_000_000 },
  { name: "northpole-close", lat: 89, alt: 3_000_000 },
];

async function capture(renderer, view) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ lat, alt }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, lat, alt),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }

      // Cesium's ImageryState is a frozen object with the canonical values 0-6.
      const stateName = (s) =>
        ({
          0: "UNLOADED",
          1: "TRANSITIONING",
          2: "RECEIVED",
          3: "TEXTURE_LOADED",
          4: "READY",
          5: "FAILED",
          6: "INVALID",
          7: "PLACEHOLDER",
        })[s] ?? `?${s}`;

      const tiles = v.scene._globe?._surface?._tilesToRender ?? [];
      const polar = tiles.filter((t) => {
        const south = ((t.rectangle?.south ?? 0) * 180) / Math.PI;
        return south < -85 || south > 84 || t.rectangle == null;
      });

      const dump = polar.slice(0, 12).map((t) => {
        const rect = t.rectangle;
        const skel = t?.data?.imagery ?? [];
        const skeletons = skel.map((ti) => {
          const li = ti?.loadingImagery;
          const ri = ti?.readyImagery;
          return {
            useWebMercatorT: !!ti?.useWebMercatorT,
            loading: li
              ? {
                  state: stateName(li.state),
                  hasImage: !!li.image,
                  hasTex: !!li.texture,
                  hasMercTex: !!li.textureWebMercator,
                  hasReprojTex: !!li._webgpuReprojectedTexture,
                }
              : null,
            ready: ri
              ? {
                  state: stateName(ri.state),
                  hasImage: !!ri.image,
                  hasTex: !!ri.texture,
                  hasMercTex: !!ri.textureWebMercator,
                  hasReprojTex: !!ri._webgpuReprojectedTexture,
                  hasLayer: !!ri.imageryLayer,
                  level: ri.level,
                  x: ri.x,
                  y: ri.y,
                }
              : null,
          };
        });
        return {
          L: t.level,
          X: t.x,
          Y: t.y,
          rect: rect
            ? `S${((rect.south * 180) / Math.PI).toFixed(2)},W${((rect.west * 180) / Math.PI).toFixed(2)},N${((rect.north * 180) / Math.PI).toFixed(2)},E${((rect.east * 180) / Math.PI).toFixed(2)}`
            : "?",
          skelCount: skel.length,
          readyCount: skel.filter(
            (ti) => ti?.readyImagery && ti?.readyImagery?.imageryLayer,
          ).length,
          skeletons,
        };
      });

      return {
        totalTiles: tiles.length,
        polarCount: polar.length,
        polarSampled: dump.length,
        polarTiles: dump,
      };
    },
    { lat: view.lat, alt: view.alt },
  );

  await browser.close();
  return result;
}

(async () => {
  for (const view of VIEWS) {
    console.log(`\n=== ${view.name} (lat=${view.lat}, alt=${view.alt}) ===`);
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`\n[${renderer}]`);
      const info = await capture(renderer, view);
      console.log(
        `  total=${info.totalTiles}  polar=${info.polarCount}  sampled=${info.polarSampled}`,
      );
      for (const t of info.polarTiles) {
        console.log(
          `  L${t.L}_${t.X}_${t.Y}  rect=[${t.rect}]  skel=${t.skelCount}  ready=${t.readyCount}`,
        );
        for (let i = 0; i < t.skeletons.length; i++) {
          const s = t.skeletons[i];
          const ld = s.loading
            ? `loading{${s.loading.state} img=${s.loading.hasImage ? 1 : 0} tx=${s.loading.hasTex ? 1 : 0} merc=${s.loading.hasMercTex ? 1 : 0} reproj=${s.loading.hasReprojTex ? 1 : 0}}`
            : "loading=null";
          const rd = s.ready
            ? `ready{${s.ready.state} L${s.ready.level}_${s.ready.x}_${s.ready.y} img=${s.ready.hasImage ? 1 : 0} tx=${s.ready.hasTex ? 1 : 0} merc=${s.ready.hasMercTex ? 1 : 0} reproj=${s.ready.hasReprojTex ? 1 : 0} layer=${s.ready.hasLayer ? 1 : 0}}`
            : "ready=null";
          console.log(
            `    skel[${i}] useWMT=${s.useWebMercatorT ? 1 : 0}  ${ld}  ${rd}`,
          );
        }
      }
    }
  }
})();
