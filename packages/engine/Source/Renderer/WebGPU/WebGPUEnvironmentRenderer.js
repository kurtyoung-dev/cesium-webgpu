/**
 * @module WebGPUEnvironmentRenderer
 *
 * Handles WebGPU rendering of celestial bodies (Sun, Moon) and Fog integration.
 * Sun uses a procedurally generated texture rendered as a billboard quad.
 * Moon uses a textured sphere with simple diffuse lighting.
 * Fog is applied via fog density parameters passed to globe/atmosphere shaders.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import createGuid from "../../Core/createGuid.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Resource from "../../Core/Resource.js";
import MoonShaderCode from "../../Shaders/WebGPU/Environment/Moon.js";
import { WebGPUImageUpload } from "./WebGPUImageUpload.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
// Phase 1.x consolidation — shared bounding-cube + base uniform pack
// for ellipsoid bodies. Moon is the first consumer; future Sun-as-
// ellipsoid and custom planet renderers will share these helpers.
import {
  createEllipsoidBoundingCube,
  createEllipsoidBindGroupLayout,
  packEllipsoidBaseUniforms,
} from "./WebGPUEllipsoidRenderer.js";

const UNIFORM_BUFFER_SIZE = 256;
// Moon uses a slightly larger uniform buffer to fit the full Phase 1.2c v2
// state (RTE moon center + camera split + 3x3 inverse-modelView + radii +
// 2 light directions + celestial state + Phong tunables + log-depth far).
const MOON_UNIFORM_BUFFER_SIZE = 320;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
// Phase 1.x consolidation — the inverseModelView3, cameraMC, sunMC,
// sceneLightMC, inverseModelMatrix, and inverseModelRot3 scratches that
// the old `_packMoonUniforms` body used were moved into
// `WebGPUEllipsoidRenderer.ts` along with the base uniform pack. The
// scratches kept here are still used by the Sun renderer
// (`scratchEncodedPos`, `scratchEncodedCamera`) and the Moon
// behind-camera early-out (`scratchMoonPositionWC`, `scratchCameraToMoon`).
const scratchEncodedCamera = new EncodedCartesian3();
const scratchMoonPositionWC = new Cartesian3();
const scratchCameraToMoon = new Cartesian3();
const scratchEncodedPos = new EncodedCartesian3();

// ============================================================
// Sun Renderer
// ============================================================

/**
 * Creates sun procedural texture via CPU fallback.
 * @private
 */
function createSunTexture(device, size) {
  const texture = device.createTexture({
    label: "Sun procedural texture",
    size: [size, size, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });

  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dist = Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2.0;

      const disk =
        dist < 0.85 ? 1.0 : dist < 0.9 ? 1.0 - (dist - 0.85) / 0.05 : 0.0;
      const corona = Math.exp(-dist * dist * 3.0) * 0.6;
      const limb = 1.0 - Math.pow(dist * 0.95, 4.0);
      const brightness = Math.max(disk * Math.max(limb, 0), corona);

      const idx = (y * size + x) * 4;
      pixels[idx + 0] = Math.min(255, brightness * 255);
      pixels[idx + 1] = Math.min(255, brightness * 0.95 * 255);
      pixels[idx + 2] = Math.min(255, brightness * 0.8 * 255);
      pixels[idx + 3] = Math.min(255, Math.max(0, brightness) * 255);
    }
  }

  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [
    size,
    size,
    1,
  ]);

  return texture;
}

/**
 * Creates sun quad vertices.
 * @private
 */
function createSunQuadBuffer(device, sunPosition) {
  EncodedCartesian3.fromCartesian(sunPosition, scratchEncodedPos);
  const h = scratchEncodedPos.high;
  const l = scratchEncodedPos.low;

  // 6 vertices: posHigh(3) + posLow(3) + direction(2) = 8 floats
  const vertices = new Float32Array([
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    -1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    1,
    1,
    h.x,
    h.y,
    h.z,
    l.x,
    l.y,
    l.z,
    -1,
    1,
  ]);

  const buffer = WebGPUBuffer.createVertexBuffer(
    device,
    vertices,
    "Sun vertices",
  );
  return buffer;
}

