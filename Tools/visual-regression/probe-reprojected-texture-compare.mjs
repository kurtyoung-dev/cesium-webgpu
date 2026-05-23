#!/usr/bin/env node
// Dump pixels from the reprojected geographic texture for the SAME polar
// imagery tile on both backends. If they differ pixel-by-pixel, the
// reprojection ALGORITHM is the source of the polar diff.
//
// WebGL: 64-row vertex-grid GPGPU reprojection (`reprojectToGeographic`)
//        produces `imagery.texture` (a Texture2D handle).
// WebGPU: per-fragment FS reprojection (`WebGPUImageryReprojection`)
//        produces `imagery._webgpuReprojectedTexture` (a GPUTexture).
//
// We read both into a canvas via a tiny test bench, compare pixel by
// pixel, and report magnitude of any difference.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const VIEW = { lon: 0, lat: 80, height: 12_000_000 };

async function dumpReprojectedPixels(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async ({ view }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
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

    // Find a tile with useWebMercatorT=false AND a non-trivial reprojected
    // texture (polar tile with Mercator-source imagery).
    let targetTile = null;
    let targetImagery = null;
    let targetSkel = null;
    for (const t of v.scene._globe._surface._tilesToRender) {
      for (const skel of t.data?.imagery ?? []) {
        const im = skel?.readyImagery;
        if (!im?.imageryLayer) continue;
        if (skel.useWebMercatorT) continue; // only polar tiles
        const isMercatorProvider = !(
          im.imageryLayer._imageryProvider.tilingScheme.projection
          instanceof C.GeographicProjection
        );
        if (!isMercatorProvider) continue;
        targetTile = t;
        targetImagery = im;
        targetSkel = skel;
        break;
      }
      if (targetTile) break;
    }
    if (!targetTile) return { error: "no polar tile with reprojected texture" };

    // Dump pixels from the reprojected texture.
    const result = {
      tile: { l: targetTile.level, x: targetTile.x, y: targetTile.y },
      imagery: {
        key: targetImagery.key,
        level: targetImagery.level,
        x: targetImagery.x,
        y: targetImagery.y,
        rectangle: targetImagery.rectangle && {
          west: targetImagery.rectangle.west,
          south: targetImagery.rectangle.south,
          east: targetImagery.rectangle.east,
          north: targetImagery.rectangle.north,
        },
      },
      useWebMercatorT: targetSkel.useWebMercatorT,
    };

    // WebGL path: imagery.texture is a Cesium Texture. Read pixel data.
    if (typeof v.scene.context._gl !== "undefined" && targetImagery.texture) {
      const gl = v.scene.context._gl;
      const tex = targetImagery.texture;
      if (tex._texture) {
        const w = tex.width;
        const h = tex.height;
        // Create a framebuffer + draw the texture into it + read pixels.
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          tex._texture,
          0,
        );
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status === gl.FRAMEBUFFER_COMPLETE) {
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          result.webglDump = {
            width: w,
            height: h,
            pixelMean: [0, 0, 0],
            samples: [],
          };
          let rS = 0, gS = 0, bS = 0;
          for (let i = 0; i < buf.length; i += 4) {
            rS += buf[i];
            gS += buf[i + 1];
            bS += buf[i + 2];
          }
          const n = buf.length / 4;
          result.webglDump.pixelMean = [rS / n, gS / n, bS / n];
          // Sample 9 pixels across the texture
          const xs = [0, w >> 2, w >> 1, (w * 3) >> 2, w - 1];
          const ys = [0, h >> 2, h >> 1, (h * 3) >> 2, h - 1];
          for (const y of ys) for (const x of xs) {
            const idx = (y * w + x) * 4;
            result.webglDump.samples.push({
              xy: [x, y],
              rgba: [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]],
            });
          }
          // Compute hash from first 64 pixels for cross-backend fingerprint
          let hash = 0;
          for (let i = 0; i < Math.min(256, buf.length); i++) {
            hash = (hash * 131 + buf[i]) | 0;
          }
          result.webglDump.hash = hash;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
      }
    }

    // WebGPU path: imagery._webgpuReprojectedTexture is a GPUTexture.
    if (targetImagery._webgpuReprojectedTexture) {
      const device = v.scene.context._device;
      const gpuTex = targetImagery._webgpuReprojectedTexture;
      const w = gpuTex.width;
      const h = gpuTex.height;
      const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
      const stagingBuffer = device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: gpuTex, mipLevel: 0 },
        { buffer: stagingBuffer, bytesPerRow },
        { width: w, height: h },
      );
      device.queue.submit([encoder.finish()]);
      await stagingBuffer.mapAsync(GPUMapMode.READ);
      const arr = new Uint8Array(stagingBuffer.getMappedRange());
      // Unpad rows
      const buf = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        buf.set(arr.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
      }
      stagingBuffer.unmap();
      stagingBuffer.destroy();

      result.webgpuDump = {
        width: w,
        height: h,
        pixelMean: [0, 0, 0],
        samples: [],
      };
      let rS = 0, gS = 0, bS = 0;
      for (let i = 0; i < buf.length; i += 4) {
        rS += buf[i];
        gS += buf[i + 1];
        bS += buf[i + 2];
      }
      const n = buf.length / 4;
      result.webgpuDump.pixelMean = [rS / n, gS / n, bS / n];
      const xs = [0, w >> 2, w >> 1, (w * 3) >> 2, w - 1];
      const ys = [0, h >> 2, h >> 1, (h * 3) >> 2, h - 1];
      for (const y of ys) for (const x of xs) {
        const idx = (y * w + x) * 4;
        result.webgpuDump.samples.push({
          xy: [x, y],
          rgba: [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]],
        });
      }
      let hash = 0;
      for (let i = 0; i < Math.min(256, buf.length); i++) {
        hash = (hash * 131 + buf[i]) | 0;
      }
      result.webgpuDump.hash = hash;
    }

    return result;
  }, { view: VIEW });

  await browser.close();
  return result;
}

