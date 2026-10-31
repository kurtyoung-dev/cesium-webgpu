// landing-cell-stage-support.mjs - shared fixtures for the landing-cell-stage spec parts.
// @purpose Spec support for landing-cell-stage: the fake Cesium module and its data URL, the fake viewer, the stage module path, and the ocean, kernel and scene-mode facades that more than one landing-cell-stage spec part drives.
// @status ACTIVE
//
// Moved verbatim out of landing-cell-stage.spec.mjs when that spec was split by concern (row
// DX-KIT-LANDING-SPECS-OVER-SIZE); only the `export` keywords and the stage module's relative path (one
// directory up from here) are new.

import { fileURLToPath } from "node:url";
import { landingStagePayload } from "../lib/landing-cell-stage.mjs";

export const FAKE_CESIUM_MODULE_SOURCE = `
export class JulianDate {
  constructor(iso) {
    this.iso = iso;
  }
  static fromIso8601(iso) {
    return new JulianDate(iso);
  }
  static toIso8601(jd) {
    return jd ? jd.iso : "2026-06-21T00:00:00Z";
  }
}

export class Color {
  constructor(css) {
    this.css = css;
  }
  static fromCssColorString(css) {
    return new Color(css);
  }
  toCssColorString() {
    return this.css;
  }
  equals(other) {
    return other != null && this.css === other.css;
  }
}

export class Cartesian3 {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static fromDegrees(lon, lat, height) {
    return new Cartesian3(lon, lat, height);
  }
}

export const Math = {
  toDegrees(rad) {
    return rad * (180 / globalThis.Math.PI);
  },
};

export class EllipsoidTerrainProvider {}

export class Material {
  static fromType(type) {
    return { type };
  }
}

export class TileMapServiceImageryProvider {
  static async fromUrl(url) {
    return { url };
  }
}
`;

export const FAKE_CESIUM_URL =
  "data:text/javascript," + encodeURIComponent(FAKE_CESIUM_MODULE_SOURCE);

export function createFakeViewer(overrides = {}) {
  const imageryLayers = overrides.imageryLayers ?? [{ id: "base-layer" }];
  return {
    useDefaultRenderLoop: true,
    clock: {
      shouldAnimate: true,
      currentTime: { iso: "2026-06-21T00:00:00Z" },
    },
    scene: {
      context: { rendererType: "webgpu", isWebGPU: true },
      requestRenderMode: true,
      highDynamicRange: false,
      msaaSamples: 1,
      backgroundColor: null,
      skyBox: { show: false },
      skyAtmosphere: { show: false, multipleScattering: false },
      sun: { show: false },
      moon: { show: false },
      screenSpaceCameraController: { enableInputs: false },
      imageryLayers: {
        _layers: imageryLayers,
        get length() {
          return this._layers.length;
        },
        removeAll() {
          this._layers = [];
        },
        addImageryProvider(provider) {
          this._layers.push(provider);
        },
      },
      globe: {
        enableLighting: false,
        showWaterEffect: false,
        showGroundAtmosphere: false,
        baseColor: null,
        terrainProvider: null,
        material: undefined,
        globalWaterMask: false,
        lakeWaterMask: false,
        riverWaterMask: false,
        enableEnhancedOcean: false,
        water: { qualityPreset: "LOW" },
        defaultCloudCollection: { enableVolumetric: true },
      },
    },
    camera: {
      setView(opts) {
        this.lastSetView = opts;
      },
      positionCartographic: {
        longitude: 0.17453292519943295,
        latitude: 0.3490658503988659,
        height: 300,
      },
    },
  };
}

export const STAGE_MODULE = fileURLToPath(
  new URL("../lib/landing-cell-stage.mjs", import.meta.url),
);

