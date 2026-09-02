import "./installWebGPUTestConstants.js";

import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Cartographic from "../../../Source/Core/Cartographic.js";
import ComponentDatatype from "../../../Source/Core/ComponentDatatype.js";
import GeographicProjection from "../../../Source/Core/GeographicProjection.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import BufferPointCollection from "../../../Source/Scene/BufferPointCollection.js";
import BufferPolylineCollection from "../../../Source/Scene/BufferPolylineCollection.js";
import BufferPolygonCollection from "../../../Source/Scene/BufferPolygonCollection.js";
import SceneMode from "../../../Source/Scene/SceneMode.js";
import {
  bufferPositionNormalizeDivisor,
  normalizeBufferPositionInPlace,
  projectBufferPositionForMode,
} from "../../../Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.js";
import {
  updateWebGPUBufferPointCollection,
  destroyWebGPUBufferPointCollection,
} from "../../../Source/Renderer/WebGPU/WebGPUBufferPointRenderer.js";
import {
  updateWebGPUBufferPolylineCollection,
  destroyWebGPUBufferPolylineCollection,
} from "../../../Source/Renderer/WebGPU/WebGPUBufferPolylineRenderer.js";
import {
  updateWebGPUBufferPolygonCollection,
  destroyWebGPUBufferPolygonCollection,
} from "../../../Source/Renderer/WebGPU/WebGPUBufferPolygonRenderer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lockstep-stride sentinel for the three BufferPrimitive renderers
// (NEW-BUFFERPRIMITIVE-PARITY / batch-bufferprimitive-pack-stride-test).
//
// The highest-risk failure mode of the BufferPrimitive color.alpha-translucency
// parity work is a SILENT CPU-pack-vs-GPU-arrayStride mismatch — the same class
// of bug the parity audit flags as the §C.8 Material-UBO-alignment risk: a stride
// mismatch does not crash, it corrupts. The CPU writes N floats per vertex, the
// pipeline's vertex-buffer layout declares a different arrayStride, and every
// attribute past the divergence point reads garbage that compiles fine and
// renders subtly wrong. When the parity batch widens the packed color lane to
// carry the RGBA alpha (vec3→vec4 / vec2→vec3 / a new polyline lane), the JS
// pack width in `repack*Dirty`, the GPU `arrayStride`/`format` in the pipeline
// vertex layout, and the WGSL `VertexInput` field MUST move in exact lockstep.
//
// This spec is the permanent guard. It does NOT hardcode the post-widening
// layout (that lands in batch-bufferprimitive-parity, a file-isolated sibling).
// Instead it drives the REAL exported `updateWebGPUBuffer*Collection` functions
// through a recording stub `GPUDevice`, then reads the two sources of truth
// straight back out of the renderers:
//
//   1. GPU side  — the `vertex.buffers[n].arrayStride` captured from the
//      `createRenderPipeline` descriptor.
//   2. CPU side  — the per-element byte width derived from the `queue.writeBuffer`
//      payload lengths the renderer emits during the dirty repack/upload, divided
//      by the element-allocation count.
//
// It then asserts, per packed vertex buffer, that CPU-bytes-per-element ===
// GPU-arrayStride. Because both numbers come from the live renderer (not a
// constant the test author guessed), the spec is correct for WHATEVER layout
// the parity batch establishes and goes green once both batches land. A future
// lane addition that desyncs pack from layout fails this spec immediately, with
// a message naming the primitive type, the attribute @location, and the two
// byte counts.
//
// No real `requestAdapter()` / `requestDevice()` is used — the recording device
// returns tagged sentinels and records descriptor arguments — so this runs in
// any Karma browser regardless of WebGPU support.
// ─────────────────────────────────────────────────────────────────────────────

// Recording stub GPUDevice. Each `create*` returns a tagged sentinel; the buffer
// sentinel carries the descriptor `size` so `WebGPUDrawCommand.detectIndexFormat`
// (which reads `indexBuffer.size`) works. `queue.writeBuffer` accumulates the
// total bytes written to each buffer handle so we can recover the CPU pack width.
function createRecordingDevice() {
  const records = {
    pipelines: [],
    // Map<bufferHandle, totalBytesWritten>
    writtenBytes: new Map(),
  };

  let bufferSeq = 0;

  const device = {
    __records: records,
    createBindGroupLayout(descriptor) {
      return { __bgl: true, descriptor };
    },
    createPipelineLayout(descriptor) {
      return { __pipelineLayout: true, descriptor };
    },
    createBindGroup(descriptor) {
      return { __bindGroup: true, descriptor };
    },
    createShaderModule(descriptor) {
      return { __shaderModule: true, descriptor };
    },
    createBuffer(descriptor) {
      // `size` is read by WebGPUDrawCommand.detectIndexFormat; `destroy` is
      // called by the renderer's destroy path. Tag with a sequence id so two
      // distinct buffers never compare equal even if they share a size/label.
      return {
        __buffer: true,
        __seq: bufferSeq++,
        size: descriptor.size,
        label: descriptor.label,
        destroy() {},
      };
    },
    createRenderPipeline(descriptor) {
      const handle = { __pipeline: true, descriptor };
      records.pipelines.push(descriptor);
      return handle;
    },
    queue: {
      writeBuffer(buffer, _offset, data) {
        const prev = records.writtenBytes.get(buffer) ?? 0;
        // `data` is the raw typed array (gpuData() is a pass-through cast), so
        // `byteLength` is the exact CPU payload size for this upload.
        records.writtenBytes.set(buffer, prev + data.byteLength);
      },
    },
  };
  return device;
}

