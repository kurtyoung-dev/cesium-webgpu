/**
 * Swap both viewers to the WGS84 EllipsoidTerrainProvider (no real
 * terrain — pure ellipsoid). Lets the capture-and-diff suite cover
 * the Batch 56 mesh-pattern regression case.
 *
 * Called as `new Function("params", src)(params)` from
 * `capture-and-diff.mjs`'s `applyScene`. Returns a promise that
 * resolves once both viewers have replaced their terrain provider
 * AND rendered at least one settled frame on it.
 */

const Cesium = window.Cesium;

function swap(viewer) {
  if (!viewer) return;
  const blp = viewer.baseLayerPicker;
  if (!blp) return;
  const vm = blp.viewModel;
  const wgs84 = vm.terrainProviderViewModels.find((t) =>
    String(t.name || "")
      .toLowerCase()
      .includes("wgs84"),
  );
  if (wgs84) {
    vm.selectedTerrain = wgs84;
  }
}

swap(window.webglViewer);
swap(window.webgpuViewer);

// Drive both viewers for a settle window — terrain provider swap
// invalidates the tile cache and the first 60-200 frames are spent
// re-loading. capture-and-diff's settleFrames gate doesn't account
// for this so we wait inline.
return new Promise((resolve) => {
  let n = 0;
  function tick() {
    n++;
    if (window.webglViewer) window.webglViewer.scene.requestRender();
    if (window.webgpuViewer) window.webgpuViewer.scene.requestRender();
    const wglReady =
      !window.webglViewer ||
      window.webglViewer.scene.globe.tilesLoaded ||
      n > 400;
    const wgpuReady =
      !window.webgpuViewer ||
      window.webgpuViewer.scene.globe.tilesLoaded ||
      n > 400;
    if (wglReady && wgpuReady && n > 60) {
      resolve();
    } else {
      requestAnimationFrame(tick);
    }
  }
  tick();
});
