// metrics-c11-references.mjs — the C11 family's pixel metrics exactly as they
// stood before the probe-kit harvest, kept as the equivalence spec's oracle.
// @purpose Spec fixture: verbatim pre-harvest bodies of the C11-13 footprint, C11-90 component/diff and C11-209 screenshot metrics, so metrics-c11.spec.mjs can prove the kit modules return what the inline code returned.
// @status ACTIVE
//
// Each body below is the text `git show a5b71fc17b:<file>` prints for the named
// function, with exactly these edits and no others:
//   - the sharp decode prologue (`const { data, info } = await sharp(...)
//     .removeAlpha().raw().toBuffer({ resolveWithObject: true })`) is replaced
//     by a `decoded` parameter carrying the same `{ data, info }`, so the
//     function is synchronous and needs no image on disk;
//   - `async function <name>` becomes `export function reference<Name>`;
//   - C11-90 `imageMetrics`: `fs.statSync(filePath).size` and
//     `sha256(fs.readFileSync(filePath))` read `fileFacts.bytes` and
//     `fileFacts.sha256` instead (the file facts are I/O, not arithmetic);
//   - C11-90 `imageDifference`: the two-file sharp decode becomes the
//     `first`/`second` decoded parameters.
// Sources: lib/c11-13-voxel-inside-camera-probe.mjs (analyzePng :1230,
// compareBackendCaptures :1333), lib/c11-90-primitive-restart-probe.mjs
// (imageMetrics :567, imageDifference :701),
// probe-c11-209-effects-placeholder-startup.mjs (analyzeScreenshot :645).
// Nothing outside the spec imports this file.

import { createHash } from "node:crypto";

/** C11-13 `PIXEL_TOLERANCES` at a5b71fc17b, verbatim. */
const PIXEL_TOLERANCES = Object.freeze({
  nonBlackThreshold: 18,
  minimumNonBlackPixels: 512,
  minimumNonBlackFraction: 0.0007,
  minimumInteriorNonBlackPixels: 64,
  minimumCenterPatchNonBlackPixels: 1,
  minimumCenterPixelMaximum: 18,
  minimumGreenDominance: 12,
  minimumFootprintIou: 0.6,
  minimumFootprintRatio: 0.65,
  maximumFootprintRatio: 1.54,
  minimumBoundingBoxRatio: 0.65,
  maximumBoundingBoxRatio: 1.54,
  maximumMeanColorL1: 60,
});

/** Both harnesses' private `sha256`, verbatim. */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function referenceAnalyzePng(pngBytes, decoded) {
  const { data, info } = decoded;
  const pixelCount = info.width * info.height;
  const mask = new Uint8Array(pixelCount);
  const threshold = PIXEL_TOLERANCES.nonBlackThreshold;
  const interiorMinX = Math.floor(info.width * 0.2);
  const interiorMaxX = Math.ceil(info.width * 0.8);
  const interiorMinY = Math.floor(info.height * 0.2);
  const interiorMaxY = Math.ceil(info.height * 0.8);
  const centerX = Math.floor(info.width / 2);
  const centerY = Math.floor(info.height / 2);
  let nonBlackPixels = 0;
  let interiorNonBlackPixels = 0;
  let centerPatchNonBlackPixels = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = y * info.width + x;
      const offset = pixel * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.max(red, green, blue) < threshold) continue;
      mask[pixel] = 1;
      nonBlackPixels += 1;
      sumR += red;
      sumG += green;
      sumB += blue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (
        x >= interiorMinX &&
        x < interiorMaxX &&
        y >= interiorMinY &&
        y < interiorMaxY
      ) {
        interiorNonBlackPixels += 1;
      }
      if (Math.abs(x - centerX) <= 4 && Math.abs(y - centerY) <= 4) {
        centerPatchNonBlackPixels += 1;
      }
    }
  }

  const centerOffset = (centerY * info.width + centerX) * info.channels;
  const meanRgb =
    nonBlackPixels > 0
      ? [sumR, sumG, sumB].map((value) => value / nonBlackPixels)
      : [0, 0, 0];
  return {
    mask,
    metrics: {
      width: info.width,
      height: info.height,
      channels: info.channels,
      pixelCount,
      rawBytes: data.length,
      rawSha256: sha256(data),
      pngBytes: pngBytes.length,
      pngSha256: sha256(pngBytes),
      nonBlackPixels,
      nonBlackFraction: nonBlackPixels / pixelCount,
      interiorNonBlackPixels,
      centerPatchNonBlackPixels,
      centerPixelRgb: [
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ],
      centerPixelMaximum: Math.max(
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ),
      meanRgb,
      greenDominance: meanRgb[1] - Math.max(meanRgb[0], meanRgb[2]),
      boundingBox:
        nonBlackPixels > 0
          ? {
              minX,
              minY,
              maxX,
              maxY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            }
          : null,
    },
  };
}

