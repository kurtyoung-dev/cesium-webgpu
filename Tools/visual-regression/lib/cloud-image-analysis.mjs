/**
 * Pure image-analysis helpers for Campaign 13 cloud probes.
 *
 * The browser probes capture a same-camera clouds-OFF image and one or more
 * clouds-ON images. These helpers subtract the background, remove the cloud
 * silhouette from structure measurements, summarize morphology, and measure
 * directional autocorrelation in a locally detrended cloud signal.
 *
 * Directional autocorrelation is intentionally used instead of a single edge
 * count. A periodic density lattice produces repeat peaks at stable lags and
 * orientations, while a screen-space ray artifact can be identified by the
 * same peak appearing in both baked and live density lanes.
 */

const DEFAULT_ANALYSIS_OPTIONS = Object.freeze({
  signalThreshold: 6 / 255,
  erosionRadius: 2,
  highPassRadius: 8,
  maxAnalysisDimension: 320,
  minimumInteriorFraction: 0.35,
  minimumPairCount: 128,
  minimumLagPixels: 8,
  maximumLagPixels: 160,
  lagStepPixels: 4,
  anglesDegrees: [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5],
  maximumReportedPeaks: 16,
});

function assertImage(image, label) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !Number.isInteger(image.channels) ||
    image.channels < 3 ||
    !image.data ||
    image.data.length !== image.width * image.height * image.channels
  ) {
    throw new TypeError(`${label} is not a valid decoded RGB/RGBA image`);
  }
}

function assertSameDimensions(left, right) {
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.channels !== right.channels
  ) {
    throw new Error("cloud images must have matching dimensions and channels");
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(fraction * sorted.length)),
  );
  return sorted[index];
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) * 0.5
    : sorted[middle];
}

function robustMad(values, center = median(values)) {
  return median(values.map((value) => Math.abs(value - center)));
}

function luminance(data, offset) {
  return (
    (0.2126 * data[offset] +
      0.7152 * data[offset + 1] +
      0.0722 * data[offset + 2]) /
    255
  );
}

function integralImage(source, width, height, Type = Float64Array) {
  const stride = width + 1;
  const integral = new Type((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += source[y * width + x];
      integral[(y + 1) * stride + x + 1] =
        integral[y * stride + x + 1] + rowSum;
    }
  }
  return integral;
}

function integralArea(integral, width, x0, y0, x1, y1) {
  const stride = width + 1;
  return (
    integral[(y1 + 1) * stride + x1 + 1] -
    integral[y0 * stride + x1 + 1] -
    integral[(y1 + 1) * stride + x0] +
    integral[y0 * stride + x0]
  );
}

function boxBlur(source, width, height, radius) {
  const integral = integralImage(source, width, height);
  const blurred = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      blurred[y * width + x] =
        integralArea(integral, width, x0, y0, x1, y1) /
        ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return blurred;
}

function erodeMask(mask, width, height, radius) {
  if (radius <= 0) {
    return mask.slice();
  }
  const integral = integralImage(mask, width, height, Uint32Array);
  const eroded = new Uint8Array(mask.length);
  const diameter = radius * 2 + 1;
  const required = diameter * diameter;
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const area = integralArea(
        integral,
        width,
        x - radius,
        y - radius,
        x + radius,
        y + radius,
      );
      if (area === required) {
        eroded[y * width + x] = 1;
      }
    }
  }
  return eroded;
}

function connectedComponentAreas(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const areas = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) {
            continue;
          }
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const neighbor = ny * width + nx;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    areas.push(tail);
  }
  return areas.sort((left, right) => left - right);
}

/**
 * Decode a PNG with the repository's existing Sharp dependency.
 */
