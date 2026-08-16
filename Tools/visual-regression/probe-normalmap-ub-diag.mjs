#!/usr/bin/env node
// Probe-normalmap-ub-diag — Batch 138 diagnostic.
// @purpose B138 diagnostic: inspects NormalMap material uniforms + UB gpuData to explain a 16-byte JS allocation vs the 32-byte WGSL expectation.
// @status ACTIVE
//
// Constructs a NormalMap material the same way Batch 135's probe did,
// then inspects material.uniforms keys + material._uniformBuffer.gpuData
// size to figure out exactly why the JS allocates 16 bytes when WGSL
// expects 32 bytes.

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
    ],
  });
  const page = await browser.newPage();
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const diag = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");

    // Path A: Material.fromType (the canonical, well-behaved path).
    const matA = C.Material.fromType("NormalMap", {
      strength: 1.0,
      repeat: { x: 1, y: 1 },
    });

    // Path B: direct constructor with partial uniforms (the path Batch 135's
    // probe used).
    const matB = new C.Material({
      fabric: {
        type: "NormalMap",
        uniforms: {
          image:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
          strength: 1.0,
          repeat: { x: 1, y: 1 },
        },
      },
    });

    function inspect(label, m) {
      return {
        label,
        type: m.type,
        uniformsKeys: Object.keys(m.uniforms),
        templateUniformsKeys: m._template?.uniforms
          ? Object.keys(m._template.uniforms)
          : null,
        templateChannels: m._template?.uniforms?.channels,
        bufferByteLength: m._uniformBuffer?.gpuData?.byteLength,
        bufferTotalFloats: m._uniformBuffer?._totalFloats,
        layoutEntries: m._uniformBuffer?._layout
          ? Array.from(m._uniformBuffer._layout.entries()).map(([k, v]) => ({
              k,
              type: v.type,
              offset: v.offset,
              size: v.size,
            }))
          : null,
        // Show actual byte values to check what the shader will read
        gpuDataFloats: m._uniformBuffer?.gpuData
          ? Array.from(
              new Float32Array(
                m._uniformBuffer.gpuData.buffer,
                m._uniformBuffer.gpuData.byteOffset,
                m._uniformBuffer.gpuData.byteLength / 4,
              ),
            )
          : null,
      };
    }

    return { matA: inspect("fromType", matA), matB: inspect("direct", matB) };
  });

  await browser.close();
  console.log(JSON.stringify(diag, null, 2));
})();