function packSunUniforms(uniformData, frameState) {
  const uniformState = frameState.context.uniformState;
  Matrix4.clone(uniformState.view, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  uniformData[24] = 0.02; // sunSize.x
  uniformData[25] = 0.02; // sunSize.y
  uniformData[26] = 1.0; // glowFactor
  uniformData[27] = 0.0;
}

/**
 * Updates WebGPU Sun rendering.
 */
function updateWebGPUSun(sun, frameState, commandList) {
  if (!sun.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;

  if (!defined(sun._webgpuCache)) {
    sun._webgpuCache = {};
  }
  const cache = sun._webgpuCache;

  if (!defined(cache.sunTexture)) {
    cache.sunTexture = createSunTexture(device, 256);
    cache.sunTextureView = cache.sunTexture.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
  }

  if (!defined(cache.pipeline)) {
    const shaderModule = device.createShaderModule({
      label: "Sun shader",
      code: `
struct Uniforms {
  mvpRTE: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>, _p0: f32,
  encodedCameraLow: vec3<f32>, _p1: f32,
  sunSize: vec2<f32>, glowFactor: f32, _p2: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@location(0) posH: vec3<f32>, @location(1) posL: vec3<f32>, @location(2) dir: vec2<f32>) -> VOut {
  var o: VOut;
  let rte = (posH - u.encodedCameraHigh) + (posL - u.encodedCameraLow);
  var cp = u.mvpRTE * vec4f(rte, 1.0);
  cp.x += dir.x * u.sunSize.x * cp.w;
  cp.y += dir.y * u.sunSize.y * cp.w;
  // Clamp the sun to the far plane. Without this the sun (world-space ~1.5e11 m)
  // gets frustum-clipped at every camera altitude whose far plane is < 1.5e11 m
  // \u2014 which is every multi-frustum slice except possibly the last.
  // Setting clip-z = clip-w maps to NDC z = 1.0, i.e. the far plane, so the
  // "less-equal" depth compare still allows the sun to render against any
  // previously-cleared depth value.
  o.pos = vec4f(cp.x, cp.y, cp.w, cp.w);
  o.uv = dir * 0.5 + 0.5; return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let tc = textureSample(tex, samp, i.uv);
  let d = length(i.uv - vec2f(0.5));
  let g = exp(-d * d * 8.0) * u.glowFactor;
  return vec4f(tc.rgb + vec3f(g), clamp(tc.a + g * 0.5, 0.0, 1.0));
}`,
    });

    const bgl = makeBindGroupLayout(device, "Sun BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
    ]);

    cache.pipeline = device.createRenderPipeline({
      label: "Sun pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [
          {
            format: context.presentationFormat || "bgra8unorm",
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: context.depthFormat || "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    cache.bindGroupLayout = bgl;
  }

  // Prefer the live rotating sun position from UniformState. `frameState.sunPositionWC`
  // is not populated anywhere in the engine today, so without this the quad
  // used to snap back to a static axis-aligned position and never rotated with
  // Earth's day/night cycle.
  const sunPos =
    frameState.context?.uniformState?.sunPositionWC ||
    frameState.sunPositionWC ||
    new Cartesian3(1.5e11, 0, 0);
  if (
    !defined(cache.vertexBuffer) ||
    !Cartesian3.equals(cache.lastSunPos, sunPos)
  ) {
    if (defined(cache.vertexBuffer)) {
      cache.vertexBuffer.destroy();
    }
    cache.vertexBuffer = createSunQuadBuffer(device, sunPos);
    cache.lastSunPos = Cartesian3.clone(sunPos);
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      undefined,
      "Sun uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }
  packSunUniforms(cache.uniformData, frameState);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  cache.bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      { binding: 1, resource: cache.sunTextureView },
      { binding: 2, resource: cache.sampler },
    ],
  });

  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexBuffer],
    vertexCount: 6,
    pass: 0, // Pass.ENVIRONMENT
    owner: sun,
  });

  commandList.push(cache.command);
}

