/**
 * Light-source classes and collection packing for scene lighting.
 *
 * {@link LightCollection} stores up to eight directional, point, spot, or area
 * lights. Its uniform pack contains enabled punctual lights in the layout
 * consumed by `LightUniforms.wgsl`. Rectangular and disk area lights bypass
 * that uniform and use the WebGPU clustered-lighting storage path.
 *
 * @module Light
 */

import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import CesiumMath from "../Core/Math.js";

/**
 * The type of a light source. Maps to the `lightType` field in WGSL shaders.
 * @enum {number}
 */
const LightType = Object.freeze({
  /** Parallel rays from infinitely far away (e.g., sun). */
  DIRECTIONAL: 0,
  /** Omni-directional point source (e.g., light bulb). */
  POINT: 1,
  /** Cone-shaped light (e.g., flashlight). */
  SPOT: 2,
  /**
   * Rectangular analytic area light evaluated with LTC by WebGPU Model PBR.
   * {@link LightCollection#pack} skips area lights because the punctual
   * uniform layout does not accept this record type.
   */
  RECT_AREA: 3,
  /** Elliptical/disk analytic area light (LTC — WebGPU only). */
  DISK_AREA: 4,
});

export { LightType };

/**
 * Base class for all light types in CesiumJS.
 * Provides shared properties: color, intensity, enabled state.
 */
export class Light {
  /**
   * The color of the light.
   * @type {Color}
   * @default Color.WHITE
   */
  color: CesiumColor;

  /**
   * The intensity multiplier for the light.
   * @type {number}
   * @default 1.0
   */
  intensity: number;

  /**
   * Whether this light is active. Disabled lights are skipped during rendering.
   * @type {boolean}
   * @default true
   */
  enabled: boolean;

  /**
   * The type of this light (DIRECTIONAL, POINT, or SPOT).
   * @type {number}
   * @readonly
   */
  readonly lightType: number;

  constructor(options: {
    color?: CesiumColor;
    intensity?: number;
    enabled?: boolean;
    lightType: number;
  }) {
    this.color = Color.clone(options.color ?? Color.WHITE);
    this.intensity = options.intensity ?? 1.0;
    this.enabled = options.enabled ?? true;
    this.lightType = options.lightType;
  }
}

/**
 * A directional light source (e.g., sun, moon).
 * Emits parallel rays from a direction — no position or attenuation.
 *
 * @example
 * const sunLight = new DirectionalLight({
 *   direction: new Cartesian3(-0.5, -0.5, -0.7),
 *   color: Color.WHITE,
 *   intensity: 1.0,
 * });
 */
export class DirectionalLight extends Light {
  /**
   * The direction the light is shining. Will be normalized.
   * @type {Cartesian3}
   */
  direction: CesiumCartesian3;

  constructor(options?: {
    direction?: CesiumCartesian3;
    color?: CesiumColor;
    intensity?: number;
    enabled?: boolean;
  }) {
    const opts = options ?? {};
    super({
      color: opts.color,
      intensity: opts.intensity,
      enabled: opts.enabled,
      lightType: LightType.DIRECTIONAL,
    });

    this.direction = Cartesian3.clone(
      opts.direction ?? new Cartesian3(0.0, 0.0, -1.0),
    );
    Cartesian3.normalize(this.direction, this.direction);
  }
}

/**
 * A point light source (e.g., light bulb, street lamp).
 * Emits light in all directions from a position with distance attenuation.
 *
 * @example
 * const streetLight = new PointLight({
 *   position: Cartesian3.fromDegrees(-75.0, 40.0, 10.0),
 *   color: Color.YELLOW,
 *   intensity: 5.0,
 *   range: 200.0,
 * });
 */
export class PointLight extends Light {
  /**
   * The world-space position of the light.
   * @type {Cartesian3}
   */
  position: CesiumCartesian3;

