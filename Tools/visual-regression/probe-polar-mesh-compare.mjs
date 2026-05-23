#!/usr/bin/env node
// Compare polar-tile mesh data + RTE camera encoding between WebGL and
// WebGPU at lat=80, alt=12 Mm. If the mesh vertices are byte-identical
// but the projected screen positions diverge, the drift is downstream
// (RTE math precision, MVP composition, dpdx/dpdy).

import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const VIEW = { lon: 0, lat: 80, height: 12_000_000 };

// Pick a tile near the pole. We'll resolve the actual tile (l, x, y)
// at runtime by finding the lowest-Y tile in tilesToRender.
async function probe(renderer) {
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

  const dump = await page.evaluate(async ({ view }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
    );
    if (wgs84) vm.selectedTerrain = wgs84;
    v.scene.skyAtmosphere.show = false;
    v.scene.globe.showGroundAtmosphere = false;
    v.scene.globe.enableLighting = false;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    });
    for (let i = 0; i < 1500; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 300) break;
    }

    // Find a polar-edge tile (lowest tile.y at lowest level visible).
    const tiles = v.scene._globe._surface._tilesToRender;
    // Pick lowest-Y among the tiles to render (most polar).
    let polarTile = null;
    for (const t of tiles) {
      if (!polarTile) polarTile = t;
      else if (t.y < polarTile.y) polarTile = t;
      else if (t.y === polarTile.y && t.level > polarTile.level) polarTile = t;
    }
    if (!polarTile) return { error: "no tiles" };

    const surfaceTile = polarTile.data;
    const mesh = surfaceTile?.mesh;

    // RTE camera state
    const us = v.scene.context.uniformState;
    const camPosWC = v.camera.positionWC;

    // Project the mesh center to clip-space using the SAME math each
    // backend should: (viewProjection × (center + (0,0,0)))
    const center = mesh?.center;
    let centerProjected = null;
    let viewProjArr = null;
    if (us.viewProjection) {
      // CesiumJS Matrix4 stores in column-major order; index 0..15.
      viewProjArr = [];
      for (let i = 0; i < 16; i++) viewProjArr.push(us.viewProjection[i]);
    }
    if (center && viewProjArr) {
      const m = viewProjArr;
      const wx =
        m[0] * center.x + m[4] * center.y + m[8] * center.z + m[12];
      const wy =
        m[1] * center.x + m[5] * center.y + m[9] * center.z + m[13];
      const wz =
        m[2] * center.x + m[6] * center.y + m[10] * center.z + m[14];
      const ww =
        m[3] * center.x + m[7] * center.y + m[11] * center.z + m[15];
      centerProjected = [wx, wy, wz, ww, wx / ww, wy / ww, wz / ww];
    }

    // Pull a small vertex sample (first 4 vertices, last 4 vertices,
    // 4 vertices near the middle).
    let vSample = null;
    if (mesh?.vertices && mesh?.encoding) {
      const verts = mesh.vertices;
      const stride = mesh.encoding.stride ?? mesh.encoding.getStride?.();
      const numV = (verts.length / stride) | 0;
      const pick = [
        0,
        1,
        2,
        3,
        numV >> 1,
        (numV >> 1) + 1,
        numV - 4,
        numV - 3,
        numV - 2,
        numV - 1,
      ];
      vSample = pick
        .filter((i) => i >= 0 && i < numV)
        .map((i) => Array.from(verts.subarray(i * stride, (i + 1) * stride)));
    }

    const camHigh = us.encodedCameraPositionMCHigh;
    const camLow = us.encodedCameraPositionMCLow;

    return {
      polarTile: { l: polarTile.level, x: polarTile.x, y: polarTile.y },
      tileCount: tiles.length,
      meshCenter: center
        ? [center.x, center.y, center.z]
        : null,
      meshVertexCount: mesh?.vertices?.length,
      meshStride: mesh?.encoding?.stride,
      meshHasNormals: mesh?.encoding?.hasVertexNormals,
      meshHasWebMercT: mesh?.encoding?.hasWebMercatorT,
      meshQuantization: mesh?.encoding?.quantization,
      centerProjected,
      vertexSample: vSample,
      camPosWC: [camPosWC.x, camPosWC.y, camPosWC.z],
      camHigh: camHigh ? [camHigh.x, camHigh.y, camHigh.z] : null,
      camLow: camLow ? [camLow.x, camLow.y, camLow.z] : null,
      viewProjFirstRow: viewProjArr ? viewProjArr.slice(0, 4) : null,
      viewProjAll: viewProjArr,
    };
  }, { view: VIEW });

  await browser.close();
  return dump;
}