// ============================================================
// Moon Renderer — Ray-Marched Analytic Ellipsoid (Phase 1.2c)
// ============================================================

/**
 * Bounding cube for the ray-marched moon shader. Phase 1.x consolidation:
 * the geometry was extracted to `WebGPUEllipsoidRenderer.ts` so future
 * ellipsoid bodies (Sun-as-ellipsoid, custom planets) can share the
 * same 8-vert / 36-index unit cube. The vertex shader still scales by
 * `radii` to wrap the moon ellipsoid, mirroring WebGL's
 * `EllipsoidPrimitive` which uses `BoxGeometry.fromDimensions({2,2,2})`.
 *
 * Why a cube and not a full-screen quad: the cube's screen footprint is
 * the moon's actual on-screen size, so the fragment shader runs only on
 * pixels that could possibly contain the moon. A full-screen quad would
 * run the FS on every pixel of the canvas (~8M FS invocations at 4K),
 * all of which would discard early but still cost rasterizer scheduling.
 *
 * @private
 */
function createMoonBoundingCube(device) {
  return createEllipsoidBoundingCube(device);
}

/**
 * Creates the Moon rendering pipeline (textured sphere + diffuse lighting).
 * @private
 */
function createMoonPipeline(device, format, depthFormat) {
  // Shader validation is handled centrally by WebGPUContext's
  // _installShaderValidation wrapper — no per-site validation needed.
  const mod = device.createShaderModule({
    label: "Moon shader",
    code: MoonShaderCode,
  });

  // Phase 1.x consolidation — use the shared bind group layout from
  // WebGPUEllipsoidRenderer so future ellipsoid bodies match exactly.
  const bgl = createEllipsoidBindGroupLayout(device);

  const pipeline = device.createRenderPipeline({
    label: "Moon pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: mod,
      entryPoint: "vs",
      // Phase 1.2c v2 — bounding cube vertex layout. 12 bytes per vertex,
      // 8 vertices, 36 indices.
      buffers: [
        {
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, // cubePos
          ],
        },
      ],
    },
    fragment: {
      module: mod,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "zero",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "zero",
              operation: "add",
            },
          },
        },
      ],
    },
    // Bounding cube — cull back faces. We render the front faces of the
    // cube and the FS ray-marches inward. If the camera enters the cube
    // (close-up moon flythrough), back-face culling would discard the
    // visible faces — handled in JS by switching cullMode dynamically OR
    // by accepting that close-up flythroughs are out of scope. For now
    // we cull back faces; close-up flythrough is a follow-up.
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: depthFormat,
      // Moon is rendered at the far plane (vertex shader forces z/w=1)
      // and composited with `less-equal`, so it only draws in pixels
      // not already occluded by closer geometry. This is draw-order
      // agnostic — unlike the prior `depthCompare: always` path which
      // relied on the moon being issued before terrain.
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  });

  return { pipeline, bgl };
}

/**
 * Asynchronously loads the real moon texture and replaces the placeholder.
 * Idempotent — re-running with the same URL is a no-op while a load is in
 * flight; the cache tracks `_textureLoading` and `_cachedTextureUrl` to
 * prevent duplicate fetches and to detect URL changes at runtime.
 *
 * On success, the new GPU texture replaces `cache.moonTexture` /
 * `moonTextureView`. The bind group is recreated each frame in
 * `updateWebGPUMoon`, so the new texture picks up automatically on the
 * next frame.
 *
 * On failure, logs once and keeps the placeholder. No retries.
 *
 * @private
 */