  /**
   * Maximum range of the light in meters. Beyond this distance,
   * the light has no effect. 0 means infinite range.
   * @type {number}
   * @default 0.0
   */
  range: number;

  /**
   * Constant attenuation factor.
   * @type {number}
   * @default 1.0
   */
  constantAttenuation: number;

  /**
   * Linear attenuation factor.
   * @type {number}
   * @default 0.09
   */
  linearAttenuation: number;

  /**
   * Quadratic attenuation factor.
   * @type {number}
   * @default 0.032
   */
  quadraticAttenuation: number;

  constructor(options?: {
    position?: CesiumCartesian3;
    color?: CesiumColor;
    intensity?: number;
    range?: number;
    constantAttenuation?: number;
    linearAttenuation?: number;
    quadraticAttenuation?: number;
    enabled?: boolean;
  }) {
    const opts = options ?? {};
    super({
      color: opts.color,
      intensity: opts.intensity,
      enabled: opts.enabled,
      lightType: LightType.POINT,
    });

    this.position = Cartesian3.clone(opts.position ?? Cartesian3.ZERO);
    this.range = opts.range ?? 0.0;
    this.constantAttenuation = opts.constantAttenuation ?? 1.0;
    this.linearAttenuation = opts.linearAttenuation ?? 0.09;
    this.quadraticAttenuation = opts.quadraticAttenuation ?? 0.032;
  }
}

/**
 * A spot light source (e.g., flashlight, headlight).
 * Emits light in a cone from a position in a direction.
 *
 * @example
 * const flashlight = new SpotLight({
 *   position: Cartesian3.fromDegrees(-75.0, 40.0, 2.0),
 *   direction: new Cartesian3(0, 0, -1),
 *   color: Color.WHITE,
 *   intensity: 10.0,
 *   innerConeAngle: CesiumMath.toRadians(15),
 *   outerConeAngle: CesiumMath.toRadians(30),
 *   range: 100.0,
 * });
 */
export class SpotLight extends Light {
  /**
   * The world-space position of the spot light.
   * @type {Cartesian3}
   */
  position: CesiumCartesian3;

  /**
   * The direction the spot light is pointing. Will be normalized.
   * @type {Cartesian3}
   */
  direction: CesiumCartesian3;

  /**
   * Inner cone angle in radians (full-intensity cone).
   * @type {number}
   * @default CesiumMath.toRadians(15)
   */
  innerConeAngle: number;

  /**
   * Outer cone angle in radians (falloff edge).
   * @type {number}
   * @default CesiumMath.toRadians(30)
   */
  outerConeAngle: number;

  /**
   * Maximum range of the light in meters. 0 means infinite.
   * @type {number}
   * @default 0.0
   */
  range: number;

  constructor(options?: {
    position?: CesiumCartesian3;
    direction?: CesiumCartesian3;
    color?: CesiumColor;
    intensity?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
    range?: number;
    enabled?: boolean;
  }) {
    const opts = options ?? {};
    super({
      color: opts.color,
      intensity: opts.intensity,
      enabled: opts.enabled,
      lightType: LightType.SPOT,
    });

    this.position = Cartesian3.clone(opts.position ?? Cartesian3.ZERO);
    this.direction = Cartesian3.clone(
      opts.direction ?? new Cartesian3(0.0, 0.0, -1.0),
    );
    Cartesian3.normalize(this.direction, this.direction);

    this.innerConeAngle = opts.innerConeAngle ?? CesiumMath.toRadians(15.0);
    this.outerConeAngle = opts.outerConeAngle ?? CesiumMath.toRadians(30.0);
    this.range = opts.range ?? 0.0;
  }
}