export async function decodeCloudPng(input) {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

/**
 * Build a cloud-only scalar field from same-camera ON and OFF images.
 */
export function buildCloudContribution(onImage, offImage, options = {}) {
  assertImage(onImage, "onImage");
  assertImage(offImage, "offImage");
  assertSameDimensions(onImage, offImage);
  const settings = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const { width, height, channels } = onImage;
  const signal = new Float32Array(width * height);
  const rawMask = new Uint8Array(signal.length);
  for (let pixel = 0; pixel < signal.length; pixel++) {
    const offset = pixel * channels;
    const difference = Math.abs(
      luminance(onImage.data, offset) - luminance(offImage.data, offset),
    );
    signal[pixel] = difference;
    rawMask[pixel] = difference > settings.signalThreshold ? 1 : 0;
  }
  const interiorMask = erodeMask(
    rawMask,
    width,
    height,
    settings.erosionRadius,
  );
  return {
    width,
    height,
    signal,
    rawMask,
    interiorMask,
    settings,
  };
}

function summarizeMorphology(field) {
  const { width, height, signal, rawMask, interiorMask } = field;
  const values = [];
  let cloudPixels = 0;
  let interiorPixels = 0;
  let signalSum = 0;
  let edgeSum = 0;
  let edgeSamples = 0;
  for (let index = 0; index < signal.length; index++) {
    if (rawMask[index]) {
      cloudPixels++;
    }
    if (!interiorMask[index]) {
      continue;
    }
    interiorPixels++;
    signalSum += signal[index];
    values.push(signal[index]);
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (
        !interiorMask[index] ||
        !interiorMask[index - 1] ||
        !interiorMask[index + 1] ||
        !interiorMask[index - width] ||
        !interiorMask[index + width]
      ) {
        continue;
      }
      const dx = Math.abs(signal[index + 1] - signal[index - 1]) * 0.5;
      const dy = Math.abs(signal[index + width] - signal[index - width]) * 0.5;
      edgeSum += Math.hypot(dx, dy);
      edgeSamples++;
    }
  }
  values.sort((left, right) => left - right);
  const components = connectedComponentAreas(rawMask, width, height);
  return {
    width,
    height,
    cloudPixels,
    cloudFraction: cloudPixels / (width * height),
    interiorPixels,
    meanSignal: interiorPixels ? signalSum / interiorPixels : 0,
    p10Signal: percentile(values, 0.1),
    p50Signal: percentile(values, 0.5),
    p90Signal: percentile(values, 0.9),
    edgeEnergy: edgeSamples ? edgeSum / edgeSamples : 0,
    componentCount: components.length,
    componentAreaP50: percentile(components, 0.5),
    componentAreaP90: percentile(components, 0.9),
    largestComponentArea: components.at(-1) ?? 0,
  };
}

function locallyDetrendedField(field) {
  const localMean = boxBlur(
    field.signal,
    field.width,
    field.height,
    field.settings.highPassRadius,
  );
  const residual = new Float32Array(field.signal.length);
  for (let index = 0; index < residual.length; index++) {
    if (!field.interiorMask[index]) {
      continue;
    }
    residual[index] = clamp(
      (field.signal[index] - localMean[index]) /
        Math.max(localMean[index], 0.03),
      -4,
      4,
    );
  }
  return residual;
}

function downsampleForPeriodicity(field, residual) {
  const stride = Math.max(
    1,
    Math.ceil(
      Math.max(field.width, field.height) / field.settings.maxAnalysisDimension,
    ),
  );
  const width = Math.ceil(field.width / stride);
  const height = Math.ceil(field.height / stride);
  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = x * stride;
      const y0 = y * stride;
      const x1 = Math.min(field.width, x0 + stride);
      const y1 = Math.min(field.height, y0 + stride);
      let sum = 0;
      let inside = 0;
      let total = 0;
      for (let sourceY = y0; sourceY < y1; sourceY++) {
        for (let sourceX = x0; sourceX < x1; sourceX++) {
          total++;
          const sourceIndex = sourceY * field.width + sourceX;
          if (!field.interiorMask[sourceIndex]) {
            continue;
          }
          inside++;
          sum += residual[sourceIndex];
        }
      }
      const index = y * width + x;
      if (
        total > 0 &&
        inside / total >= field.settings.minimumInteriorFraction
      ) {
        mask[index] = 1;
        values[index] = sum / Math.max(inside, 1);
      }
    }
  }
  return { width, height, stride, values, mask };
}

function normalizedCorrelation(sample, dx, dy, minimumPairCount) {
  const xStart = Math.max(0, -dx);
  const xEnd = Math.min(sample.width, sample.width - dx);
  const yStart = Math.max(0, -dy);
  const yEnd = Math.min(sample.height, sample.height - dy);
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const indexA = y * sample.width + x;
      const indexB = (y + dy) * sample.width + x + dx;
      if (!sample.mask[indexA] || !sample.mask[indexB]) {
        continue;
      }
      const a = sample.values[indexA];
      const b = sample.values[indexB];
      count++;
      sumA += a;
      sumB += b;
      sumAA += a * a;
      sumBB += b * b;
      sumAB += a * b;
    }
  }
  if (count < minimumPairCount) {
    return null;
  }
  const covariance = sumAB - (sumA * sumB) / count;
  const varianceA = sumAA - (sumA * sumA) / count;
  const varianceB = sumBB - (sumB * sumB) / count;
  const denominator = Math.sqrt(
    Math.max(varianceA, 0) * Math.max(varianceB, 0),
  );
  if (!(denominator > 1e-12)) {
    return null;
  }
  return {
    correlation: clamp(covariance / denominator, -1, 1),
    pairCount: count,
  };
}

