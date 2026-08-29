// C12-29 S5 replacement-device capture lineage and executable sampler.
// @purpose Fail-closed AST/dataflow proof plus strict persisted-PNG decode for the replacement-device certification probe.
// @status ACTIVE

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { parse } from "acorn";

import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_CAPTURE_SOURCE,
  FUSED_SNAPSHOT_END,
} from "./same-task-capture.mjs";

export const C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA =
  "c12-29-s5-replacement-device-capture-proof-v4";
export const C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA =
  "c12-29-s5-replacement-device-box-grid-sampler-v1";
export const C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA =
  "c12-29-s5-replacement-device-capture-transaction-v2";
export const C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA =
  "c12-29-s5-replacement-device-runtime-attestation-v1";
export const C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_GLOBAL =
  "__c1229S5ReplacementRuntimeAttestor";
export const C12_29_S5_REPLACEMENT_SAMPLER_BEGIN =
  "// ==BEGIN replacement-device-box-grid-sampler==";
export const C12_29_S5_REPLACEMENT_SAMPLER_END =
  "// ==END replacement-device-box-grid-sampler==";

export const C12_29_S5_REPLACEMENT_VIEWPORT = Object.freeze({
  width: 960,
  height: 960,
});
export const C12_29_S5_REPLACEMENT_SAMPLE_GRID = Object.freeze({
  width: 16,
  height: 16,
});

/**
 * Install the page-side half of the replacement capture witness before any
 * application script. The randomized Playwright binding is captured in this
 * closure and is never passed to the measured function. The returned API owns
 * creation and invocation of the canonical fused helper, observes render and
 * freeze through proxies, reads frame slots synchronously before the helper's
 * first await resolves, and emits each event over the out-of-band binding.
 *
 * Keep this function closure-free: Playwright serializes Function#toString.
 */
export function installC1229S5ReplacementRuntimeAttestor(options) {
  const root = globalThis;
  const binding = root[options.bindingName];
  if (typeof binding !== "function") {
    throw new Error("replacement-device witness binding is unavailable");
  }
  if (root.__c1229S5ReplacementRuntimeAttestor !== undefined) {
    throw new Error(
      "replacement-device runtime attestor was already installed",
    );
  }

  const FunctionToString = Function.prototype.toString;
  const ReflectApply = Reflect.apply;
  const ReflectGet = Reflect.get;
  const ObjectFreeze = Object.freeze;
  const ObjectDefineProperty = Object.defineProperty;
  const TextEncoderConstructor = TextEncoder;
  const ProxyConstructor = Proxy;
  const encoder = new TextEncoderConstructor();
  const subtleDigest = crypto.subtle.digest.bind(crypto.subtle);
  const randomUuid = crypto.randomUUID.bind(crypto);
  const witnessNonce = randomUuid();
  const objectTokens = new WeakMap();
  let objectOrdinal = 0;
  let sequence = 0;
  let prepared = false;
  let finished = false;
  let captureOrdinal = 0;

  const tokenFor = (value, prefix) => {
    if ((typeof value !== "object" && typeof value !== "function") || !value) {
      return null;
    }
    let token = objectTokens.get(value);
    if (!token) {
      token = `${prefix}-${++objectOrdinal}-${randomUuid()}`;
      objectTokens.set(value, token);
    }
    return token;
  };
  const digestHex = async (bytes) =>
    Array.from(
      new Uint8Array(
        await ReflectApply(subtleDigest, undefined, ["SHA-256", bytes]),
      ),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
  const digestJson = (value) =>
    digestHex(encoder.encode(JSON.stringify(value)));
  const sourceSha256 = (value) =>
    digestHex(encoder.encode(ReflectApply(FunctionToString, value, [])));
  const pngBytes = (dataUrl) => {
    const prefix = "data:image/png;base64,";
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
      throw new Error(
        "replacement-device witness capture is not a PNG data URL",
      );
    }
    const binary = atob(dataUrl.slice(prefix.length));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };
  const emit = async (kind, payload) => {
    const event = {
      schema: options.schema,
      sessionId: options.sessionId,
      renderer: options.renderer,
      witnessNonce,
      sequence: ++sequence,
      kind,
      ...payload,
    };
    await ReflectApply(binding, undefined, [event]);
    return event;
  };

  const prepare = async ({
    measurement,
    captureFactory,
    sampler,
    frameReader,
    scene,
    canvas,
    timeFn,
    expected,
  }) => {
    if (prepared || finished) {
      throw new Error("replacement-device witness prepare is not one-shot");
    }
    prepared = true;
    if (
      typeof measurement !== "function" ||
      typeof captureFactory !== "function" ||
      typeof sampler !== "function" ||
      typeof frameReader !== "function" ||
      typeof timeFn !== "function" ||
      !scene ||
      !canvas
    ) {
      throw new Error(
        "replacement-device witness executable inputs are invalid",
      );
    }
    const sources = {
      measurementSha256: await sourceSha256(measurement),
      captureFactorySha256: await sourceSha256(captureFactory),
      samplerSha256: await sourceSha256(sampler),
      frameReaderSha256: await sourceSha256(frameReader),
    };
    for (const key of Object.keys(sources)) {
      if (sources[key] !== expected[key]) {
        throw new Error(`replacement-device executed ${key} is not canonical`);
      }
    }

    const originalRender = scene.render;
    const originalToDataUrl = canvas.toDataURL;
    const originalContext = scene.context;
    if (
      typeof originalRender !== "function" ||
      typeof originalToDataUrl !== "function" ||
      !originalContext ||
      scene.canvas !== canvas
    ) {
      throw new Error(
        "replacement-device render/freeze/context primitives are invalid",
      );
    }
    let renderCalls = 0;
    let freezeCalls = 0;
    const sceneProxy = new ProxyConstructor(scene, {
      get(target, property) {
        if (property === "render") {
          return (...args) => {
            renderCalls++;
            return ReflectApply(originalRender, target, args);
          };
        }
        return ReflectGet(target, property, target);
      },
    });
    const canvasProxy = new ProxyConstructor(canvas, {
      get(target, property) {
        if (property === "toDataURL") {
          return (...args) => {
            freezeCalls++;
            return ReflectApply(originalToDataUrl, target, args);
          };
        }
        return ReflectGet(target, property, target);
      },
    });
    const fusedCapture = ReflectApply(captureFactory, undefined, [
      sceneProxy,
      canvasProxy,
      timeFn,
    ]);
    const captureSnapshot = fusedCapture?.captureSnapshot;
    if (typeof captureSnapshot !== "function") {
      throw new Error(
        "replacement-device canonical capture factory is invalid",
      );
    }

    const owners = {
      sceneToken: tokenFor(scene, "scene"),
      contextToken: tokenFor(originalContext, "context"),
      canvasToken: tokenFor(canvas, "canvas"),
    };
    await emit("begin", {
      installerSha256: expected.installerSha256,
      ...sources,
      ...owners,
    });

    const capture = async (label) => {
      if (finished) {
        throw new Error("replacement-device witness capture follows finish");
      }
      if (scene.context !== originalContext || scene.canvas !== canvas) {
        throw new Error(
          "replacement-device scene/context/canvas lineage changed before capture",
        );
      }
      const ordinal = ++captureOrdinal;
      const renderStart = renderCalls;
      const freezeStart = freezeCalls;
      const beforeFrameNumber = scene.frameState?.frameNumber;
      const snapshotPromise = ReflectApply(captureSnapshot, fusedCapture, []);
      const afterFreezeFrameNumber = scene.frameState?.frameNumber;
      const frame = ReflectApply(frameReader, undefined, []);
      const afterReadFrameNumber = scene.frameState?.frameNumber;
      if (
        renderCalls - renderStart !== 1 ||
        freezeCalls - freezeStart !== 1 ||
        afterFreezeFrameNumber !== afterReadFrameNumber ||
        frame?.frameNumber !== afterReadFrameNumber
      ) {
        throw new Error(
          "replacement-device capture did not have one synchronous render/freeze/frame origin",
        );
      }
      const { dataUrl, imageData } = await snapshotPromise;
      if (
        renderCalls - renderStart !== 1 ||
        freezeCalls - freezeStart !== 1 ||
        scene.render !== originalRender ||
        canvas.toDataURL !== originalToDataUrl ||
        scene.context !== originalContext ||
        scene.canvas !== canvas
      ) {
        throw new Error(
          "replacement-device render/freeze lineage changed during decode",
        );
      }
      const rgba = ReflectApply(sampler, undefined, [imageData]);
      let nonBlackPixels = 0;
      let luminance = 0;
      for (let index = 0; index < rgba.length; index += 4) {
        if (rgba[index] || rgba[index + 1] || rgba[index + 2]) {
          nonBlackPixels++;
        }
        luminance +=
          0.2126 * rgba[index] +
          0.7152 * rgba[index + 1] +
          0.0722 * rgba[index + 2];
      }
      const captureNonce = randomUuid();
      const frameSha256 = await digestJson(frame);
      const capturePngSha256 = await digestHex(pngBytes(dataUrl));
      const sampleSha256 = await digestJson(rgba);
      const meanLuminance =
        luminance / (expected.sampleWidth * expected.sampleHeight);
      const context = originalContext;
      const lineage = {
        sessionId: options.sessionId,
        renderer: options.renderer,
        witnessNonce,
        witnessSequence: sequence + 1,
        sceneToken: owners.sceneToken,
        contextToken: owners.contextToken,
        canvasToken: owners.canvasToken,
        adapterToken: tokenFor(context?._adapter, "adapter"),
        deviceToken: tokenFor(context?._device, "device"),
        resourceGeneration: context?.resourceGeneration ?? null,
      };
      const transaction = {
        schema: expected.captureTransactionSchema,
        ...lineage,
        captureNonce,
        captureOrdinal: ordinal,
        frameSha256,
        label,
        width: imageData.width,
        height: imageData.height,
        pngSha256: capturePngSha256,
        samplerSchema: expected.samplerSchema,
        sampleWidth: expected.sampleWidth,
        sampleHeight: expected.sampleHeight,
        sampleSha256,
        nonBlackPixels,
        meanLuminance,
        sampleRgba: rgba,
      };
      const transactionSha256 = await digestJson(transaction);
      await emit("capture", {
        label,
        captureOrdinal: ordinal,
        captureNonce,
        frameSha256,
        pngSha256: capturePngSha256,
        sampleSha256,
        transactionSha256,
        beforeFrameNumber: beforeFrameNumber ?? null,
        frameNumber: afterReadFrameNumber,
        renderCalls: 1,
        freezeCalls: 1,
        ...lineage,
      });
      return {
        ...frame,
        image: {
          label,
          ...lineage,
          captureNonce,
          captureOrdinal: ordinal,
          frameSha256,
          transactionSha256,
          capturePngSha256,
          sampleSha256,
          width: imageData.width,
          height: imageData.height,
          dataUrl,
          samplerSchema: expected.samplerSchema,
          sampleWidth: expected.sampleWidth,
          sampleHeight: expected.sampleHeight,
          nonBlackPixels,
          meanLuminance,
          sampleRgba: rgba,
        },
      };
    };
    const finish = async (body) => {
      if (finished) {
        throw new Error("replacement-device witness finish is not one-shot");
      }
      finished = true;
      if (scene.context !== originalContext || scene.canvas !== canvas) {
        throw new Error(
          "replacement-device scene/context/canvas lineage changed before finish",
        );
      }
      await emit("finish", {
        bodySha256: await digestJson(body),
        captureCount: captureOrdinal,
        finalSceneToken: tokenFor(scene, "scene"),
        finalContextToken: tokenFor(originalContext, "context"),
        finalCanvasToken: tokenFor(canvas, "canvas"),
        finalAdapterToken: tokenFor(originalContext?._adapter, "adapter"),
        finalDeviceToken: tokenFor(originalContext?._device, "device"),
        finalResourceGeneration: originalContext?.resourceGeneration ?? null,
      });
      return body;
    };
    return ObjectFreeze({ capture, finish });
  };

  ObjectDefineProperty(root, "__c1229S5ReplacementRuntimeAttestor", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: ObjectFreeze({ prepare }),
  });
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const AST_METADATA = new Set(["end", "loc", "range", "start", "type"]);
const LIVE_READ_METHODS = new Set([
  "createImageBitmap",
  "drawImage",
  "getImageData",
  "readPixels",
  "screenshot",
  "toBlob",
  "toDataURL",
  "transferToImageBitmap",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function captureFrameValue(snapshot) {
  return {
    frameNumber: snapshot?.frameNumber,
    selectionRevision: snapshot?.selectionRevision,
    surfaceRadius: snapshot?.surfaceRadius,
    selectedTileIds: snapshot?.selectedTileIds,
    providerToken: snapshot?.providerToken,
    s5: {
      prepared: snapshot?.s5?.prepared,
      revision: snapshot?.s5?.revision,
      gate: snapshot?.s5?.gate,
      payload: snapshot?.s5?.payload,
    },
  };
}

export function deriveC1229S5ReplacementCaptureFrameSha256(snapshot) {
  return sha256(JSON.stringify(captureFrameValue(snapshot)));
}

function captureTransactionValue(image) {
  return {
    schema: C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
    sessionId: image?.sessionId,
    renderer: image?.renderer,
    witnessNonce: image?.witnessNonce,
    witnessSequence: image?.witnessSequence,
    sceneToken: image?.sceneToken,
    contextToken: image?.contextToken,
    canvasToken: image?.canvasToken,
    adapterToken: image?.adapterToken,
    deviceToken: image?.deviceToken,
    resourceGeneration: image?.resourceGeneration,
    captureNonce: image?.captureNonce,
    captureOrdinal: image?.captureOrdinal,
    frameSha256: image?.frameSha256,
    label: image?.label,
    width: image?.width,
    height: image?.height,
    pngSha256: image?.sha256 ?? image?.capturePngSha256,
    samplerSchema: image?.samplerSchema,
    sampleWidth: image?.sampleWidth,
    sampleHeight: image?.sampleHeight,
    sampleSha256: image?.sampleSha256,
    nonBlackPixels: image?.nonBlackPixels,
    meanLuminance: image?.meanLuminance,
    sampleRgba: image?.sampleRgba,
  };
}

export function deriveC1229S5ReplacementCaptureTransactionSha256(image) {
  return sha256(JSON.stringify(captureTransactionValue(image)));
}

/**
 * Deterministically box-average an RGBA image into a rectangular sample grid.
 * Every source pixel belongs to exactly one box. Bounds use integer partitions,
 * so non-divisible source dimensions retain their final row and column.
 */
export function sampleC1229S5ReplacementRgba(
  imageData,
  sampleWidth = 16,
  sampleHeight = 16,
) {
  const data = imageData?.data;
  const width = imageData?.width;
  const height = imageData?.height;
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isInteger(sampleWidth) ||
    sampleWidth <= 0 ||
    !Number.isInteger(sampleHeight) ||
    sampleHeight <= 0 ||
    sampleWidth > width ||
    sampleHeight > height ||
    data === null ||
    data === undefined ||
    typeof data.length !== "number" ||
    data.length !== width * height * 4
  ) {
    throw new Error("replacement-device sample input is invalid");
  }
  const rgba = [];
  for (let sampleY = 0; sampleY < sampleHeight; sampleY++) {
    const y0 = Math.floor((sampleY * height) / sampleHeight);
    const y1 = Math.floor(((sampleY + 1) * height) / sampleHeight);
    for (let sampleX = 0; sampleX < sampleWidth; sampleX++) {
      const x0 = Math.floor((sampleX * width) / sampleWidth);
      const x1 = Math.floor(((sampleX + 1) * width) / sampleWidth);
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel++) {
            const value = data[offset + channel];
            if (!Number.isInteger(value) || value < 0 || value > 255) {
              throw new Error(
                "replacement-device certified sample grid channel is invalid",
              );
            }
            sums[channel] += value;
          }
          count++;
        }
      }
      if (count <= 0) {
        throw new Error("replacement-device sample box is empty");
      }
      for (const sum of sums) rgba.push(Math.round(sum / count));
    }
  }
  return rgba;
}

