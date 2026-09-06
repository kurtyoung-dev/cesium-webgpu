/**
 * Handles WebGPU rendering of GroundPrimitive / ClassificationPrimitive.
 *
 * Uses a depth-texture sampling approach matching WebGL's
 * `ShadowVolumeAppearanceFS.glsl`. Sampling depth instead of marking
 * coverage in stencil lets the classifier select globe depth,
 * packed-translucent depth, or a per-frustum source at draw time. The same
 * plumbing supports translucent-on-translucent and point-cloud tile
 * classification, multi-frustum rendering, and ground polylines.
 *
 * Current state:
 *   - The depth-sample path emits a single pass per primitive. It reads an
 *     RGBA-packed depth source and discards where depth is 0, which denotes
 *     sky or an absent surface. Volume rasterization supplies lateral
 *     coverage, while the vertex shader clamps depth.
 *   - No stencil fallback is emitted. If no depth source is published yet,
 *     such as during the first frame or a viewport resize, classification is
 *     skipped for that frame.
 *
 * Surface normals are not reconstructed from depth derivatives. Unsupported
 * material types fall back to the primitive's color so classification still
 * produces a visible result.
 *
 * @private
 * @module WebGPUGroundPrimitiveRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import SceneMode from "../../Scene/SceneMode.js";
import csm_depthClamp from "../../Shaders/WebGPU/chunks/functions/csm_depthClamp.js";
import csm_reverseLogDepth from "../../Shaders/WebGPU/chunks/functions/csm_reverseLogDepth.js";
import csm_vertexLogDepth from "../../Shaders/WebGPU/chunks/functions/csm_vertexLogDepth.js";
import csm_writeLogDepth from "../../Shaders/WebGPU/chunks/functions/csm_writeLogDepth.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// Color pipelines use the scene-framebuffer target helper. Pick
// (`[{ format }]`), depth-only
// (`[{ format, writeMask: 0 }]`), and velocity (`[{ format: "rg16float" }]`)
// pipelines stay single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  sampler as samplerEntry,
  texture as textureEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  attachPickToColorCommand,
  findFirstGeometryInstancePickId,
} from "./WebGPUPickCommandHelpers.js";
import { selectClassificationBoundingVolume } from "./WebGPUClassificationBoundingVolume.js";
import { packClassificationColor } from "./WebGPUGroundPrimitiveInstanceColor.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// Keep one module cache per device so primitives sharing shader variants also
// share their compiled modules, even though ground primitives are typically
// few per scene.
const _groundPrimitiveShaderCaches = new WeakMap();

function getGroundPrimitiveShaderCache(device) {
  let cache = _groundPrimitiveShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _groundPrimitiveShaderCaches.set(device, cache);
  }
  return cache;
}

// The uniform buffer carries separate `mvRTE` and `proj` matrices plus a
// `morphFlags` vec4 for the SCENE3D ↔ SCENE2D morph pipeline. The morph
// vertex shader uses these alongside `mvpRTE` to project both
// the 3D ECEF and 2D-projected position attributes through the
// morph-state view, then blends in EC space by `morphFlags.x`
// (`morphTime`).
//
// The textured-material tail carries:
//   `invProj` — for depth → eye-coord recovery
//   `materialMeta` / `materialColor` / `materialParam0` / `materialParam1`
//                  — material dispatch (mirrors GroundPolyline)
//   `swCornerEC` / `eastwardEC` / `northwardEC` — planar-extent fields
//                  (CPU-transformed to eye space once per frame so the
//                  FS just does plane-dot for UV recovery — no per-
//                  fragment matrix mul)
//   `extentMode`   — .x = 0 (planar) | 1 (spherical), .yz = inverse
//                    extents (planar) or (latRangeInv, lonRangeInv)
//                    (spherical), .w = longitudeRotation (spherical)
//   `sphericalSW`  — (south, west, _, _) — spherical-extent corner
//   `invView`      — for spherical worldCoord recovery (eye → world)
// Threshold `ShadowVolumeAppearance.MAX_WIDTH_FOR_PLANAR_EXTENTS`
// (~1°) decides which path a given polygon's geometry was built for;
// the per-instance attribute set determines which fields the FS uses.
const UNIFORM_BUFFER_SIZE = 640;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchProjection = new Matrix4();
const scratchInvProj = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

// Eye-space scratch values support the planar-extent transform in
// `packUniforms`. The world-space southwest
// corner + east/north direction vectors are read from the primitive's
// per-instance attributes (`getGeometryInstanceAttributes`), pulled
// out of the batch table, and transformed through `scratchMVRTE` (the
// mode-correct view matrix with translation zeroed) into eye space.
const scratchRTEDelta = new Cartesian3();
const scratchSWHigh = new Cartesian3();
const scratchSWLow = new Cartesian3();
const scratchSWEC = new Cartesian3();
const scratchEastWorld = new Cartesian3();
const scratchNorthWorld = new Cartesian3();
const scratchEastEC = new Cartesian3();
const scratchNorthEC = new Cartesian3();

/**
 * Material-type enum mirroring `materialMeta.x` in the WGSL. Adding a
 * material requires (a) a new entry here, (b) a matching `applyMaterial`
 * branch in the WGSL, and (c) packing the material's parameters into
 * `materialParam0` / `materialParam1` in `resolveMaterialState`.
 *
 * @private
 */
const GroundPrimitiveMaterialType = Object.freeze({
  COLOR: 0,
  STRIPE: 1,
  CHECKERBOARD: 2,
  GRID: 3,
  IMAGE: 4,
});

// Track which custom material `type` strings we've already warned about
// (avoid log spam when the same custom material rides many primitives).
const _warnedCustomGroundMaterialTypes = new Set();

/**
 * Inspect the appearance's material and return a packed material state
 * the WGSL `applyMaterial` consumes. Returns `{ type, color, param0,
 * param1 }` — all four valid for any input. Unknown material types log
 * once and fall through to the flat-color path (`type = 0`).
 *
 * Mirrors the GroundPolyline `resolveMaterialState` pattern; the
 * material-types supported differ because polygon materials don't have
 * the polyline-specific `Dash` / `Glow` / `Outline` / `Arrow` set, but
 * DO use the polygon-relevant `Stripe` / `Checkerboard` / `Grid`.
 *
 * @private
 */
function resolveMaterialState(primitive) {
  const fallback = {
    type: GroundPrimitiveMaterialType.COLOR,
    color: [1.0, 1.0, 1.0, 1.0],
    param0: [0.0, 0.0, 0.0, 0.0],
    param1: [0.0, 0.0, 0.0, 0.0],
  };
  const material = primitive?.appearance?.material;
  if (!material) {
    return fallback;
  }
  const type = material.type;
  const uniforms = material.uniforms ?? {};

  const packColor = (c, defaults) =>
    defined(c)
      ? [
          c.red ?? defaults[0],
          c.green ?? defaults[1],
          c.blue ?? defaults[2],
          c.alpha ?? defaults[3],
        ]
      : defaults;

  if (type === "Stripe") {
    // StripeMaterial uniforms (see Material.js, Material.StripeType):
    //   horizontal (bool, default true) -- stripes run along the s axis
    //                                       when true; along t when false
    //   evenColor / oddColor / offset / repeat
    // Note: `StripeOrientation` (the CZML enum) is a higher-level concept
    // that the `StripeMaterialProperty` layer maps to the boolean
    // `horizontal` uniform -- by the time we see the material here, the
    // mapped boolean is on `uniforms.horizontal`. Read THAT directly.
    const oddColor = uniforms.oddColor;
    const isHorizontal = uniforms.horizontal !== false; // default true
    return {
      type: GroundPrimitiveMaterialType.STRIPE,
      color: packColor(uniforms.evenColor, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        uniforms.repeat ?? 5.0,
        uniforms.offset ?? 0.0,
        isHorizontal ? 1.0 : 0.0,
        0.0,
      ],
      param1: packColor(oddColor, [0.0, 0.0, 0.0, 1.0]),
    };
  }

  if (type === "Checkerboard") {
    const repeat = uniforms.repeat;
    return {
      type: GroundPrimitiveMaterialType.CHECKERBOARD,
      color: packColor(uniforms.lightColor, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        repeat?.x ?? repeat?.[0] ?? 5.0,
        repeat?.y ?? repeat?.[1] ?? 5.0,
        0.0,
        0.0,
      ],
      param1: packColor(uniforms.darkColor, [0.0, 0.0, 0.0, 1.0]),
    };
  }

  if (type === "Grid") {
    const lineCount = uniforms.lineCount;
    const lineThickness = uniforms.lineThickness;
    return {
      type: GroundPrimitiveMaterialType.GRID,
      color: packColor(uniforms.color, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        uniforms.cellAlpha ?? 0.1,
        lineCount?.x ?? lineCount?.[0] ?? 8.0,
        lineCount?.y ?? lineCount?.[1] ?? 8.0,
        0.0,
      ],
      param1: [
        lineThickness?.x ?? lineThickness?.[0] ?? 1.0,
        lineThickness?.y ?? lineThickness?.[1] ?? 1.0,
        0.0,
        0.0,
      ],
    };
  }

  if (type === "Color") {
    // Explicit Color material — packs through the materialColor slot so
    // even custom-colored ColorAppearance flows ride the texture path
    // consistently. The dsColorFS fast path (type==0) still wins.
    return {
      type: GroundPrimitiveMaterialType.COLOR,
      color: packColor(uniforms.color, [1.0, 1.0, 1.0, 1.0]),
      param0: [0.0, 0.0, 0.0, 0.0],
      param1: [0.0, 0.0, 0.0, 0.0],
    };
  }

  if (type === "Image") {
    // ImageMaterial — sample uniforms.image (a 2D texture) at st*repeat,
    // modulated by uniforms.color (tint). The texture is uploaded by
    // ensureMaterialImage and bound at group-0 binding 1; until it loads a
    // 1x1 white fallback is bound so the tint still shows. Mirrors the
    // GroundPolyline Image path (resolveMaterialState + ensureMaterialImage).
    const repeat = uniforms.repeat;
    return {
      type: GroundPrimitiveMaterialType.IMAGE,
      color: packColor(uniforms.color, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        repeat?.x ?? repeat?.[0] ?? 1.0,
        repeat?.y ?? repeat?.[1] ?? 1.0,
        0.0,
        0.0,
      ],
      param1: [0.0, 0.0, 0.0, 0.0],
      image: uniforms.image ?? null,
    };
  }

  // Unknown material type — warn once + fall through to Color so the
  // primitive still classifies (just untextured). Custom procedural
  // materials (Fabric shaders) still land here.
  //>>includeStart('debug', pragmas.debug);
  if (defined(type) && !_warnedCustomGroundMaterialTypes.has(type)) {
    _warnedCustomGroundMaterialTypes.add(type);
    console.warn(
      `[WebGPU:GroundPrimitive] material type="${type}" not natively ` +
        "supported — falling back to flat color. " +
        "Supported: Color, Stripe, Checkerboard, Grid, Image. " +
        "Custom procedural (Fabric) materials are pending follow-up work.",
    );
  }
  //>>includeEnd('debug');
  return fallback;
}

/**
 * Upload the Image-material source into a per-primitive GPU texture and
 * expose it as `cache.materialImageView`. Idempotent on the same source
 * (tracked via `cache._materialImageSource`); a newer source supersedes
 * an in-flight load. On success, nulls `cache.materialBindGroupViewRef`
 * so the next `createCommands` rebuilds the group-0 bind group against
 * the new view. Mirrors the GroundPolyline `ensureMaterialImage` port —
 * the only difference is the diagnostic tag.
 *
 * Accepts a URL string, ImageBitmap, HTMLImageElement, HTMLCanvasElement,
 * or ImageData (the source types Cesium's ImageMaterial accepts on
 * `uniforms.image`).
 *
 * @private
 */
function ensureMaterialImage(device, cache, imageSource) {
  if (!defined(imageSource)) {
    cache._materialImageSource = null;
    cache.materialImageView = undefined;
    return;
  }
  if (cache._materialImageSource === imageSource) {
    return;
  }
  cache._materialImageSource = imageSource;
  cache._materialImageLoading = true;
  cache.materialImageView = undefined;

  const finishLoad = (imageBitmap) => {
    if (cache._materialImageSource !== imageSource) {
      // A newer load superseded this one — drop it on the floor.
      imageBitmap.close?.();
      return;
    }
    const tex = device.createTexture({
      label: "GroundPrimitive material image",
      size: {
        width: imageBitmap.width,
        height: imageBitmap.height,
        depthOrArrayLayers: 1,
      },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // flipY — WebGL Material image textures upload with flipY: true (the
    // Texture default), so row 0 of the source lands at t=0 (bottom).
    // Without the flip the sampled pattern is vertically mirrored against
    // WebGL: a checkerboard keeps the same variance while producing about
    // 90% per-pixel mismatch.
    device.queue.copyExternalImageToTexture(
      { source: imageBitmap, flipY: true },
      { texture: tex },
      { width: imageBitmap.width, height: imageBitmap.height },
    );
    cache.materialImageTexture?.destroy?.();
    cache.materialImageTexture = tex;
    cache.materialImageView = tex.createView();
    cache._materialImageLoading = false;
    // Invalidate the material bind group so the next createCommands
    // rebuilds with the new view.
    cache.materialBindGroupViewRef = null;
    imageBitmap.close?.();
  };

  const fail = (err) => {
    if (cache._materialImageSource === imageSource) {
      cache._materialImageLoading = false;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        "[WebGPU:GroundPrimitive] Failed to load Image material source:",
        err,
      );
      //>>includeEnd('debug');
    }
  };

  if (typeof imageSource === "string") {
    fetch(imageSource)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob))
      .then(finishLoad)
      .catch(fail);
  } else if (imageSource instanceof ImageBitmap) {
    finishLoad(imageSource);
  } else if (
    typeof HTMLImageElement !== "undefined" &&
    imageSource instanceof HTMLImageElement
  ) {
    if (imageSource.complete && imageSource.naturalWidth > 0) {
      createImageBitmap(imageSource).then(finishLoad).catch(fail);
    } else {
      imageSource.addEventListener(
        "load",
        () => createImageBitmap(imageSource).then(finishLoad).catch(fail),
        { once: true },
      );
      imageSource.addEventListener("error", fail, { once: true });
    }
  } else if (
    typeof HTMLCanvasElement !== "undefined" &&
    imageSource instanceof HTMLCanvasElement
  ) {
    createImageBitmap(imageSource).then(finishLoad).catch(fail);
  } else if (
    typeof ImageData !== "undefined" &&
    imageSource instanceof ImageData
  ) {
    createImageBitmap(imageSource).then(finishLoad).catch(fail);
  } else {
    fail(new Error(`unsupported image source type: ${typeof imageSource}`));
  }
}

