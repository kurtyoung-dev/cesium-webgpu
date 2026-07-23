/**
 * Installs the browser-side cloud probe helper. The function is deliberately
 * self-contained so Playwright can inject it with `page.addInitScript`.
 *
 * Cloud volumetric configuration moved off `Globe` during cloud unification.
 * Probes must configure `globe.defaultCloudCollection.volumetric` directly and
 * verify that every requested value survived the round trip.
 */
export function installCloudProbeHarness() {
  const root = globalThis;

  const valuesEqual = (actual, expected) => {
    if (
      expected !== null &&
      typeof expected === "object" &&
      !Array.isArray(expected)
    ) {
      return Object.keys(expected).every((key) =>
        valuesEqual(actual?.[key], expected[key]),
      );
    }
    return Object.is(actual, expected);
  };

  const snapshotValue = (value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return Object.fromEntries(
        Object.keys(value).map((key) => [key, snapshotValue(value[key])]),
      );
    }
    return value;
  };

  root.__cloudProbe = Object.freeze({
    configure(options = {}) {
      const viewer = root.viewer;
      if (!viewer?.scene?.globe?.defaultCloudCollection) {
        throw new Error(
          "cloud probe requires viewer.scene.globe.defaultCloudCollection",
        );
      }

      const scene = viewer.scene;
      const context = scene.context;
      const rendererType = String(
        context?.rendererType ?? (context?.isWebGPU ? "webgpu" : "webgl"),
      ).toLowerCase();
      const errors = [];

      scene.requestRenderMode = false;
      const collection = scene.globe.defaultCloudCollection;
      const volumetric = collection.volumetric;
      const requested = options.volumetric ?? {};

      for (const [key, value] of Object.entries(requested)) {
        if (!(key in volumetric)) {
          errors.push(`unknown CloudVolumetrics property ${key}`);
          continue;
        }
        volumetric[key] = value;
      }
      collection.enableVolumetric = options.enableVolumetric !== false;

      if (scene.requestRenderMode !== false) {
        errors.push("scene.requestRenderMode did not stay false");
      }
      if (options.requireWebGPU === true && rendererType !== "webgpu") {
        errors.push(`expected WebGPU, resolved ${String(rendererType)}`);
      }
      if (
        collection.enableVolumetric !==
        (options.enableVolumetric !== false)
      ) {
        errors.push(
          `enableVolumetric round trip failed: ${String(
            collection.enableVolumetric,
          )}`,
        );
      }

      const config = {};
      for (const [key, expected] of Object.entries(requested)) {
        if (!(key in volumetric)) {
          continue;
        }
        const actual = volumetric[key];
        config[key] = snapshotValue(actual);
        if (!valuesEqual(actual, expected)) {
          errors.push(
            `${key} round trip failed: expected ${JSON.stringify(
              expected,
            )}, received ${JSON.stringify(actual)}`,
          );
        }
      }

      const truth = {
        ok: errors.length === 0,
        errors,
        rendererType,
        isWebGPU: context?.isWebGPU === true,
        requestRenderMode: scene.requestRenderMode,
        enableVolumetric: collection.enableVolumetric,
        renderMode: collection.renderMode,
        config,
      };
      if (!truth.ok) {
        throw new Error(`cloud probe configuration failed: ${errors.join("; ")}`);
      }
      return truth;
    },
  });
}

/** Inject the browser helper before the application loads. */
export async function installCloudProbeHarnessOnPage(page) {
  await page.addInitScript(installCloudProbeHarness);
}