(async () => {
  console.log("[reprojected-texture-compare] dumping polar-tile reprojected pixels");
  console.log();
  const wgl = await dumpReprojectedPixels("webgl");
  const wgpu = await dumpReprojectedPixels("webgpu");

  console.log("WebGL  picked tile :", wgl.tile, " imagery:", wgl.imagery);
  console.log("WebGPU picked tile :", wgpu.tile, " imagery:", wgpu.imagery);
  console.log();

  if (wgl.webglDump) {
    console.log("=== WebGL imagery.texture reprojected pixels ===");
    console.log(
      `  size=${wgl.webglDump.width}x${wgl.webglDump.height} mean RGB=[${wgl.webglDump.pixelMean.map(x => x.toFixed(1)).join(", ")}]`,
    );
    console.log(`  fingerprint hash: ${wgl.webglDump.hash}`);
  } else {
    console.log("WebGL: no readable imagery.texture (likely WebGPU build, no GL context)");
  }
  if (wgpu.webgpuDump) {
    console.log("=== WebGPU _webgpuReprojectedTexture pixels ===");
    console.log(
      `  size=${wgpu.webgpuDump.width}x${wgpu.webgpuDump.height} mean RGB=[${wgpu.webgpuDump.pixelMean.map(x => x.toFixed(1)).join(", ")}]`,
    );
    console.log(`  fingerprint hash: ${wgpu.webgpuDump.hash}`);
  }

  // Cross-compare sample pixels (if both available — they should NOT be on a
  // single page, since we're running webgl + webgpu in separate browsers).
  // Print samples side-by-side for visual inspection.
  if (wgl.webglDump && wgpu.webgpuDump) {
    console.log();
    console.log("=== Sampled pixels (WebGL | WebGPU) ===");
    for (let i = 0; i < wgl.webglDump.samples.length; i++) {
      const a = wgl.webglDump.samples[i];
      const b = wgpu.webgpuDump.samples[i];
      const da = [
        a.rgba[0] - b.rgba[0],
        a.rgba[1] - b.rgba[1],
        a.rgba[2] - b.rgba[2],
      ];
      const mag = Math.max(Math.abs(da[0]), Math.abs(da[1]), Math.abs(da[2]));
      const mark = mag < 4 ? "  " : mag < 16 ? "~ " : "* ";
      console.log(
        `  ${mark}xy=${JSON.stringify(a.xy).padEnd(12)} WGL=[${a.rgba.slice(0, 3)}]  WGPU=[${b.rgba.slice(0, 3)}]  Δ=${da}`,
      );
    }
  }
})();