/**
 * A rectangular analytic area light shaded with Linearly Transformed
 * Cosines (Heitz et al., SIGGRAPH 2016). The finite emitter produces smooth
 * angular falloff without allocating or sampling a shadow map.
 *
 * The WebGPU Model PBR path evaluates area lights when clustered lighting is
 * enabled; clustered lighting is disabled by default. WebGPU lit primitives and
 * WebGL renderers ignore area lights. With no active area lights, the fragment
 * shader returns before reading the LTC texture or area-light buffer.
 *
 * The rectangle is centered at `position`, faces `direction` (its normal),
 * with `up` giving the local +Y (height) axis; the +X (width) axis is
 * `cross(direction, up)`. `width`/`height` are the full edge lengths in
 * meters. `intensity` is emitter radiance (nits-like); there is no
 * inverse-square attenuation; falloff emerges from the shrinking solid
 * angle, matching the LTC radiometry.
 *
 * @example
 * scene.clusteredLightingEnabled = true;
 * scene.lights.add(new Cesium.RectAreaLight({
 *   position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 30.0),
 *   direction: new Cesium.Cartesian3(0, 0, -1),
 *   up: new Cesium.Cartesian3(0, 1, 0),
 *   width: 8.0,
 *   height: 4.0,
 *   color: Cesium.Color.WHITE,
 *   intensity: 4.0,
 * }));
 */
export class RectAreaLight extends Light {
  /** World-space center of the rectangle. */
  position: CesiumCartesian3;
  /** Emitter normal (the direction it faces). Normalized. */
  direction: CesiumCartesian3;
  /** Local up axis (height direction). Normalized. */
  up: CesiumCartesian3;
  /** Full width of the rectangle in meters (along cross(direction, up)). */
  width: number;
  /** Full height of the rectangle in meters (along up). */
  height: number;
  /**
   * When true the rectangle emits from both faces; when false only the
   * front face (points behind the emitter plane receive nothing).
   * @default false
   */
  twoSided: boolean;
  /**
   * Cull radius in meters. Fragments farther than this from the emitter
   * center are skipped (0 = never cull). Purely an optimization — does
   * not attenuate intensity.
   * @default 0.0
   */
  range: number;

  constructor(options?: {
    position?: CesiumCartesian3;
    direction?: CesiumCartesian3;
    up?: CesiumCartesian3;
    width?: number;
    height?: number;
    twoSided?: boolean;
    range?: number;
    color?: CesiumColor;
    intensity?: number;
    enabled?: boolean;
  }) {
    const opts = options ?? {};
    super({
      color: opts.color,
      intensity: opts.intensity,
      enabled: opts.enabled,
      lightType: LightType.RECT_AREA,
    });
    this.position = Cartesian3.clone(opts.position ?? Cartesian3.ZERO);
    this.direction = Cartesian3.clone(
      opts.direction ?? new Cartesian3(0.0, 0.0, -1.0),
    );
    Cartesian3.normalize(this.direction, this.direction);
    this.up = Cartesian3.clone(opts.up ?? new Cartesian3(0.0, 1.0, 0.0));
    Cartesian3.normalize(this.up, this.up);
    this.width = Math.max(opts.width ?? 1.0, 1e-3);
    this.height = Math.max(opts.height ?? 1.0, 1e-3);
    this.twoSided = opts.twoSided ?? false;
    this.range = opts.range ?? 0.0;
  }
}

/**
 * An elliptical (disk) analytic area light shaded with Linearly
 * Transformed Cosines. It uses the same backend and feature gate as
 * {@link RectAreaLight}; the emitter is an ellipse of radii
 * `radiusX` (along cross(direction, up)) and `radiusY` (along up).
 * A circular disk uses `radiusX === radiusY`.
 *
 * @example
 * scene.lights.add(new Cesium.DiskAreaLight({
 *   position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 20.0),
 *   direction: new Cesium.Cartesian3(0, 0, -1),
 *   radiusX: 3.0,
 *   radiusY: 3.0,
 *   intensity: 6.0,
 * }));
 */