function summarizePeriodicity(field) {
  const residual = locallyDetrendedField(field);
  const sample = downsampleForPeriodicity(field, residual);
  const directional = [];
  const allCorrelations = [];
  for (const angleDegrees of field.settings.anglesDegrees) {
    const radians = (angleDegrees * Math.PI) / 180;
    const samples = [];
    const seenOffsets = new Set();
    for (
      let lagPixels = field.settings.minimumLagPixels;
      lagPixels <= field.settings.maximumLagPixels;
      lagPixels += field.settings.lagStepPixels
    ) {
      const dx = Math.round((Math.cos(radians) * lagPixels) / sample.stride);
      const dy = Math.round((Math.sin(radians) * lagPixels) / sample.stride);
      if (dx === 0 && dy === 0) {
        continue;
      }
      const key = `${dx},${dy}`;
      if (seenOffsets.has(key)) {
        continue;
      }
      seenOffsets.add(key);
      const result = normalizedCorrelation(
        sample,
        dx,
        dy,
        field.settings.minimumPairCount,
      );
      if (!result) {
        continue;
      }
      const realizedLagPixels = Math.hypot(dx, dy) * sample.stride;
      const record = {
        angleDegrees,
        lagPixels: realizedLagPixels,
        correlation: result.correlation,
        pairCount: result.pairCount,
      };
      samples.push(record);
      allCorrelations.push(result.correlation);
    }
    directional.push({ angleDegrees, samples });
  }

  const baseline = median(allCorrelations);
  const mad = robustMad(allCorrelations, baseline);
  const robustScale = Math.max(1.4826 * mad, 0.02);
  const peaks = [];
  for (const direction of directional) {
    for (let index = 1; index < direction.samples.length - 1; index++) {
      const previous = direction.samples[index - 1];
      const current = direction.samples[index];
      const next = direction.samples[index + 1];
      if (
        current.correlation < previous.correlation ||
        current.correlation < next.correlation
      ) {
        continue;
      }
      const localProminence =
        current.correlation - (previous.correlation + next.correlation) * 0.5;
      const excess = current.correlation - baseline;
      peaks.push({
        ...current,
        localProminence,
        excess,
        robustProminence: excess / robustScale,
        strength: Math.max(0, excess) + Math.max(0, localProminence),
      });
    }
  }
  peaks.sort((left, right) => right.strength - left.strength);
  const reportedPeaks = peaks.slice(0, field.settings.maximumReportedPeaks);
  const strongest = reportedPeaks[0];
  return {
    method: "locally-detrended-directional-autocorrelation-v1",
    analysisStridePixels: sample.stride,
    sampledWidth: sample.width,
    sampledHeight: sample.height,
    correlationSampleCount: allCorrelations.length,
    medianCorrelation: baseline,
    correlationMad: mad,
    maximumCorrelation:
      allCorrelations.length > 0 ? Math.max(...allCorrelations) : 0,
    score: strongest?.strength ?? 0,
    strongestPeak: strongest ?? null,
    peaks: reportedPeaks,
  };
}

/**
 * Analyze morphology and directional periodicity without returning large
 * intermediate typed arrays.
 */
export function analyzeCloudImages(onImage, offImage, options = {}) {
  const field = buildCloudContribution(onImage, offImage, options);
  return {
    morphology: summarizeMorphology(field),
    periodicity: summarizePeriodicity(field),
  };
}

/**
 * Whole-image difference used only to prove that two controlled lanes did not
 * accidentally capture the same branch.
 */
export function compareCloudImages(left, right) {
  assertImage(left, "left");
  assertImage(right, "right");
  assertSameDimensions(left, right);
  let differentPixels = 0;
  let absoluteRgbDelta = 0;
  let maxChannelDelta = 0;
  const pixels = left.width * left.height;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * left.channels;
    let differs = false;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(
        left.data[offset + channel] - right.data[offset + channel],
      );
      absoluteRgbDelta += difference;
      maxChannelDelta = Math.max(maxChannelDelta, difference);
      differs ||= difference !== 0;
    }
    if (differs) {
      differentPixels++;
    }
  }
  return {
    differentPixels,
    differentPixelFraction: differentPixels / pixels,
    meanAbsoluteRgbDelta: absoluteRgbDelta / (pixels * 3 * 255),
    maxChannelDelta,
  };
}

function angularDistance(left, right) {
  const difference = Math.abs(left - right) % 180;
  return Math.min(difference, 180 - difference);
}