function _loadRealMoonTexture(device, cache, textureUrl) {
  if (cache._textureLoading) {
    return;
  }
  if (cache._cachedTextureUrl === textureUrl) {
    return;
  }
  cache._textureLoading = true;
  cache._cachedTextureUrl = textureUrl;

  Resource.createIfNeeded(textureUrl)
    .fetchImage()
    .then(function (image) {
      const width = image.width;
      const height = image.height;
      const newTexture = device.createTexture({
        label: "Moon texture",
        size: [width, height, 1],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      return WebGPUImageUpload.uploadImageToTexture(
        device,
        image,
        newTexture,
      ).then(function () {
        // Destroy the placeholder before replacing.
        if (defined(cache.moonTexture)) {
          cache.moonTexture.destroy();
        }
        cache.moonTexture = newTexture;
        cache.moonTextureView = newTexture.createView();
        cache._textureLoading = false;
        // Invalidate the bind group + render bundle so the next frame
        // rebuilds them with the new texture view. The bundle manager's
        // invalidate() is called from updateWebGPUMoon when it sees the
        // _bundleStale flag.
        cache.bindGroup = undefined;
        cache._bundleStale = true;
      });
    })
    .catch(function (err) {
      console.warn(
        "[WebGPUEnvironmentRenderer] Moon texture load failed:",
        err && err.message ? err.message : err,
      );
      cache._textureLoading = false;
      // Leave _cachedTextureUrl set so we don't retry the same broken URL
      // on every frame. A subsequent change to moon.textureUrl will trigger
      // a fresh load.
    });
}

/**
 * Creates a placeholder 4x4 gray texture for the Moon when the real texture hasn't loaded.
 * @private
 */
function createMoonPlaceholderTexture(device) {
  const size = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = 180;
    pixels[i * 4 + 1] = 180;
    pixels[i * 4 + 2] = 180;
    pixels[i * 4 + 3] = 255;
  }
  const texture = device.createTexture({
    label: "Moon placeholder",
    size: [size, size, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [
    size,
    size,
    1,
  ]);
  return texture;
}

/**
 * Updates WebGPU Moon rendering — Phase 1.2c v2.
 *
 * Architecture: bounding-cube rasterization + analytic ray-marched
 * ellipsoid in model space + RTE 64-bit precision in the VS. Mirrors the
 * WebGL EllipsoidPrimitive moon path with full feature parity, plus the
 * Phase 1.2 celestial improvements (phase gating, earthshine).
 *
 * Performance leverage from Phase 0:
 *   - Render bundle pre-encoding via WebGPURenderBundleManager. The
 *     pipeline + bind group + vertex/index buffer + draw call sequence
 *     is identical every frame; we cache the encoded bundle and replay
 *     it. The uniform buffer contents change each frame (writeBuffer),
 *     but the bundle reads from the same buffer object so the new data
 *     just shows up on the next replay.
 *   - SnapshotModeService freezable registration. When snapshot mode is
 *     active, the moon's per-frame uniform writes still happen on the
 *     first frame after entering, then become a no-op until thaw — the
 *     bundle replays the captured uniforms verbatim.
 *   - Behind-camera early-out before any work, so a moon below the
 *     horizon doesn't even submit a draw command.
 *
 * @private
 */
function updateWebGPUMoon(moon, frameState, commandList) {
  if (!moon.show) {
    return;
  }
  const context = frameState.context;
  const device = context.device;
  if (!device) {
    return;
  }

  if (!defined(moon._webgpuCache)) {
    moon._webgpuCache = {};
  }
  const cache = moon._webgpuCache;

  // ── Behind-camera early-out ─────────────────────────────────────────
  // If the moon is fully behind the camera, don't submit anything. The
  // bounding cube would be culled by the rasterizer anyway, but skipping
  // the draw command avoids the bundle execute and the per-frame uniform
  // writes too.
  const cameraPosWC = frameState.camera.positionWC;
  const cameraDirWC = frameState.camera.directionWC;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;
  Matrix4.getTranslation(modelMatrix, scratchMoonPositionWC);
  Cartesian3.subtract(scratchMoonPositionWC, cameraPosWC, scratchCameraToMoon);
  // Pad by max radius so a partially-visible moon at the screen edge is
  // still drawn. Cheap conservative test.
  const maxRadius = Math.max(
    moon._ellipsoid.radii.x,
    moon._ellipsoid.radii.y,
    moon._ellipsoid.radii.z,
  );
  const dotForward = Cartesian3.dot(scratchCameraToMoon, cameraDirWC);
  if (dotForward < -maxRadius) {
    return; // moon is fully behind the camera
  }

  // ── One-time resource creation ──────────────────────────────────────

  // Bounding cube geometry (8 verts, 36 indices)
  if (!defined(cache.geometry)) {
    cache.geometry = createMoonBoundingCube(device);
  }

  // Pipeline + bind group layout. Guarded by pushErrorScope so a shader
  // compilation failure doesn't poison the command encoder — the moon
  // just silently doesn't render instead of killing the whole frame.
  if (!defined(cache.pipeline) && !cache._pipelineFailed) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    device.pushErrorScope("validation");
    const result = createMoonPipeline(device, format, depthFmt);
    device.popErrorScope().then((error) => {
      if (error) {
        console.error(
          `[WebGPU:Moon] Pipeline creation failed: ${error.message}`,
        );
        cache._pipelineFailed = true;
        cache.pipeline = undefined;
      }
    });
    cache.pipeline = result.pipeline;
    cache.bgl = result.bgl;
  }

  // Moon texture (placeholder until async load completes)
  if (!defined(cache.moonTexture)) {
    cache.moonTexture = createMoonPlaceholderTexture(device);
    cache.moonTextureView = cache.moonTexture.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
  }
  if (defined(moon.textureUrl)) {
    _loadRealMoonTexture(device, cache, moon.textureUrl);
  }

  // Uniform buffer (Phase 1.2c v2 layout = 320 bytes / 80 floats)
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      MOON_UNIFORM_BUFFER_SIZE,
      undefined,
      "Moon uniforms",
    );
    cache.uniformData = new Float32Array(MOON_UNIFORM_BUFFER_SIZE / 4);
  }

  // Bind group (recreated whenever the texture changes; see invalidation
  // path in _loadRealMoonTexture which clears cache.bindGroup).
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      label: "Moon bind group",
      layout: cache.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: cache.moonTextureView },
        { binding: 2, resource: cache.sampler },
      ],
    });
    // Bind group changed → render bundle (if any) is stale.
    cache._bundleStale = true;
  }

  // Snapshot mode freezable registration. First-time only. Each Moon
  // instance gets one freezable registration; the freezable just toggles
  // a flag the per-frame path consults to skip uniform writes. The
  // service reference is stashed on the cache so destroy() can
  // unregister later — without it, the closure would leak after the
  // moon's GPU resources are destroyed.
  if (!cache._snapshotRegistered) {
    const scene = frameState.scene;
    if (defined(scene) && defined(scene.snapshotMode)) {
      scene.snapshotMode.registerFreezable(
        "moon-renderer",
        createMoonFreezable(cache),
      );
      cache._snapshotRegistered = true;
      cache._snapshotService = scene.snapshotMode;
    }
  }

  // ── Per-frame uniform pack ──────────────────────────────────────────
  //
  // Skip the entire pack-and-write when the snapshot service has frozen
  // us. The bundle's recorded `setBindGroup` still points at the same
  // GPU uniform buffer, so it reads whatever was last written.
  if (!cache._frozen) {
    _packMoonUniforms(moon, frameState, cache);
    device.queue.writeBuffer(
      cache.uniformBuffer.buffer,
      0,
      cache.uniformData.buffer,
      cache.uniformData.byteOffset,
      cache.uniformData.byteLength,
    );
  }

  // ── Render bundle: pre-encoded draw sequence ────────────────────────
  //
  // The pipeline + bind group + vertex/index buffer + indexed draw is
  // identical every frame, so we record it once into a GPURenderBundle
  // and replay it via executeBundles. WebGPURenderBundleManager handles
  // caching and eviction. The bundle becomes stale on:
  //   - first frame for this moon
  //   - texture upgrade (cache.bindGroup replaced)
  //   - explicit invalidation
  // Bundle key includes the surface format set so different render passes
  // (e.g. picking) get their own bundles.
  // Skip bundle creation if the pipeline failed validation — prevents
  // an invalid pipeline from producing an invalid bundle that would
  // poison the entire command encoder on executeBundles.
  const bundleMgr = context.renderBundleManager;
  if (defined(bundleMgr) && defined(cache.pipeline) && !cache._pipelineFailed) {
    const bundleKey = `moon:${moon._cacheId ?? (moon._cacheId = createGuid())}:${context.presentationFormat}:${context.depthFormat}`;
    if (cache._bundleStale) {
      bundleMgr.invalidate(bundleKey);
      cache._bundleStale = false;
    }
    const bundle = bundleMgr.getOrCreate(
      bundleKey,
      {
        colorFormats: [context.presentationFormat || "bgra8unorm"],
        depthStencilFormat: context.depthFormat || "depth24plus-stencil8",
        label: "Moon bundle",
      },
      function (encoder) {
        encoder.setPipeline(cache.pipeline);
        encoder.setBindGroup(0, cache.bindGroup);
        encoder.setVertexBuffer(0, cache.geometry.vertexBuffer.buffer);
        encoder.setIndexBuffer(cache.geometry.indexBuffer, "uint16");
        encoder.drawIndexed(cache.geometry.indexCount);
        return 1; // one draw call
      },
    );
    cache.bundle = bundle;
  }

  // ── Submit ──────────────────────────────────────────────────────────
  //
  // Build a draw command that carries the bundle. The Pass.ENVIRONMENT
  // executor will call executeBundles when it sees `command.bundle` set.
  // For renderers that don't yet support bundle execution, the command
  // also carries the pipeline/bindgroup/buffers so it can fall back to
  // a normal indexed draw.
  cache.command = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.geometry.vertexBuffer],
    indexBuffer: cache.geometry.indexBuffer,
    indexCount: cache.geometry.indexCount,
    indexFormat: "uint16",
    pass: 0, // Pass.ENVIRONMENT
    owner: moon,
  });
  // Attach the bundle so a bundle-aware pass executor can replay it
  // instead of recording the draw calls again.
  if (defined(cache.bundle)) {
    cache.command.bundle = cache.bundle;
  }

  commandList.push(cache.command);
}