/**
 * Lazily create the 1x1 white fallback material texture + the material
 * sampler. The fallback is ALWAYS bound at group-0 binding 1 for non-image
 * materials (and for image materials before their texture finishes loading)
 * so the single group-0 layout is uniform across material types. White is
 * the multiplicative identity, so the `materialColor` tint shows through
 * unmodified. Mirrors the GroundPolyline port.
 *
 * @private
 */
function ensureFallbackMaterialTexture(device, cache) {
  if (defined(cache.fallbackMaterialTexture)) {
    return;
  }
  cache.fallbackMaterialTexture = device.createTexture({
    label: "GroundPrimitive fallback material tex",
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: cache.fallbackMaterialTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  cache.fallbackMaterialView = cache.fallbackMaterialTexture.createView();
  cache.materialSampler = device.createSampler({
    label: "GroundPrimitive material sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });
}

/**
 * (Re)build the group-0 bind group (binding 0 = per-primitive uniforms,
 * binding 1 = material image view, binding 2 = material sampler). Picks
 * `cache.materialImageView` when an Image material's texture has loaded,
 * else the 1x1 white fallback. Records the bound view on
 * `cache.materialBindGroupViewRef` so the caller only rebuilds when the
 * effective view changes (async image load, or first allocation). The
 * same field is nulled by `ensureMaterialImage` on load completion to
 * force a rebuild.
 *
 * @private
 */
function rebuildMaterialBindGroup(device, cache) {
  ensureFallbackMaterialTexture(device, cache);
  const matView = cache.materialImageView ?? cache.fallbackMaterialView;
  cache.bindGroup = device.createBindGroup({
    label: "GroundPrimitive group0",
    layout: cache.bgl,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      { binding: 1, resource: matView },
      { binding: 2, resource: cache.materialSampler },
    ],
  });
  cache.materialBindGroupViewRef = matView;
}

/**
 * Read the extent attributes from the primitive's first geometry
 * instance and pack them into the UBO so the FS can recover surface
 * UV from a depth-sampled fragment.
 *
 * Two paths, picked by the primitive's geometry (`GroundPrimitive`
 * decides during `update` based on `MAX_WIDTH_FOR_PLANAR_EXTENTS`):
 *
 *   - **Planar** (small polygons, bounding rect < ~1°): per-instance
 *     attributes `southWest_HIGH/LOW` + `eastward` + `northward`. The
 *     un-normalized `eastward` / `northward` vectors are SW→SE and
 *     SW→NW; their magnitudes are the east and north extents. CPU-
 *     transformed to eye space (`mvRTE`) once per frame — FS does a
 *     dot product per axis, no per-fragment matrix mul. Mirrors WebGL's
 *     `ShadowVolumeAppearanceVS` lines 71-86 + `…FS` lines 63-64.
 *
 *   - **Spherical** (larger polygons): per-instance attributes
 *     `sphericalExtents` (south, west, latRangeInv, lonRangeInv) +
 *     `longitudeRotation` (IDL handling). The FS recovers the surface
 *     world position via `invView × eyeCoord`, computes approximate
 *     (lat, lon) from `atan2`, and applies the SW corner + range
 *     inverses to get UV. Mirrors WebGL's `…FS` lines 54-60. `invView`
 *     is packed once per frame from `uniformState.inverseView`.
 *
 * Writes `extentMode.x = 0` (planar) or `1` (spherical); the FS
 * `surfaceUV` dispatches on it.
 *
 * Returns `true` if either extent path is wired, `false` if the
 * primitive lacks both attribute sets (e.g. a non-textured
 * GroundPrimitive that never went through `useFragmentCulling = true`).
 *
 * @private
 */
function packExtents(data, primitive, frameState) {
  // Walk the wrapping chain to the inner Cesium `Primitive` that carries the
  // batch table. The renderer is invoked with variable wrapper depth:
  //   GroundPrimitive → ._primitive (ClassificationPrimitive) → ._primitive
  //   (Primitive),  OR directly with a ClassificationPrimitive / Primitive.
  // A fixed two-hop lookup overshoots a directly supplied
  // ClassificationPrimitive. That makes this function return false, after
  // which `packUniforms` writes `materialMeta.x = 0` last and selects the
  // flat-color path for every textured material. Stop at the object that owns
  // `_batchTable`, matching the `_webgpuGeometryData` chain walk at the
  // command-build site below.
  let inner = primitive;
  for (let depth = 0; depth < 4 && inner && !inner._batchTable; depth++) {
    inner = inner._primitive;
  }
  if (!inner || !inner._instanceIds || inner._instanceIds.length === 0) {
    return false;
  }
  // Read the extents directly from the batch table by integer index,
  // bypassing the public `getGeometryInstanceAttributes(id)` API which
  // requires the GeometryInstance to have a defined `id`. The extents
  // are per-instance attributes added by
  // `ShadowVolumeAppearance.getPlanarTextureCoordinateAttributes`; we
  // only care about the first instance (multi-instance + per-instance
  // materials is a follow-up). `_batchTableAttributeIndices` is the
  // name → batch-table-index map populated when the inner Primitive's
  // batch table is built (Primitive.js); all four extent attributes
  // appear together (a planar-extent primitive has all or none).
  const bt = inner._batchTable;
  const indices = inner._batchTableAttributeIndices;
  if (!bt || !indices) {
    return false;
  }

  // Slot layout. These fields stay below byte 512 because Dawn/Tint can alias
  // a uniform-buffer vec4's `.zw` components to `.xy` at higher offsets; the
  // matching packing constraint is documented in `packUniforms`.
  //   swCornerEC   = 72..75  (planar only; 0 in spherical)
  //   eastwardEC   = 76..79  (planar only)
  //   northwardEC  = 80..83  (planar only)
  //   extentMode   = 84..87  (.x = mode, .yz = inv extents, .w = lonRot)
  //   sphericalSW  = 88..91  (.xy = (south, west); 0 in planar)
  //   invView      = 92..107 (spherical only; zeroed in planar)

  // Planar path: 4 attributes (southWest_HIGH/LOW + eastward + northward).
  const swHIdx = indices.southWest_HIGH;
  const swLIdx = indices.southWest_LOW;
  const eastIdx = indices.eastward;
  const northIdx = indices.northward;
  if (
    swHIdx !== undefined &&
    swLIdx !== undefined &&
    eastIdx !== undefined &&
    northIdx !== undefined
  ) {
    const swH = bt.getBatchedAttribute(0, swHIdx);
    const swL = bt.getBatchedAttribute(0, swLIdx);
    const eastW = bt.getBatchedAttribute(0, eastIdx);
    const northW = bt.getBatchedAttribute(0, northIdx);
    if (!swH || !swL || !eastW || !northW) {
      return false;
    }
    scratchSWHigh.x = swH.x;
    scratchSWHigh.y = swH.y;
    scratchSWHigh.z = swH.z;
    scratchSWLow.x = swL.x;
    scratchSWLow.y = swL.y;
    scratchSWLow.z = swL.z;
    scratchEastWorld.x = eastW.x;
    scratchEastWorld.y = eastW.y;
    scratchEastWorld.z = eastW.z;
    scratchNorthWorld.x = northW.x;
    scratchNorthWorld.y = northW.y;
    scratchNorthWorld.z = northW.z;

    // RTE delta to camera, then mvRTE to eye space. Mirrors the colorVS
    // RTE form: rte = (pH - camH) + (pL - camL).
    const camHigh = scratchEncodedCamera.high;
    const camLow = scratchEncodedCamera.low;
    scratchRTEDelta.x =
      scratchSWHigh.x - camHigh.x + (scratchSWLow.x - camLow.x);
    scratchRTEDelta.y =
      scratchSWHigh.y - camHigh.y + (scratchSWLow.y - camLow.y);
    scratchRTEDelta.z =
      scratchSWHigh.z - camHigh.z + (scratchSWLow.z - camLow.z);
    Matrix4.multiplyByPointAsVector(scratchMVRTE, scratchRTEDelta, scratchSWEC);
    Matrix4.multiplyByPointAsVector(
      scratchMVRTE,
      scratchEastWorld,
      scratchEastEC,
    );
    Matrix4.multiplyByPointAsVector(
      scratchMVRTE,
      scratchNorthWorld,
      scratchNorthEC,
    );

    const eastExtent = Cartesian3.magnitude(scratchEastEC);
    const northExtent = Cartesian3.magnitude(scratchNorthEC);
    if (eastExtent < 1e-6 || northExtent < 1e-6) {
      return false;
    }
    Cartesian3.divideByScalar(scratchEastEC, eastExtent, scratchEastEC);
    Cartesian3.divideByScalar(scratchNorthEC, northExtent, scratchNorthEC);

    data[72] = scratchSWEC.x; // swCornerEC @72
    data[73] = scratchSWEC.y;
    data[74] = scratchSWEC.z;
    data[75] = 0.0;
    data[76] = scratchEastEC.x; // eastwardEC @76
    data[77] = scratchEastEC.y;
    data[78] = scratchEastEC.z;
    data[79] = 0.0;
    data[80] = scratchNorthEC.x; // northwardEC @80
    data[81] = scratchNorthEC.y;
    data[82] = scratchNorthEC.z;
    data[83] = 0.0;
    // extentMode @84: .x = 0 (planar), .y/z = inv extents.
    data[84] = 0.0;
    data[85] = 1.0 / eastExtent;
    data[86] = 1.0 / northExtent;
    data[87] = 0.0;
    // Spherical slots zeroed.
    data[88] = 0.0; // sphericalSW @88
    data[89] = 0.0;
    data[90] = 0.0;
    data[91] = 0.0;
    for (let i = 92; i <= 107; i++) {
      // invView @92 zeroed (identity not needed; planar path ignores it)
      data[i] = 0.0;
    }
    return true;
  }

  // Spherical path: sphericalExtents (south, west, latRangeInv,
  // lonRangeInv) + longitudeRotation. The FS recovers worldCoord from
  // eyeCoord via invView, then takes (lat, lon) from atan2.
  const sphIdx = indices.sphericalExtents;
  const lonRotIdx = indices.longitudeRotation;
  if (sphIdx === undefined) {
    return false;
  }
  const sph = bt.getBatchedAttribute(0, sphIdx);
  if (!sph) {
    return false;
  }
  // The packer in ShadowVolumeAppearance writes
  //   [south, west, latRangeInverse, longitudeRangeInverse]
  // as a 4-component FLOAT attribute. `getBatchedAttribute` returns a
  // Cartesian4-like object — index by .x .y .z .w in order.
  const south = sph.x ?? sph[0];
  const west = sph.y ?? sph[1];
  const latInv = sph.z ?? sph[2];
  const lonInv = sph.w ?? sph[3];
  let longitudeRotation = 0.0;
  if (lonRotIdx !== undefined) {
    const lonRot = bt.getBatchedAttribute(0, lonRotIdx);
    // `longitudeRotation` is a single-float attribute; the batch table
    // wraps it as a scalar — accept both number and length-1 array.
    longitudeRotation =
      typeof lonRot === "number" ? lonRot : (lonRot?.x ?? lonRot?.[0] ?? 0.0);
  }

  // Planar slots zeroed (FS skips them when extentMode.x == 1).
  for (let i = 72; i <= 83; i++) {
    data[i] = 0.0;
  }
  // extentMode @84: .x = 1 (spherical), .y = 1/latRange, .z = 1/lonRange,
  // .w = longitudeRotation.
  data[84] = 1.0;
  data[85] = latInv;
  data[86] = lonInv;
  data[87] = longitudeRotation;
  // sphericalSW.xy = (south, west) @88.
  data[88] = south;
  data[89] = west;
  data[90] = 0.0;
  data[91] = 0.0;
  // invView (16 floats, slots 92..107, byte 368-431 < 512) — uniformState
  // exposes `inverseView` for the active SceneMode. Used by the FS to recover
  // worldCoord from eye coords for the (lat, lon) computation.
  Matrix4.pack(frameState.context.uniformState.inverseView, data, 92);
  return true;
}

/**
 * Build the three GroundPrimitive pipeline descriptors (stencil, color,
 * pick) plus the shared pipeline-layout / BGL / shader module.
 *
 * Routing through the central
 * `WebGPURenderPipelineCache` means two ground primitives with the same
 * format / depth format / blend / stencil descriptor share a single
 * `GPURenderPipeline`. The descriptors themselves still live here (they
 * carry `pipelineLayout` + the shared shader module reference), but the
 * actual pipeline objects are materialized asynchronously by the cache.
 * @private
 */
function buildGroundPipelineResources(
  device,
  format,
  depthFormat,
  sampleCount,
  logDepthActive,
  // Pick pipelines target the context's byte-object-ID format authority,
  // matching the pick framebuffer,
  // never the (possibly float/HDR) scene format.
  pickFormat = "rgba8unorm",
) {
  // Uniform-buffer head layout; the remaining fields are documented beside
  // their packing sites in `packUniforms`:
  //   floats   0-15 : mvpRTE                         (mat4x4<f32>)
  //   floats  16-19 : camH + _p0                     (vec3<f32> + pad)
  //   floats  20-23 : camL + _p1                     (vec3<f32> + pad)
  //   floats  24-27 : color                          (vec4<f32>)
  //   floats  28-31 : pickColor                      (vec4<f32>)
  //   floats  32-35 : viewport (x, y, w, h)          (vec4<f32>)
  //   floats  36-39 : morphFlags                     (vec4<f32>)
  //   floats  40-55 : inverseProjection              (mat4x4<f32>)
  //
  // The depth-sample `dsColor` / `dsPick` path is the only classification
  // path. Commands skip dispatch rather than falling back to stencil when
  // no depth source is published yet (first frame, viewport resize), at
  // a cost of one missed classification frame at startup.
  const code = `
${csm_depthClamp}
${logDepthActive ? csm_reverseLogDepth : ""}
${logDepthActive ? csm_vertexLogDepth : ""}
${logDepthActive ? csm_writeLogDepth : ""}
struct U {
  // CRITICAL LAYOUT INVARIANT (WEBGPU_DEBUGGING_LOG Batch 184 FINAL ROOT CAUSE):
  // Dawn/Tint MIS-READS a uniform-buffer vec4's .zw components as .xy when the
  // vec4 starts at/after BYTE 512. (Verified: the GPU buffer bytes are correct
  // via mapAsync; the SHADER LOAD aliases.) Therefore EVERY field the shader
  // actually reads MUST live below byte 512. The unused prevViewProjection and
  // the morph-only mvRTE/proj (read solely by morphColorVS during the transient
  // 2D-to-3D morph) are pushed to the tail (> 512) where the bug is benign.
  // DO NOT insert read fields after frustum, and DO NOT grow the head past byte
  // 512, without splitting into a 2nd uniform buffer. Float offsets are
  // annotated; packUniforms / packExtents MUST match.
  mvpRTE: mat4x4<f32>,        // @0   (byte 0)
  camH: vec3<f32>, _p0: f32,  // @16
  camL: vec3<f32>, _p1: f32,  // @20
  color: vec4<f32>,           // @24
  pickColor: vec4<f32>,       // @28
  viewport: vec4<f32>,        // @32  — FS divides @builtin(position).xy by .zw
  // morphFlags.x = morphTime (read by morph VS). .yzw reserved.
  morphFlags: vec4<f32>,      // @36
  // invProj — inverse projection (uniformState.inverseProjection); windowToEye.
  invProj: mat4x4<f32>,       // @40  (byte 160)
  // materialMeta.x = materialType (0 Color / 1 Stripe / 2 Checker / 3 Grid / 4 Image)
  materialMeta: vec4<f32>,    // @56
  materialColor: vec4<f32>,   // @60
  materialParam0: vec4<f32>,  // @64
  materialParam1: vec4<f32>,  // @68
  // Planar-extent eye-space frame (valid when extentMode.x == 0).
  swCornerEC: vec4<f32>,      // @72  (byte 288)
  eastwardEC: vec4<f32>,      // @76
  northwardEC: vec4<f32>,     // @80
  // extentMode: .x mode, .y 1/eastExtent|1/latRange, .z 1/northExtent|1/lonRange,
  // .w longitudeRotation. (.zw — the UV SCALES — were the corrupted lanes.)
  extentMode: vec4<f32>,      // @84
  // sphericalSW.xy = (south, west) of SW corner (radians), for the spherical path.
  sphericalSW: vec4<f32>,     // @88
  invView: mat4x4<f32>,       // @92  (byte 368) — spherical UV worldPos recovery
  // frustum.xy = (near, far) of the current frustum slice.
  frustum: vec4<f32>,         // @108 (byte 432, < 512 ✓ — last READ field)
  // ── tail: > byte 512, EXPENDABLE to the Dawn .zw bug ──
  // prevViewProjection — layout-only invariant today (NOT read by any FS/VS).
  prevViewProjection: mat4x4<f32>, // @112 (byte 448)
  // mvRTE / proj — morph-state matrices, read ONLY by morphColorVS during the
  // transient MORPH. Their .zw columns alias here (byte >= 512) → textured
  // classification DURING a 2D↔3D morph is imperfect (WIP edge case).
  mvRTE: mat4x4<f32>,         // @128 (byte 512)
  proj: mat4x4<f32>,          // @144 (byte 576)
};
@group(0) @binding(0) var<uniform> u: U;
// Image-material texture + sampler. Always bound (1x1 white fallback when the
// material is not Image / its image is still loading). Read ONLY by the
// materialType==4 (Image) branch of applyMaterial; other material types + the
// pick/stencil shaders leave them unused (valid — the binding is in the shared
// group-0 layout but a shader may ignore it).
@group(0) @binding(1) var materialTex: texture_2d<f32>;
@group(0) @binding(2) var materialSampler: sampler;

// Depth-sample resources. Group 1 carries the depth texture + sampler;
// the source view is bound late by WebGPUDrawCommand.bindGroupResolvers
// at draw time so per-frustum + per-frame depth-source swaps (globe-depth
// ↔ packed-translucent-depth) take effect without rebuilding the command.
@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

// NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — per-SLICE
// frustum state. The group-0 u.invProj / u.frustum are packed ONCE
// per frame at command-build time and therefore carry the WRONG slice's
// projection in multi-frustum scenes (the depth-sample classifier draws
// in whichever slice contains the surface, not the slice that happened
// to be current when packUniforms ran). This group is bound per-slice at
// draw time by a bind-group resolver that reads the renderer's published
// context._currentFrustumInvProj / _currentFrustumNearFar, so the FS
// recovers eye-space against the correct projection. Only invProj +
// (near, far) are per-slice; u.invView stays in group 0 because the
// VIEW matrix is constant across a frame's frustum slices (only the
// projection's near/far change). The dsColorFS Color fast path never
// reads this group (short-circuits when materialType == 0), so flat-color
// classification is unaffected.
struct FrustumState {
  perSlice: vec2<f32>,  // (near, far) of THIS draw's frustum band
  encode: vec2<f32>,    // (near, far) the globe LOG-encoded the depth texture with
  invProj: mat4x4<f32>,
};
@group(2) @binding(0) var<uniform> fstate: FrustumState;

struct CO { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };

@vertex fn colorVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> CO {
  var o: CO;
  // NEW-CLASSIFIER-GROUNDPRIM-2D-RTE (Batch 170 final) — mode-conditional
  // .zxy swizzle. In SCENE2D / COLUMBUS_VIEW the bound attributes are
  // position2DHigh/Low stored as (projX, projY, height) -- the natural
  // output of mapProjection.project() in GeometryPipeline.projectTo2D.
  // But camera.positionWC in 2D/CV is in the camera's ENU frame
  // (altitude, projX, projY) -- the TRANSFORM_2D rotation in
  // CameraInternals.updateMembers -- and uniformState.view is built
  // from that ENU camera, so the VS must subtract / project in ENU space.
  // Mirror WebGL's czm_translateRelativeToEye(pos2D.zxy, pos2DLow.zxy)
  // pattern at PrimitiveShaderHelpers.js:291 -- swizzle the 2D positions
  // to (height, projX, projY) before the RTE subtraction. SCENE3D
  // (morphFlags.x == 1.0) keeps the unswizzled ECEF positions.
  let is3D = u.morphFlags.x;
  let pHm = mix(pH.zxy, pH, vec3<f32>(is3D));
  let pLm = mix(pL.zxy, pL, vec3<f32>(is3D));
  let rte = (pHm - u.camH) + (pLm - u.camL);
  // czm_depthClamp — matches WebGL ShadowVolumeAppearanceVS.glsl which
  // wraps the projection in czm_depthClamp(...). Ground primitive shadow
  // volumes bracket terrain min/max; without depth clamp the upper /
  // lower extremes get frustum-clipped at oblique viewing angles.
  o.pos = csm_depthClamp(u.mvpRTE * vec4f(rte, 1.0));
${
  logDepthActive
    ? // Renderer-wide log depth: the shadow volume must depth-test against the
      // LOG-depth globe with the SAME encoding (fstate.encodeFrustum = the full
      // camera frustum the globe encoded with). Otherwise the volume's standard
      // hyperbolic z (~1.0 at the surface) fails the `less-equal` test vs the
      // globe's log z (~0.55) and the ENTIRE volume is culled — the classifier
      // vanishes. Write per-vertex log z into clip space (coarse vs the globe's
      // per-fragment frag_depth, but well within the terrain-height margin the
      // front-face-pass / back-face-reject test needs). Mirrors WebGL, which
      // applies czm_writeLogDepth to ALL geometry including shadow volumes.
      "  let _ldNear = fstate.encode.x;\n" +
      "  let _ldFar = fstate.encode.y;\n" +
      "  let _ldFactor = 1.0 / log2((_ldFar - _ldNear) + 1.0);\n" +
      "  let _logZ = csm_writeLogDepth(csm_vertexLogDepth(o.pos, _ldNear), _ldFactor);\n" +
      "  o.pos.z = clamp(_logZ, 0.0, 1.0) * o.pos.w;\n"
    : ""
}
  o.col = u.color;
  return o;
}

// Reverse of WebGPUGlobeDepth's pack: each RGBA byte carries a slice of
// the depth value. The pack writes
//   floor(d * vec4(1, 255, 65025, 16581375)) / 255
// so the unpack is dot(packed, vec4(1, 1/255, 1/65025, 1/16581375)).
// Matches czm_unpackDepth in the WebGL builtins exactly.
fn unpackDepth(packed: vec4<f32>) -> f32 {
  return dot(packed, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

// Eye-coord recovery from a depth-sampled fragment. Mirrors the PROVEN
// GroundPolyline windowToEyeCoordinates (same depth-sample classifier
// family) exactly: build clip-space from window XY + the sampled depth,
// multiply by the inverse projection, perspective-divide.
//
// Batch 171 incorrectly applied a reverseLogDepth here -- but the globe
// depth pass does NOT log-encode (a grep of Globe/*.wgsl finds no
// csm_writeLogDepth/frag_depth), so the stored value IS the standard
// WebGPU NDC z in [0, 1]. GroundPolyline confirms this: it inverse-
// projects the raw depth with no log reversal. Batch 173 corrects the
// math AND reads the PER-SLICE invProj from fstate (group 2) so the
// projection matches the slice the fragment was drawn in (the once-per-
// frame group-0 u.invProj captured the wrong slice at command-build
// time). WebGPU NDC z is [0, 1] (no -1..1 remap); clip-y points down vs
// eye-y up, so flip y.
fn windowToEye(fragXY: vec2<f32>, storedDepth: f32) -> vec3<f32> {
  var ndc = (fragXY / u.viewport.zw) * 2.0 - 1.0;
  ndc.y = -ndc.y;
${
  logDepthActive
    ? // The globe writes LOG depth (renderer-wide log-depth epic). Ports WebGL's
      // czm_screenToEyeCoordinates LOG_DEPTH path (windowToEyeCoordinates.glsl)
      // to WebGPU's replay architecture, where the globe DrawCommand is built once
      // and replayed across every frustum slice — so the entire globe depth texture
      // is log-encoded against ONE near/far: the full camera frustum captured at
      // scene-update (fstate.encodeFrustum), NOT the per-slice band the surface is
      // drawn in (fstate.frustum, e.g. [0.1,1e8] of a [0.1,1e10] camera).
      //   (1) DECODE the precise eye distance with the ENCODING near/far
      //       (fstate.encodeFrustum) — log encodes clipW = eye distance, which is
      //       projection-independent. Decoding with the per-slice near/far (the
      //       prior bug, via the unreliable group-0 u.frustum) used the wrong log
      //       base and reconstructed ~1e12 m → flat UV.
      //   (2) RE-ENCODE that distance to the PER-SLICE window depth and unproject
      //       with the per-slice fstate.invProj, applying WebGL's
      //       `eye.w = 1/depthFromCamera` precision override so the slice
      //       projection's crushed-near-1.0 window depth never limits precision.
      // DECODE the eye distance with the globe's ENCODE frustum (fstate.encode,
      // the value the globe log-encoded the whole depth texture with, stashed on
      // the shared uniformState). UNPROJECT with the per-primitive group-0
      // u.invProj + u.frustum (the command-build slice; self-consistent, and
      // reliable now that the U struct reorder put them below the Dawn 512-byte
      // uniform-vec4 bug). The eye.w = 1/depthFromCamera override (WebGL
      // windowToEyeCoordinates) makes the crushed-near-1.0 window depth not limit
      // precision — the xy ray comes from u.invProj (fov/aspect identical across
      // slices), the distance from the precise log decode.
      "  let depthFromCamera = csm_reverseLogDepthToEyeDistance(storedDepth, fstate.encode.x, fstate.encode.y);\n" +
      "  let sNear = u.frustum.x;\n" +
      "  let sFar = u.frustum.y;\n" +
      "  let windowZ = sFar * (1.0 - sNear / depthFromCamera) / (sFar - sNear);\n" +
      "  var q = u.invProj * vec4<f32>(ndc, windowZ, 1.0);\n" +
      "  q.w = 1.0 / depthFromCamera;\n" +
      "  return q.xyz / q.w;"
    : "  let clip = vec4<f32>(ndc, storedDepth, 1.0);\n" +
      "  let eye = u.invProj * clip;\n" +
      "  return eye.xyz / eye.w;"
}
}

// UV recovery for the depth-sampled surface point. Dispatches on
// extentMode.x: 0 = planar (CPU-transformed eye-space frame; dot
// products give normalized UV), 1 = spherical (recover worldCoord via
// invView, take approximate spherical (lat, lon), subtract SW corner +
// scale by 1/range). Mirrors WebGL's ShadowVolumeAppearanceFS lines
// 53-65.
fn surfaceUV(eyeCoord: vec3<f32>) -> vec2<f32> {
  let mode = u.extentMode.x;
  if (mode < 0.5) {
    // Planar path.
    let toSW = eyeCoord - u.swCornerEC.xyz;
    let s = dot(u.eastwardEC.xyz,  toSW) * u.extentMode.y;
    let t = dot(u.northwardEC.xyz, toSW) * u.extentMode.z;
    return vec2<f32>(s, t);
  }
  // Spherical path. Eye-space → world (ECEF) via invView. The 4th
  // homogeneous component is 1 since eyeCoord is a position.
  let worldH = u.invView * vec4<f32>(eyeCoord, 1.0);
  let world = worldH.xyz / worldH.w;
  // czm_approximateSphericalCoordinates uses Cesium's
  // czm_fastApproximateAtan(arg1, arg2) which returns arctan(arg2/arg1)
  // in the right quadrant -- i.e. EQUIVALENT to standard atan2(arg2,
  // arg1) (the implementation uses opposite/adjacent ratio with
  // adjacent=first arg, opposite=second arg). So:
  //   Cesium lat = czm_fastApproximateAtan(magXY, z) == std atan2(z, magXY)
  //   Cesium lon = czm_fastApproximateAtan(x,     y) == std atan2(y, x)
  // WGSL atan2(y, x) IS std atan2. ShadowVolumeAppearance builds the
  // packed sphericalExtents on the JS side via the same
  // CesiumMath.fastApproximateAtan2 convention, so the FS conventions
  // MUST match exactly -- swap and the polygon shows a wide gradient
  // instead of a polygon-aligned texture.
  let magXY = sqrt(world.x * world.x + world.y * world.y);
  let latitude = atan2(world.z, magXY);
  var longitude = atan2(world.y, world.x);
  // IDL handling: shift longitude by longitudeRotation then wrap into
  // (-pi, pi]. WebGL's czm_branchFreeTernary is just a sign-trick mix;
  // the explicit conditional is fine here -- per-fragment but the
  // branch is uniform within the polygon (longitudeRotation is a
  // per-primitive constant).
  longitude += u.extentMode.w;
  let TWO_PI = 6.283185307179586;
  let PI = 3.141592653589793;
  if (longitude > PI) {
    longitude -= TWO_PI;
  }
  let s = (longitude - u.sphericalSW.y) * u.extentMode.z;
  let t = (latitude  - u.sphericalSW.x) * u.extentMode.y;
  return vec2<f32>(s, t);
}

// Apply material at (s, t). materialMeta.x selects among supported
// material types (see UBO doc above). The Color path is handled by the
// caller (dsColorFS) — calling applyMaterial with materialType==0 still
// returns materialColor as a safe fallback so the function is well-
// defined for any input.
fn applyMaterial(st: vec2<f32>, stDX: vec2<f32>, stDY: vec2<f32>, fallbackColor: vec4<f32>) -> vec4<f32> {
  let materialType = u32(u.materialMeta.x);

  if (materialType == 1u) {
    // Stripe. Mirrors StripeMaterial.glsl:
    //   evenColor (materialColor) -- "on" stripe
    //   oddColor  (materialParam1) -- "off" stripe
    //   repeat    (materialParam0.x) -- WebGL halves this: stripe pairs
    //             span (repeat * 0.5) cycles across the polygon.
    //   offset    (materialParam0.y) -- phase shift
    //   horizontal (materialParam0.z) -- 1 = HORIZONTAL stripes (lines
    //              along east, variation along t/north), 0 = VERTICAL
    //              stripes (lines along north, variation along s/east).
    //              WebGL: coord = mix(s, t, horizontal).
    let repeat = u.materialParam0.x;
    let offset = u.materialParam0.y;
    let horizontal = u.materialParam0.z;
    let coord = mix(st.x, st.y, horizontal);
    let value = fract((coord - offset) * (repeat * 0.5));
    // step + mix mirrors WebGL: 0 .. 0.5 = even, 0.5 .. 1 = odd.
    if (value < 0.5) {
      return u.materialColor;
    }
    return u.materialParam1;
  }

  if (materialType == 2u) {
    // Checkerboard. Mirrors CheckerboardMaterial.glsl (and the
    // condensed GroundPolyline applyMaterial Checkerboard branch):
    //   lightColor (materialColor)
    //   darkColor  (materialParam1)
    //   repeat     (materialParam0.xy)
    let repeatS = u.materialParam0.x;
    let repeatT = u.materialParam0.y;
    let parity = (floor(repeatS * st.x) + floor(repeatT * st.y)) % 2.0;
    let scaledW = fract(repeatS * st.x);
    let scaledH = fract(repeatT * st.y);
    let dW = abs(scaledW - floor(scaledW + 0.5));
    let dH = abs(scaledH - floor(scaledH + 0.5));
    let aaDist = min(dW, dH);
    let lightColor = u.materialColor;
    let darkColor = u.materialParam1;
    let solidColor = mix(lightColor, darkColor, parity);
    let fade = smoothstep(0.0, 0.03, aaDist);
    return mix(lightColor, solidColor, fade);
  }

  if (materialType == 3u) {
    // Grid. Ports GridMaterial.glsl's derivative branch exactly
    // (C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO — the previous
    // viewport-ratio thickness approximation produced sub-pixel aliased
    // lines that mostly vanished):
    //   color         (materialColor) -- line + cell tint
    //   cellAlpha     (materialParam0.x)
    //   lineCount     (materialParam0.yz)
    //   lineThickness (materialParam1.xy) -- in pixels
    // WebGL: scaled distance to the nearest cell border, then a
    // derivative-widthed smoothstep gives value = 1 in the cell
    // interior, 0 on the line. FLAT appearance output is
    // diffuse + emission = 2 * (color.rgb * 0.5) = color.rgb
    // (czm_gammaCorrect is identity without HDR), alpha =
    // color.a * (1 - (1 - cellAlpha) * value). czm_pixelRatio is 1.0
    // for the standard canvas (no supersampling) — carried as a
    // constant here.
    let cellAlpha = u.materialParam0.x;
    let lineCount = vec2<f32>(u.materialParam0.y, u.materialParam0.z);
    let lineThickness = vec2<f32>(u.materialParam1.x, u.materialParam1.y);
    var scaledWidth = fract(lineCount.x * st.x);
    scaledWidth = abs(scaledWidth - floor(scaledWidth + 0.5));
    var scaledHeight = fract(lineCount.y * st.y);
    scaledHeight = abs(scaledHeight - floor(scaledHeight + 0.5));
    // Fuzz factor -- controls blurriness of lines (WebGL constant).
    let fuzz = 1.2;
    let thickness = lineThickness - 1.0; // czm_pixelRatio = 1.0
    // "3D Engine Design for Virtual Globes" section 4.3.1. WebGL uses
    // hardware dFdx/dFdy on the interpolated v_texcoord; our st is
    // RECONSTRUCTED per-fragment from packed globe depth, so hardware
    // derivatives pick up the depth-pack quantization noise (the
    // cross-row dpdy blows up to >1 cell and washes every line out).
    // The caller passes ANALYTIC +1px st deltas computed with the
    // fragment's own depth instead — exact for locally-flat surfaces,
    // noise-free by construction.
    let dxST = abs(stDX);
    let dyST = abs(stDY);
    let dF = vec2<f32>(max(dxST.x, dyST.x), max(dxST.y, dyST.y)) * lineCount;
    let value = min(
      smoothstep(dF.x * thickness.x, dF.x * (fuzz + thickness.x), scaledWidth),
      smoothstep(dF.y * thickness.y, dF.y * (fuzz + thickness.y), scaledHeight),
    );
    let baseColor = u.materialColor;
    let alpha = baseColor.a * (1.0 - (1.0 - cellAlpha) * value);
    return vec4<f32>(baseColor.rgb, alpha);
  }

  if (materialType == 4u) {
    // Image. Mirrors ImageMaterial.glsl: sample the material texture at
    // st * repeat (wrapped), modulate by the tint color (materialColor).
    //   repeat (materialParam0.xy)
    //   color  (materialColor) -- tint; defaults to white so an untinted
    //          image shows its own colors.
    let uv = vec2<f32>(st.x * u.materialParam0.x, st.y * u.materialParam0.y);
    let texel = textureSampleLevel(materialTex, materialSampler, fract(uv), 0.0);
    return texel * u.materialColor;
  }

  // materialType == 0 (Color): caller already returned via the fast
  // path; any unrecognized type also falls through to the fallback.
  return fallbackColor;
}

// Depth-sample classifier. Samples the depth source (globe-depth or
// packed-translucent-depth, swapped at draw time by the bind-group
// resolver) at the fragment's screen-space position; discards where the
// surface wrote no depth (sky / nothing classifiable). The volume's
// rasterization handles lateral coverage. Per-instance-color path is
// pixel-equivalent to WebGL's ShadowVolumeAppearanceFS PER_INSTANCE_COLOR
// + FLAT branch. NEW-GROUNDPRIM-TEXTURED-MATERIALS (Batch 171) added the
// material path: when materialMeta.x != 0, recover eye-space from
// window+depth, compute planar UV from the per-primitive extent fields,
// dispatch to the matching applyMaterial branch.
@fragment fn dsColorFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  // Fast path: per-instance / appearance flat color. No UV or material
  // dispatch needed. Premultiply alpha, as WebGL's ShadowVolumeAppearanceFS
  // does on its PER_INSTANCE_COLOR branch and as the material path below
  // does: the color target's source factor is "one", so an unpremultiplied
  // return composites 1/alpha too bright over the classified surface.
  let materialType = u32(u.materialMeta.x);
  if (materialType == 0u) {
    return vec4<f32>(i.col.rgb * i.col.a, i.col.a);
  }
  // Material path: recover eye-space, compute planar UV, apply material.
  // NOTE (Batch 171): the LOG path's windowToEye reads the per-slice
  // invProj from group 2 (fstate); the NON-LOG path (default) still
  // unprojects with the group-0 u.invProj — see the caveat below.
  // The Batch 174 bounding-volume distribution (frustum-distribution fix,
  // NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION) IS in place, so the
  // command now lands in the slice containing its surface.
  //
  // KNOWN RESIDUAL (Batch 198, confirmed empirically — see
  // NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION "ADDITIONAL FINDING"): the
  // textured UV tiles ~4× too FINE vs WebGL across the whole polygon. The
  // extents + OBB remap are correct; the error is a windowToEye invProj /
  // depth-reconstruction mismatch — the non-log path uses u.invProj =
  // inverse(uniformState.projection) captured at createCommands time, which
  // doesn't match the projection the globe wrote the sampled depth with, so
  // eye.w (and the eye.xy the UV derives from) is scaled. Shares the
  // mid-flight log-depth-epic root with the b3dm-occlusion gap (Batch 201):
  // with scene.logarithmicDepthBuffer on, the render frustum is the single
  // [0.1, 1e8] log partition but depth is written HYPERBOLIC (log write off).
  // Re-verify the frustum count + st range before fixing (the earlier
  // "per-slice / Link 4" framing assumed multi-frustum and is likely wrong).
  // Variance probes don't catch it (frequency-blind). The flat-color Color
  // path is unaffected (it short-circuits above and never reads the
  // depth → eye recovery).
${
  logDepthActive
    ? // Multi-frustum: View.js bins this classifier command into EVERY slice its
      // bounding volume spans, but only the slice whose [near,far] CONTAINS the
      // surface holds the real (log-encoded) globe depth — the others hold the
      // far/cleared depth. Decode the eye distance (full-frustum encoding in
      // u.frustum) and discard when the surface lies outside THIS slice's
      // [near,far] (fstate.frustum), so the far-slice draw doesn't alpha-blend a
      // garbage (flat) reconstruction over the correct near-slice draw. Mirrors
      // WebGL, where each frustum only classifies surfaces within its own band.
      "  let sliceEyeDist = csm_reverseLogDepthToEyeDistance(surfaceDepth, fstate.encode.x, fstate.encode.y);\n" +
      "  if (sliceEyeDist < fstate.perSlice.x || sliceEyeDist > fstate.perSlice.y) { discard; }"
    : ""
}
  let ec = windowToEye(i.pos.xy, surfaceDepth);
  let st = surfaceUV(ec);
  // Analytic +1px st derivatives for material anti-aliasing (Grid lines).
  // Re-evaluate the window->eye->UV chain at neighboring pixels with THIS
  // fragment's depth: exact for locally-flat surfaces and immune to the
  // depth-pack quantization noise that hardware dpdx/dpdy would inherit
  // from the reconstructed st.
  let stDX = surfaceUV(windowToEye(i.pos.xy + vec2<f32>(1.0, 0.0), surfaceDepth)) - st;
  let stDY = surfaceUV(windowToEye(i.pos.xy + vec2<f32>(0.0, 1.0), surfaceDepth)) - st;
  let outColor = applyMaterial(st, stDX, stDY, i.col);
  // Premultiply alpha to match WebGL ShadowVolumeAppearanceFS's
  // out_FragColor.rgb *= out_FragColor.a (classification primitives
  // ride on a translucent-friendly blend state).
  return vec4<f32>(outColor.rgb * outColor.a, outColor.a);
}

@fragment fn dsPickFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return u.pickColor;
}

// AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER) —
// CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW variant. Same VS + sky-discard
// as the color path; the pipeline disables color writes (writeMask=0) and
// enables stencil-write so the only side-effect is marking stencil=0xff
// on every classified-surface pixel the volume covers. The composite
// (WebGPUInvertClassification's classifiedPipeline / unclassifiedPipeline)
// reads those bits to gate which tile pixels get the invert tint.
@fragment fn dsStencilFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return vec4<f32>(0.0);
}

// Batch 164 -- A.4 NEW-CLASSIFIER-2D-CV-MORPH morph pipeline. Mirrors
// the WebGL appearance3DMorph flow -- consumes BOTH the 3D ECEF and
// 2D-projected position attribute sets and blends EC-space positions
// by morphFlags.x (morphTime). The 2D positions ride at locations
// 2/3 with the same stride layout as the 3D pair; the JS side
// interleaves 12 bytes per attribute pair into a 24-byte vertex
// stream that the buffer layout decodes into pH/pL/pH2D/pL2D.
//
// Coordinate convention: the 2D positions follow Cesium's projected
// frame where the X-axis is the projection's altitude and (Y, Z) are
// the planar pair -- matching WebGPUGroundPolylineRenderer.vsMorph,
// hence the .zxy swizzle on the 2D pair before feeding it to the
// shared translateRelativeToEye math. Without the swizzle the
// 2D-projected lat/lon land in the wrong axes and the volume floats
// off the projected surface during the morph.
@vertex fn morphColorVS(
  @location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>,
  @location(2) pH2D: vec3<f32>, @location(3) pL2D: vec3<f32>,
) -> CO {
  var o: CO;
  let morphTime = u.morphFlags.x;
  let rte3D = (pH - u.camH) + (pL - u.camL);
  let rte2D = (pH2D.zxy - u.camH) + (pL2D.zxy - u.camL);
  let posEc3D = (u.mvRTE * vec4<f32>(rte3D, 1.0)).xyz;
  let posEc2D = (u.mvRTE * vec4<f32>(rte2D, 1.0)).xyz;
  // Blend EC positions by morphTime, then project. Matches WebGL
  // appearance3DMorph and WebGPUGroundPolylineRenderer.vsMorph.
  let posEc = mix(posEc2D, posEc3D, morphTime);
  o.pos = csm_depthClamp(u.proj * vec4<f32>(posEc, 1.0));
  o.col = u.color;
  return o;
}

// NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — velocity entry
// points for TAA. GroundPrimitive volumes have static per-feature
// geometry, so velocity is camera-only: project the SAME world-space
// position (high+low encoded position) through both the current vpRTE
// (matching colorVS) and the previous full VP, emit (currNdc - prevNdc)
// to the rg16float velocity texture. Mirrors the Voxel pattern (Batch
// 173) and the Vector3DTile classifier sweep (Batches 178-179).
//
// Coverage parity: the velocity VS uses the SAME csm_depthClamp + mvpRTE
// math as colorVS so the rasterized fragment positions match exactly —
// no half-pixel offsets in the emitted velocity vectors. The VS DOES
// NOT replicate the morphColorVS path; velocity emission is suppressed
// during MORPHING by the JS-side gating in createWebGPUGroundPrimitiveCommands
// (TAA during scene-mode morph is rare; the camera-only fallback in
// the velocity-pass is correct for static-geometry transitions).
struct VelocityCO {
  @builtin(position) pos: vec4<f32>,
  @location(0) currClip: vec4<f32>,
  @location(1) prevClip: vec4<f32>,
};

@vertex fn vsVelocity(
  @location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>,
) -> VelocityCO {
  // Current frame: identical to colorVS so the velocity-pass
  // rasterization matches the color pass fragment-for-fragment.
  // Mode-conditional swizzle matches colorVS (see comment there);
  // SCENE3D keeps unswizzled ECEF, SCENE2D / CV swizzles position2D
  // (projX, projY, height) -> (height, projX, projY) before RTE.
  let is3D = u.morphFlags.x;
  let pHm = mix(pH.zxy, pH, vec3<f32>(is3D));
  let pLm = mix(pL.zxy, pL, vec3<f32>(is3D));
  let rte = (pHm - u.camH) + (pLm - u.camL);
  let curClip = csm_depthClamp(u.mvpRTE * vec4<f32>(rte, 1.0));
  // Previous frame: project the world-space position (high + low,
  // simple sum is fine here because pH/pL are SOA-encoded high/low
  // bits of an absolute world position — adding them recovers the
  // original world coordinates) through prev VP. The csm_depthClamp
  // is intentionally NOT applied to prev — the clamp affects clip-z,
  // and velocity derives from clip-x/y/w; the omission is benign and
  // saves the helper call on the prev path.
  let worldPosRaw = pHm + pLm;
  let prClip = u.prevViewProjection * vec4<f32>(worldPosRaw, 1.0);
  var o: VelocityCO;
  o.pos = curClip;
  o.currClip = curClip;
  o.prevClip = prClip;
  return o;
}

@fragment fn fsVelocity(i: VelocityCO) -> @location(0) vec2<f32> {
  let curW = i.currClip.w;
  let prevW = i.prevClip.w;
  // Behind-near-plane fragments contribute zero velocity — TAA will
  // treat the pixel as static and reuse history without reprojection.
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = i.currClip.xy / curW;
  let prevNdc = i.prevClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

  const mod = getGroundPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.GROUND_PRIMITIVE,
    code,
    logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    // Label carries the log state so the two module variants are
    // distinguishable in devtools, matching the Vector3DTile* siblings.
    `GroundPrimitive${logDepthActive ? " [log]" : ""}`,
  );

  // `logDepthActive` selects a distinct module above, and every descriptor
  // below uses it for both stages. Module identity and entry points are part of
  // the central pipeline key; the log-depth flag in each descriptor name keeps
  // the variants legible in diagnostics and provides defense in depth. A
  // mismatched shader would interpret a hyperbolic scene-depth buffer as
  // logarithmic depth, or vice versa, and mis-reconstruct eye distance.
  const ldFlag = logDepthActive ? 1 : 0;
  // Group 0: per-primitive uniforms (binding 0) + the material image
  // texture (binding 1) and its sampler (binding 2). The texture/sampler
  // are ALWAYS bound — non-image materials (color/stripe/checkerboard/grid)
  // bind a 1x1 white fallback so the single group-0 layout is shared by
  // every material type. The Image branch of `applyMaterial` (materialType
  // == 4u) is the only consumer; other branches ignore the binding.
  const bgl = makeBindGroupLayout(device, "GroundPrimitive BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    textureEntry(1, Stage.FRAGMENT, { sampleType: "float" }),
    samplerEntry(2, Stage.FRAGMENT, "filtering"),
  ]);

  // Depth-sample BGL + 2-group pipeline layout. Group 0 carries the
  // per-primitive uniforms; group 1 carries the depth texture + sampler.
  // Bound late at draw time via WebGPUDrawCommand.bindGroupResolvers so
  // per-frustum source swaps don't require rebuilding the command.
  const depthSampleBgl = makeBindGroupLayout(
    device,
    "GroundPrimitive DepthSample BGL",
    [
      textureEntry(0, Stage.FRAGMENT, { sampleType: "float" }),
      samplerEntry(1, Stage.FRAGMENT, "filtering"),
    ],
  );
  // Group 2 carries per-slice frustum state: inverse projection and near/far.
  // It is fragment-only because the
  // depth-sample FS reads it for eye-space recovery. The globe's LOG-encode
  // frustum (needed by both the VS log-z write and the FS decode) is delivered
  // via group-0 `u.frustum` instead. Bound per-slice at draw time via the
  // frustum-state bind-group resolver. Every GroundPrimitive pipeline (color /
  // pick / stencil / morph / velocity) shares `depthSampleLayout`, so they all
  // gain this third group.
  const frustumStateBgl = makeBindGroupLayout(
    device,
    "GroundPrimitive FrustumState BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );
  const depthSampleLayout = device.createPipelineLayout({
    label: "GroundPrimitive DepthSample PipelineLayout",
    bindGroupLayouts: [bgl, depthSampleBgl, frustumStateBgl],
  });

  const vertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    },
  ];

  // The morph layout uses two simultaneous vertex buffers, each
  // with a (high, low) RTE pair. Buffer 0 carries 3D ECEF positions
  // (locations 0/1 — same as the non-morph pipeline so the JS side
  // reuses the same `position3DHigh/Low` interleave). Buffer 1 carries
  // the projected 2D positions (locations 2/3). Only used during
  // SCENE_MODE.MORPHING; the non-morph pipelines bind a single buffer.
  const morphVertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    },
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 2, offset: 0, format: "float32x3" },
        { shaderLocation: 3, offset: 12, format: "float32x3" },
      ],
    },
  ];

  // Color pipeline — single pass, samples depth in the fragment shader
  // and discards where depth is 0. Layout uses both BGLs (per-primitive
  // uniforms in @group(0), depth source in @group(1)). depthStencil
  // retains less-equal for early rejection of fragments beyond the
  // volume's far face but does not configure stencil — the depth-sample
  // path doesn't read or write the stencil bits, so the attachment's
  // stencil aspect remains untouched (other passes still read it for
  // InvertClassification etc.).
  // Scene-framebuffer color pipelines bake the MSAA sample count.
  const msState = sampleCount > 1 ? { count: sampleCount } : undefined;
  // Match WebGL's premultiplied-alpha blend. Its ClassificationPrimitive
  // color pass uses a source factor of one because
  // ShadowVolumeAppearanceFS premultiplies rgb by alpha in the shader.
  // dsColorFS mirrors the premultiply, so the pipeline must mirror the
  // same source factor; using a source-alpha factor applies alpha twice and
  // darkens every translucent classification
  // (Grid cellAlpha cells, translucent per-instance colors).
  const premultipliedBlend = {
    color: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
    alpha: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
  };
  const depthSampleColorDescriptor = {
    name: `GroundPrimitive depthSampleColor [${format}/${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsColorFS",
      // Scene-framebuffer color target with premultiplied-alpha blending for
      // WebGL classification parity.
      targets: makeSceneFBTargets(format, { blend: premultipliedBlend }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: msState,
  };

  const depthSamplePickDescriptor = {
    name: `GroundPrimitive depthSamplePick [${pickFormat}/${depthFormat}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsPickFS",
      targets: [{ format: pickFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // No `multisample` — the pick variant renders into the single-sample
    // 1-target WebGPU pick framebuffer (matching the GroundPolyline
    // pickDescriptor). It must NOT bind in the MSAA 2-target MRT scene
    // pass; that's enforced at the dispatch site, not here.
  };

  // The ignore-show variant writes stencil only.
  // Color writes disabled (writeMask=0); the pipeline runs solely to mark
  // the invert FBO's stencil with 0xff on classified pixels. The
  // stencilReference value is set per-draw via
  // `applyPerEncoderState({ stencilTest: { reference: 0xff } })`.
  const depthSampleStencilDescriptor = {
    name: `GroundPrimitive depthSampleStencil [${format}/${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsStencilFS",
      targets: [{ format, writeMask: 0 }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
      stencilFront: {
        compare: "always",
        failOp: "keep",
        depthFailOp: "keep",
        passOp: "replace",
      },
      stencilBack: {
        compare: "always",
        failOp: "keep",
        depthFailOp: "keep",
        passOp: "replace",
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
    },
    // The stencil-only pipeline still runs in the MSAA scene pass.
    multisample: msState,
  };

  // The morph color pipeline uses
  // Two-buffer vertex layout (3D + 2D position pairs); same fragment
  // shader as the non-morph color path — the morph blend lives in the
  // VS so the FS just samples globe depth and emits per-instance color.
  // Color targets, blend, depth-stencil, and the pipeline layout all
  // mirror `depthSampleColorDescriptor` so the cache key only differs
  // by `vertex.entryPoint` + `vertex.buffers`.
  const morphColorDescriptor = {
    name: `GroundPrimitive morphColor [${format}/${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: {
      module: mod,
      entryPoint: "morphColorVS",
      buffers: morphVertexBuffers,
    },
    fragment: {
      module: mod,
      entryPoint: "dsColorFS",
      // Scene-framebuffer color target with premultiplied-alpha blending;
      // see `depthSampleColorDescriptor` for the WebGL parity constraint.
      targets: makeSceneFBTargets(format, { blend: premultipliedBlend }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: msState,
  };

  const morphPickDescriptor = {
    name: `GroundPrimitive morphPick [${pickFormat}/${depthFormat}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: {
      module: mod,
      entryPoint: "morphColorVS",
      buffers: morphVertexBuffers,
    },
    fragment: {
      module: mod,
      entryPoint: "dsPickFS",
      targets: [{ format: pickFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // No `multisample` — single-sample 1-target pick FBO (see
    // depthSamplePickDescriptor).
  };

  // The velocity pipeline uses the same depth-sample bind-group layout as the color
  // pipeline so bind groups are reused; single rg16float color target,
  // no blend, depth read-only. Only the non-morph variant is built —
  // velocity emission is suppressed during MORPHING by the JS-side
  // gating (TAA during scene-mode morph is rare).
  const velocityDescriptor = {
    name: `GroundPrimitive velocity [${depthFormat}/ld=${ldFlag}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "vsVelocity", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "fsVelocity",
      targets: [{ format: "rg16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };

  return {
    depthSampleColorDescriptor,
    depthSamplePickDescriptor,
    depthSampleStencilDescriptor,
    morphColorDescriptor,
    morphPickDescriptor,
    velocityDescriptor,
    bgl,
    depthSampleBgl,
    frustumStateBgl,
  };
}

/**
 * Convert a `WebGPURenderPipelineDescriptor` (cache-friendly shape) back
 * into the WebGPU descriptor for the synchronous fallback path. Only
 * called when the central pipeline cache isn't available — preserves the
 * historical behavior for legacy callers.
 * @private
 */
function descriptorToGPU(d) {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve the stencil + color + pick pipelines through the central
 * pipeline cache. If the cache isn't available, falls back to direct
 * synchronous `device.createRenderPipeline()`. Returns true once all
 * three pipelines are materialized; returns false on the first frame
 * after async creation kicks off so the caller can skip the draw and
 * try again next tick.
 *
 * Uses the same asynchronous resolution pattern as
 * `tryResolveEllipsoidPipelines`.
 * @private
 */
function tryResolveGroundPrimitivePipelines(
  device,
  pipelineCache,
  resources,
  cache,
) {
  if (
    cache.depthSampleColorPipeline &&
    cache.depthSamplePickPipeline &&
    cache.depthSampleStencilPipeline
  ) {
    return true;
  }

  if (pipelineCache) {
    const dsColorSync = pipelineCache.getPipelineSync(
      resources.depthSampleColorDescriptor,
    );
    const dsPickSync = pipelineCache.getPipelineSync(
      resources.depthSamplePickDescriptor,
    );
    const dsStencilSync = pipelineCache.getPipelineSync(
      resources.depthSampleStencilDescriptor,
    );
    // Resolve the velocity pipeline alongside color, pick, and stencil. A
    // cache miss is
    // non-fatal: color path continues to render correctly without it;
    // velocity-pass dispatch becomes a no-op until the variant lands.
    const dsVelocitySync = pipelineCache.getPipelineSync(
      resources.velocityDescriptor,
    );
    if (dsColorSync && dsPickSync && dsStencilSync) {
      cache.depthSampleColorPipeline = dsColorSync;
      cache.depthSamplePickPipeline = dsPickSync;
      cache.depthSampleStencilPipeline = dsStencilSync;
      cache.velocityPipeline = dsVelocitySync ?? null;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.depthSampleColorDescriptor),
        pipelineCache.getPipeline(resources.depthSamplePickDescriptor),
        pipelineCache.getPipeline(resources.depthSampleStencilDescriptor),
        pipelineCache.getPipeline(resources.velocityDescriptor),
      ])
        .then(([dsColor, dsPick, dsStencil, dsVelocity]) => {
          cache.depthSampleColorPipeline = dsColor;
          cache.depthSamplePickPipeline = dsPick;
          cache.depthSampleStencilPipeline = dsStencil;
          cache.velocityPipeline = dsVelocity;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear the in-flight flag
          // so the next frame retries.
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Without a central cache, such as with a WebGL-backed graphics context or
  // during pre-initialization, create the pipelines synchronously.
  cache.depthSampleColorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSampleColorDescriptor),
  );
  cache.depthSamplePickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSamplePickDescriptor),
  );
  cache.depthSampleStencilPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSampleStencilDescriptor),
  );
  // The synchronous path also creates the velocity pipeline.
  cache.velocityPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.velocityDescriptor),
  );
  return true;
}

/**
 * Resolves morph pipelines lazily on the first morphing frame so
 * non-morphing scenes do not pay the cache hit.
 * Mirrors `tryResolveGroundPrimitivePipelines` for the morph
 * descriptor pair.
 * @private
 */
function tryResolveGroundPrimitiveMorphPipelines(
  device,
  pipelineCache,
  resources,
  cache,
) {
  if (cache.morphColorPipeline && cache.morphPickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const morphColorSync = pipelineCache.getPipelineSync(
      resources.morphColorDescriptor,
    );
    const morphPickSync = pipelineCache.getPipelineSync(
      resources.morphPickDescriptor,
    );
    if (morphColorSync && morphPickSync) {
      cache.morphColorPipeline = morphColorSync;
      cache.morphPickPipeline = morphPickSync;
      cache.morphPipelineRequestPending = false;
      return true;
    }
    if (!cache.morphPipelineRequestPending) {
      cache.morphPipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.morphColorDescriptor),
        pipelineCache.getPipeline(resources.morphPickDescriptor),
      ])
        .then(([morphColor, morphPick]) => {
          cache.morphColorPipeline = morphColor;
          cache.morphPickPipeline = morphPick;
          cache.morphPipelineRequestPending = false;
        })
        .catch(() => {
          cache.morphPipelineRequestPending = false;
        });
    }
    return false;
  }

  cache.morphColorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.morphColorDescriptor),
  );
  cache.morphPickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.morphPickDescriptor),
  );
  return true;
}

function packUniforms(data, frameState, modelMatrix, pickColor, primitive) {
  const uniformState = frameState.context.uniformState;
  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, data, 0);

  // RTE camera encoding. `camera.positionWC` is the right source for ALL
  // modes — in SCENE2D / COLUMBUS_VIEW the camera frame's `actualTransform`
  // (TRANSFORM_2D) maps the local position into ENU `(altitude, projX, projY)`
  // space, which is what the 2D view matrix consumes. The position2D
  // attributes are stored unswizzled as `(projX, projY, height)`; the WGSL
  // VS applies a mode-conditional `.zxy` swizzle (matching WebGL's
  // `czm_translateRelativeToEye(...zxy, ...zxy)` convention at line 291 of
  // PrimitiveShaderHelpers.js) so the RTE subtraction is well-formed.
  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[16] = scratchEncodedCamera.high.x;
  data[17] = scratchEncodedCamera.high.y;
  data[18] = scratchEncodedCamera.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCamera.low.x;
  data[21] = scratchEncodedCamera.low.y;
  data[22] = scratchEncodedCamera.low.z;
  data[23] = 0.0;

  // Floats 24-27 carry the flat colour `colorVS` copies into `o.col` and the
  // `dsColorFS` material-type-0 fast path shades from. The appearance
  // material is only one of its two sources: a `PerInstanceColorAppearance`
  // has no material and keeps its colour on the geometry instance, the way
  // WebGL's `PER_INSTANCE_COLOR` varying does.
  packClassificationColor(data, 24, primitive);

  // The pick-color slot occupies floats 28-31 and defaults to zero
  // when no pick ID has been registered yet; the pick pass skips the
  // draw in that case so the zeros never reach the pick FBO.
  data[28] = pickColor?.red ?? 0.0;
  data[29] = pickColor?.green ?? 0.0;
  data[30] = pickColor?.blue ?? 0.0;
  data[31] = pickColor?.alpha ?? 0.0;

  // Viewport (floats 32-35). The depth-sample FS divides
  // `@builtin(position).xy` by viewport.zw to recover the screen-space
  // UV used to fetch globe depth. Source from `context.drawingBufferWidth/
  // Height` directly: `uniformState.viewportCartesian4` is zero-initialized
  // until per-frame viewport setup, but feature renderers run earlier during
  // primitive update. A nullish fallback does not replace zero, so using that
  // value produces a 0/0 viewport, a NaN screen UV, a zero depth sample, and a
  // universal discard. Ground polylines require the same direct source.
  const ctx = frameState.context;
  data[32] = 0.0;
  data[33] = 0.0;
  data[34] = ctx?.drawingBufferWidth || 1;
  data[35] = ctx?.drawingBufferHeight || 1;

  // Previous view-projection occupies floats 112-127. `UniformState.update`
  // returns the prior value before assigning the current view-projection to
  // `_previousViewProjection`, so frame N receives frame N-1. The first frame
  // uses identity.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 112); // tail (byte 448) — unused, dodges the Dawn >512 bug
  } else {
    data[112] = 1;
    data[113] = 0;
    data[114] = 0;
    data[115] = 0;
    data[116] = 0;
    data[117] = 1;
    data[118] = 0;
    data[119] = 0;
    data[120] = 0;
    data[121] = 0;
    data[122] = 1;
    data[123] = 0;
    data[124] = 0;
    data[125] = 0;
    data[126] = 0;
    data[127] = 1;
  }

  // Morph fields:
  //
  // floats 128..143 — `mvRTE` — model-view RTE (translation zeroed).
  //   Read by `morphColorVS` to project both the 3D and 2D
  //   position attributes through the morph-state view (then blends
  //   in EC space). For the non-morph paths this slot is don't-care
  //   because `colorVS` only reads `mvpRTE`.
  //
  // floats 144..159 — `proj` — projection matrix.
  //   Final projection after the EC-space morph blend.
  //
  // floats 36..39 — `morphFlags` — .x = morphTime
  //   (1.0 = full SCENE3D, 0.0 = full SCENE2D / Columbus View,
  //   fractional during MORPHING).
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.pack(scratchMVRTE, data, 128); // tail (byte 512) — morph-only
  Matrix4.clone(uniformState.projection, scratchProjection);
  Matrix4.pack(scratchProjection, data, 144); // tail (byte 576) — morph-only
  // SceneMode 3D = 1.0, MORPHING = frameState.morphTime ∈ [0, 1]
  // (1.0 = full 3D, 0.0 = full 2D), SCENE2D / COLUMBUS_VIEW = 0.0.
  // `morphTime` is canonical on `frameState` (FrameState.js:98 init,
  // updated by `Scene.morphComplete*` listeners); `uniformState`
  // doesn't carry it directly. Non-morph scenes leave this stale,
  // which is fine — only `morphColorVS` reads it.
  data[36] = frameState?.morphTime ?? 0.0; // morphFlags @36
  data[37] = 0.0;
  data[38] = 0.0;
  data[39] = 0.0;

  // Material dispatch slots.
  // invProj (floats 40..55) — inverse projection, used by windowToEye in the FS.
  // Compute it from uniformState.projection, which is live at feature-renderer pack time; the
  // volume's mvpRTE uses it) rather than reading uniformState.inverseProjection,
  // whose lazy cache can still be zero when the GroundPrimitive packs its
  // uniform buffer during command construction. A degenerate inverse produces
  // constant eye recovery and flat textured UVs.
  Matrix4.inverse(uniformState.projection, scratchInvProj);
  Matrix4.pack(scratchInvProj, data, 40);

  // Resolve material state. The Color (type 0) path skips planar-extent
  // packing because dsColorFS short-circuits to `i.col` — no UV / no
  // dot-product / no FS-side dispatch. Stripe / Checkerboard / Grid all
  // need the extents; pack them OR fall back to Color if the primitive
  // lacks the planar-extent attributes (spherical path or missing).
  const materialState = primitive ? resolveMaterialState(primitive) : null;
  const matType = materialState?.type ?? 0;
  if (matType !== 0 && primitive) {
    const haveExtents = packExtents(data, primitive, frameState);
    if (!haveExtents) {
      // No extents at all — fall back to Color so the primitive still
      // classifies (just as flat color). Logged once via the
      // resolveMaterialState's custom-material path.
      data[56] = 0.0;
    } else {
      data[56] = matType;
    }
  } else {
    data[56] = 0.0;
  }
  data[57] = 0.0;
  data[58] = 0.0;
  data[59] = 0.0; // materialMeta.yzw @56

  // materialColor (floats 60..63).
  const mc = materialState?.color ?? [1.0, 1.0, 1.0, 1.0];
  data[60] = mc[0];
  data[61] = mc[1];
  data[62] = mc[2];
  data[63] = mc[3];
  // materialParam0 (floats 64..67).
  const mp0 = materialState?.param0 ?? [0.0, 0.0, 0.0, 0.0];
  data[64] = mp0[0]; // materialParam0 @64
  data[65] = mp0[1];
  data[66] = mp0[2];
  data[67] = mp0[3];
  // materialParam1 (floats 68..71).
  const mp1 = materialState?.param1 ?? [0.0, 0.0, 0.0, 0.0];
  data[68] = mp1[0];
  data[69] = mp1[1];
  data[70] = mp1[2];
  data[71] = mp1[3];

  // Extents (floats 72..107) — packExtents wrote these if the material path is
  // active. Zero them out otherwise so the FS dispatch reading them gets
  // deterministic safe values (dsColorFS's fast path won't touch them at
  // matType==0). NOTE: floats 72..107 (bytes 288..431) are < 512 — see the
  // U-struct layout invariant (Dawn >512 vec4 .zw aliasing bug).
  if (matType === 0 || !primitive) {
    for (let i = 72; i <= 107; i++) {
      data[i] = 0.0;
    }
  }

  // frustum.xy = (near, far) of the CURRENT frustum slice (per-slice band).
  // The globe's LOG-encode frustum is delivered to the depth-sample shaders via
  // group-2 fstate.frustum.zw (written every draw at draw-time), NOT here.
  const cf = uniformState.currentFrustum;
  data[108] = cf?.x ?? 0.1; // frustum.x = near (@108, byte 432)
  data[109] = cf?.y ?? 1.0e8; // far
  data[110] = 0.0;
  data[111] = 0.0;
}

/**
 * Creates WebGPU commands for a GroundPrimitive.
 * Returns both stencil and color commands.
 */
function createWebGPUGroundPrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  // SCENE2D and COLUMBUS_VIEW use the per-vertex
  // `position2DHigh/Low` attributes that `PrimitivePipeline.js:175-208`
  // produces alongside the 3D positions. With both encoded into the
  // same coordinate space as the active `uniformState.view * projection`
  // and `camera.positionWC`, the existing RTE math at `colorVS`
  // produces correct classification volumes. MORPHING routes through
  // `morphColorVS`, which consumes both attribute sets and blends
  // eye-space positions by
  // `uniformState.morphTime`.
  //
  // `position2DHigh/Low` stores `(projX, projY, height)`, while
  // `camera.positionWC` uses the scene's ENU ordering
  // `(altitude, projX, projY)`. The non-morph `colorVS` and `vsVelocity`
  // apply WebGL's mode-conditional `.zxy` swizzle before RTE subtraction so
  // positions and the encoded camera share a coordinate frame. Without the
  // swizzle, a Mercator extent spanning roughly ±20 million metres moves the
  // classification volume off-screen. `morphColorVS` applies the same swizzle.
  //
  // Textured-material detail in 2D additionally depends on `appearance2D` UVs
  // and extents; that is orthogonal to selecting the volume positions here.
  const sceneMode = frameState?.mode;
  const isNon3D = sceneMode !== SceneMode.SCENE3D;
  const isMorphing = sceneMode === SceneMode.MORPHING;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {};
  }
  const cache = primitive._webgpuCache;

  // Build the bind-group layout, pipeline layout, shader module, and pipeline
  // descriptors once, then route the actual
  // pipeline creation through `context.webgpuPipelineCache`. The
  // descriptors and shader module are stashed on the cache so the async
  // resolver can re-poll across frames until pipelines materialize.
  // Invalidate cached resources when the scene format changes, such as an HDR
  // toggle. Cached pipeline objects must be cleared with `_pipelineResources`
  // and `bgl`; otherwise the resolver's truthy-slot check retains a pipeline
  // whose color format no longer matches the active attachment, and WebGPU
  // rejects the draw at submission.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  // Renderer-wide log depth: when the master switch flips, the classifier's
  // windowToEye must (de)activate the reverse-log path, which changes the
  // shader source — so a flip invalidates the cached pipeline resources just
  // like a format change does. Inert while the flag is off (default).
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  if (
    defined(cache._pipelineResources) &&
    (cache._pipelineFormatGeneration !== sceneGen ||
      cache._pipelineLogDepth !== logDepthActive)
  ) {
    cache._pipelineResources = undefined;
    cache.bgl = undefined;
    // Clear cached pipeline objects so the resolvers re-run against
    // the new resources / format. Both the standard depth-sample trio
    // and the morph pair need clearing.
    cache.depthSampleColorPipeline = undefined;
    cache.depthSamplePickPipeline = undefined;
    cache.depthSampleStencilPipeline = undefined;
    cache.morphColorPipeline = undefined;
    cache.morphPickPipeline = undefined;
    // Clear the velocity pipeline alongside the others on format changes.
    cache.velocityPipeline = undefined;
    // Bind groups reference the old BGL which is now stale.
    cache.bindGroup = undefined;
    // ALSO null the material-view ref: the lazy group-0 rebuild gates on
    // `materialBindGroupViewRef !== effectiveMatView`, so leaving the ref
    // intact after dropping `cache.bindGroup` skips the rebuild and the
    // draw submits with NO bind group at index 0 (invalidates the whole
    // scene pass encoder). This matters for HDR toggles and for the log-depth
    // master switch,
    // which legitimately flips per scene MODE (useLogDepth is false under
    // 2D's orthographic frustum), making 3D->2D hit this every time.
    cache.materialBindGroupViewRef = null;
    cache.depthSampleBindGroup = undefined;
    cache.depthSampleViewRef = undefined;
    // Frustum-state bind groups reference the old frustumStateBgl because the
    // whole _pipelineResources is rebuilt on format change), so drop them
    // too. The UBO buffers themselves are layout-agnostic but the bind
    // groups must be recreated against the new BGL; clear both so the
    // lazy `ensureFrustumStateSlot` rebuilds them.
    cache.frustumStateUBOs = undefined;
    cache.frustumStateBindGroups = undefined;
    cache.frustumStateBindGroup = undefined;
    // Reset pending-request flags so the resolvers can re-issue.
    cache.pipelineRequestPending = false;
    cache.morphPipelineRequestPending = false;
  }

  if (!defined(cache._pipelineResources)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const sampleCount = context._msaaSamples ?? 1;
    cache._pipelineResources = buildGroundPipelineResources(
      device,
      format,
      depthFmt,
      sampleCount,
      logDepthActive,
      // Use the pick target format authority rather than the scene format.
      context.pickPipelineFormat || "rgba8unorm",
    );
    cache.bgl = cache._pipelineResources.bgl;
    cache.pipelineRequestPending = false;
    cache._pipelineFormatGeneration = sceneGen;
    cache._pipelineLogDepth = logDepthActive;
  }

  // Resolve stencil + color + pick through the central cache. On the
  // first frame this kicks off async creation and returns false, so we
  // skip the draw rather than enqueue commands referencing null
  // pipelines. Subsequent frames pick up the cached objects synchronously.
  if (
    !tryResolveGroundPrimitivePipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return {
      stencilPipeline: null,
      colorPipeline: null,
      pickPipeline: null,
      bindGroup: cache.bindGroup ?? null,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  // Resolve morph pipelines lazily on the first
  // MORPHING frame and cached thereafter. Same first-frame skip
  // contract as the non-morph resolver above.
  if (
    isMorphing &&
    !tryResolveGroundPrimitiveMorphPipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return {
      stencilPipeline: null,
      colorPipeline: null,
      pickPipeline: null,
      bindGroup: cache.bindGroup ?? null,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "GroundPrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    // group-0 bind group (uniforms @0 + material texture @1 + sampler @2).
    // Built via the shared helper so the material slots are always bound;
    // the 1x1 white fallback stands in until an Image material loads.
    rebuildMaterialBindGroup(device, cache);
  }

  const modelMatrix = primitive.modelMatrix || Matrix4.IDENTITY;

  // Geometry-backed wrappers already own the canonical per-instance pick IDs
  // on their inner Primitive. Reuse the first one (this renderer is explicitly
  // first-geometry-only below) instead of allocating a second wrapper ID.
  // The inner ID preserves GeometryInstance.id + pickPrimitive exactly as the
  // WebGL path does; a wrapper-level ID loses the instance id and duplicates
  // registry/resource ownership. Primitive.destroy owns its lifecycle.
  const passes = frameState.passes;
  const allowPicking = primitive?.allowPicking !== false;
  const pickId =
    allowPicking && !!(passes && (passes.pick || passes.render))
      ? findFirstGeometryInstancePickId(primitive)
      : undefined;
  const pickColor = pickId?.color;

  packUniforms(
    cache.uniformData,
    frameState,
    modelMatrix,
    pickColor,
    primitive,
  );
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Image material: kick off (idempotent) texture upload, and rebuild the
  // group-0 bind group whenever the effective material view changes — first
  // allocation, source swap, or async load completion (which nulls
  // materialBindGroupViewRef in ensureMaterialImage's finishLoad). Non-image
  // materials drop any cached image source so a later Image re-assignment
  // reloads, then ride the always-bound white fallback.
  const materialState = resolveMaterialState(primitive);
  if (materialState.type === GroundPrimitiveMaterialType.IMAGE) {
    ensureMaterialImage(device, cache, materialState.image);
  } else if (defined(cache._materialImageSource)) {
    cache._materialImageSource = null;
    cache.materialImageView = undefined;
    cache.materialBindGroupViewRef = null;
  }
  const effectiveMatView =
    cache.materialImageView ?? cache.fallbackMaterialView;
  if (cache.materialBindGroupViewRef !== effectiveMatView) {
    rebuildMaterialBindGroup(device, cache);
  }

  // Build actual draw commands if vertex data is available.
  //
  // `_webgpuGeometryData` is populated by
  // `Scene/PrimitiveGeometryHelpers.js` on the innermost Cesium
  // `Primitive`. The wrapping chain for a GroundPrimitive is:
  //   `_GroundPrimitive` → `._primitive` (`ClassificationPrimitive`) →
  //   `._primitive` (`Primitive`) → `._webgpuGeometryData` (array).
  // Walk the chain to find the slot. Direct callers that wire the
  // renderer against a `Primitive` or `ClassificationPrimitive` work
  // through the same lookup with shorter chains.
  //
  // The producer-side hook lives in the existing `Primitive.update` →
  // `createVertexArray` flow in PrimitiveGeometryHelpers. ClassificationPrimitive
  // needs no separate populator because it
  // delegates to a Primitive at construction time
  // (`ClassificationPrimitive.js:417`). The renderer therefore walks the
  // wrapper chain and extracts
  // `_webgpuGeometryData[g].attributes.position3DHigh.values`.
  //
  // Only `_webgpuGeometryData[0]` is consumed. Multi-geometry primitives are
  // rare for GroundPrimitive, which typically represents one rectangle or
  // polygon.
  const geomDataArray =
    primitive._webgpuGeometryData ??
    primitive._primitive?._webgpuGeometryData ??
    primitive._primitive?._primitive?._webgpuGeometryData;
  if (!defined(geomDataArray) || geomDataArray.length === 0) {
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }
  const geomData = geomDataArray[0];
  // Pick the position-attribute set that matches the active scene mode.
  // `PrimitivePipeline.js` always produces `position3DHigh/Low` and produces
  // `position2DHigh/Low` when the scene mode is non-3D.
  // In SCENE3D the 2D set is absent; in SCENE2D / COLUMBUS_VIEW the 2D
  // set is the one whose coordinate system matches
  // `uniformState.view × projection` and `camera.positionWC` (CesiumJS
  // adjusts the camera position to the active scene mode), so RTE
  // math composes correctly without shader changes.
  //
  // Strict — no `?? position3DHigh` fallback in non-3D modes. A
  // primitive that lacks `position2DHigh/Low` while running in
  // SCENE2D / CV would project 3D ECEF coords through the 2D VP
  // matrix and draw garbage volumes.
  // The `defined(...)` guard below catches this and returns null
  // commands so the primitive silently skips that frame instead.
  // Three position-source modes are supported:
  //   "3D"    : SCENE3D — bind only `position3DHigh/Low` (loc 0/1).
  //   "2D"    : SCENE2D / COLUMBUS_VIEW — bind only `position2DHigh/Low`
  //             (loc 0/1, swapped at the source-attribute level so the
  //             non-morph pipeline keeps reading from loc 0/1).
  //   "MORPH" : SCENE_MORPHING — bind BOTH 3D (loc 0/1) AND 2D (loc 2/3)
  //             so the morph VS can blend EC-space positions by
  //             `morphFlags.x` (uniformState.morphTime).
  const useNon3DPositions = isNon3D;
  const posHighAttr = useNon3DPositions
    ? geomData?.attributes?.position2DHigh
    : geomData?.attributes?.position3DHigh;
  const posLowAttr = useNon3DPositions
    ? geomData?.attributes?.position2DLow
    : geomData?.attributes?.position3DLow;
  // For MORPHING we need BOTH attribute sets — the primary `posHigh/LowAttr`
  // is the 3D side (loc 0/1), and we additionally consume 2D attributes
  // for the second vertex buffer.
  const morphPosHigh = isMorphing
    ? geomData?.attributes?.position3DHigh
    : posHighAttr;
  const morphPosLow = isMorphing
    ? geomData?.attributes?.position3DLow
    : posLowAttr;
  const morphPos2DHigh = isMorphing
    ? geomData?.attributes?.position2DHigh
    : undefined;
  const morphPos2DLow = isMorphing
    ? geomData?.attributes?.position2DLow
    : undefined;
  // Validation: morph requires both attribute sets; non-morph requires
  // exactly the active set. If either is missing we silent-skip the
  // frame rather than dispatch a half-bound pipeline.
  const primaryHigh = isMorphing ? morphPosHigh : posHighAttr;
  const primaryLow = isMorphing ? morphPosLow : posLowAttr;
  const morphAttrsValid =
    !isMorphing ||
    (defined(morphPos2DHigh?.values) &&
      defined(morphPos2DLow?.values) &&
      morphPos2DHigh.values.length === morphPos2DLow.values.length &&
      morphPos2DHigh.values.length === primaryHigh?.values?.length);
  if (
    !defined(primaryHigh?.values) ||
    !defined(primaryLow?.values) ||
    primaryHigh.values.length !== primaryLow.values.length ||
    !morphAttrsValid
  ) {
    //>>includeStart('debug', pragmas.debug);
    if (isMorphing) {
      oneTimeWarning(
        "WebGPUGroundPrimitive.missingMorphAttributes",
        "GroundPrimitive during MORPHING is missing one of `position3DHigh/Low` " +
          "or `position2DHigh/Low` (or the two pairs have mismatched lengths). " +
          "Silently skipping this frame. Tracked under A.4 / NEW-CLASSIFIER-2D-CV-MORPH.",
      );
    } else if (useNon3DPositions) {
      oneTimeWarning(
        "WebGPUGroundPrimitive.missing2DAttributes",
        "GroundPrimitive in non-3D scene mode has no `position2DHigh/Low` " +
          "attribute pair on its geometry — typically because the asset was " +
          "created with `scene3DOnly: true` or pre-projected positions. " +
          "Silently skipping this frame to avoid drawing 3D ECEF coords " +
          "through the 2D view-projection matrix.",
      );
    }
    //>>includeEnd('debug');
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }

  // Create vertex buffer(s). Single 24-byte/vertex stream for non-morph
  // modes; two parallel 24-byte streams for MORPHING (3D + 2D).
  //
  // Track the source that populated the cached vertex buffer and rebuild when
  // the scene mode changes between 3D, 2D/CV, and morphing. The morph key also
  // owns a parallel 2D buffer.
  const positionSourceKey = isMorphing
    ? "MORPH"
    : useNon3DPositions
      ? "2D"
      : "3D";
  if (cache.positionSourceKey !== positionSourceKey) {
    cache.vertexGPUBuffer?.destroy();
    cache.vertexGPUBuffer = undefined;
    cache.vertexGPUBuffer2D?.destroy();
    cache.vertexGPUBuffer2D = undefined;
    cache.positionSourceKey = positionSourceKey;
  }
  if (!defined(cache.vertexGPUBuffer)) {
    const numVerts = primaryHigh.values.length / 3;
    const interleaved = new Float32Array(numVerts * 6);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * 6;
      const src = v * 3;
      interleaved[dst] = primaryHigh.values[src];
      interleaved[dst + 1] = primaryHigh.values[src + 1];
      interleaved[dst + 2] = primaryHigh.values[src + 2];
      interleaved[dst + 3] = primaryLow.values[src];
      interleaved[dst + 4] = primaryLow.values[src + 1];
      interleaved[dst + 5] = primaryLow.values[src + 2];
    }
    // `WebGPUBuffer.createVertexBuffer(device, data, label)` writes the
    // data on its own; we don't follow up with a separate
    // `device.queue.writeBuffer` call. The legacy renderer's call site
    // had this wrong (passed `byteLength` as data), which contributed
    // to the silent breakage along with the broader geometry-plumbing
    // gap.
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved,
      `GroundPrimitive VB ${positionSourceKey}`,
    );
    cache.vertexCount = numVerts;
  }
  // The morph pipeline's second vertex buffer uses the same
  // 24-byte stride / interleave as the primary; lives at slot 1 in
  // the morph descriptor's `morphVertexBuffers`.
  if (isMorphing && !defined(cache.vertexGPUBuffer2D)) {
    const numVerts = morphPos2DHigh.values.length / 3;
    const interleaved = new Float32Array(numVerts * 6);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * 6;
      const src = v * 3;
      interleaved[dst] = morphPos2DHigh.values[src];
      interleaved[dst + 1] = morphPos2DHigh.values[src + 1];
      interleaved[dst + 2] = morphPos2DHigh.values[src + 2];
      interleaved[dst + 3] = morphPos2DLow.values[src];
      interleaved[dst + 4] = morphPos2DLow.values[src + 1];
      interleaved[dst + 5] = morphPos2DLow.values[src + 2];
    }
    cache.vertexGPUBuffer2D = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved,
      "GroundPrimitive VB MORPH-2D",
    );
  }

  // Create index buffer if indexed geometry. Auto-detect uint16 vs
  // uint32 from the maximum index value (matches
  // `WebGPUPrimitiveCommands.ensureIndexBuffer`).
  const indices = geomData.indices;
  if (defined(indices) && !defined(cache.indexGPUBuffer)) {
    let needsU32 = false;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > 0xffff) {
        needsU32 = true;
        break;
      }
    }
    const typed = needsU32
      ? new Uint32Array(indices)
      : new Uint16Array(indices);
    cache.indexFormat = needsU32 ? "uint32" : "uint16";
    cache.indexGPUBuffer = device.createBuffer({
      label: "GroundPrimitive IB",
      size: typed.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.indexGPUBuffer, 0, typed);
    cache.indexCount = indices.length;
  }

  // Pick the classification pass(es) based on `classificationType`.
  // ClassificationType: TERRAIN=0, CESIUM_3D_TILE=1, BOTH=2.
  // Pass enum:          TERRAIN_CLASSIFICATION=3, CESIUM_3D_TILE_CLASSIFICATION=6.
  // Emit one command per relevant pass, matching the pass-list pattern used
  // by the vector-tile primitive and clamped-polyline renderers. `BOTH` must
  // produce terrain and 3D Tiles commands rather than collapsing to one pass.
  const classType = primitive?.classificationType ?? 0;
  const groundPasses = [];
  if (classType === 0 /* TERRAIN */ || classType === 2 /* BOTH */) {
    groundPasses.push(Pass.TERRAIN_CLASSIFICATION);
  }
  if (classType === 1 /* CESIUM_3D_TILE */ || classType === 2 /* BOTH */) {
    // The semantic slot is `Pass.CESIUM_3D_TILE_CLASSIFICATION`, but this
    // branch still uses `Pass.CESIUM_3D_TILE`; their numeric values diverged
    // when classification passes were inserted. Correcting the dispatch route
    // requires dedicated 3D Tiles classification runtime coverage.
    groundPasses.push(Pass.CESIUM_3D_TILE);
  }

  // Depth sampling is the only classifier path.
  // Pick a depth source: prefer packed-translucent-depth (front-most
  // translucent surface) so classification volumes clip against
  // translucent 3D-tile surfaces; fall through to globe-depth when no
  // translucent tiles contributed depth this frame. Both views share
  // the same RGBA-packed format. The actual view is bound late at draw
  // time via `bindGroupResolvers` so per-frustum
  // source swaps take effect within a frame.
  //
  // When neither view is published (first frame, viewport resize), no
  // commands are emitted — classification pixels are missing for that
  // frame, which is the trade for retiring the always-broken stencil
  // fallback. In steady state the classifier dispatches every frame.
  const packedTranslucentView = context._packedTranslucentDepthView ?? null;
  const globeDepthView = context._globeDepthView ?? null;
  const picking = passes?.pick === true || passes?.pickVoxel === true;
  const depthSourceView = picking
    ? context._pickClassificationDepthView
    : (packedTranslucentView ?? globeDepthView);
  if (!depthSourceView) {
    return {
      colorPipeline: cache.depthSampleColorPipeline,
      pickPipeline: cache.depthSamplePickPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
      // Array fields support `BOTH`. Empty arrays mean no commands this frame
      // because the depth source is not yet published.
      colorCommands: [],
      pickCommands: [],
      ignoreShowCommand: null,
    };
  }

  if (!defined(cache.depthSampleSampler)) {
    cache.depthSampleSampler = device.createSampler({
      label: "GroundPrimitive depth-sample sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  if (
    !defined(cache.depthSampleBindGroup) ||
    cache.depthSampleViewRef !== depthSourceView
  ) {
    cache.depthSampleBindGroup = device.createBindGroup({
      label: "GroundPrimitive depth-sample BG",
      layout: cache._pipelineResources.depthSampleBgl,
      entries: [
        { binding: 0, resource: depthSourceView },
        { binding: 1, resource: cache.depthSampleSampler },
      ],
    });
    cache.depthSampleViewRef = depthSourceView;
  }

  // The per-frustum bind-group resolver follows depth-source publications.
  // Each frustum updates `_packedTranslucentDepthView` / `_globeDepthView`
  // before its classification pass executes. The resolver picks up the
  // current values at draw time and rebuilds the bind group when the
  // source view ref has changed since the last call. Spans-frustum-
  // boundaries primitives get re-resolved per frustum.
  const resolveDepthSampleBindGroup = () => {
    const currentSource = picking
      ? context._pickClassificationDepthView
      : (context._packedTranslucentDepthView ?? context._globeDepthView);
    if (!currentSource) {
      return null; // fall through to static reference
    }
    if (cache.depthSampleViewRef !== currentSource) {
      cache.depthSampleBindGroup = device.createBindGroup({
        label: "GroundPrimitive depth-sample BG",
        layout: cache._pipelineResources.depthSampleBgl,
        entries: [
          { binding: 0, resource: currentSource },
          { binding: 1, resource: cache.depthSampleSampler },
        ],
      });
      cache.depthSampleViewRef = currentSource;
    }
    return cache.depthSampleBindGroup;
  };

  // Group 2 uses a frustum-state uniform-buffer ring and a per-slice
  // bind-group resolver.
  //
  // The depth → eye recovery in `windowToEye` needs the projection of the
  // slice the fragment is drawn in, but `packUniforms` runs once per frame
  // (command-build) and can only capture one slice. Solve it the same way
  // the depth-source swap does: a bind-group resolver that runs per-draw.
  //
  // Each slice needs a distinct GPU buffer. `device.queue.writeBuffer` is
  // not ordered relative to the command encoder: every write in a frame
  // applies before the command buffer executes, and the last write wins.
  // Writing one shared buffer per slice would leave every slice reading the last
  // slice's projection. So slot the buffers by `_currentFrustumIndex`;
  // each slice writes its own buffer once, the command buffer binds the
  // matching buffer per slice. Buffers + bind groups are lazily grown.
  if (!defined(cache.frustumStateUBOs)) {
    cache.frustumStateUBOs = [];
    cache.frustumStateBindGroups = [];
    cache.frustumStateData = new Float32Array(20); // mat4(16) + frustum vec4(4)
  }
  const ensureFrustumStateSlot = (idx) => {
    let ubo = cache.frustumStateUBOs[idx];
    if (!defined(ubo)) {
      ubo = WebGPUBuffer.createUniformBuffer(
        device,
        256,
        `GroundPrimitive FrustumState UBO slice ${idx}`,
      );
      cache.frustumStateUBOs[idx] = ubo;
      cache.frustumStateBindGroups[idx] = device.createBindGroup({
        label: `GroundPrimitive FrustumState BG slice ${idx}`,
        layout: cache._pipelineResources.frustumStateBgl,
        entries: [{ binding: 0, resource: { buffer: ubo.buffer } }],
      });
    }
    return idx;
  };
  const writeFrustumState = (idx, invProj, near, far, encNear, encFar) => {
    const data = cache.frustumStateData;
    data[0] = near; // perSlice.x
    data[1] = far; // perSlice.y
    data[2] = encNear; // encode.x
    data[3] = encFar; // encode.y
    for (let c = 0; c < 16; c++) {
      data[4 + c] = invProj[c];
    }
    device.queue.writeBuffer(
      cache.frustumStateUBOs[idx].buffer,
      0,
      data.buffer,
      0,
      80, // mat4 (64B) + frustum vec4 (16B)
    );
  };
  // Static fallback (slice 0) seeded from the once-per-frame uniformState
  // — used only if the per-slice publish is absent (resolver returns
  // null). This keeps non-multi-frustum and
  // first-frame paths still get a valid (if not slice-refined) projection.
  // NOTE: fstate carries only the per-slice invProj + band; the globe's
  // LOG-encode frustum is delivered separately via group-0 u.frustum.
  // The globe's LOG-encode frustum is stashed on the SHARED uniformState by the
  // frustum loop (context fields don't cross the GraphicsContext boundary, but
  // uniformState is the same singleton). Packed into fstate.frustum.zw.
  const encNF = frameState.context.uniformState._logDepthEncodeNearFar;
  ensureFrustumStateSlot(0);
  {
    const us = frameState.context.uniformState;
    const invProj0 = us.inverseProjection;
    const cf = us.currentFrustum;
    if (invProj0) {
      const n = cf?.x ?? 0.1;
      const f = cf?.y ?? 1.0e8;
      writeFrustumState(
        0,
        invProj0,
        n,
        f,
        encNF ? encNF[0] : n,
        encNF ? encNF[1] : f,
      );
    }
    cache.frustumStateBindGroup = cache.frustumStateBindGroups[0];
  }
  const resolveFrustumStateBindGroup = () => {
    // Read the shared uniformState rather than `context._currentFrustum*`;
    // those fields live on the renderer's config.context, a different object from this classifier's
    // frameState.context under the GraphicsContext abstraction). uniformState
    // carries this slice's projection + the loop-stashed encode frustum + slice
    // index. This resolver is not currently invoked for the color draw; the
    // static slot 0 below is bound instead, so per-slice encode delivery remains
    // incomplete.
    const us = frameState?.context?.uniformState;
    if (!us) {
      return null;
    }
    const invProj = us.inverseProjection;
    const cf = us.currentFrustum;
    if (!invProj || !cf) {
      return null;
    }
    const idx = us._currentSliceIndex | 0;
    const enc = us._logDepthEncodeNearFar;
    ensureFrustumStateSlot(idx);
    writeFrustumState(
      idx,
      invProj,
      cf.x,
      cf.y,
      enc ? enc[0] : cf.x,
      enc ? enc[1] : cf.y,
    );
    return cache.frustumStateBindGroups[idx];
  };

  // Forward the ClassificationPrimitive's
  // appearance render state so `applyPerEncoderState` runs the dynamic
  // stencilRef / blendConstant / scissor / viewport ops on the depth-sample
  // classifier draws. ClassificationPrimitive's `_appearance` exposes the
  // shared 3-pass renderState set (stencilDepth, color, pick) but the
  // depth-sample architecture collapses those into a single
  // pipeline + classifier shader pair, so here we forward the appearance's
  // top-level renderState (typically the color-pass state) and let the
  // pipeline handle stencil/blend behavior. Falls through to undefined for
  // primitives without an appearance.
  const classificationRS =
    primitive?.appearance?.renderState ??
    primitive?._primitive?.appearance?.renderState;

  // Emit one color command and optional
  // pick) command per relevant pass. The shared draw args are
  // identical across passes; only the `pass` enum differs. Each pick
  // command is attached to its sibling color command via
  // `attachPickToColorCommand` so the dispatcher's pick-pass swap
  // routes correctly. For BOTH (groundPasses.length === 2), this emits
  // two color and two pick commands per primitive.
  // Select the pipeline and vertex-buffer set by scene mode.
  // MORPHING uses the morph pair (consume both 3D + 2D streams,
  // blend EC-space positions in the VS by morphTime); non-morph
  // modes use the standard depth-sample pair (single stream).
  const activeColorPipeline = isMorphing
    ? cache.morphColorPipeline
    : cache.depthSampleColorPipeline;
  const activePickPipeline = isMorphing
    ? cache.morphPickPipeline
    : cache.depthSamplePickPipeline;
  const activeVertexBuffers = isMorphing
    ? [cache.vertexGPUBuffer, cache.vertexGPUBuffer2D]
    : [cache.vertexGPUBuffer];

  // Use the mode-appropriate bounding volume so Cesium's multi-frustum command
  // distribution (View.js createPotentiallyVisibleSet) assigns this
  // classification command to the frustum slice containing its surface.
  // Without a bounding volume, View.js falls back to the full camera
  // near..far (`View.js:374-388`) and `insertIntoBin` dumps the command into
  // every slice including the farthest/empty one — where the textured-
  // material depth-to-eye reconstruction yields a billions-of-
  // metres eye-z and the UV clamps flat.
  //
  // This function serves two primitive shapes that store their volumes
  // differently, which is why the selection is a shared helper rather than a
  // field read. A `GroundPrimitive` owns `_boundingVolumes` (SCENE3D,
  // world-space OrientedBoundingBox from the tile rectangle + terrain
  // min/max) and `_boundingVolumes2D` (non-3D, a BoundingSphere from
  // `fromRectangleWithHeights2D` with its center swizzled to the
  // `(height, projX, projY)` 2D frame) — the pair WebGL reads at
  // `GroundPrimitive.js:925-930`. A directly constructed
  // `ClassificationPrimitive`, which reaches this same function through the
  // CLASSIFICATION_PRIMITIVE feature renderer, has NEITHER field: its volumes
  // are the inner Primitive's four `_boundingSphere*` arrays, which is what
  // WebGL reads at `ClassificationPrimitive.js:1336-1348`. Reading only the
  // GroundPrimitive pair left every standalone ClassificationPrimitive
  // unbounded in every mode, SCENE3D included. Each volume is already in its
  // own mode's space, so neither shape hits a coordinate-space mismatch.
  //
  // Every mode is selected for, SCENE2D and MORPHING included. 2D is not one
  // frustum for distribution purposes: `View.js:575-583` divides the
  // accumulated range by `scene.nearToFarDistance2D` (1.75e6 m), and the
  // no-bounding-volume branch at `View.js:374-388` feeds that range the
  // camera's entire near..far — so an omitted volume CREATES slices rather
  // than merely failing to select one, and the classification blends once per
  // slice.
  const classifyBoundingVolume = selectClassificationBoundingVolume(
    primitive,
    sceneMode,
  );

  const sharedDrawArgs = {
    bindGroups: [
      cache.bindGroup,
      cache.depthSampleBindGroup,
      cache.frustumStateBindGroup,
    ],
    bindGroupResolvers: [
      undefined,
      resolveDepthSampleBindGroup,
      resolveFrustumStateBindGroup,
    ],
    vertexBuffers: activeVertexBuffers,
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    owner: primitive,
    renderState: classificationRS,
    // Distribute to the correct frustum slice. Cull only when
    // we have a valid same-space bounding volume; undefined BV keeps the
    // full-range, no-cull behavior.
    boundingVolume: classifyBoundingVolume,
    cull: defined(classifyBoundingVolume),
  };
  // Derive a velocity command alongside the first color command per primitive
  // when TAA is on and the scene is not morphing; the velocity vertex shader uses the
  // single-stream layout; morph would need its own velocity variant
  // matching the two-stream layout — deferred behind real demand for
  // TAA-during-morph). Per-feature animation isn't possible for static
  // ground classification volumes anyway, so one velocity command per
  // primitive is sufficient.
  const taaEnabled = frameState?.taaEnabled === true;
  const emitVelocity =
    taaEnabled && !isMorphing && defined(cache.velocityPipeline);
  // The velocity VS only consumes locations 0/1 (the 3D high/low
  // position pair), matching the single-stream non-morph layout. When
  // morph is active sharedDrawArgs.vertexBuffers carries two streams,
  // which would mismatch the velocity pipeline's single-buffer
  // expectation — thus the !isMorphing gate above.
  const velocityVertexBuffers = isMorphing ? null : [cache.vertexGPUBuffer];

  const colorCommands = [];
  const pickCommands = [];
  for (let p = 0; p < groundPasses.length; p++) {
    const passEnum = groundPasses[p];
    const colorCmd = new WebGPUDrawCommand({
      ...sharedDrawArgs,
      pipeline: activeColorPipeline,
      pass: passEnum,
    });
    if (emitVelocity && p === 0) {
      colorCmd.velocityCommand = new WebGPUDrawCommand({
        ...sharedDrawArgs,
        // Velocity uses the single-stream vertex buffer layout.
        vertexBuffers: velocityVertexBuffers,
        pipeline: cache.velocityPipeline,
        pass: passEnum,
      });
    }
    if (defined(pickColor)) {
      const pickCmd = new WebGPUDrawCommand({
        ...sharedDrawArgs,
        pipeline: activePickPipeline,
        pass: passEnum,
        pickOnly: true,
      });
      attachPickToColorCommand(colorCmd, pickCmd);
      pickCommands.push(pickCmd);
    }
    colorCommands.push(colorCmd);
  }
  // Stash the most-recent pick command for backwards compatibility with
  // any consumers that read `cache.pickCommand` directly.
  cache.pickCommand =
    pickCommands.length > 0 ? pickCommands[pickCommands.length - 1] : undefined;

  // Emit a CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW command alongside the
  // color command for primitives that classify 3D Tiles. WebGPUSceneRenderer3DTilePasses
  // dispatches pass 7 inside the invert FBO before the regular CLASSIFICATION
  // pass; this command writes stencil=0xff on every classified-surface pixel
  // the volume covers so the stencil-gated composite can distinguish
  // classified vs unclassified regions. TERRAIN_CLASSIFICATION-only
  // primitives don't participate in invert classification — only emit
  // when 3D Tile classification is active (BOTH or CESIUM_3D_TILE).
  let ignoreShowCommand = null;
  // Skip the ignore-show stencil write during morphing.
  // The stencil pipeline binds the single-VB layout (loc 0/1 only),
  // but `sharedDrawArgs.vertexBuffers` carries two streams during
  // morph — WebGPU validates that bound buffer count matches the
  // pipeline's `vertex.buffers` length, so re-using it would fail.
  // Invert classification is a niche path; missing the IGNORE_SHOW
  // stencil mark for the brief morph window is acceptable. Closing
  // this gap fully would need a `morphStencilDescriptor` mirror
  // (cheap follow-up).
  if (groundPasses.includes(6) && !isMorphing) {
    ignoreShowCommand = new WebGPUDrawCommand({
      ...sharedDrawArgs,
      pipeline: cache.depthSampleStencilPipeline,
      // The semantic slot is
      // `Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW`, but this command
      // still uses `Pass.CESIUM_3D_TILE_CLASSIFICATION`; their numeric values
      // diverged when classification passes were inserted. Correcting the
      // dispatch route requires dedicated 3D Tiles classification runtime
      // coverage.
      pass: Pass.CESIUM_3D_TILE_CLASSIFICATION,
      // Stencil reference 0xff — `applyPerEncoderState` reads
      // `stencilTest.reference` and calls `passEncoder.setStencilReference`
      // before the draw. Combined with the pipeline's `passOp: replace`,
      // every rasterized fragment marks stencil=0xff.
      renderState: { stencilTest: { reference: 0xff } },
    });
  }

  return {
    colorPipeline: cache.depthSampleColorPipeline,
    pickPipeline: cache.depthSamplePickPipeline,
    bindGroup: cache.bindGroup,
    // Sentinel — null `stencilCommand` tells the GroundPrimitive consumer
    // to push only `colorCommand(s)`. The legacy stencil 2-pass dispatch
    // shape is kept in the consumer for backwards-compat with any
    // future renderer that wants to emit a stencil pre-pass; in the
    // current depth-sample architecture it's always null.
    stencilCommand: null,
    // Backwards-compatible singular slots — point at the first / last
    // entry of the new arrays so any consumer still reading these keeps
    // working. `colorCommand` mirrors the FIRST color command (matches
    // the historical "single pass per primitive" shape for non-BOTH
    // cases, and is the TERRAIN command for BOTH if present, else the
    // 3D Tile command).
    colorCommand: colorCommands.length > 0 ? colorCommands[0] : null,
    pickCommand: cache.pickCommand,
    ignoreShowCommand,
    // Array-shaped slots let the
    // GroundPrimitive dispatch site iterates these so BOTH
    // classification primitives push two commands (TERRAIN + 3D Tile)
    // instead of one.
    colorCommands,
    pickCommands,
  };
}

function destroyWebGPUGroundPrimitiveResources(primitive) {
  const cache = primitive._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  // Release every geometry GPU buffer on primitive eviction. The mode-flip
  // path destroys and rebuilds vertex buffers, so omitting them here would
  // accumulate allocations across scene-mode changes.
  cache.vertexGPUBuffer?.destroy();
  // Release the morph-side 2D vertex buffer if present.
  cache.vertexGPUBuffer2D?.destroy();
  cache.indexGPUBuffer?.destroy();
  // Pick IDs belong to the inner Cesium Primitive and are released by its
  // destroy path. Do not destroy them here or register a duplicate owner.
  primitive._webgpuCache = undefined;
}

export {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
export default {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
