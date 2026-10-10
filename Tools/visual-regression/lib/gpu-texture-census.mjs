/**
 * GPU texture census for Playwright probes: counts, per texture label, how many
 * textures a page created and how many it destroyed.
 * @purpose Page init script that wraps GPUDevice.createTexture and GPUTexture.destroy to count created and destroyed textures per label without holding a reference to any texture, plus the Node-side reader and the pure summary a probe records.
 * @status ACTIVE
 *
 * WHY. A texture that is never destroyed is invisible in a frame: the page
 * renders correctly and the GPU memory grows until the garbage collector, or
 * never. A resource-lifetime fix therefore cannot be proven by a capture alone.
 * Counting `createTexture` and `destroy()` per label in the page makes the
 * lifetime observable on the real browser and the real device, so a BEFORE and
 * AFTER run of the same probe differ in a number rather than in nothing.
 *
 * WHAT IT DOES NOT DO. It keeps no reference to a texture (a census that held
 * every texture would keep each one alive and change the memory it measures);
 * a `WeakSet` remembers which textures were already counted as destroyed so a
 * second `destroy()` on the same texture is reported as a repeat, not counted
 * twice. A texture the page drops without `destroy()` stays "live" here even
 * after the collector reclaims it, which is exactly the condition measured.
 *
 * USAGE.
 *   await page.addInitScript(gpuTextureCensusInit); // before page.goto
 *   ... drive the page ...
 *   const census = await readGpuTextureCensus(page);
 *   const row = summarizeTextureCensus(census, "CubeMapPanorama-cubemap");
 *
 * @module Tools/visual-regression/lib/gpu-texture-census
 */

/**
 * Page-context initializer. Pass to `page.addInitScript`. Self-contained: it
 * runs in the browser with no Node scope. A page without WebGPU gets an empty
 * census with `installed: false`.
 */
export function gpuTextureCensusInit() {
  const w = /** @type {any} */ (globalThis);
  if (w.__gpuTextureCensus) {
    return;
  }
  const census = { installed: false, byLabel: {}, repeatedDestroys: 0 };
  w.__gpuTextureCensus = census;
  const DeviceProto = w.GPUDevice && w.GPUDevice.prototype;
  const TextureProto = w.GPUTexture && w.GPUTexture.prototype;
  if (!DeviceProto || !TextureProto) {
    return;
  }
  const labelOf = new WeakMap();
  const destroyed = new WeakSet();
  const rowFor = (label) => {
    if (!census.byLabel[label]) {
      census.byLabel[label] = { created: 0, destroyed: 0 };
    }
    return census.byLabel[label];
  };
  const createTexture = DeviceProto.createTexture;
  DeviceProto.createTexture = function (descriptor) {
    const texture = createTexture.call(this, descriptor);
    const label =
      descriptor && typeof descriptor.label === "string"
        ? descriptor.label
        : "(unlabelled)";
    labelOf.set(texture, label);
    rowFor(label).created++;
    return texture;
  };
  const destroy = TextureProto.destroy;
  TextureProto.destroy = function () {
    if (destroyed.has(this)) {
      census.repeatedDestroys++;
    } else if (labelOf.has(this)) {
      destroyed.add(this);
      rowFor(labelOf.get(this)).destroyed++;
    }
    return destroy.call(this);
  };
  census.installed = true;
}

/**
 * Read the census from the page.
 *
 * @param {{evaluate: Function}} page A Playwright page.
 * @returns {Promise<{installed: boolean, byLabel: Object<string, {created: number, destroyed: number}>, repeatedDestroys: number}>}
 */
export async function readGpuTextureCensus(page) {
  return await page.evaluate(() => {
    const census = /** @type {any} */ (globalThis).__gpuTextureCensus;
    return census
      ? JSON.parse(JSON.stringify(census))
      : { installed: false, byLabel: {}, repeatedDestroys: 0 };
  });
}

/**
 * One label's row: created, destroyed and the difference, which is the number
 * of textures under that label still undestroyed when the census was read.
 * Pure, so a spec drives it without a browser.
 *
 * @param {{byLabel?: Object<string, {created: number, destroyed: number}>}} census
 * @param {string} label The texture label, exactly as the engine sets it.
 * @returns {{label: string, created: number, destroyed: number, live: number}}
 */
export function summarizeTextureCensus(census, label) {
  const row = census?.byLabel?.[label] ?? { created: 0, destroyed: 0 };
  const created = Number.isFinite(row.created) ? row.created : 0;
  const destroyed = Number.isFinite(row.destroyed) ? row.destroyed : 0;
  return { label, created, destroyed, live: created - destroyed };
}