/**
 * Packs the moon uniform buffer for one frame. Pulled out of
 * updateWebGPUMoon so the snapshot-mode skip path is a single conditional.
 *
 * Layout matches the `U` struct in Moon.wgsl (Phase 1.2c v2):
 *   mvpRTE             0..15  (mat4)
 *   camH + pad         16..19
 *   camL + pad         20..23
 *   moonH + pad        24..27
 *   moonL + pad        28..31
 *   ivmRow0 + pad      32..35
 *   ivmRow1 + pad      36..39
 *   ivmRow2 + pad      40..43
 *   cameraPosMC + pad  44..47
 *   radii + pad        48..51
 *   oneOverRadiiSq+pad 52..55
 *   sunDirMC + onlySun 56..59
 *   sceneLightMC + pad 60..63
 *   moonDirWC + phase  64..67
 *   shineFlag/log/shin/spec 68..71
 *   farPlane + 3 pad   72..75
 *   spare              76..79
 *
 * @private
 */
function _packMoonUniforms(moon, frameState, cache) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const ellipsoidPrimitive = moon._ellipsoidPrimitive;
  const modelMatrix = ellipsoidPrimitive.modelMatrix;
  const viewMatrix = uniformState.view;
  const projMatrix = uniformState.projection;

  // Compute mvpRelativeToEye: projection × (view × model with the moon
  // translation zeroed). Same math as before; the body translation is
  // applied via the RTE position split written by the shared packer.
  Matrix4.multiply(viewMatrix, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(projMatrix, scratchMVRTE, scratchMVPRTE);

  const ud = cache.uniformData;
  ud.fill(0);

  // ── Phase 1.x consolidation: shared base uniform pack (offsets 0..63) ──
  // Fills mvpRTE, camH/L split, centerH/L split, ivmRow0..2, cameraPosMC,
  // radii, oneOverRadiiSq, sunDirMC, sceneLightDirMC. Body-specific
  // writes follow at offsets 64+.
  packEllipsoidBaseUniforms(ud, {
    mvpRelativeToEye: scratchMVPRTE,
    viewMatrix: viewMatrix,
    cameraPositionWC: frameState.camera.positionWC,
    modelMatrix: modelMatrix,
    radii: moon._ellipsoid.radii,
    oneOverRadiiSquared: moon._ellipsoid.oneOverRadiiSquared,
    sunDirectionWC: uniformState.sunDirectionWC,
    sceneLightDirectionWC: defined(uniformState.lightDirectionWC)
      ? uniformState.lightDirectionWC
      : uniformState.sunDirectionWC,
  });

  // The shared packer leaves the .w slot of sunDirMC (offset 59) at zero.
  // The Moon shader uses that slot for the `onlySunLighting` flag.
  ud[59] = moon.onlySunLighting === false ? 0.0 : 1.0;

  // ── Moon-specific uniforms (offsets 64..79) ──
  const moonDirWC = frameState.moonDirectionWC;
  const ac = frameState.atmosphericConditions;
  const earthshineOn =
    defined(ac) && defined(ac.lighting) && ac.lighting.enableEarthshine === true
      ? 1.0
      : 0.0;

  // moonDirWC + phaseFraction — offsets 64..67
  ud[64] = defined(moonDirWC) ? moonDirWC.x : 0.0;
  ud[65] = defined(moonDirWC) ? moonDirWC.y : 0.0;
  ud[66] = defined(moonDirWC) ? moonDirWC.z : 0.0;
  ud[67] = frameState.moonPhaseFraction ?? 1.0;

  // earthshine, useLogDepth, shininess, specularStrength — offsets 68..71
  ud[68] = earthshineOn;
  ud[69] = frameState.useLogDepth === true ? 1.0 : 0.0;
  ud[70] = 5.0; // shininess (Phong exponent — rocky lunar surface)
  ud[71] = 0.3; // specularStrength

  // farPlane + 3 pad — offsets 72..75
  ud[72] = defined(uniformState.currentFrustum)
    ? uniformState.currentFrustum.y
    : 1.0e9;
  ud[73] = 0;
  ud[74] = 0;
  ud[75] = 0;

  // Offsets 76..79 are spare; ud.fill(0) above already zeroed them.
}