// An ocean facade shaped like Scene/GlobeWaterOcean.js: setting `enabled`
// true builds one primitive and adds it to scene.primitives, false removes it.
// `build: false` is a facade that keeps the flag but builds nothing.
export function fftOcean(scene, { build = true } = {}) {
  return {
    _enabled: false,
    _primitive: undefined,
    get enabled() {
      return this._enabled;
    },
    set enabled(value) {
      value = value === true;
      if (value === this._enabled) {
        return;
      }
      this._enabled = value;
      if (value && build) {
        this._primitive = { kind: "OceanSurfacePrimitive" };
        scene.primitives.push(this._primitive);
      } else if (!value && this._primitive) {
        scene.primitives.splice(scene.primitives.indexOf(this._primitive), 1);
        this._primitive = undefined;
      }
    },
    get primitive() {
      return this._primitive;
    },
  };
}

export function oceanViewer(options) {
  const viewer = createFakeViewer();
  viewer.scene.primitives = [];
  viewer.scene.globe.show = true;
  viewer.scene.enableSSR = false;
  viewer.scene.deferredLighting = false;
  viewer.scene.globe.water = {
    qualityPreset: "LOW",
    ocean: fftOcean(viewer.scene, options),
  };
  return viewer;
}

export const FAKE_SCENE_MODE_SOURCE =
  FAKE_CESIUM_MODULE_SOURCE +
  `
export const SceneMode = Object.freeze({
  MORPHING: 0,
  COLUMBUS_VIEW: 1,
  SCENE2D: 2,
  SCENE3D: 3,
  getMorphTime() {
    return 0;
  },
});
`;
export const FAKE_SCENE_MODE_URL =
  "data:text/javascript," + encodeURIComponent(FAKE_SCENE_MODE_SOURCE);

// A facade shaped like Scene/GlobeWaterOcean.js: the kernel setter accepts the
// two names only and forwards to the primitive; the primitive is created with
// the facade's kernel. `forward: false` is a facade that forgets to forward.
export function kernelOcean(scene, { forward = true } = {}) {
  return {
    _enabled: false,
    _ifftKernel: "stockham",
    _primitive: undefined,
    get enabled() {
      return this._enabled;
    },
    set enabled(value) {
      value = value === true;
      if (value === this._enabled) {
        return;
      }
      this._enabled = value;
      if (value) {
        this._primitive = { ifftKernel: this._ifftKernel };
        scene.primitives.push(this._primitive);
      } else if (this._primitive) {
        scene.primitives.splice(scene.primitives.indexOf(this._primitive), 1);
        this._primitive = undefined;
      }
    },
    get primitive() {
      return this._primitive;
    },
    get ifftKernel() {
      return this._ifftKernel;
    },
    set ifftKernel(value) {
      if (value === "stockham" || value === "pingpong") {
        this._ifftKernel = value;
        if (forward && this._primitive) {
          this._primitive.ifftKernel = value;
        }
      }
    },
  };
}

export function kernelViewer(options) {
  const viewer = oceanViewer();
  viewer.scene.globe.water.ocean = kernelOcean(viewer.scene, options);
  return viewer;
}

export function kernelPayload(dials, moduleUrl = FAKE_CESIUM_URL) {
  return {
    ...landingStagePayload({
      id: "test-s9-kernel",
      camera: null,
      clock: null,
      dials,
    }),
    moduleUrl,
  };
}

// A scene whose morphTo* methods change `mode` like a duration-0 morph does.
// `morphs: false` leaves the mode alone; `throws` makes the morph throw.
export function sceneModeViewer({ morphs = true, throws = null } = {}) {
  const viewer = oceanViewer();
  const scene = viewer.scene;
  scene.mode = 3;
  const morphTo = (mode) => () => {
    if (throws) {
      throw new Error(throws);
    }
    if (morphs) {
      scene.mode = mode;
    }
  };
  scene.morphTo3D = morphTo(3);
  scene.morphTo2D = morphTo(2);
  scene.morphToColumbusView = morphTo(1);
  return viewer;
}