// Stub context — only the fields the three `updateWebGPUBuffer*Collection`
// functions actually read. Picking is OFF (so no `createPickId`), log-depth is
// OFF (so the historical `defines=0` pipeline is built — byte-identical to the
// hyperbolic path), and `scenePipelineFormat` is supplied so the
// `navigator.gpu.getPreferredCanvasFormat()` fallback is never reached.
function createStubContext(device) {
  return {
    device,
    _msaaSamples: 1,
    scenePipelineFormat: "rgba8unorm",
    _scenePipelineFormatGeneration: 0,
    _logDepthWriteEnabled: false,
    drawingBufferWidth: 256,
    drawingBufferHeight: 256,
    // Camera at the origin with identity transforms keeps the debug-only RTE
    // round-trip + zeroed-translation assertions (WebGPURTEAssertions) happy:
    // EncodedCartesian3.fromCartesian((0,0,0)) → high=low=0 (drift 0), and
    // view*model == identity has a zeroed translation column.
    uniformState: makeIdentityUniformState(),
  };
}

function makeIdentityMatrix() {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function makeIdentityUniformState() {
  const identity = makeIdentityMatrix();
  return {
    view: identity,
    projection: identity,
    viewProjection: identity,
    cameraPosition: new Cartesian3(0, 0, 0),
    // Consumed by packCameraLogDepthLanes; benign values (factor derived,
    // never read by a pipeline because LOG_DEPTH is off this frame).
    currentFrustum: { x: 1.0, y: 1.0e7 },
    oneOverLog2FarDepthFromNearPlusOne: 0,
  };
}

function createStubFrameState(context) {
  return {
    context,
    // A real Scene frameState always declares its mode. This stride-only stub
    // predates the shared 2D/CV projection path; leaving mode undefined now
    // (correctly) selects that non-3D path, but without the mapProjection a real
    // frameState would also provide. Keep this fixture explicitly on the
    // byte-identical 3D pack path that the stride assertions are exercising.
    mode: SceneMode.SCENE3D,
    pixelRatio: 1.0,
    useLogDepth: false,
    passes: { render: true, pick: false },
    commandList: [],
  };
}

// Drive a single `update*` call and return everything the assertion needs:
// the captured render pipeline descriptor (GPU arrayStrides) and the draw
// command (its `vertexBuffers` order lines up 1:1 with the pipeline's
// `vertex.buffers[]`), plus the per-handle CPU bytes written.
function captureLayout(collection, updateFn) {
  const device = createRecordingDevice();
  const context = createStubContext(device);
  const frameState = createStubFrameState(context);

  updateFn(collection, frameState);

  // The COLOR pipeline is built first in every initializer (the pick pipeline
  // is the second `createRenderPipeline`); its vertex layout is the one the
  // render-pass draw command uses. The render command is the only command
  // pushed (pick is off).
  const command = frameState.commandList[0];
  expect(command).withContext("render draw command was pushed").toBeDefined();

  // The command's pipeline === the cached COLOR pipeline; recover its descriptor.
  const pipelineDescriptor = command.pipeline.descriptor;
  const gpuBuffers = pipelineDescriptor.vertex.buffers;

  return {
    cache: collection._webgpuCache,
    vertexBuffers: command.vertexBuffers,
    gpuBuffers,
    writtenBytes: device.__records.writtenBytes,
  };
}

// Compare CPU pack width to GPU arrayStride for every packed vertex buffer.
//
// Self-calibrating divisor: slot 0 is always `@location(0) positionHigh`, a
// 3-float RTE high lane (12 bytes/element) that the RTE precision rules forbid
// from ever changing width. We recover the element-allocation count as
// (bytes written to slot 0) / (slot 0 arrayStride), then every other packed
// slot's CPU-bytes-per-element must equal its declared GPU arrayStride.
//
// `excludeHandles` lists per-vertex geometry buffers that carry no per-primitive
// packed data (the point renderer's static quad VB) — those are not part of the
// pack/layout lockstep contract and are skipped.
//
// Returns an array of { location, gpuStride, cpuBytesPerElement } mismatch
// records (empty when everything is in lockstep), so the caller can build a
// message naming the primitive type and the two byte counts.
function findStrideMismatches(captured, excludeHandles) {
  const { vertexBuffers, gpuBuffers, writtenBytes } = captured;

  expect(vertexBuffers.length)
    .withContext("command vertexBuffers count matches pipeline buffer count")
    .toBe(gpuBuffers.length);

  const slot0Bytes = writtenBytes.get(vertexBuffers[0]) ?? 0;
  const slot0Stride = gpuBuffers[0].arrayStride;
  expect(slot0Stride)
    .withContext("slot 0 (positionHigh) declares a nonzero arrayStride")
    .toBeGreaterThan(0);
  expect(slot0Bytes)
    .withContext("slot 0 (positionHigh) received a CPU upload")
    .toBeGreaterThan(0);
  expect(slot0Bytes % slot0Stride)
    .withContext("slot 0 upload is a whole number of elements")
    .toBe(0);

  const allocCount = slot0Bytes / slot0Stride;

  const mismatches = [];
  for (let n = 0; n < gpuBuffers.length; n++) {
    const handle = vertexBuffers[n];
    if (excludeHandles.indexOf(handle) !== -1) {
      continue;
    }
    const gpuStride = gpuBuffers[n].arrayStride;
    const cpuBytes = writtenBytes.get(handle);
    if (cpuBytes === undefined) {
      // A packed slot that received no upload is itself a desync — record it.
      mismatches.push({
        location: gpuBuffers[n].attributes[0].shaderLocation,
        gpuStride,
        cpuBytesPerElement: 0,
      });
      continue;
    }
    const cpuBytesPerElement = cpuBytes / allocCount;
    if (cpuBytesPerElement !== gpuStride) {
      mismatches.push({
        location: gpuBuffers[n].attributes[0].shaderLocation,
        gpuStride,
        cpuBytesPerElement,
      });
    }
  }
  return mismatches;
}

function describeMismatches(type, mismatches) {
  return mismatches
    .map(
      (m) =>
        `${type} @location(${m.location}): CPU pack stride ${m.cpuBytesPerElement} bytes/element ` +
        `!= GPU arrayStride ${m.gpuStride} bytes`,
    )
    .join("; ");
}

describe("Renderer/WebGPU/WebGPUBufferPrimitive pack-vs-arrayStride lockstep", function () {
  it("BufferPoint: CPU pack stride matches GPU arrayStride for every per-instance buffer", function () {
    const collection = new BufferPointCollection({ primitiveCountMax: 4 });
    collection.add({ position: new Cartesian3(0, 0, 0) });

    const captured = captureLayout(
      collection,
      updateWebGPUBufferPointCollection,
    );

    // The static quad VB (per-vertex corner geometry) carries no per-primitive
    // packed data — it is written once at init with a fixed 6-vertex payload and
    // is not part of the pack/layout lockstep contract.
    const excludeHandles = [captured.cache.quadVB];
    const mismatches = findStrideMismatches(captured, excludeHandles);

    expect(mismatches)
      .withContext(describeMismatches("BufferPoint", mismatches))
      .toEqual([]);

    destroyWebGPUBufferPointCollection(collection);
  });

  it("BufferPolyline: CPU pack stride matches GPU arrayStride for every per-vertex buffer", function () {
    const collection = new BufferPolylineCollection({
      primitiveCountMax: 4,
      vertexCountMax: 16,
    });
    collection.add({
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    });

    const captured = captureLayout(
      collection,
      updateWebGPUBufferPolylineCollection,
    );

    // Polyline has no static geometry buffer — every vertex buffer is packed.
    const mismatches = findStrideMismatches(captured, []);

    expect(mismatches)
      .withContext(describeMismatches("BufferPolyline", mismatches))
      .toEqual([]);

    destroyWebGPUBufferPolylineCollection(collection);
  });

  it("BufferPolygon: CPU pack stride matches GPU arrayStride for every per-vertex buffer", function () {
    const collection = new BufferPolygonCollection({
      primitiveCountMax: 4,
      vertexCountMax: 16,
      triangleCountMax: 8,
    });
    collection.add({
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangles: new Uint32Array([0, 1, 2]),
    });

    const captured = captureLayout(
      collection,
      updateWebGPUBufferPolygonCollection,
    );

    // Polygon has no static geometry buffer — every vertex buffer is packed.
    const mismatches = findStrideMismatches(captured, []);

    expect(mismatches)
      .withContext(describeMismatches("BufferPolygon", mismatches))
      .toEqual([]);

    destroyWebGPUBufferPolygonCollection(collection);
  });

  it("the lockstep check itself fails (with type + byte counts) on a one-float desync", function () {
    // Negative control proving the assertion is live: synthesize a captured
    // layout whose GPU arrayStride is widened by one float (4 bytes) past the
    // CPU pack width — exactly the silent corruption a future lane addition
    // would introduce if the pack array were NOT widened in lockstep. The
    // mismatch must be detected and described with the primitive type and the
    // two byte counts.
    const positionHighHandle = { __buffer: true, __seq: 0 };
    const colorHandle = { __buffer: true, __seq: 1 };
    const writtenBytes = new Map();
    // 1 element allocated: positionHigh = 12 bytes (3 floats), color lane
    // packed as 3 floats (12 bytes) on the CPU...
    writtenBytes.set(positionHighHandle, 12);
    writtenBytes.set(colorHandle, 12);
    const captured = {
      vertexBuffers: [positionHighHandle, colorHandle],
      gpuBuffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          // ...but the GPU layout was widened to 4 floats (16 bytes) without a
          // matching CPU pack widening — the silent-corruption desync.
          arrayStride: 16,
          attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }],
        },
      ],
      writtenBytes,
    };

    const mismatches = findStrideMismatches(captured, []);

    expect(mismatches.length).toBe(1);
    expect(mismatches[0].location).toBe(3);
    expect(mismatches[0].gpuStride).toBe(16);
    expect(mismatches[0].cpuBytesPerElement).toBe(12);

    const message = describeMismatches("BufferTestType", mismatches);
    expect(message).toContain("BufferTestType");
    expect(message).toContain("@location(3)");
    expect(message).toContain("12"); // CPU bytes/element
    expect(message).toContain("16"); // GPU arrayStride
  });

  it("keeps the shared BufferPrimitive projection contract explicit in 3D, Columbus View, and 2D", function () {
    const projection = new GeographicProjection();
    const cartographic = Cartographic.fromDegrees(-75.0, 40.0, 120.0);
    const position = projection.ellipsoid.cartographicToCartesian(cartographic);
    const translation = new Cartesian3(25.0, -10.0, 5.0);
    const modelMatrix = Matrix4.fromTranslation(translation);
    const transformedPosition = Matrix4.multiplyByPoint(
      modelMatrix,
      position,
      new Cartesian3(),
    );
    const transformedCartographic =
      projection.ellipsoid.cartesianToCartographic(transformedPosition);
    const projected = projection.project(transformedCartographic);

    const frameState = {
      mode: SceneMode.SCENE3D,
      mapProjection: projection,
      morphTime: 1.0,
    };
    const result = new Cartesian3();

    // In 3D the renderer deliberately keeps collection-local coordinates;
    // the camera/model matrix path applies modelMatrix later.
    expect(
      projectBufferPositionForMode(position, frameState, modelMatrix, result),
    ).toEqual(position);

    frameState.mode = SceneMode.COLUMBUS_VIEW;
    expect(
      projectBufferPositionForMode(position, frameState, modelMatrix, result),
    ).toEqualEpsilon(
      new Cartesian3(projected.z, projected.x, projected.y),
      1.0e-7,
    );

    frameState.mode = SceneMode.SCENE2D;
    expect(
      projectBufferPositionForMode(position, frameState, modelMatrix, result),
    ).toEqualEpsilon(new Cartesian3(0.0, projected.x, projected.y), 1.0e-7);
  });

  it("preserves normalized integer position divisors and signed-endpoint clamping", function () {
    const collection = {
      _positionNormalized: true,
      _positionDatatype: ComponentDatatype.BYTE,
    };
    const cases = [
      [ComponentDatatype.BYTE, 127.0],
      [ComponentDatatype.UNSIGNED_BYTE, 255.0],
      [ComponentDatatype.SHORT, 32767.0],
      [ComponentDatatype.UNSIGNED_SHORT, 65535.0],
      [ComponentDatatype.INT, 2147483647.0],
      [ComponentDatatype.UNSIGNED_INT, 4294967295.0],
    ];

    for (const [datatype, divisor] of cases) {
      collection._positionDatatype = datatype;
      expect(bufferPositionNormalizeDivisor(collection)).toBe(divisor);
    }

    collection._positionDatatype = ComponentDatatype.FLOAT;
    expect(bufferPositionNormalizeDivisor(collection)).toBe(0);
    collection._positionNormalized = false;
    collection._positionDatatype = ComponentDatatype.BYTE;
    expect(bufferPositionNormalizeDivisor(collection)).toBe(0);

    const signedBytePosition = new Cartesian3(-128.0, 64.0, 127.0);
    normalizeBufferPositionInPlace(signedBytePosition, 127.0);
    expect(signedBytePosition.x).toBe(-1.0);
    expect(signedBytePosition.y).toBeCloseTo(64.0 / 127.0, 14);
    expect(signedBytePosition.z).toBe(1.0);
  });
});