/**
 * Build a SnapshotFreezable-shaped object for a moon cache. Mirrors the
 * pattern used by `WebGPURenderBundleManager.asFreezable()` and
 * `WebGPUVolumetricFogRenderer.asFreezable()` so the registration site
 * is symmetric and the spec layer can drive the freezable contract
 * without needing a real GPU device.
 *
 * @param {object} cache The moon's `_webgpuCache` object.
 * @returns {{ name: string, freeze: function, thaw: function, isFrozen: function }}
 */
function createMoonFreezable(cache) {
  return {
    name: "moon-renderer",
    freeze: function () {
      cache._frozen = true;
    },
    thaw: function () {
      cache._frozen = false;
    },
    isFrozen: function () {
      return cache._frozen === true;
    },
  };
}

/**
 * Phase 6 debug surface — return a diagnostic snapshot of a Moon's
 * WebGPU cache. Returns `null` when the moon hasn't yet had its first
 * `update()` call (cache absent) or when called against a non-WebGPU
 * scene. Pure read; safe to call from `Scene.getDebugSnapshot()`.
 *
 * @param {Moon} moon
 * @returns {object|null}
 */
function getWebGPUMoonStatistics(moon) {
  if (!defined(moon) || !defined(moon._webgpuCache)) {
    return null;
  }
  const cache = moon._webgpuCache;
  // Pull the moon-specific uniforms back out of the packed buffer for
  // a quick "what got pushed to the GPU last frame" view. The offsets
  // here mirror `_packMoonUniforms()` (offsets 64..75 are moon tail).
  const ud = cache.uniformData;
  const moonDirWC =
    defined(ud) && ud.length > 67 ? { x: ud[64], y: ud[65], z: ud[66] } : null;
  const phaseFraction = defined(ud) && ud.length > 67 ? ud[67] : null;
  const earthshineOn = defined(ud) && ud.length > 68 ? ud[68] === 1.0 : null;
  const useLogDepth = defined(ud) && ud.length > 69 ? ud[69] === 1.0 : null;
  const shininess = defined(ud) && ud.length > 70 ? ud[70] : null;
  const specularStrength = defined(ud) && ud.length > 71 ? ud[71] : null;
  return {
    backend: "webgpu",
    pipelineReady: defined(cache.pipeline),
    bindGroupReady: defined(cache.bindGroup),
    moonTextureLoaded: defined(cache.moonTexture),
    moonTextureUrl: cache.moonTextureUrl ?? null,
    bundleStale: cache._bundleStale === true,
    snapshotRegistered: cache._snapshotRegistered === true,
    frozen: cache._frozen === true,
    moonDirectionWC: moonDirWC,
    phaseFraction,
    earthshineOn,
    useLogDepth,
    shininess,
    specularStrength,
  };
}