export class DiskAreaLight extends Light {
  /** World-space center of the disk. */
  position: CesiumCartesian3;
  /** Emitter normal (the direction it faces). Normalized. */
  direction: CesiumCartesian3;
  /** Local up axis (radiusY direction). Normalized. */
  up: CesiumCartesian3;
  /** Ellipse radius in meters along cross(direction, up). */
  radiusX: number;
  /** Ellipse radius in meters along up. */
  radiusY: number;
  /** @default false */
  twoSided: boolean;
  /** Cull radius in meters (0 = never cull). Optimization only. @default 0.0 */
  range: number;

  constructor(options?: {
    position?: CesiumCartesian3;
    direction?: CesiumCartesian3;
    up?: CesiumCartesian3;
    radiusX?: number;
    radiusY?: number;
    twoSided?: boolean;
    range?: number;
    color?: CesiumColor;
    intensity?: number;
    enabled?: boolean;
  }) {
    const opts = options ?? {};
    super({
      color: opts.color,
      intensity: opts.intensity,
      enabled: opts.enabled,
      lightType: LightType.DISK_AREA,
    });
    this.position = Cartesian3.clone(opts.position ?? Cartesian3.ZERO);
    this.direction = Cartesian3.clone(
      opts.direction ?? new Cartesian3(0.0, 0.0, -1.0),
    );
    Cartesian3.normalize(this.direction, this.direction);
    this.up = Cartesian3.clone(opts.up ?? new Cartesian3(0.0, 1.0, 0.0));
    Cartesian3.normalize(this.up, this.up);
    this.radiusX = Math.max(opts.radiusX ?? 1.0, 1e-3);
    this.radiusY = Math.max(opts.radiusY ?? 1.0, 1e-3);
    this.twoSided = opts.twoSided ?? false;
    this.range = opts.range ?? 0.0;
  }
}

/** Maximum number of lights supported in the uniform buffer. */
const MAX_LIGHTS = 8;

/**
 * A collection of lights that can be attached to a Scene.
 * Manages the list of active lights and provides data for the
 * GPU uniform buffer.
 *
 * @example
 * const lights = new LightCollection();
 * lights.add(new DirectionalLight({ direction: sunDir }));
 * lights.add(new PointLight({ position: lampPos, range: 50 }));
 * scene.lights = lights;
 */
export class LightCollection {
  private _lights: Light[] = [];
  private _dirty: boolean = true;

  /** Maximum number of simultaneous lights. */
  static readonly MAX_LIGHTS = MAX_LIGHTS;

  /**
   * Add a light to the collection.
   * @param light - The light to add
   * @returns The added light
   */
  add(light: Light): Light {
    if (this._lights.length >= MAX_LIGHTS) {
      throw new Error(
        `Cannot add more than ${MAX_LIGHTS} lights to a LightCollection.`,
      );
    }
    this._lights.push(light);
    this._dirty = true;
    return light;
  }

  /**
   * Remove a light from the collection.
   * @param light - The light to remove
   * @returns True if the light was found and removed
   */
  remove(light: Light): boolean {
    const index = this._lights.indexOf(light);
    if (index === -1) {
      return false;
    }
    this._lights.splice(index, 1);
    this._dirty = true;
    return true;
  }

  /**
   * Remove all lights from the collection.
   */
  removeAll(): void {
    this._lights.length = 0;
    this._dirty = true;
  }

  /**
   * Get the number of lights in the collection.
   */
  get length(): number {
    return this._lights.length;
  }

