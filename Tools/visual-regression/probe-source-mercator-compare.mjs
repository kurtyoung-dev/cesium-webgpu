#!/usr/bin/env node
// Dump pixels from the SOURCE Mercator texture for the same imagery tile
// on both backends and compare row-by-row. If they differ, the polar
// reprojection diff has a SOURCE-side cause (upload convention, color
// space, precision) — not a reprojection-algorithm cause.
//
// WebGL:  imagery.textureWebMercator   (Cesium Texture, uploaded via
//         `new Texture({source: image})` with UNPACK_FLIP_Y_WEBGL=true)
// WebGPU: imagery._webgpuMercatorTexture (GPUTexture, uploaded via
//         `copyExternalImageToTexture` against a pre-flipped ImageBitmap
//         from Resource.fetchImage({flipY: true}))
//
// Both should hold the same imagery PNG data. The probe compares the
// stored pixel data at multiple sample points and aggregates a mean
// brightness ratio + identical-row count.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const VIEW = { lon: 0, lat: 80, height: 12_000_000 };

async function dumpSourcePixels(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ view }) => {
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

      // Find a polar tile (useWebMercatorT=false) with a Mercator provider.
      // The source mercator texture is what gets uploaded from the
      // imagery provider PNG and is then SAMPLED by the reproject pass.
      let targetImagery = null;
      let _targetSkel = null;
      for (const t of v.scene._globe._surface._tilesToRender) {
        for (const skel of t.data?.imagery ?? []) {
          const im = skel?.readyImagery;
          if (!im?.imageryLayer) continue;
          if (skel.useWebMercatorT) continue; // only polar tiles
          const isMercatorProvider = !(
            im.imageryLayer._imageryProvider.tilingScheme.projection instanceof
            C.GeographicProjection
          );
          if (!isMercatorProvider) continue;
          targetImagery = im;
          _targetSkel = skel;
          break;
        }
        if (targetImagery) break;
      }
      if (!targetImagery)
        return { error: "no polar tile with source mercator texture" };

      const result = {
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
      };

      // WebGL: read `imagery.textureWebMercator` pixels via FBO+readPixels.
      if (
        typeof v.scene.context._gl !== "undefined" &&
        targetImagery.textureWebMercator
      ) {
        const gl = v.scene.context._gl;
        const tex = targetImagery.textureWebMercator;
        if (tex._texture) {
          const w = tex.width;
          const h = tex.height;
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
            let rS = 0,
              gS = 0,
              bS = 0;
            for (let i = 0; i < buf.length; i += 4) {
              rS += buf[i];
              gS += buf[i + 1];
              bS += buf[i + 2];
            }
            const n = buf.length / 4;
            result.webglSource = {
              width: w,
              height: h,
              pixelMean: [rS / n, gS / n, bS / n],
              samples: [],
              // Note: WebGL readPixels gives row 0 = BOTTOM of texture.
              // If the texture was uploaded with flipY=true, row 0 = PNG bottom.
              readOrigin: "bottom-up",
            };
            const xs = [0, w >> 2, w >> 1, (w * 3) >> 2, w - 1];
            const ys = [0, h >> 2, h >> 1, (h * 3) >> 2, h - 1];
            for (const y of ys)
              for (const x of xs) {
                const idx = (y * w + x) * 4;
                result.webglSource.samples.push({
                  xy: [x, y],
                  rgba: [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]],
                });
              }
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(fb);
        }
      }

      // WebGPU: read `imagery._webgpuMercatorTexture` pixels via copyToBuffer.
      if (targetImagery._webgpuMercatorTexture) {
        const device = v.scene.context._device;
        const gpuTex = targetImagery._webgpuMercatorTexture;
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
        const buf = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          buf.set(
            arr.subarray(y * bytesPerRow, y * bytesPerRow + w * 4),
            y * w * 4,
          );
        }
        stagingBuffer.unmap();
        stagingBuffer.destroy();
        let rS = 0,
          gS = 0,
          bS = 0;
        for (let i = 0; i < buf.length; i += 4) {
          rS += buf[i];
          gS += buf[i + 1];
          bS += buf[i + 2];
        }
        const n = buf.length / 4;
        result.webgpuSource = {
          width: w,
          height: h,
          pixelMean: [rS / n, gS / n, bS / n],
          samples: [],
          readOrigin: "top-down",
        };
        const xs = [0, w >> 2, w >> 1, (w * 3) >> 2, w - 1];
        const ys = [0, h >> 2, h >> 1, (h * 3) >> 2, h - 1];
        for (const y of ys)
          for (const x of xs) {
            const idx = (y * w + x) * 4;
            result.webgpuSource.samples.push({
              xy: [x, y],
              rgba: [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]],
            });
          }
      }
      return result;
    },
    { view: VIEW },
  );

  await browser.close();
  return result;
}

(async () => {
  console.log(
    "[source-mercator-compare] dumping the SOURCE mercator texture pixels",
  );
  console.log();
  const wgl = await dumpSourcePixels("webgl");
  const wgpu = await dumpSourcePixels("webgpu");

  console.log("WebGL  picked imagery:", wgl.imagery);
  console.log("WebGPU picked imagery:", wgpu.imagery);
  console.log();

  if (wgl.webglSource) {
    console.log("=== WebGL imagery.textureWebMercator pixels ===");
    console.log(
      `  size=${wgl.webglSource.width}x${wgl.webglSource.height} read=${wgl.webglSource.readOrigin}`,
    );
    console.log(
      `  mean RGB=[${wgl.webglSource.pixelMean.map((x) => x.toFixed(1)).join(", ")}]`,
    );
  }
  if (wgpu.webgpuSource) {
    console.log("=== WebGPU _webgpuMercatorTexture pixels ===");
    console.log(
      `  size=${wgpu.webgpuSource.width}x${wgpu.webgpuSource.height} read=${wgpu.webgpuSource.readOrigin}`,
    );
    console.log(
      `  mean RGB=[${wgpu.webgpuSource.pixelMean.map((x) => x.toFixed(1)).join(", ")}]`,
    );
  }

  if (wgl.webglSource && wgpu.webgpuSource) {
    console.log();
    console.log("=== Sampled pixels (matched by (x,y)) ===");
    console.log("    Both backends store SOUTH at row 0:");
    console.log("    - WebGL: flipY=true at upload + bottom-up readPixels");
    console.log(
      "    - WebGPU: pre-flipped ImageBitmap + top-down copyToBuffer",
    );
    console.log("    So (x,y) in WGL buf == (x,y) in WGPU buf geographically.");
    for (let i = 0; i < wgl.webglSource.samples.length; i++) {
      const a = wgl.webglSource.samples[i];
      const b = wgpu.webgpuSource.samples.find(
        (s) => s.xy[0] === a.xy[0] && s.xy[1] === a.xy[1],
      );
      if (!b) continue;
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