// ============================================================
// Fog Integration
// ============================================================

/**
 * Extracts fog parameters for WebGPU shaders.
 * @param {Fog} fog
 * @param {FrameState} frameState
 * @returns {{ density: number, minimumBrightness: number }}
 */
function getWebGPUFogParameters(fog, frameState) {
  if (!fog || !fog.enabled) {
    return { density: 0.0, minimumBrightness: 0.0 };
  }
  return {
    density: frameState.fog.density || 0.0,
    minimumBrightness: frameState.fog.minimumBrightness || 0.03,
  };
}

// ============================================================
// Cleanup
// ============================================================

function destroyWebGPUSunResources(sun) {
  const cache = sun._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.vertexBuffer)) {
    cache.vertexBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.sunTexture)) {
    cache.sunTexture.destroy();
  }
  sun._webgpuCache = undefined;
}

function destroyWebGPUMoonResources(moon) {
  const cache = moon._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  // Phase 6 audit fix — the moon registers a "moon-renderer" freezable
  // with `scene.snapshotMode` during update(). The closure captures the
  // `cache` object; without explicit unregistration, the registration
  // outlives the moon's GPU resources and freeze()/thaw() would mutate
  // a destroyed cache on the next snapshot enter/exit.
  if (cache._snapshotRegistered && defined(cache._snapshotService)) {
    try {
      cache._snapshotService.unregisterFreezable("moon-renderer");
    } catch (e) {
      console.warn("[WebGPU:Moon] unregisterFreezable failed:", e);
    }
    cache._snapshotRegistered = false;
    cache._snapshotService = undefined;
  }
  if (defined(cache.geometry)) {
    if (defined(cache.geometry.vertexBuffer)) {
      cache.geometry.vertexBuffer.destroy();
    }
    if (defined(cache.geometry.indexBuffer)) {
      cache.geometry.indexBuffer.destroy();
    }
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.moonTexture)) {
    cache.moonTexture.destroy();
  }
  moon._webgpuCache = undefined;
}

export {
  updateWebGPUSun,
  updateWebGPUMoon,
  getWebGPUFogParameters,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
  createMoonFreezable,
};

export default {
  updateWebGPUSun,
  updateWebGPUMoon,
  getWebGPUFogParameters,
  destroyWebGPUSunResources,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
  createMoonFreezable,
};