export function referenceCompareBackendCaptures(webgl, webgpu) {
  const comparable =
    webgl?.metrics?.width === webgpu?.metrics?.width &&
    webgl?.metrics?.height === webgpu?.metrics?.height &&
    webgl?.mask?.length === webgpu?.mask?.length &&
    webgl?.mask?.length > 0;
  if (!comparable) {
    return {
      comparable: false,
      bothNonVacuous: false,
      intersectionPixels: 0,
      unionPixels: 0,
      footprintIou: 0,
      footprintRatio: null,
      boundingBoxWidthRatio: null,
      boundingBoxHeightRatio: null,
      meanColorL1: Number.POSITIVE_INFINITY,
    };
  }
  let intersectionPixels = 0;
  let unionPixels = 0;
  for (let pixel = 0; pixel < webgl.mask.length; pixel += 1) {
    const gl = webgl.mask[pixel] === 1;
    const gpu = webgpu.mask[pixel] === 1;
    if (gl && gpu) intersectionPixels += 1;
    if (gl || gpu) unionPixels += 1;
  }
  const webglPixels = webgl.metrics.nonBlackPixels;
  const webgpuPixels = webgpu.metrics.nonBlackPixels;
  const bothNonVacuous =
    webglPixels >= PIXEL_TOLERANCES.minimumNonBlackPixels &&
    webgpuPixels >= PIXEL_TOLERANCES.minimumNonBlackPixels;
  return {
    comparable: true,
    bothNonVacuous,
    intersectionPixels,
    unionPixels,
    footprintIou: unionPixels > 0 ? intersectionPixels / unionPixels : 0,
    footprintRatio: webglPixels > 0 ? webgpuPixels / webglPixels : null,
    boundingBoxWidthRatio:
      webgl.metrics.boundingBox?.width > 0
        ? webgpu.metrics.boundingBox?.width / webgl.metrics.boundingBox.width
        : null,
    boundingBoxHeightRatio:
      webgl.metrics.boundingBox?.height > 0
        ? webgpu.metrics.boundingBox?.height / webgl.metrics.boundingBox.height
        : null,
    meanColorL1: webgl.metrics.meanRgb.reduce(
      (sum, channel, index) =>
        sum + Math.abs(channel - webgpu.metrics.meanRgb[index]),
      0,
    ),
  };
}

export function referenceImageMetrics(decoded, fileFacts) {
  const { data, info } = decoded;
  const pixelCount = info.width * info.height;
  const mask = new Uint8Array(pixelCount);
  let modelMaskPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * info.channels;
    const colors = [data[offset], data[offset + 1], data[offset + 2]];
    const maximum = Math.max(...colors);
    const minimum = Math.min(...colors);
    if (maximum >= 32 && maximum - minimum <= 42) {
      mask[pixel] = 1;
      modelMaskPixels += 1;
    }
  }

  const significantThreshold = Math.max(64, Math.floor(pixelCount * 0.00005));
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    let size = 0;
    let minimumX = info.width;
    let maximumX = -1;
    let minimumY = info.height;
    let maximumY = -1;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const current = queue[head++];
      size += 1;
      const x = current % info.width;
      const y = Math.floor(current / info.width);
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) {
            continue;
          }
          const next = ny * info.width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (size >= significantThreshold) {
      const width = maximumX - minimumX + 1;
      const height = maximumY - minimumY + 1;
      components.push({
        pixels: size,
        bounds: { minimumX, maximumX, minimumY, maximumY },
        width,
        height,
        verticalAspect: height / width,
        elongation: Math.max(width / height, height / width),
      });
    }
  }
  components.sort((left, right) => right.pixels - left.pixels);
  const componentSizes = components.map((component) => component.pixels);
  const significantComponentPixels = componentSizes.reduce(
    (sum, size) => sum + size,
    0,
  );
  const componentBalance =
    components.length > 0 ? components.at(-1).pixels / components[0].pixels : 0;
  return {
    width: info.width,
    height: info.height,
    bytes: fileFacts.bytes,
    sha256: fileFacts.sha256,
    modelMaskPixels,
    modelMaskFraction: modelMaskPixels / pixelCount,
    significantComponentThreshold: significantThreshold,
    significantComponentCount: components.length,
    significantComponentPixels,
    significantComponentCoverage:
      modelMaskPixels > 0 ? significantComponentPixels / modelMaskPixels : 0,
    significantComponentSizes: componentSizes.slice(0, 16),
    significantComponents: components.slice(0, 16),
    componentBalance,
    largestComponentShare:
      modelMaskPixels > 0 ? (componentSizes[0] ?? 0) / modelMaskPixels : 1,
  };
}

export function referenceImageDifference(first, second) {
  if (
    first.info.width !== second.info.width ||
    first.info.height !== second.info.height ||
    first.info.channels !== second.info.channels
  ) {
    return { comparable: false, changedPixels: 0, meanAbsoluteDelta: 0 };
  }
  let changedPixels = 0;
  let absoluteDelta = 0;
  for (
    let offset = 0;
    offset < first.data.length;
    offset += first.info.channels
  ) {
    let maximumDelta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        first.data[offset + channel] - second.data[offset + channel],
      );
      maximumDelta = Math.max(maximumDelta, delta);
      absoluteDelta += delta;
    }
    if (maximumDelta >= 12) changedPixels += 1;
  }
  return {
    comparable: true,
    changedPixels,
    meanAbsoluteDelta:
      absoluteDelta / (first.info.width * first.info.height * 3),
  };
}

export function referenceAnalyzeScreenshot(decoded) {
  const { data, info } = decoded;
  const colors = new Set();
  let nonBlack = 0;
  let sum = 0;
  let sumSquares = 0;
  const pixels = info.width * info.height;
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (red + green + blue > 24) {
      nonBlack++;
    }
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sum += luma;
    sumSquares += luma * luma;
    colors.add(`${red >> 4},${green >> 4},${blue >> 4}`);
  }
  const mean = sum / pixels;
  return {
    width: info.width,
    height: info.height,
    pixels,
    nonBlackPixels: nonBlack,
    nonBlackFraction: nonBlack / pixels,
    distinctQuantizedColors: colors.size,
    meanLuma: mean,
    lumaStddev: Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean)),
  };
}
