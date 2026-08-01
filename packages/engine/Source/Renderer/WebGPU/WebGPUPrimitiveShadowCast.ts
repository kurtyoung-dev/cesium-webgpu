import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

const PRIMITIVE_RTE_SHADOW_CAST_LAYOUT = "primitiveRte24";
const PRIMITIVE_SHADOW_CAST_FLOATS = 24;
const PRIMITIVE_SHADOW_CAST_BYTES =
  PRIMITIVE_SHADOW_CAST_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const PRIMITIVE_SHADOW_CAST_INPUT_FLOATS = 19;

interface PrimitiveShadowCastUploadState {
  currentWords: Uint32Array;
  uploadedWords: Uint32Array;
  uploaded: boolean;
}

interface PrimitiveShadowCastHost {
  primitiveShadowCastData?: Float32Array;
  primitiveShadowCastInputState?: Float64Array;
  primitiveShadowCastUB?: WebGPUBuffer;
  primitiveShadowCastUploadState?: PrimitiveShadowCastUploadState;
  primitiveShadowCastDevice?: GPUDevice;
}

interface PrimitiveShadowCastCommand {
  _shadowCastLayout?: string;
  _shadowCastPrimitiveUB?: WebGPUBuffer;
  _shadowCastBindGroupCacheHost?: object;
  _primitiveShadowCastHost?: PrimitiveShadowCastHost;
  vertexStride?: number;
}

const scratchInverseModel = new Matrix4();
const scratchModelLinear = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchEncodedCamera = new EncodedCartesian3();

function createUploadState(data: Float32Array): PrimitiveShadowCastUploadState {
  return {
    currentWords: new Uint32Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    ),
    uploadedWords: new Uint32Array(
      data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    ),
    uploaded: false,
  };
}

function inputsEqual(
  state: Float64Array,
  modelMatrix: Matrix4,
  cameraPositionWC: Cartesian3,
): boolean {
  for (let i = 0; i < 16; i++) {
    if (state[i] !== modelMatrix[i]) {
      return false;
    }
  }
  return (
    state[16] === cameraPositionWC.x &&
    state[17] === cameraPositionWC.y &&
    state[18] === cameraPositionWC.z
  );
}

function storeInputs(
  state: Float64Array,
  modelMatrix: Matrix4,
  cameraPositionWC: Cartesian3,
): void {
  for (let i = 0; i < 16; i++) {
    state[i] = modelMatrix[i];
  }
  state[16] = cameraPositionWC.x;
  state[17] = cameraPositionWC.y;
  state[18] = cameraPositionWC.z;
}

/**
 * Packs the primitive shadow transform in the same precision domain as the
 * primitive color pass: model-space RTE followed by a translation-free model
 * linear transform into camera-relative world axes.
 */
function packPrimitiveShadowCastUniform(
  data: Float32Array,
  modelMatrix: Matrix4,
  cameraPositionWC: Cartesian3,
  cameraMCHigh?: Cartesian3,
  cameraMCLow?: Cartesian3,
): void {
  Matrix4.clone(modelMatrix, scratchModelLinear);
  scratchModelLinear[12] = 0.0;
  scratchModelLinear[13] = 0.0;
  scratchModelLinear[14] = 0.0;
  Matrix4.pack(scratchModelLinear, data, 0);

  if (!defined(cameraMCHigh) || !defined(cameraMCLow)) {
    Matrix4.inverse(modelMatrix, scratchInverseModel);
    Matrix4.multiplyByPoint(
      scratchInverseModel,
      cameraPositionWC,
      scratchCameraMC,
    );
    EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);
    cameraMCHigh = scratchEncodedCamera.high;
    cameraMCLow = scratchEncodedCamera.low;
  }
  data[16] = cameraMCHigh.x;
  data[17] = cameraMCHigh.y;
  data[18] = cameraMCHigh.z;
  data[19] = 0.0;
  data[20] = cameraMCLow.x;
  data[21] = cameraMCLow.y;
  data[22] = cameraMCLow.z;
  data[23] = 0.0;
}