  /**
   * Get the number of enabled lights.
   */
  get enabledCount(): number {
    let count = 0;
    for (let i = 0; i < this._lights.length; i++) {
      if (this._lights[i].enabled) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get a light by index.
   * @param index - The index of the light
   * @returns The light at the given index
   */
  get(index: number): Light {
    return this._lights[index];
  }

  /**
   * Whether the collection has been modified since last pack.
   */
  get dirty(): boolean {
    return this._dirty;
  }

  /**
   * Pack all enabled lights into a Float32Array suitable for a
   * WebGPU uniform buffer. Each light occupies 20 floats (80 bytes):
   *
   * Layout per light (80 bytes, 20 floats):
   *   [0-2]  direction/position xyz  [3] lightType
   *   [4-6]  color rgb               [7] intensity
   *   [8]    range                   [9] constantAtt
   *   [10]   linearAtt               [11] quadraticAtt
   *   [12]   innerConeAngle          [13] outerConeAngle
   *   [14-15] padding
   *   [16-18] spotDirection xyz (spot lights only)  [19] padding
   *
   * Buffer header (16 bytes, 4 floats):
   *   [0] lightCount  [1-3] padding
   *
   * Total: 4 + MAX_LIGHTS * 20 = 164 floats = 656 bytes
   *
   * A spot light's forward direction occupies floats 16..18 so the `vec3` is
   * aligned to a 16-byte WGSL uniform slot. The cone attenuation reads this
   * direction separately from the position at floats 0..2.
   *
   * @param result - Optional pre-allocated Float32Array
   * @returns Packed light data
   */
  pack(result?: Float32Array): Float32Array {
    const headerSize = 4; // lightCount + 3 padding
    const lightsPerSlot = 20; // floats per light
    const totalSize = headerSize + MAX_LIGHTS * lightsPerSlot;

    if (!defined(result) || result!.length < totalSize) {
      result = new Float32Array(totalSize);
    } else {
      result!.fill(0);
    }

    let enabledIndex = 0;
    for (let i = 0; i < this._lights.length && enabledIndex < MAX_LIGHTS; i++) {
      const light = this._lights[i];
      if (!light.enabled) {
        continue;
      }
      // Area lights use the clustered dispatcher's analytic storage path. Skip
      // them so the header counts only record types accepted by the punctual
      // uniform shader.
      if (light instanceof RectAreaLight || light instanceof DiskAreaLight) {
        continue;
      }

      const offset = headerSize + enabledIndex * lightsPerSlot;

      // Direction or position (depending on type)
      if (light instanceof DirectionalLight) {
        result![offset + 0] = light.direction.x;
        result![offset + 1] = light.direction.y;
        result![offset + 2] = light.direction.z;
      } else if (light instanceof PointLight || light instanceof SpotLight) {
        result![offset + 0] = (light as PointLight).position.x;
        result![offset + 1] = (light as PointLight).position.y;
        result![offset + 2] = (light as PointLight).position.z;
      }

      // Light type
      result![offset + 3] = light.lightType;

      // Color
      result![offset + 4] = light.color.red;
      result![offset + 5] = light.color.green;
      result![offset + 6] = light.color.blue;

      // Intensity
      result![offset + 7] = light.intensity;

      // Attenuation (for point/spot lights)
      if (light instanceof PointLight || light instanceof SpotLight) {
        const pl = light as PointLight;
        result![offset + 8] = pl.range;
        result![offset + 9] = pl.constantAttenuation;
        result![offset + 10] = pl.linearAttenuation;
        result![offset + 11] = pl.quadraticAttenuation;
      }

      // Spot light cone angles + forward direction
      if (light instanceof SpotLight) {
        const sl = light as SpotLight;
        result![offset + 12] = sl.innerConeAngle;
        result![offset + 13] = sl.outerConeAngle;
        // The WGSL `vec3` slot begins at float 16. Construction normalizes the
        // direction before it is copied into floats 16..18.
        result![offset + 16] = sl.direction.x;
        result![offset + 17] = sl.direction.y;
        result![offset + 18] = sl.direction.z;
      }

      enabledIndex++;
    }

    // Header: light count
    result![0] = enabledIndex;

    this._dirty = false;
    return result!;
  }

  /**
   * Destroy the collection and release references.
   */
  destroy(): void {
    this._lights.length = 0;
  }
}

export default Light;
