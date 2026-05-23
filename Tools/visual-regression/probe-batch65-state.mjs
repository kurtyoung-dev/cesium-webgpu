#!/usr/bin/env node
// Batch 65 state verification. For each of 4 camera positions, dumps:
//   1. Imagery provider name + projection
//   2. Per-tile: useWebMercatorT, hasMerc, hasReproj, hasImage, layer index
//   3. Texture-cache contents (keys + which are *_merc vs geographic)
//   4. Whether the bind decision (mercator vs geographic) agrees with the
//      effectiveUseWebMercatorT flag the tile-UB packer would write.
//
// The point is to validate that dual-texture binding stays in lock-step
// with the cached translation/scale values under realistic conditions.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

const VIEWS = [
  { name: "equator", lon: 0, lat: 0, height: 3_000_000 },
  { name: "midlat-mid", lon: -100, lat: 40, height: 3_000_000 },
  { name: "northpole-orbit", lon: 0, lat: 80, height: 12_000_000 },
  { name: "southpole-close", lon: 0, lat: -89, height: 3_000_000 },
];

async function probe(view) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async ({ view }) => {
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
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    });
    for (let i = 0; i < 1500; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 300) break;
    }

    const layer = v.imageryLayers.get(0);
    const provider = layer._imageryProvider;
    const isMercator =
      !(provider.tilingScheme.projection instanceof C.GeographicProjection);

    const tiles = v.scene._globe?._surface?._tilesToRender ?? [];

    // Per-tile inspection. Tile is "OK" when the binding decision
    // (which texture the cache will pick — Mercator vs Geographic) agrees
    // with the `effectiveUseWebMercatorT` flag the tile-UB packer would
    // write. Both read `tileImagery.useWebMercatorT` and
    // `imagery._webgpuMercatorTexture` — agreement is the construction
    // invariant Batch 65 relies on.
    //
    // Note: the renderer's imagery texture cache lives in a per-device
    // WeakMap created lazily inside `addWebGPUDrawCommandsForTile` (not
    // accessible from the probe). Batch 71 removed the dead `fr._instance`
    // field that we previously tried to read; we validate imagery-object
    // state directly — the source of truth that both the cache lookup
    // and the UB packer consult.
    let agreeOK = 0;
    let agreeMismatch = 0;
    let mercTileCount = 0;
    let geoTileCount = 0;
    let bothMissingTileCount = 0;
    let bothPresentTileCount = 0;
    const samples = [];

    for (const t of tiles) {
      for (const skel of t.data?.imagery ?? []) {
        const imagery = skel?.readyImagery;
        if (!imagery?.imageryLayer) continue;
        const useWMT = !!skel.useWebMercatorT;
        const hasMerc = !!imagery._webgpuMercatorTexture;
        const hasReproj = !!imagery._webgpuReprojectedTexture;
        const hasImage = !!imagery.image;

        if (hasMerc && hasReproj) bothPresentTileCount++;
        else if (!hasMerc && !hasReproj) bothMissingTileCount++;
        if (useWMT && hasMerc) mercTileCount++;
        else geoTileCount++;

        // Reproduce the cache decision
        let cacheWillBindMercator;
        if (useWMT && hasMerc) cacheWillBindMercator = true;
        else if (hasReproj) cacheWillBindMercator = false;
        else if (hasMerc) cacheWillBindMercator = true;
        else cacheWillBindMercator = false; // image-upload fallback → geographic

        const effectiveUseWMT = useWMT && hasMerc;
        const tileUBWritesMerc = effectiveUseWMT;

        if (tileUBWritesMerc === cacheWillBindMercator) {
          agreeOK++;
        } else {
          agreeMismatch++;
          if (samples.length < 5) {
            samples.push({
              tile: `L${t.level}_X${t.x}_Y${t.y}`,
              imgKey: imagery.key,
              useWMT,
              hasMerc,
              hasReproj,
              hasImage,
              cacheWillBindMercator,
              tileUBWritesMerc,
            });
          }
        }
      }
    }

    return {
      providerName: provider.constructor?.name,
      isMercatorProvider: isMercator,
      tileCount: tiles.length,
      agreeOK,
      agreeMismatch,
      mismatchSamples: samples,
      tileStats: {
        bothPresent: bothPresentTileCount,
        bothMissing: bothMissingTileCount,
        willBindMercator: mercTileCount,
        willBindGeographic: geoTileCount,
      },
    };
  }, { view });

  await browser.close();
  return result;
}

(async () => {
  console.log("[batch65-state] verifying dual-texture binding/UB agreement");
  console.log();
  for (const view of VIEWS) {
    const r = await probe(view);
    const ok = r.agreeMismatch === 0;
    const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `${mark} ${view.name.padEnd(20)} provider=${r.providerName} isMerc=${r.isMercatorProvider} tiles=${r.tileCount}`,
    );
    console.log(
      `   imagery state: bothPresent=${r.tileStats.bothPresent} bothMissing=${r.tileStats.bothMissing} willBindMerc=${r.tileStats.willBindMercator} willBindGeo=${r.tileStats.willBindGeographic}`,
    );
    console.log(
      `   binding/UB agree=${r.agreeOK} mismatch=${r.agreeMismatch}`,
    );
    if (r.mismatchSamples.length) {
      console.log("   mismatch samples:");
      for (const s of r.mismatchSamples) {
        console.log(
          `     ${s.tile} useWMT=${s.useWMT} merc=${s.hasMerc} reproj=${s.hasReproj} img=${s.hasImage} → cacheMerc=${s.cacheWillBindMercator} ubMerc=${s.tileUBWritesMerc}`,
        );
      }
    }
    console.log();
  }
})();
