#!/usr/bin/env node
// Probe the REALIZED WebGPU imagery texture for a loaded globe tile.
//
// C9-AUDIT-P1-SWEEP (Batch 684): the old probe read imagery._webgpuTexture /
// imagery._webgpuTextureView — fields that DO NOT EXIST on the imagery object,
// so every "hasWebGPUTex" flag was vacuously false and the probe could never
// fail. It now reads the actual realized GPUTexture from two authoritative
// sources and ASSERTS one is present for a loaded, rendered tile:
//
//   1. The per-imagery dual-texture fields (`imagery._webgpuMercatorTexture` /
//      `imagery._webgpuReprojectedTexture`). Per the WebGPUGlobeSurfaceTextures
//      module docstring these ARE exactly the GPUTextures the renderer's
//      `_imageryTextureCache` holds (`${key}_merc` → mercator, `${key}` →
//      reprojected), set by ImageryLayer._reprojectTexture.
//   2. The per-renderer `_imageryTextureCache` Map entry (`{ texture }`),
//      reached through the only page-visible handle to the device-keyed globe
//      renderer: the `sceneCaptureReflections` publish
//      (`context._webgpuSceneCaptureSources.globeRenderer`). Best-effort +
//      guarded — if unreachable the imagery-field assertion still stands.
import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const ctx = v.scene.context;

    const surface = v.scene.globe._surface;
    const tiles = surface._tilesToRender;
    const sampleTile = tiles?.[0];
    if (!sampleTile?.data?.imagery?.length) {
      return { error: "no imagery on first tile", tilesCount: tiles?.length };
    }

    const ti = sampleTile.data.imagery[0];
    const imagery = ti.readyImagery;
    const isGPUTexture = (t) =>
      !!t && typeof t === "object" && typeof t.createView === "function";

    // ── Source 1: per-imagery realized dual-texture fields (REAL) ──
    const realizedMerc = imagery?._webgpuMercatorTexture ?? null;
    const realizedGeo = imagery?._webgpuReprojectedTexture ?? null;
    let realizedFromImagery = null;
    if (isGPUTexture(realizedMerc)) {
      realizedFromImagery = "merc";
    } else if (isGPUTexture(realizedGeo)) {
      realizedFromImagery = "geo";
    }

    const baseKey =
      imagery?.key ||
      `${imagery?.x ?? 0}_${imagery?.y ?? 0}_${imagery?.level ?? 0}`;

    // ── Source 2: per-renderer _imageryTextureCache (best-effort) ──
    // Reach the device-keyed globe renderer via the sceneCaptureReflections
    // publish. Bounded (6 frames) + guarded; failure here does not fail the
    // probe, the imagery-field assertion below does.
    let cacheProbe = { reachable: false };
    try {
      const prev = ctx.sceneCaptureReflections;
      ctx.sceneCaptureReflections = true;
      for (let i = 0; i < 6; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const renderer = ctx._webgpuSceneCaptureSources?.globeRenderer;
      ctx.sceneCaptureReflections = prev;
      const cache = renderer?._imageryTextureCache;
      if (cache && typeof cache.get === "function") {
        const entryHasTex = (e) => isGPUTexture(e?.texture);
        cacheProbe = {
          reachable: true,
          size: cache.size,
          baseKey,
          geoEntryHasTexture: entryHasTex(cache.get(baseKey)),
          mercEntryHasTexture: entryHasTex(cache.get(`${baseKey}_merc`)),
        };
      }
    } catch (e) {
      cacheProbe = { reachable: false, error: String(e) };
    }

    const realizedTexturePresent =
      realizedFromImagery !== null ||
      cacheProbe.geoEntryHasTexture === true ||
      cacheProbe.mercEntryHasTexture === true;

    return {
      tilesToRender: tiles.length,
      tileLevel: sampleTile.level,
      tileXY: [sampleTile.x, sampleTile.y],
      imageryReady: !!imagery,
      imageryState: imagery?.state,
      imageryHasImage: !!imagery?.image,
      baseKey,
      realizedFromImagery,
      cacheProbe,
      realizedTexturePresent,
    };
  });

  await browser.close();
  console.log(JSON.stringify(result, null, 2));

  // Real pass/fail assertion — a loaded, rendered tile MUST carry a realized
  // WebGPU imagery GPUTexture on at least one of the two authoritative sources.
  if (result.error) {
    console.log(`FAIL: ${result.error}`);
    process.exit(1);
  }
  if (!result.realizedTexturePresent) {
    console.log(
      "FAIL: loaded tile has NO realized WebGPU imagery texture " +
        "(imagery dual-texture fields AND per-renderer cache both empty)",
    );
    process.exit(1);
  }
  console.log(
    "PASS: realized WebGPU imagery texture present for loaded tile " +
      `(imagery=${result.realizedFromImagery ?? "none"}, ` +
      `cacheReachable=${result.cacheProbe.reachable})`,
  );
  process.exit(0);
})();