function peaksMatch(left, right, options) {
  const lagTolerance = Math.max(
    options.minimumLagTolerancePixels,
    Math.max(left.lagPixels, right.lagPixels) * options.relativeLagTolerance,
  );
  return (
    Math.abs(left.lagPixels - right.lagPixels) <= lagTolerance &&
    angularDistance(left.angleDegrees, right.angleDegrees) <=
      options.angleToleranceDegrees
  );
}

function matchingPeak(peak, candidates, options) {
  let best = null;
  for (const candidate of candidates) {
    if (!peaksMatch(peak, candidate, options)) {
      continue;
    }
    if (!best || candidate.strength > best.strength) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Attribute repeat peaks in a baked/live × midpoint/IGN factorial.
 */
export function classifyCloudPeriodicityFactorial(analyses, options = {}) {
  const settings = {
    minimumLagTolerancePixels: 6,
    relativeLagTolerance: 0.12,
    angleToleranceDegrees: 15,
    scoreRatioLimit: 1.25,
    scoreAdditiveAllowance: 0.03,
    ...options,
  };
  for (const key of ["bakedMidpoint", "bakedIgn", "liveMidpoint", "liveIgn"]) {
    if (!analyses[key]?.periodicity?.peaks) {
      throw new TypeError(`missing periodicity analysis for ${key}`);
    }
  }

  const bakedMidpoint = analyses.bakedMidpoint.periodicity;
  const bakedIgn = analyses.bakedIgn.periodicity;
  const liveMidpoint = analyses.liveMidpoint.periodicity;
  const liveIgn = analyses.liveIgn.periodicity;
  const persistentBaked = [];
  const commonWithLive = [];
  for (const midpointPeak of bakedMidpoint.peaks) {
    const ignPeak = matchingPeak(midpointPeak, bakedIgn.peaks, settings);
    if (!ignPeak) {
      continue;
    }
    const record = {
      angleDegrees: (midpointPeak.angleDegrees + ignPeak.angleDegrees) * 0.5,
      lagPixels: (midpointPeak.lagPixels + ignPeak.lagPixels) * 0.5,
      strength: Math.min(midpointPeak.strength, ignPeak.strength),
      midpoint: midpointPeak,
      ign: ignPeak,
    };
    const liveMatch =
      matchingPeak(midpointPeak, liveMidpoint.peaks, settings) ??
      matchingPeak(midpointPeak, liveIgn.peaks, settings) ??
      matchingPeak(ignPeak, liveMidpoint.peaks, settings) ??
      matchingPeak(ignPeak, liveIgn.peaks, settings);
    if (liveMatch) {
      commonWithLive.push({ ...record, live: liveMatch });
    } else {
      persistentBaked.push(record);
    }
  }

  const phaseSensitiveBaked = bakedMidpoint.peaks.filter(
    (peak) => !matchingPeak(peak, bakedIgn.peaks, settings),
  );
  const bakedMeanScore = (bakedMidpoint.score + bakedIgn.score) * 0.5;
  const liveMeanScore = (liveMidpoint.score + liveIgn.score) * 0.5;
  const allowedBakedScore = Math.max(
    liveMeanScore * settings.scoreRatioLimit,
    liveMeanScore + settings.scoreAdditiveAllowance,
  );
  return {
    method: "baked-live-midpoint-ign-factorial-v1",
    laneScores: {
      bakedMidpoint: bakedMidpoint.score,
      bakedIgn: bakedIgn.score,
      liveMidpoint: liveMidpoint.score,
      liveIgn: liveIgn.score,
    },
    bakedMeanScore,
    liveMeanScore,
    bakedToLiveScoreRatio: bakedMeanScore / Math.max(liveMeanScore, 1e-9),
    bakedScoreExcess: bakedMeanScore - liveMeanScore,
    allowedBakedScore,
    persistentBakedOnlyPeakCount: persistentBaked.length,
    persistentBakedOnlyPeaks: persistentBaked,
    commonRayOrScreenPeakCount: commonWithLive.length,
    commonRayOrScreenPeaks: commonWithLive,
    phaseSensitiveBakedPeakCount: phaseSensitiveBaked.length,
    phaseSensitiveBakedPeaks: phaseSensitiveBaked,
    candidateGate: {
      description:
        "baked directional-periodicity score stays within the live control envelope",
      ratioLimit: settings.scoreRatioLimit,
      additiveAllowance: settings.scoreAdditiveAllowance,
      value: bakedMeanScore,
      limit: allowedBakedScore,
      passed: bakedMeanScore <= allowedBakedScore,
    },
  };
}