function uploadIfChanged(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: Float32Array,
  state: PrimitiveShadowCastUploadState,
): boolean {
  const currentWords = state.currentWords;
  const uploadedWords = state.uploadedWords;
  let changed = !state.uploaded;
  if (!changed) {
    for (let i = 0; i < currentWords.length; i++) {
      if (currentWords[i] !== uploadedWords[i]) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) {
    return false;
  }

  device.queue.writeBuffer(
    buffer,
    0,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  uploadedWords.set(currentWords);
  state.uploaded = true;
  return true;
}

/**
 * Creates or refreshes the stable transform resource owned by one logical
 * Primitive. Repeated color/depth-fail commands with the same model/camera
 * tuple return before matrix inversion and never allocate or upload again.
 */
function updatePrimitiveShadowCastUniform(
  device: GPUDevice,
  host: PrimitiveShadowCastHost,
  modelMatrix: Matrix4,
  cameraPositionWC: Cartesian3,
  label = "Primitive shadow cast UB",
  cameraMCHigh?: Cartesian3,
  cameraMCLow?: Cartesian3,
): WebGPUBuffer {
  let bufferCreated = false;
  if (
    !defined(host.primitiveShadowCastUB) ||
    host.primitiveShadowCastUB.isDestroyed ||
    host.primitiveShadowCastDevice !== device
  ) {
    if (
      defined(host.primitiveShadowCastUB) &&
      !host.primitiveShadowCastUB.isDestroyed
    ) {
      host.primitiveShadowCastUB.destroy();
    }
    host.primitiveShadowCastUB = WebGPUBuffer.createUniformBuffer(
      device,
      PRIMITIVE_SHADOW_CAST_BYTES,
      undefined,
      label,
    );
    host.primitiveShadowCastDevice = device;
    bufferCreated = true;
  }
  if (!defined(host.primitiveShadowCastData)) {
    host.primitiveShadowCastData = new Float32Array(
      PRIMITIVE_SHADOW_CAST_FLOATS,
    );
  }
  if (!defined(host.primitiveShadowCastInputState)) {
    host.primitiveShadowCastInputState = new Float64Array(
      PRIMITIVE_SHADOW_CAST_INPUT_FLOATS,
    );
    host.primitiveShadowCastInputState.fill(Number.NaN);
  }
  if (bufferCreated || !defined(host.primitiveShadowCastUploadState)) {
    host.primitiveShadowCastUploadState = createUploadState(
      host.primitiveShadowCastData,
    );
  }

  if (
    !inputsEqual(
      host.primitiveShadowCastInputState,
      modelMatrix,
      cameraPositionWC,
    )
  ) {
    packPrimitiveShadowCastUniform(
      host.primitiveShadowCastData,
      modelMatrix,
      cameraPositionWC,
      cameraMCHigh,
      cameraMCLow,
    );
    storeInputs(
      host.primitiveShadowCastInputState,
      modelMatrix,
      cameraPositionWC,
    );
  }

  uploadIfChanged(
    device,
    host.primitiveShadowCastUB.buffer,
    host.primitiveShadowCastData,
    host.primitiveShadowCastUploadState,
  );
  return host.primitiveShadowCastUB;
}

/**
 * Tags a generic Primitive command for the transform-aware RTE cast variant.
 * The persistent primitive cache owns both the transform UBO and bind-group
 * weak cache; short-lived draw command twins do not own GPU cache state.
 */
function configurePrimitiveShadowCastCommand(
  command: PrimitiveShadowCastCommand,
  host: PrimitiveShadowCastHost,
  vertexStride: number,
): void {
  command._shadowCastLayout = PRIMITIVE_RTE_SHADOW_CAST_LAYOUT;
  command._shadowCastBindGroupCacheHost = host;
  command._primitiveShadowCastHost = host;
  command.vertexStride = vertexStride;
}

function updatePrimitiveShadowCastCommand(
  device: GPUDevice,
  command: PrimitiveShadowCastCommand,
  modelMatrix: Matrix4,
  cameraPositionWC: Cartesian3,
  cameraMCHigh?: Cartesian3,
  cameraMCLow?: Cartesian3,
): WebGPUBuffer | undefined {
  const host = command._primitiveShadowCastHost;
  if (
    command._shadowCastLayout !== PRIMITIVE_RTE_SHADOW_CAST_LAYOUT ||
    !defined(host)
  ) {
    return undefined;
  }

  const buffer = updatePrimitiveShadowCastUniform(
    device,
    host,
    modelMatrix,
    cameraPositionWC,
    undefined,
    cameraMCHigh,
    cameraMCLow,
  );
  command._shadowCastPrimitiveUB = buffer;
  return buffer;
}

export {
  PRIMITIVE_RTE_SHADOW_CAST_LAYOUT,
  configurePrimitiveShadowCastCommand,
  packPrimitiveShadowCastUniform,
  updatePrimitiveShadowCastCommand,
  updatePrimitiveShadowCastUniform,
};
export type { PrimitiveShadowCastCommand, PrimitiveShadowCastHost };