(async () => {
  const wgl = await probe("webgl");
  const wgpu = await probe("webgpu");

  console.log("=== Polar tile (lat 80 / alt 12 Mm) ===");
  console.log("WebGL  polar tile:", wgl.polarTile, " tiles in view:", wgl.tileCount);
  console.log("WebGPU polar tile:", wgpu.polarTile, " tiles in view:", wgpu.tileCount);
  console.log();

  console.log("=== Mesh center ===");
  console.log("WebGL :", wgl.meshCenter);
  console.log("WebGPU:", wgpu.meshCenter);
  if (wgl.meshCenter && wgpu.meshCenter) {
    const d = wgl.meshCenter.map((x, i) => x - wgpu.meshCenter[i]);
    const mag = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
    console.log("Δ:", d.map((x) => x.toExponential(2)), "magnitude:", mag.toFixed(6), "m");
  }
  console.log();

  console.log("=== Mesh metadata ===");
  console.log(
    `WebGL : verts=${wgl.meshVertexCount} stride=${wgl.meshStride} norm=${wgl.meshHasNormals} wmt=${wgl.meshHasWebMercT} quant=${wgl.meshQuantization}`,
  );
  console.log(
    `WebGPU: verts=${wgpu.meshVertexCount} stride=${wgpu.meshStride} norm=${wgpu.meshHasNormals} wmt=${wgpu.meshHasWebMercT} quant=${wgpu.meshQuantization}`,
  );
  console.log();

  console.log("=== Vertex sample (first 4, mid 2, last 4) ===");
  if (wgl.vertexSample && wgpu.vertexSample) {
    let identical = true;
    for (let i = 0; i < wgl.vertexSample.length; i++) {
      const a = wgl.vertexSample[i];
      const b = wgpu.vertexSample[i];
      if (!a || !b) continue;
      for (let j = 0; j < Math.min(a.length, b.length); j++) {
        if (a[j] !== b[j]) {
          identical = false;
          console.log(`  Δ vtx[${i}].${j}: WGL=${a[j]} WGPU=${b[j]}`);
        }
      }
    }
    console.log(identical ? "  All sampled vertex bytes IDENTICAL" : "  Vertex data DIFFERS (see diffs above)");
  }
  console.log();

  console.log("=== RTE camera ===");
  console.log("WGL  posWC:", wgl.camPosWC);
  console.log("WGPU posWC:", wgpu.camPosWC);
  if (wgl.camHigh) {
    console.log("WGL  encodedCameraHigh:", wgl.camHigh);
    console.log("WGL  encodedCameraLow :", wgl.camLow);
    console.log("WGPU encodedCameraHigh:", wgpu.camHigh);
    console.log("WGPU encodedCameraLow :", wgpu.camLow);
  }
  console.log();

  console.log("=== viewProjection first row ===");
  console.log("WGL :", wgl.viewProjFirstRow);
  console.log("WGPU:", wgpu.viewProjFirstRow);
  if (wgl.viewProjFirstRow && wgpu.viewProjFirstRow) {
    const d = wgl.viewProjFirstRow.map((x, i) => x - wgpu.viewProjFirstRow[i]);
    console.log("Δ:", d.map((x) => x.toExponential(3)));
  }
  console.log();

  console.log("=== Mesh center projected to clip space ===");
  console.log("WGL  [x,y,z,w, x/w,y/w,z/w]:", wgl.centerProjected);
  console.log("WGPU [x,y,z,w, x/w,y/w,z/w]:", wgpu.centerProjected);
})();