// Function#toString is the executable source copied into page.evaluate. The
// probe's exact marker block and the AST-selected executed declaration must both
// equal this value before a RUNNING record can be created.
//
// The result is normalized to LF because Function#toString reproduces the
// function's source bytes verbatim: on a checkout whose working tree carries
// CRLF endings it returns carriage returns, while every value it is compared
// against is LF. The probe text is normalized before it is parsed, and the
// sibling fused constant is a template literal, whose cooked value the
// language itself normalizes. Without this the two can never be equal on such
// a checkout and the comparison reports a source-identity failure that is
// really a line-ending difference. Normalizing the executable text is the
// right depth for that: the identity being proved belongs to the source, not
// to the checkout that happens to hold it.
function canonicalExecutableSource(fn) {
  return fn.toString().replace(/\r\n/g, "\n");
}

export const C12_29_S5_REPLACEMENT_SAMPLER_SOURCE = canonicalExecutableSource(
  sampleC1229S5ReplacementRgba,
);
export const C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256 = sha256(
  C12_29_S5_REPLACEMENT_SAMPLER_SOURCE,
);
export const C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256 = sha256(
  FUSED_SNAPSHOT_CAPTURE_SOURCE,
);
export const C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE =
  canonicalExecutableSource(installC1229S5ReplacementRuntimeAttestor);
export const C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256 = sha256(
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE,
);

