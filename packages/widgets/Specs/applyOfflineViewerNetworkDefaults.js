/**
 * Removes only implicit network-backed Viewer defaults in the offline spec
 * lane. Explicit test inputs are preserved so provider behavior remains under
 * each spec's control, and the online lane remains production-equivalent.
 *
 * @param {object} options Viewer constructor options owned by the spec helper.
 * @param {boolean} offline Whether the deterministic offline lane is active.
 * @returns {object} The same options object after any offline defaults.
 */
export default function applyOfflineViewerNetworkDefaults(options, offline) {
  if (offline !== true || options.globe === false) {
    return options;
  }

  if (options.baseLayerPicker === false) {
    if (
      options.baseLayer === undefined &&
      options.imageryProvider === undefined
    ) {
      options.baseLayer = false;
    }
    return options;
  }

  if (
    options.imageryProviderViewModels === undefined &&
    options.selectedImageryProviderViewModel === undefined
  ) {
    options.imageryProviderViewModels = [];
  }

  // Viewer constructs CesiumWidget before BaseLayerPicker. Even an explicit
  // picker roster cannot prevent CesiumWidget from creating World Imagery
  // until its first model is selected, so suppress the initial layer whenever
  // there is no explicit selection or other base imagery input.
  if (
    options.selectedImageryProviderViewModel === undefined &&
    options.baseLayer === undefined &&
    options.imageryProvider === undefined
  ) {
    options.baseLayer = false;
  }

  return options;
}