export function deriveC1229S5ReplacementSampleStats(rgba) {
  if (!Array.isArray(rgba) || rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error("replacement-device RGBA sample grid is invalid");
  }
  let nonBlackPixels = 0;
  let luminance = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    const red = rgba[index];
    const green = rgba[index + 1];
    const blue = rgba[index + 2];
    const alpha = rgba[index + 3];
    if (
      ![red, green, blue, alpha].every(
        (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255,
      )
    ) {
      throw new Error("replacement-device RGBA sample channel is invalid");
    }
    if (red || green || blue) nonBlackPixels++;
    luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  return {
    nonBlackPixels,
    meanLuminance: luminance / (rgba.length / 4),
  };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) {
    return left;
  }
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

function unfilterRgba(inflated, width, height) {
  const stride = width * 4;
  const expectedLength = height * (stride + 1);
  if (inflated.byteLength !== expectedLength) {
    throw new Error(
      `inflated PNG bytes ${inflated.byteLength} != expected ${expectedLength}`,
    );
  }
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    if (filter > 4) throw new Error(`unsupported PNG row filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const encoded = inflated[sourceOffset++];
      const target = y * stride + x;
      const left = x >= 4 ? pixels[target - 4] : 0;
      const above = y > 0 ? pixels[target - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[target - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paeth(left, above, upperLeft);
      pixels[target] = (encoded + predictor) & 0xff;
    }
  }
  return pixels;
}

/** Strictly decode the final persisted non-interlaced 8-bit RGBA Canvas PNG. */
export function inspectC1229S5ReplacementPng(bytesInput) {
  const reasons = [];
  const bytes = Buffer.isBuffer(bytesInput)
    ? bytesInput
    : Buffer.from(bytesInput ?? []);
  if (
    bytes.byteLength <= PNG_SIGNATURE.byteLength ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    return { ok: false, reasons: ["PNG signature is invalid"] };
  }

  let offset = PNG_SIGNATURE.byteLength;
  let ihdr = null;
  let sawIend = false;
  let idatStarted = false;
  let idatEnded = false;
  const compressed = [];
  const chunkTypes = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      reasons.push("PNG chunk framing is truncated");
      break;
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const next = crcOffset + 4;
    if (next > bytes.byteLength) {
      reasons.push("PNG chunk length escapes the file");
      break;
    }
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(dataStart, dataEnd);
    if (!/^[A-Za-z]{4}$/u.test(type)) reasons.push("PNG chunk type is invalid");
    if (
      crc32(Buffer.concat([typeBytes, data])) !== bytes.readUInt32BE(crcOffset)
    ) {
      reasons.push(`${type || "unknown"} PNG chunk CRC is invalid`);
    }
    chunkTypes.push(type);
    if (type === "IHDR") {
      if (ihdr !== null || chunkTypes.length !== 1 || length !== 13) {
        reasons.push("PNG must contain one first 13-byte IHDR");
      } else {
        ihdr = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
          compressionMethod: data[10],
          filterMethod: data[11],
          interlaceMethod: data[12],
        };
      }
    } else if (type === "IDAT") {
      if (idatEnded) reasons.push("PNG IDAT chunks are not consecutive");
      idatStarted = true;
      compressed.push(data);
    } else {
      if (idatStarted && type !== "IEND") idatEnded = true;
      if (type === "IEND") {
        if (sawIend || length !== 0) reasons.push("PNG IEND is invalid");
        sawIend = true;
        if (next !== bytes.byteLength) reasons.push("PNG has bytes after IEND");
      } else if ((typeBytes[0] & 0x20) === 0 && type !== "IHDR") {
        reasons.push(`unsupported critical PNG chunk ${type}`);
      }
    }
    offset = next;
    if (type === "IEND") break;
  }

  if (ihdr === null) reasons.push("PNG IHDR is absent");
  if (!idatStarted || compressed.length === 0)
    reasons.push("PNG IDAT is absent");
  if (!sawIend) reasons.push("PNG IEND is absent");
  if (
    ihdr &&
    (ihdr.width !== C12_29_S5_REPLACEMENT_VIEWPORT.width ||
      ihdr.height !== C12_29_S5_REPLACEMENT_VIEWPORT.height)
  ) {
    reasons.push("PNG dimensions differ from the frozen 960x960 viewport");
  }
  if (
    ihdr &&
    (ihdr.bitDepth !== 8 ||
      ihdr.colorType !== 6 ||
      ihdr.compressionMethod !== 0 ||
      ihdr.filterMethod !== 0 ||
      ihdr.interlaceMethod !== 0)
  ) {
    reasons.push("PNG is not non-interlaced 8-bit RGBA with standard methods");
  }

  let pixels;
  if (reasons.length === 0) {
    try {
      const expected = ihdr.height * (ihdr.width * 4 + 1);
      const inflated = inflateSync(Buffer.concat(compressed), {
        maxOutputLength: expected,
      });
      pixels = unfilterRgba(inflated, ihdr.width, ihdr.height);
    } catch (error) {
      reasons.push(
        `PNG zlib/scanline decode failed: ${error?.message ?? error}`,
      );
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const sampleRgba = sampleC1229S5ReplacementRgba(
    { data: pixels, width: ihdr.width, height: ihdr.height },
    C12_29_S5_REPLACEMENT_SAMPLE_GRID.width,
    C12_29_S5_REPLACEMENT_SAMPLE_GRID.height,
  );
  return {
    ok: true,
    reasons: [],
    pixels,
    proof: {
      width: ihdr.width,
      height: ihdr.height,
      bitDepth: ihdr.bitDepth,
      colorType: ihdr.colorType,
      interlaceMethod: ihdr.interlaceMethod,
      chunkTypes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      samplerSchema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
      sampleWidth: C12_29_S5_REPLACEMENT_SAMPLE_GRID.width,
      sampleHeight: C12_29_S5_REPLACEMENT_SAMPLE_GRID.height,
      sampleRgba,
      ...deriveC1229S5ReplacementSampleStats(sampleRgba),
    },
  };
}

function walkAst(node, parent, visitor) {
  if (!node || typeof node !== "object" || typeof node.type !== "string")
    return;
  if (visitor(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (AST_METADATA.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, node, visitor);
    } else {
      walkAst(value, node, visitor);
    }
  }
}

const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionDeclaration" ||
  node?.type === "FunctionExpression";

function countExact(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

function dedent(block) {
  const lines = String(block).replace(/\r\n/g, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const common = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/u)[0])
    .sort((left, right) => left.length - right.length)[0];
  return lines
    .map((line) =>
      common && line.startsWith(common) ? line.slice(common.length) : line,
    )
    .join("\n");
}

function markedBlock(text, begin, end) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish <= start) return null;
  return dedent(text.slice(start + begin.length, finish));
}

function staticValue(node) {
  if (node?.type === "Literal") return { known: true, value: node.value };
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return { known: true, value: node.quasis[0]?.value?.cooked };
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticValue(node.left);
    const right = staticValue(node.right);
    if (left.known && right.known) {
      return { known: true, value: left.value + right.value };
    }
  }
  return { known: false, value: undefined };
}

function staticProperty(member) {
  if (member?.type !== "MemberExpression") return undefined;
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  const value = staticValue(member.property);
  return value.known ? String(value.value) : undefined;
}

function memberNamed(node, objectName, propertyName) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === objectName &&
    node.property.type === "Identifier" &&
    node.property.name === propertyName
  );
}

function propertyName(property) {
  if (!property || property.type !== "Property") return undefined;
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  const value = staticValue(property.key);
  return value.known ? String(value.value) : undefined;
}

function declarationNamed(ast, name) {
  const values = [];
  walkAst(ast, undefined, (node, parent) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name
    ) {
      values.push({ declaration: node, statement: parent });
    } else if (node.type === "FunctionDeclaration" && node.id?.name === name) {
      values.push({ declaration: node, statement: node });
    }
  });
  return values;
}

function inside(node, outer) {
  return node.start >= outer.start && node.end <= outer.end;
}

function ancestor(node, parents, predicate) {
  for (
    let current = parents.get(node);
    current;
    current = parents.get(current)
  ) {
    if (predicate(current)) return current;
  }
  return undefined;
}

function canvasDerived(node) {
  if (node?.type === "Identifier") return node.name === "canvas";
  if (node?.type !== "MemberExpression") return false;
  const property = staticProperty(node);
  return (
    property === "canvas" ||
    property === "prototype" ||
    canvasDerived(node.object)
  );
}

function sourceNode(text, node) {
  const lineStart = text.lastIndexOf("\n", node.start - 1) + 1;
  const indentation = text.slice(lineStart, node.start);
  const lines = text.slice(node.start, node.end).split("\n");
  return lines
    .map((line, index) =>
      index > 0 && indentation && line.startsWith(indentation)
        ? line.slice(indentation.length)
        : line,
    )
    .join("\n");
}

function parseModule(source) {
  return parse(source, {
    allowAwaitOutsideFunction: true,
    ecmaVersion: "latest",
    locations: true,
    sourceType: "module",
  });
}

export function inspectC1229S5ReplacementModuleImports(source) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const ast = parseModule(text);
  const staticSpecifiers = [];
  const dynamicExpressions = [];
  walkAst(ast, undefined, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      const value = staticValue(node.source);
      if (!value.known || typeof value.value !== "string") {
        throw new Error("replacement-device policy import is not static");
      }
      staticSpecifiers.push(value.value);
    } else if (node.type === "ImportExpression") {
      const value = staticValue(node.source);
      if (value.known && typeof value.value === "string") {
        staticSpecifiers.push(value.value);
      } else {
        dynamicExpressions.push(sourceNode(text, node.source));
      }
    }
  });
  return {
    staticSpecifiers: [...new Set(staticSpecifiers)].sort(),
    dynamicExpressions: [...new Set(dynamicExpressions)].sort(),
  };
}

function failure(message, node) {
  return `${message}${node?.loc?.start.line ? ` at line ${node.loc.start.line}` : ""}`;
}

/**
 * Prove the probe-specific capture lineage. This is intentionally strict: the
 * sole accepted capture is a direct call whose promise feeds one destructured
 * PNG/ImageData pair, and that pair feeds both documentary bytes and sampling.
 * Aliases, bind/call/Reflect routes, property escapes, and extra captures fail.
 */
export function analyzeC1229S5ReplacementCaptureSource(source) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const failures = [];
  const fusedBeginCount = countExact(text, FUSED_SNAPSHOT_BEGIN);
  const fusedEndCount = countExact(text, FUSED_SNAPSHOT_END);
  const samplerBeginCount = countExact(
    text,
    C12_29_S5_REPLACEMENT_SAMPLER_BEGIN,
  );
  const samplerEndCount = countExact(text, C12_29_S5_REPLACEMENT_SAMPLER_END);
  if (fusedBeginCount !== 1 || fusedEndCount !== 1) {
    failures.push("fused snapshot markers must each occur exactly once");
  }
  if (samplerBeginCount !== 1 || samplerEndCount !== 1) {
    failures.push("replacement sampler markers must each occur exactly once");
  }
  const embeddedFused = markedBlock(
    text,
    FUSED_SNAPSHOT_BEGIN,
    FUSED_SNAPSHOT_END,
  );
  const embeddedSampler = markedBlock(
    text,
    C12_29_S5_REPLACEMENT_SAMPLER_BEGIN,
    C12_29_S5_REPLACEMENT_SAMPLER_END,
  );
  if (embeddedFused !== FUSED_SNAPSHOT_CAPTURE_SOURCE) {
    failures.push("embedded fused snapshot source is not canonical");
  }
  if (embeddedSampler !== C12_29_S5_REPLACEMENT_SAMPLER_SOURCE) {
    failures.push("embedded replacement sampler source is not canonical");
  }

  let ast;
  try {
    ast = parseModule(text);
  } catch (error) {
    failures.push(`capture source parse failed: ${error?.message ?? error}`);
    return {
      ok: false,
      failures,
      proof: null,
    };
  }
  const parents = new WeakMap();
  walkAst(ast, undefined, (node, parent) => {
    if (parent) parents.set(node, parent);
  });

  const fusedDeclarations = declarationNamed(ast, "makeFusedSnapshotCapture");
  const samplerDeclarations = declarationNamed(
    ast,
    "sampleC1229S5ReplacementRgba",
  );
  const measureDeclarations = declarationNamed(
    ast,
    "MEASURE_C1229_S5_REPLACEMENT_SESSION",
  );
  const measure = measureDeclarations[0]?.declaration?.init;
  if (
    measureDeclarations.length !== 1 ||
    measure?.type !== "FunctionExpression" ||
    measure.id?.name !== "MEASURE_C1229_S5_REPLACEMENT_SESSION" ||
    measure.async !== true ||
    measure.params.length !== 1 ||
    measure.params[0]?.type !== "Identifier" ||
    measure.params[0].name !== "contract"
  ) {
    failures.push(
      "the replacement measurement must be one named async MEASURE_C1229_S5_REPLACEMENT_SESSION declaration",
    );
  }
  const fusedStatement = fusedDeclarations[0]?.statement;
  const samplerStatement = samplerDeclarations.find(
    ({ statement }) => statement.type === "FunctionDeclaration",
  )?.statement;
  if (
    fusedDeclarations.length !== 1 ||
    !fusedStatement ||
    sourceNode(text, fusedStatement) !== FUSED_SNAPSHOT_CAPTURE_SOURCE
  ) {
    failures.push(
      "the executed fused snapshot declaration must occur once and equal the canonical source",
    );
  }
  if (
    samplerDeclarations.length !== 1 ||
    !samplerStatement ||
    sourceNode(text, samplerStatement) !== C12_29_S5_REPLACEMENT_SAMPLER_SOURCE
  ) {
    failures.push(
      "the executed replacement sampler declaration must occur once and equal the canonical source",
    );
  }
  if (
    measure &&
    (!fusedStatement ||
      !samplerStatement ||
      !inside(fusedStatement, measure) ||
      !inside(samplerStatement, measure))
  ) {
    failures.push(
      "canonical capture and sampler declarations must execute inside the bound measurement",
    );
  }

  const measurementEvaluateCalls = [];
  const measureIdentifierUses = [];
  walkAst(ast, undefined, (node) => {
    if (
      node.type === "Identifier" &&
      node.name === "MEASURE_C1229_S5_REPLACEMENT_SESSION"
    ) {
      measureIdentifierUses.push(node);
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      staticProperty(node.callee) === "evaluate" &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === "MEASURE_C1229_S5_REPLACEMENT_SESSION"
    ) {
      measurementEvaluateCalls.push(node);
    }
  });
  const measurementEvaluate = measurementEvaluateCalls[0];
  const evaluateContract = measurementEvaluate?.arguments?.[1];
  const evaluateRace = measurementEvaluate
    ? ancestor(
        measurementEvaluate,
        parents,
        (node) =>
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Promise" &&
          staticProperty(node.callee) === "race",
      )
    : undefined;
  const evaluateAssignment = evaluateRace
    ? ancestor(
        evaluateRace,
        parents,
        (node) =>
          node.type === "AssignmentExpression" &&
          node.left.type === "Identifier" &&
          node.left.name === "measured",
      )
    : undefined;
  const runnerDeclarations = declarationNamed(ast, "runBrowserSession").filter(
    ({ declaration }) => declaration.type === "FunctionDeclaration",
  );
  const runner = runnerDeclarations[0]?.declaration;
  const runnerEvaluateCalls = [];
  const measuredAssignments = [];
  if (runner) {
    walkAst(runner.body, runner, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "page" &&
        staticProperty(node.callee) === "evaluate"
      ) {
        runnerEvaluateCalls.push(node);
      }
      if (
        node.type === "AssignmentExpression" &&
        node.left.type === "Identifier" &&
        node.left.name === "measured"
      ) {
        measuredAssignments.push(node);
      }
    });
  }
  const progressEvaluate = runnerEvaluateCalls.find(
    (call) => call !== measurementEvaluate,
  );
  const progressReader = progressEvaluate?.arguments?.[0];
  const progressBody = progressReader?.body;
  const exactProgressReader =
    progressReader?.type === "ArrowFunctionExpression" &&
    progressReader.params.length === 0 &&
    progressBody?.type === "LogicalExpression" &&
    progressBody.operator === "??" &&
    memberNamed(
      progressBody.left,
      "globalThis",
      "__c1229S5ReplacementProgress",
    ) &&
    progressBody.right?.type === "Literal" &&
    progressBody.right.value === null;
  if (
    measurementEvaluateCalls.length !== 1 ||
    evaluateContract?.type !== "CallExpression" ||
    evaluateContract.callee.type !== "Identifier" ||
    evaluateContract.callee.name !== "sessionContract" ||
    evaluateContract.arguments.length !== 3 ||
    evaluateContract.arguments[0]?.type !== "Identifier" ||
    evaluateContract.arguments[0].name !== "renderer" ||
    evaluateContract.arguments[1]?.type !== "Identifier" ||
    evaluateContract.arguments[1].name !== "sessionId" ||
    evaluateContract.arguments[2]?.type !== "Identifier" ||
    evaluateContract.arguments[2].name !== "captureSourceProof" ||
    !evaluateRace ||
    !evaluateAssignment ||
    evaluateAssignment.right?.type !== "AwaitExpression" ||
    evaluateAssignment.right.argument !== evaluateRace ||
    runnerDeclarations.length !== 1 ||
    runnerEvaluateCalls.length !== 2 ||
    measuredAssignments.length !== 1 ||
    measuredAssignments[0] !== evaluateAssignment ||
    !exactProgressReader
  ) {
    failures.push(
      "the sole measurement page.evaluate route must consume the named measurement directly",
    );
  }

  // v3 is deliberately a restricted executable dialect plus an independently
  // witnessed runtime transaction. Static call shape remains necessary, but it
  // can no longer certify an unwitnessed or dynamically substituted capture.
  if (measure && fusedStatement && samplerStatement && runner) {
    const frameReaderDeclarations = declarationNamed(
      measure.body,
      "readCaptureFrame",
    ).filter(({ declaration }) => isFunction(declaration.init));
    const frameReader = frameReaderDeclarations[0]?.declaration?.init;
    const frameReaderSource = frameReader
      ? sourceNode(text, frameReader)
      : null;
    let frameReaderSafe = Boolean(
      frameReader?.type === "ArrowFunctionExpression" &&
      frameReader.params.length === 0 &&
      frameReader.body?.type === "ObjectExpression" &&
      frameReader.body.properties.map(propertyName).join(",") ===
        "frameNumber,selectionRevision,surfaceRadius,selectedTileIds,providerToken,s5",
    );
    if (frameReader) {
      let readerCalls = 0;
      walkAst(frameReader.body, frameReader, (node) => {
        if (
          node.type === "AwaitExpression" ||
          node.type === "AssignmentExpression" ||
          node.type === "UpdateExpression" ||
          node.type === "NewExpression"
        ) {
          frameReaderSafe = false;
        }
        if (node.type === "CallExpression") {
          readerCalls++;
          if (
            node.callee.type !== "Identifier" ||
            !["payload", "selectedIds"].includes(node.callee.name) ||
            node.arguments.length !== 0
          ) {
            frameReaderSafe = false;
          }
        }
        if (
          node.type === "MemberExpression" &&
          ["render", "toDataURL", "captureSnapshot"].includes(
            staticProperty(node),
          )
        ) {
          frameReaderSafe = false;
        }
      });
      frameReaderSafe &&= readerCalls === 2;
    }
    if (frameReaderDeclarations.length !== 1 || !frameReaderSafe) {
      failures.push(
        "the witnessed frame reader must be one synchronous restricted slot read",
      );
    }

    const attestedDeclarations = declarationNamed(
      measure.body,
      "attestedCapture",
    );
    const attestedInit = attestedDeclarations[0]?.declaration?.init;
    const prepareCall =
      attestedInit?.type === "AwaitExpression" ? attestedInit.argument : null;
    const prepareCallee = prepareCall?.callee;
    const attestorMember = prepareCallee?.object;
    const prepareArgument = prepareCall?.arguments?.[0];
    const prepareProperties = new Map(
      (prepareArgument?.properties ?? [])
        .filter((property) => property.type === "Property")
        .map((property) => [propertyName(property), property.value]),
    );
    const exactIdentifier = (name, expectedName = name) =>
      prepareProperties.get(name)?.type === "Identifier" &&
      prepareProperties.get(name).name === expectedName;
    const expectedAttestation = prepareProperties.get("expected");
    const timeFunction = prepareProperties.get("timeFn");
    const prepareExact =
      attestedDeclarations.length === 1 &&
      prepareCall?.type === "CallExpression" &&
      prepareCall.arguments.length === 1 &&
      prepareCallee?.type === "MemberExpression" &&
      !prepareCallee.computed &&
      prepareCallee.property?.name === "prepare" &&
      memberNamed(
        attestorMember,
        "globalThis",
        "__c1229S5ReplacementRuntimeAttestor",
      ) &&
      prepareArgument?.type === "ObjectExpression" &&
      prepareArgument.properties.map(propertyName).join(",") ===
        "measurement,captureFactory,sampler,frameReader,scene,canvas,timeFn,expected" &&
      exactIdentifier("measurement", "MEASURE_C1229_S5_REPLACEMENT_SESSION") &&
      exactIdentifier("captureFactory", "makeFusedSnapshotCapture") &&
      exactIdentifier("sampler", "sampleC1229S5ReplacementRgba") &&
      exactIdentifier("frameReader", "readCaptureFrame") &&
      exactIdentifier("scene") &&
      exactIdentifier("canvas") &&
      timeFunction?.type === "ArrowFunctionExpression" &&
      timeFunction.params.length === 0 &&
      timeFunction.body?.type === "Identifier" &&
      timeFunction.body.name === "pinnedTime" &&
      memberNamed(expectedAttestation, "contract", "attestation");
    if (!prepareExact) {
      failures.push(
        "the canonical measurement must prepare one exact sealed runtime attestor",
      );
    }

    const snapshotDeclarationsV3 = declarationNamed(
      measure.body,
      "snapshot",
    ).filter(({ declaration }) => isFunction(declaration.init));
    const snapshotV3 = snapshotDeclarationsV3[0]?.declaration?.init;
    const snapshotBody = snapshotV3?.body;
    const snapshotCaptureCall =
      snapshotBody?.type === "CallExpression" ? snapshotBody : null;
    const snapshotExact =
      snapshotDeclarationsV3.length === 1 &&
      snapshotV3?.type === "ArrowFunctionExpression" &&
      snapshotV3.async === false &&
      snapshotV3.params.length === 1 &&
      snapshotV3.params[0]?.type === "Identifier" &&
      snapshotV3.params[0].name === "label" &&
      snapshotCaptureCall?.callee?.type === "MemberExpression" &&
      !snapshotCaptureCall.callee.computed &&
      memberNamed(snapshotCaptureCall.callee, "attestedCapture", "capture") &&
      snapshotCaptureCall.arguments.length === 1 &&
      snapshotCaptureCall.arguments[0]?.type === "Identifier" &&
      snapshotCaptureCall.arguments[0].name === "label";
    if (!snapshotExact) {
      failures.push(
        "the sole snapshot route must call the sealed attestedCapture.capture",
      );
    }

    const phaseSnapshotCallsV3 = [];
    const finishCalls = [];
    walkAst(measure.body, measure, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "snapshot"
      ) {
        const label = staticValue(node.arguments[0]);
        const awaited = parents.get(node)?.type === "AwaitExpression";
        const assigned = ancestor(
          node,
          parents,
          (candidate) => candidate.type === "VariableDeclarator",
        );
        phaseSnapshotCallsV3.push({
          node,
          label: label.known ? label.value : undefined,
          awaited,
          assigned:
            assigned?.id?.type === "Identifier" ? assigned.id.name : null,
          direct:
            assigned?.init?.type === "AwaitExpression" &&
            assigned.init.argument === node,
        });
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        memberNamed(node.callee, "attestedCapture", "finish")
      ) {
        const awaited = parents.get(node);
        const returned = awaited ? parents.get(awaited) : undefined;
        finishCalls.push({
          node,
          direct:
            awaited?.type === "AwaitExpression" &&
            returned?.type === "ReturnStatement" &&
            returned.argument === awaited &&
            node.arguments.length === 1 &&
            node.arguments[0]?.type === "ObjectExpression",
        });
      }
    });
    phaseSnapshotCallsV3.sort(
      (left, right) => left.node.start - right.node.start,
    );
    const phaseSnapshotLabelsV3 = phaseSnapshotCallsV3.map(
      (entry) => entry.label,
    );
    if (
      phaseSnapshotCallsV3.length !== 4 ||
      phaseSnapshotLabelsV3.join(",") !==
        "control-before,control-after-gap,webgpu-before,webgpu-after" ||
      phaseSnapshotCallsV3.some(
        (entry) => !entry.awaited || !entry.assigned || !entry.direct,
      ) ||
      phaseSnapshotCallsV3.map((entry) => entry.assigned).join(",") !==
        "before,afterGap,before,after"
    ) {
      failures.push(
        "the bound measurement must await exactly the four canonical phase snapshots",
      );
    }
    if (
      finishCalls.length !== 4 ||
      finishCalls.some((entry) => !entry.direct)
    ) {
      failures.push(
        "every measurement return must be body-bound by the sealed runtime attestor",
      );
    }

    const initScriptWitnessCalls = [];
    const exposeBindingWitnessCalls = [];
    walkAst(runner.body, runner, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        memberNamed(node.callee, "page", "addInitScript") &&
        node.arguments[0]?.type === "Identifier" &&
        node.arguments[0].name === "installC1229S5ReplacementRuntimeAttestor"
      ) {
        initScriptWitnessCalls.push(node);
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        memberNamed(node.callee, "browserContext", "exposeBinding") &&
        node.arguments[0]?.type === "Identifier" &&
        node.arguments[0].name === "witnessBindingName"
      ) {
        exposeBindingWitnessCalls.push(node);
      }
    });
    const initScriptCalls = initScriptWitnessCalls.length;
    const exposeBindingCalls = exposeBindingWitnessCalls.length;
    if (initScriptCalls !== 1 || exposeBindingCalls !== 1) {
      failures.push(
        "the runtime witness must have one pre-page installer and one out-of-band binding",
      );
    }

    const witnessNameDeclarations = declarationNamed(
      runner.body,
      "witnessBindingName",
    );
    const witnessName = witnessNameDeclarations[0]?.declaration?.init;
    const witnessExpression = witnessName?.expressions?.[0];
    const randomUuidCall = witnessExpression?.callee?.object;
    const randomBindingNameExact =
      witnessNameDeclarations.length === 1 &&
      witnessName?.type === "TemplateLiteral" &&
      witnessName.expressions.length === 1 &&
      witnessName.quasis.length === 2 &&
      witnessName.quasis[0]?.value?.cooked === "__c1229S5ReplacementWitness_" &&
      witnessName.quasis[1]?.value?.cooked === "" &&
      witnessExpression?.type === "CallExpression" &&
      staticProperty(witnessExpression.callee) === "replaceAll" &&
      witnessExpression.arguments.length === 2 &&
      staticValue(witnessExpression.arguments[0]).value === "-" &&
      staticValue(witnessExpression.arguments[1]).value === "" &&
      randomUuidCall?.type === "CallExpression" &&
      randomUuidCall.callee?.type === "Identifier" &&
      randomUuidCall.callee.name === "randomUUID" &&
      randomUuidCall.arguments.length === 0;
    const witnessNameUses = [];
    const attestationEventUses = [];
    const eventSinkPushes = [];
    const bodyBindings = [];
    walkAst(runner.body, runner, (node) => {
      if (node.type === "Identifier" && node.name === "witnessBindingName") {
        witnessNameUses.push(node);
      }
      if (node.type === "Identifier" && node.name === "attestationEvents") {
        attestationEventUses.push(node);
      }
      if (
        node.type === "CallExpression" &&
        memberNamed(node.callee, "attestationEvents", "push")
      ) {
        eventSinkPushes.push(node);
      }
      if (
        node.type === "BinaryExpression" &&
        node.operator === "!==" &&
        (memberNamed(node.left, "finishEvent", "bodySha256") ||
          memberNamed(node.left?.expression, "finishEvent", "bodySha256")) &&
        node.right?.type === "CallExpression" &&
        node.right.callee?.type === "Identifier" &&
        node.right.callee.name === "sha256" &&
        node.right.arguments.length === 1
      ) {
        const bufferCall = node.right.arguments[0];
        const jsonCall = bufferCall?.arguments?.[0];
        if (
          bufferCall?.type === "CallExpression" &&
          memberNamed(bufferCall.callee, "Buffer", "from") &&
          bufferCall.arguments.length === 1 &&
          jsonCall?.type === "CallExpression" &&
          memberNamed(jsonCall.callee, "JSON", "stringify") &&
          jsonCall.arguments.length === 1 &&
          jsonCall.arguments[0]?.type === "Identifier" &&
          jsonCall.arguments[0].name === "measured"
        ) {
          bodyBindings.push(node);
        }
      }
    });
    const attestationDeclarations = declarationNamed(
      runner.body,
      "attestationEvents",
    );
    const eventSink = eventSinkPushes[0];
    const exposeCallback = exposeBindingWitnessCalls[0]?.arguments?.[1];
    const eventSinkExact =
      attestationDeclarations.length === 1 &&
      attestationDeclarations[0].declaration.init?.type === "ArrayExpression" &&
      attestationDeclarations[0].declaration.init.elements.length === 0 &&
      attestationEventUses.length === 6 &&
      eventSinkPushes.length === 1 &&
      eventSink.arguments.length === 1 &&
      eventSink.arguments[0]?.type === "CallExpression" &&
      eventSink.arguments[0].callee?.type === "Identifier" &&
      eventSink.arguments[0].callee.name === "structuredClone" &&
      eventSink.arguments[0].arguments.length === 1 &&
      eventSink.arguments[0].arguments[0]?.type === "Identifier" &&
      eventSink.arguments[0].arguments[0].name === "event" &&
      ancestor(eventSink, parents, isFunction) === exposeCallback;
    const initOptions = initScriptWitnessCalls[0]?.arguments?.[1];
    const initProperties = new Map(
      (initOptions?.properties ?? [])
        .filter((property) => property.type === "Property")
        .map((property) => [propertyName(property), property.value]),
    );
    const initScriptExact =
      initScriptWitnessCalls.length === 1 &&
      initOptions?.type === "ObjectExpression" &&
      initOptions.properties.map(propertyName).join(",") ===
        "bindingName,schema,sessionId,renderer" &&
      initProperties.get("bindingName")?.type === "Identifier" &&
      initProperties.get("bindingName").name === "witnessBindingName" &&
      initProperties.get("schema")?.type === "Identifier" &&
      initProperties.get("schema").name ===
        "C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA" &&
      initProperties.get("sessionId")?.type === "Identifier" &&
      initProperties.get("sessionId").name === "sessionId" &&
      initProperties.get("renderer")?.type === "Identifier" &&
      initProperties.get("renderer").name === "renderer";
    const runnerWitnessExact =
      randomBindingNameExact &&
      witnessNameUses.length === 3 &&
      eventSinkExact &&
      bodyBindings.length === 1 &&
      initScriptExact;
    if (!runnerWitnessExact) {
      failures.push(
        "the runtime witness must use one randomized binding, exact event sink, and returned-body digest",
      );
    }

    const criticalBindings = new Set([
      "MEASURE_C1229_S5_REPLACEMENT_SESSION",
      "attestedCapture",
      "makeFusedSnapshotCapture",
      "readCaptureFrame",
      "sampleC1229S5ReplacementRgba",
      "snapshot",
    ]);
    const criticalProperties = new Set([
      "capture",
      "captureSnapshot",
      "finish",
      "prepare",
      "toDataURL",
    ]);
    const criticalMutationProperties = new Set([
      ...criticalProperties,
      "_adapter",
      "_device",
      "context",
      "frameNumber",
      "resourceGeneration",
    ]);
    const reflectionMethods = new Set([
      "construct",
      "defineProperties",
      "defineProperty",
      "deleteProperty",
      "getOwnPropertyDescriptor",
      "getOwnPropertyDescriptors",
      "getPrototypeOf",
      "ownKeys",
      "preventExtensions",
      "set",
      "setPrototypeOf",
    ]);
    const dynamicExecutableNames = new Set([
      "AsyncFunction",
      "Function",
      "GeneratorFunction",
      "Proxy",
      "eval",
    ]);
    const criticalGlobalRoots = new Set([
      "document",
      "frames",
      "globalThis",
      "parent",
      "self",
      "top",
      "window",
    ]);
    const memberRootName = (node) => {
      let current = node;
      while (current?.type === "MemberExpression") current = current.object;
      return current?.type === "Identifier" ? current.name : undefined;
    };
    const excludedV3 = [fusedStatement, samplerStatement].filter(Boolean);
    const outsideCanonicalV3 = (node) =>
      !excludedV3.some((range) => inside(node, range));
    let restrictedDialect = true;
    let runtimeImports = 0;
    walkAst(measure.body, measure, (node, parent) => {
      if (!outsideCanonicalV3(node)) return false;
      const reject = (message) => {
        restrictedDialect = false;
        failures.push(failure(message, node));
      };
      if (node.type === "Identifier" && dynamicExecutableNames.has(node.name)) {
        reject(
          "dynamic executable references are outside the certified dialect",
        );
      }
      if (node.type === "ImportExpression") {
        if (memberNamed(node.source, "contract", "runtimePath")) {
          runtimeImports++;
        } else {
          reject("dynamic import is outside the certified executable dialect");
        }
      }
      if (node.type === "ForInStatement") {
        reject(
          "property enumeration is outside the certified executable dialect",
        );
      }
      if (
        (node.type === "CallExpression" || node.type === "NewExpression") &&
        node.callee?.type === "Identifier" &&
        [
          "AsyncFunction",
          "Function",
          "GeneratorFunction",
          "Proxy",
          "eval",
        ].includes(node.callee.name)
      ) {
        reject("dynamic code generation is outside the certified dialect");
      }
      if (node.type === "TaggedTemplateExpression") {
        reject("tagged execution is outside the certified dialect");
      }
      if (
        node.type === "AssignmentExpression" ||
        node.type === "UpdateExpression" ||
        node.type === "UnaryExpression"
      ) {
        const target =
          node.type === "AssignmentExpression" ? node.left : node.argument;
        if (
          target?.type === "Identifier" &&
          criticalBindings.has(target.name)
        ) {
          reject("canonical executable binding mutation is forbidden");
        }
        if (
          target?.type === "MemberExpression" &&
          (target.computed ||
            criticalMutationProperties.has(staticProperty(target)) ||
            staticProperty(target) === "render" ||
            (target.object?.type === "Identifier" &&
              criticalBindings.has(target.object.name)))
        ) {
          reject("computed or critical member mutation is forbidden");
        }
      }
      if (node.type === "MemberExpression") {
        const property = staticProperty(node);
        if (
          [
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
            "__proto__",
            "constructor",
            "prototype",
          ].includes(property) ||
          (node.computed &&
            ([
              "HTMLCanvasElement",
              "Object",
              "OffscreenCanvas",
              "Reflect",
              "attestedCapture",
              "canvas",
              "scene",
            ].includes(memberRootName(node)) ||
              criticalGlobalRoots.has(memberRootName(node))))
        ) {
          reject(
            "dynamic critical member access is outside the certified dialect",
          );
        }
        if (
          criticalProperties.has(property) &&
          node !== snapshotCaptureCall?.callee &&
          node !== prepareCallee &&
          !finishCalls.some((entry) => entry.node.callee === node)
        ) {
          reject(
            "critical executable member appears outside its canonical route",
          );
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        node.left?.type === "MemberExpression" &&
        criticalGlobalRoots.has(memberRootName(node.left)) &&
        !(
          node.operator === "=" &&
          node.left.object?.type === "Identifier" &&
          node.left.object.name === "globalThis" &&
          ["__c1229S5ReplacementProgress", "viewer"].includes(
            staticProperty(node.left),
          )
        )
      ) {
        reject(
          "global executable-surface mutation is outside the certified dialect",
        );
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === "Reflect"
      ) {
        const property = staticProperty(node.callee);
        const authorizedTrigger =
          property === "apply" &&
          node.arguments.length === 3 &&
          node.arguments[0]?.type === "Identifier" &&
          node.arguments[0].name === "methodValue" &&
          node.arguments[1]?.type === "Identifier" &&
          node.arguments[1].name === "benchmark" &&
          node.arguments[2]?.type === "ArrayExpression" &&
          node.arguments[2].elements.length === 0;
        if (!authorizedTrigger) {
          reject("reflection is outside the certified executable dialect");
        }
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === "Object"
      ) {
        const property = staticProperty(node.callee);
        const canonicalStyleAssignment =
          property === "assign" &&
          node.arguments.length === 2 &&
          memberNamed(node.arguments[0], "container", "style") &&
          node.arguments[1]?.type === "ObjectExpression";
        if (property !== "is" && !canonicalStyleAssignment) {
          reject(
            "Object reflection or aggregation is outside the certified dialect",
          );
        }
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === "document"
      ) {
        const method = staticProperty(node.callee);
        const argument = staticValue(node.arguments[0]);
        const exactDomRead =
          node.arguments.length === 1 &&
          ((method === "getElementById" &&
            argument.known &&
            argument.value === "cesiumContainer") ||
            (method === "createElement" &&
              argument.known &&
              ["canvas", "div"].includes(argument.value)));
        if (!exactDomRead) {
          reject("dynamic DOM execution is outside the certified dialect");
        }
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        ["setInterval", "setTimeout"].includes(node.callee.name) &&
        staticValue(node.arguments[0]).known
      ) {
        reject("string timer execution is outside the certified dialect");
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        reflectionMethods.has(staticProperty(node.callee))
      ) {
        reject(
          "descriptor/prototype reflection is outside the certified dialect",
        );
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        ["apply", "bind", "call"].includes(staticProperty(node.callee)) &&
        node.callee.object?.type === "Identifier" &&
        criticalBindings.has(node.callee.object.name)
      ) {
        reject("indirect canonical executable invocation is forbidden");
      }
      void parent;
    });
    if (runtimeImports !== 1) {
      restrictedDialect = false;
      failures.push(
        "the certified measurement must have one contract-bound runtime import",
      );
    }

    if (measureIdentifierUses.length !== 4) {
      failures.push(
        "the named measurement must have only declaration, self-attestation, and page.evaluate uses",
      );
    }

    const proofV3 = {
      schema: C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA,
      measurement: {
        declarationCount: measureDeclarations.length,
        identifierUses: measureIdentifierUses.length,
        pageEvaluateCalls: measurementEvaluateCalls.length,
        phaseSnapshotCalls: phaseSnapshotCallsV3.length,
        phaseSnapshotLabels: phaseSnapshotLabelsV3,
        finishCalls: finishCalls.length,
        executedSha256: sha256(sourceNode(text, measure)),
      },
      fused: {
        beginMarkerCount: fusedBeginCount,
        endMarkerCount: fusedEndCount,
        canonicalSha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
        embeddedSha256: embeddedFused === null ? null : sha256(embeddedFused),
        executedSha256: sha256(sourceNode(text, fusedStatement)),
      },
      sampler: {
        schema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
        beginMarkerCount: samplerBeginCount,
        endMarkerCount: samplerEndCount,
        canonicalSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
        embeddedSha256:
          embeddedSampler === null ? null : sha256(embeddedSampler),
        executedSha256: sha256(sourceNode(text, samplerStatement)),
      },
      frameReader: {
        declarationCount: frameReaderDeclarations.length,
        executedSha256:
          frameReaderSource === null ? null : sha256(frameReaderSource),
        restricted: frameReaderSafe,
      },
      attestor: {
        schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
        installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
        initScriptCalls,
        exposeBindingCalls,
        prepareCalls: prepareExact ? 1 : 0,
        captureCalls: snapshotExact ? 1 : 0,
        finishCalls: finishCalls.length,
        restrictedDialect,
        randomBindingNames: randomBindingNameExact ? 1 : 0,
        eventSinkWrites: eventSinkExact ? 1 : 0,
        bodyBindings: bodyBindings.length,
        runnerRestricted: runnerWitnessExact,
      },
      helperInstalls: prepareExact ? 1 : 0,
      captureCalls: snapshotExact ? 1 : 0,
      samplerCalls: prepareExact ? 1 : 0,
      documentaryOrigins: snapshotExact ? 1 : 0,
      sampleOrigins: snapshotExact ? 1 : 0,
      sameOrigin: snapshotExact && frameReaderSafe,
      failureCount: failures.length,
    };
    return { ok: failures.length === 0, failures, proof: proofV3 };
  }

  const snapshotDeclarations = declarationNamed(ast, "snapshot").filter(
    ({ declaration }) => isFunction(declaration.init),
  );
  const fusedCaptureDeclarations = declarationNamed(ast, "fusedCapture");
  const fusedCaptureInitializer =
    fusedCaptureDeclarations[0]?.declaration?.init;
  if (
    fusedCaptureDeclarations.length !== 1 ||
    fusedCaptureInitializer?.type !== "CallExpression" ||
    fusedCaptureInitializer.callee.type !== "Identifier" ||
    fusedCaptureInitializer.callee.name !== "makeFusedSnapshotCapture" ||
    fusedCaptureInitializer.arguments.length !== 3 ||
    fusedCaptureInitializer.arguments[0]?.type !== "Identifier" ||
    fusedCaptureInitializer.arguments[0].name !== "scene" ||
    fusedCaptureInitializer.arguments[1]?.type !== "Identifier" ||
    fusedCaptureInitializer.arguments[1].name !== "canvas" ||
    !isFunction(fusedCaptureInitializer.arguments[2])
  ) {
    failures.push("the canonical fused helper must be installed exactly once");
  }
  const snapshot = snapshotDeclarations[0]?.declaration?.init;
  if (snapshotDeclarations.length !== 1 || !snapshot) {
    failures.push("the replacement snapshot function must occur exactly once");
  }
  if (measure && snapshot && !inside(snapshot, measure)) {
    failures.push(
      "the replacement snapshot function must execute inside the bound measurement",
    );
  }

  const phaseSnapshotCalls = [];
  if (measure) {
    walkAst(measure.body, measure, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "snapshot"
      ) {
        const label = staticValue(node.arguments[0]);
        const awaited = parents.get(node)?.type === "AwaitExpression";
        const assigned = ancestor(
          node,
          parents,
          (candidate) => candidate.type === "VariableDeclarator",
        );
        phaseSnapshotCalls.push({
          node,
          label: label.known ? label.value : undefined,
          awaited,
          assigned:
            assigned?.id?.type === "Identifier" ? assigned.id.name : null,
          direct:
            assigned?.init?.type === "AwaitExpression" &&
            assigned.init.argument === node,
        });
      }
    });
  }
  phaseSnapshotCalls.sort((left, right) => left.node.start - right.node.start);
  const phaseSnapshotLabels = phaseSnapshotCalls.map((entry) => entry.label);
  if (
    phaseSnapshotCalls.length !== 4 ||
    phaseSnapshotLabels.join(",") !==
      "control-before,control-after-gap,webgpu-before,webgpu-after" ||
    phaseSnapshotCalls.some(
      (entry) => !entry.awaited || !entry.assigned || !entry.direct,
    ) ||
    phaseSnapshotCalls.map((entry) => entry.assigned).join(",") !==
      "before,afterGap,before,after"
  ) {
    failures.push(
      "the bound measurement must await exactly the four canonical phase snapshots",
    );
  }

  let captureCall = null;
  let frameDeclaration = null;
  let decodeDeclaration = null;
  let sampleDeclaration = null;
  let returnedImage = null;
  if (snapshot) {
    for (const statement of snapshot.body.body ?? []) {
      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations) {
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === "snapshotPromise"
          ) {
            if (statement.kind !== "const" || captureCall) {
              failures.push(
                "snapshotPromise must be one const declaration",
                declaration,
              );
            }
            captureCall = declaration.init;
          }
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === "frame"
          ) {
            frameDeclaration = statement;
          }
          if (declaration.id.type === "ObjectPattern") {
            const names = declaration.id.properties.map(propertyName).sort();
            if (names.join(",") === "dataUrl,imageData") {
              decodeDeclaration = { declaration, statement };
            }
          }
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === "rgba"
          ) {
            sampleDeclaration = { declaration, statement };
          }
        }
      }
      if (
        statement.type === "ReturnStatement" &&
        statement.argument?.type === "ObjectExpression"
      ) {
        const imageProperty = statement.argument.properties.find(
          (property) => propertyName(property) === "image",
        );
        if (imageProperty?.value?.type === "ObjectExpression") {
          returnedImage = imageProperty.value;
        }
      }
    }
  }

  const directCapture =
    captureCall?.type === "CallExpression" &&
    captureCall.arguments.length === 0 &&
    captureCall.callee.type === "MemberExpression" &&
    captureCall.callee.computed === false &&
    captureCall.callee.object.type === "Identifier" &&
    captureCall.callee.object.name === "fusedCapture" &&
    captureCall.callee.property.type === "Identifier" &&
    captureCall.callee.property.name === "captureSnapshot";
  if (!directCapture) {
    failures.push(
      "snapshotPromise must come from the sole direct fusedCapture.captureSnapshot() call",
      captureCall,
    );
  }
  if (
    captureCall &&
    frameDeclaration &&
    !(captureCall.end < frameDeclaration.start)
  ) {
    failures.push(
      "capture must freeze before the frame-slot snapshot",
      frameDeclaration,
    );
  }
  if (captureCall && frameDeclaration) {
    let yielded = false;
    walkAst(snapshot.body, snapshot, (node) => {
      if (
        node.type === "AwaitExpression" &&
        node.start > captureCall.end &&
        node.start < frameDeclaration.start
      ) {
        yielded = true;
      }
    });
    if (yielded) failures.push("capture yields before the frame-slot snapshot");
  }
  const decodeInit = decodeDeclaration?.declaration?.init;
  if (
    decodeInit?.type !== "AwaitExpression" ||
    decodeInit.argument.type !== "Identifier" ||
    decodeInit.argument.name !== "snapshotPromise" ||
    !frameDeclaration ||
    decodeDeclaration.statement.start <= frameDeclaration.end
  ) {
    failures.push(
      "the frozen capture promise must be awaited after frame slots",
    );
  }
  const sampleInit = sampleDeclaration?.declaration?.init;
  if (
    sampleInit?.type !== "CallExpression" ||
    sampleInit.callee.type !== "Identifier" ||
    sampleInit.callee.name !== "sampleC1229S5ReplacementRgba" ||
    sampleInit.arguments.length !== 1 ||
    sampleInit.arguments[0].type !== "Identifier" ||
    sampleInit.arguments[0].name !== "imageData" ||
    !decodeDeclaration ||
    sampleDeclaration.statement.start <= decodeDeclaration.statement.end
  ) {
    failures.push(
      "the sample grid must derive directly from the frozen decoded ImageData",
    );
  }

  const singleSnapshotDeclaration = (name) => {
    const declarations = snapshot
      ? declarationNamed(snapshot.body, name).filter(
          ({ declaration }) => declaration.type === "VariableDeclarator",
        )
      : [];
    return declarations.length === 1 ? declarations[0].declaration : null;
  };
  const awaitedCall = (declaration, calleeName) => {
    const awaited = declaration?.init;
    const call = awaited?.type === "AwaitExpression" ? awaited.argument : null;
    return call?.type === "CallExpression" &&
      call.callee.type === "Identifier" &&
      call.callee.name === calleeName
      ? call
      : null;
  };
  const frameShaDeclaration = singleSnapshotDeclaration("frameSha256");
  const nonceDeclaration = singleSnapshotDeclaration("captureNonce");
  const ordinalDeclaration = singleSnapshotDeclaration("ordinal");
  const pngShaDeclaration = singleSnapshotDeclaration("capturePngSha256");
  const transactionDeclaration = singleSnapshotDeclaration("transactionSha256");
  const frameShaCall = awaitedCall(frameShaDeclaration, "digestJson");
  const pngShaCall = awaitedCall(pngShaDeclaration, "digestHex");
  const transactionCall = awaitedCall(transactionDeclaration, "digestJson");
  const pngBytesCall = pngShaCall?.arguments?.[0];
  const transactionObject = transactionCall?.arguments?.[0];
  const transactionProperties = new Map(
    (transactionObject?.properties ?? [])
      .filter((property) => property.type === "Property")
      .map((property) => [propertyName(property), property]),
  );
  const member = (node, object, property) =>
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === object &&
    node.property.type === "Identifier" &&
    node.property.name === property;
  const identifier = (node, name) =>
    node?.type === "Identifier" && node.name === name;
  const transactionShape = [
    "schema",
    "captureNonce",
    "captureOrdinal",
    "frameSha256",
    "label",
    "width",
    "height",
    "pngSha256",
    "samplerSchema",
    "sampleWidth",
    "sampleHeight",
    "nonBlackPixels",
    "meanLuminance",
    "sampleRgba",
  ];
  if (
    frameShaCall?.arguments?.length !== 1 ||
    !identifier(frameShaCall?.arguments?.[0], "frame") ||
    nonceDeclaration?.init?.type !== "CallExpression" ||
    !member(nonceDeclaration.init.callee, "crypto", "randomUUID") ||
    nonceDeclaration.init.arguments.length !== 0 ||
    ordinalDeclaration?.init?.type !== "UpdateExpression" ||
    ordinalDeclaration.init.operator !== "++" ||
    ordinalDeclaration.init.prefix !== true ||
    !identifier(ordinalDeclaration.init.argument, "captureOrdinal") ||
    pngBytesCall?.type !== "CallExpression" ||
    !identifier(pngBytesCall.callee, "pngBytes") ||
    pngBytesCall.arguments.length !== 1 ||
    !identifier(pngBytesCall.arguments[0], "dataUrl") ||
    transactionObject?.type !== "ObjectExpression" ||
    transactionObject.properties.map(propertyName).join(",") !==
      transactionShape.join(",") ||
    !member(
      transactionProperties.get("schema")?.value,
      "contract",
      "captureTransactionSchema",
    ) ||
    !identifier(
      transactionProperties.get("captureNonce")?.value,
      "captureNonce",
    ) ||
    !identifier(
      transactionProperties.get("captureOrdinal")?.value,
      "ordinal",
    ) ||
    !identifier(
      transactionProperties.get("frameSha256")?.value,
      "frameSha256",
    ) ||
    !identifier(transactionProperties.get("label")?.value, "label") ||
    !member(transactionProperties.get("width")?.value, "imageData", "width") ||
    !member(
      transactionProperties.get("height")?.value,
      "imageData",
      "height",
    ) ||
    !identifier(
      transactionProperties.get("pngSha256")?.value,
      "capturePngSha256",
    ) ||
    !member(
      transactionProperties.get("samplerSchema")?.value,
      "contract",
      "samplerSchema",
    ) ||
    !member(
      transactionProperties.get("sampleWidth")?.value,
      "contract",
      "sampleWidth",
    ) ||
    !member(
      transactionProperties.get("sampleHeight")?.value,
      "contract",
      "sampleHeight",
    ) ||
    !identifier(
      transactionProperties.get("nonBlackPixels")?.value,
      "nonBlackPixels",
    ) ||
    !identifier(
      transactionProperties.get("meanLuminance")?.value,
      "meanLuminance",
    ) ||
    !identifier(transactionProperties.get("sampleRgba")?.value, "rgba")
  ) {
    failures.push(
      "the snapshot must seal nonce, ordinal, frame, PNG, and grid in one canonical transaction",
    );
  }

  const imageProperties = new Map(
    (returnedImage?.properties ?? [])
      .filter((property) => property.type === "Property")
      .map((property) => [propertyName(property), property]),
  );
  const dataUrlProperty = imageProperties.get("dataUrl");
  const sampleProperty = imageProperties.get("sampleRgba");
  const widthProperty = imageProperties.get("width");
  const heightProperty = imageProperties.get("height");
  for (const [property, binding] of [
    ["captureNonce", "captureNonce"],
    ["captureOrdinal", "ordinal"],
    ["frameSha256", "frameSha256"],
    ["transactionSha256", "transactionSha256"],
    ["capturePngSha256", "capturePngSha256"],
  ]) {
    const value = imageProperties.get(property)?.value;
    if (value?.type !== "Identifier" || value.name !== binding) {
      failures.push(
        `reported ${property} must come from the canonical capture transaction`,
      );
    }
  }
  if (
    dataUrlProperty?.value?.type !== "Identifier" ||
    dataUrlProperty.value.name !== "dataUrl"
  ) {
    failures.push(
      "the documentary PNG must be the sole capture's dataUrl",
      dataUrlProperty,
    );
  }
  if (
    sampleProperty?.value?.type !== "Identifier" ||
    sampleProperty.value.name !== "rgba"
  ) {
    failures.push(
      "reported sampleRgba must be the sole capture's sampled grid",
      sampleProperty,
    );
  }
  for (const [name, property] of [
    ["width", widthProperty],
    ["height", heightProperty],
  ]) {
    if (
      property?.value?.type !== "MemberExpression" ||
      property.value.computed ||
      property.value.object.type !== "Identifier" ||
      property.value.object.name !== "imageData" ||
      property.value.property.type !== "Identifier" ||
      property.value.property.name !== name
    ) {
      failures.push(
        `reported ${name} must come from the sole decoded ImageData`,
        property,
      );
    }
  }

  const excludedRanges = [fusedStatement, samplerStatement].filter(Boolean);
  const outsideCanonical = (node) =>
    !excludedRanges.some((range) => inside(node, range));
  let captureMemberCount = 0;
  let fusedCaptureIdentifierCount = 0;
  let fusedHelperIdentifierCount = 0;
  let samplerIdentifierCount = 0;
  let samplerCallCount = 0;
  walkAst(ast, undefined, (node, parent) => {
    if (!outsideCanonical(node)) return false;
    if (node.type === "Identifier" && node.name === "fusedCapture") {
      fusedCaptureIdentifierCount++;
    }
    if (
      node.type === "Identifier" &&
      node.name === "makeFusedSnapshotCapture"
    ) {
      fusedHelperIdentifierCount++;
    }
    if (
      node.type === "Identifier" &&
      node.name === "sampleC1229S5ReplacementRgba"
    ) {
      samplerIdentifierCount++;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "sampleC1229S5ReplacementRgba"
    ) {
      samplerCallCount++;
    }
    if (node.type === "MemberExpression") {
      const property = staticProperty(node);
      if (property === "captureSnapshot") {
        captureMemberCount++;
        if (node !== captureCall?.callee) {
          failures.push(
            failure(
              "captureSnapshot is aliased, replaced, escaped, or invoked a second time",
              node,
            ),
          );
        }
      }
      if (
        property === undefined &&
        node.computed &&
        node.object.type === "Identifier" &&
        node.object.name === "fusedCapture"
      ) {
        failures.push(
          failure("dynamic capture member access is unsupported", node),
        );
      }
      if (LIVE_READ_METHODS.has(property)) {
        failures.push(
          failure(
            `${property} appears outside the canonical immutable capture`,
            node,
          ),
        );
      }
      if (node.computed && canvasDerived(node.object)) {
        failures.push(
          failure("dynamic canvas/prototype member access is forbidden", node),
        );
      }
    }
    if (
      node.type === "Identifier" &&
      (node.name === "HTMLCanvasElement" || node.name === "OffscreenCanvas")
    ) {
      failures.push(
        failure("canvas prototype substitution is forbidden", node),
      );
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      staticProperty(node.callee) === "createElement" &&
      staticValue(node.arguments[0]).value === "canvas"
    ) {
      failures.push(
        failure("a second canvas capture origin is forbidden", node),
      );
    }
    if (
      node.type === "Property" &&
      propertyName(node) === "captureSnapshot" &&
      node.parent !== captureCall?.callee
    ) {
      failures.push(
        failure("destructured captureSnapshot aliases are forbidden", node),
      );
    }
    if (node.type === "Property" && LIVE_READ_METHODS.has(propertyName(node))) {
      failures.push(
        failure(
          `${propertyName(node)} is destructured or aggregated outside the canonical capture`,
          node,
        ),
      );
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      staticProperty(node.callee) === "get" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Reflect" &&
      staticValue(node.arguments[1]).value === "captureSnapshot"
    ) {
      failures.push(failure("Reflect.get capture aliases are forbidden", node));
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      staticProperty(node.callee) === "get" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Reflect" &&
      LIVE_READ_METHODS.has(String(staticValue(node.arguments[1]).value))
    ) {
      failures.push(
        failure("Reflect.get live-canvas readers are forbidden", node),
      );
    }
    if (
      node.type === "Identifier" &&
      node.name === "snapshotPromise" &&
      parent?.type !== "VariableDeclarator" &&
      !(
        parent?.type === "AwaitExpression" &&
        decodeInit === parent &&
        parent.argument === node
      )
    ) {
      failures.push(
        failure("the capture promise escapes its sole await", node),
      );
    }
  });
  if (
    captureMemberCount !== 1 ||
    fusedCaptureIdentifierCount !== 2 ||
    fusedHelperIdentifierCount !== 1
  ) {
    failures.push(
      "exactly one unaliased fused capture must supply documentary PNG and samples",
    );
  }
  if (samplerIdentifierCount !== 1 || samplerCallCount !== 1) {
    failures.push("exactly one canonical sampler call must supply sampleRgba");
  }

  if (snapshot && returnedImage) {
    const allowedDataUrl = new Set();
    for (const property of decodeDeclaration?.declaration?.id?.properties ??
      []) {
      if (propertyName(property) === "dataUrl") {
        allowedDataUrl.add(property.key);
        allowedDataUrl.add(property.value);
      }
    }
    allowedDataUrl.add(dataUrlProperty?.key);
    allowedDataUrl.add(dataUrlProperty?.value);
    allowedDataUrl.add(pngBytesCall?.arguments?.[0]);
    const allowedImageData = new Set();
    for (const property of decodeDeclaration?.declaration?.id?.properties ??
      []) {
      if (propertyName(property) === "imageData") {
        allowedImageData.add(property.key);
        allowedImageData.add(property.value);
      }
    }
    allowedImageData.add(sampleInit?.arguments?.[0]);
    allowedImageData.add(widthProperty?.value?.object);
    allowedImageData.add(heightProperty?.value?.object);
    allowedImageData.add(transactionProperties.get("width")?.value?.object);
    allowedImageData.add(transactionProperties.get("height")?.value?.object);
    walkAst(snapshot.body, snapshot, (node) => {
      if (
        node.type === "Identifier" &&
        node.name === "dataUrl" &&
        !allowedDataUrl.has(node)
      ) {
        failures.push(
          failure("documentary dataUrl has an unsupported alias or use", node),
        );
      }
      if (
        node.type === "Identifier" &&
        node.name === "imageData" &&
        !allowedImageData.has(node)
      ) {
        failures.push(
          failure(
            "decoded ImageData has an unsupported alias or stale use",
            node,
          ),
        );
      }
      if (node.type === "Identifier" && node.name === "rgba") {
        const parent = parents.get(node);
        const grandparent = parents.get(parent);
        const declaration =
          parent?.type === "VariableDeclarator" && parent.id === node;
        const returned = sampleProperty?.value === node;
        const sealed = transactionProperties.get("sampleRgba")?.value === node;
        const readMember =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !(
            grandparent?.type === "AssignmentExpression" ||
            grandparent?.type === "UpdateExpression" ||
            (grandparent?.type === "CallExpression" &&
              grandparent.callee === parent)
          );
        if (!declaration && !returned && !sealed && !readMember) {
          failures.push(
            failure("sample grid is mutated, aliased, or escapes", node),
          );
        }
      }
    });
  }

  const proof = {
    schema: C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA,
    measurement: {
      declarationCount: measureDeclarations.length,
      identifierUses: measureIdentifierUses.length,
      pageEvaluateCalls: measurementEvaluateCalls.length,
      phaseSnapshotCalls: phaseSnapshotCalls.length,
      phaseSnapshotLabels,
    },
    fused: {
      beginMarkerCount: fusedBeginCount,
      endMarkerCount: fusedEndCount,
      canonicalSha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
      embeddedSha256: embeddedFused === null ? null : sha256(embeddedFused),
      executedSha256: fusedStatement
        ? sha256(sourceNode(text, fusedStatement))
        : null,
    },
    sampler: {
      schema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
      beginMarkerCount: samplerBeginCount,
      endMarkerCount: samplerEndCount,
      canonicalSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
      embeddedSha256: embeddedSampler === null ? null : sha256(embeddedSampler),
      executedSha256: samplerStatement
        ? sha256(sourceNode(text, samplerStatement))
        : null,
    },
    helperInstalls: fusedHelperIdentifierCount,
    captureCalls: captureMemberCount,
    samplerCalls: samplerCallCount,
    documentaryOrigins: dataUrlProperty ? 1 : 0,
    sampleOrigins: sampleProperty ? 1 : 0,
    sameOrigin:
      directCapture &&
      dataUrlProperty?.value?.name === "dataUrl" &&
      sampleProperty?.value?.name === "rgba",
    failureCount: failures.length,
  };
  return { ok: failures.length === 0, failures, proof };
}

export default {
  C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA,
  C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
  C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_GLOBAL,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_SAMPLER_BEGIN,
  C12_29_S5_REPLACEMENT_SAMPLER_END,
  C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
  C12_29_S5_REPLACEMENT_SAMPLER_SOURCE,
  C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_SAMPLE_GRID,
  C12_29_S5_REPLACEMENT_VIEWPORT,
  analyzeC1229S5ReplacementCaptureSource,
  deriveC1229S5ReplacementCaptureFrameSha256,
  deriveC1229S5ReplacementCaptureTransactionSha256,
  deriveC1229S5ReplacementSampleStats,
  inspectC1229S5ReplacementPng,
  inspectC1229S5ReplacementModuleImports,
  installC1229S5ReplacementRuntimeAttestor,
  sampleC1229S5ReplacementRgba,
};
