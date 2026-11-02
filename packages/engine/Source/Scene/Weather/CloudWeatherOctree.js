import Cartesian3 from "../../Core/Cartesian3.js";
import OctreeNode from "../OctreeNode.js";

function sineRange(low, high) {
  let minimum = Math.min(Math.sin(low), Math.sin(high));
  let maximum = Math.max(Math.sin(low), Math.sin(high));
  for (
    let k = Math.ceil((low - Math.PI * 0.5) / Math.PI);
    Math.PI * 0.5 + k * Math.PI <= high;
    k++
  ) {
    const value = k % 2 === 0 ? 1 : -1;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return [minimum, maximum];
}

function product(a, b) {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...values), Math.max(...values)];
}

function sectorBounds(
  x0,
  y0,
  x1,
  y1,
  width,
  height,
  options,
  baseFraction = 0,
  topFraction = 1,
) {
  const { equatorialRadius: a, polarRadius: b, bottom, top } = options;
  // Include bilinear support and one additional texel for the shader's angular
  // coordinate rounding, including asin's reduced precision near the poles.
  const lon0 = ((x0 - 1.5) / width) * Math.PI * 2 - Math.PI;
  const lon1 = ((x1 + 1.5) / width) * Math.PI * 2 - Math.PI;
  const lat0 = Math.max(-Math.PI * 0.5, Math.PI * (0.5 - (y1 + 1.5) / height));
  const lat1 = Math.min(Math.PI * 0.5, Math.PI * (0.5 - (y0 - 1.5) / height));
  const sinLat = sineRange(lat0, lat1);
  const cosLat = sineRange(lat0 + Math.PI * 0.5, lat1 + Math.PI * 0.5);
  const nearPole = Math.max(Math.abs(lat0), Math.abs(lat1));
  const nearEquator =
    lat0 <= 0 && lat1 >= 0 ? 0 : Math.min(Math.abs(lat0), Math.abs(lat1));
  const radius = (latitude, altitude) =>
    1 /
    Math.hypot(
      Math.cos(latitude) / (a + altitude),
      Math.sin(latitude) / (b + altitude),
    );
  let innerRadius = radius(nearPole, bottom);
  if (baseFraction > 0) {
    // The shader interpolates squared implicit-surface residuals. Its height
    // is not linear in altitude: h=f lies on this reciprocal-squared blend.
    const innerA =
      1 /
      Math.sqrt(
        (1 - baseFraction) / (a + bottom) ** 2 + baseFraction / (a + top) ** 2,
      );
    const innerB =
      1 /
      Math.sqrt(
        (1 - baseFraction) / (b + bottom) ** 2 + baseFraction / (b + top) ** 2,
      );
    innerRadius =
      1 / Math.hypot(Math.cos(nearPole) / innerA, Math.sin(nearPole) / innerB);
  }
  let outerRadius = radius(nearEquator, top);
  if (topFraction < 1) {
    const outerA =
      1 /
      Math.sqrt(
        (1 - topFraction) / (a + bottom) ** 2 + topFraction / (a + top) ** 2,
      );
    const outerB =
      1 /
      Math.sqrt(
        (1 - topFraction) / (b + bottom) ** 2 + topFraction / (b + top) ** 2,
      );
    outerRadius =
      1 /
      Math.hypot(
        Math.cos(nearEquator) / outerA,
        Math.sin(nearEquator) / outerB,
      );
  }
  const radial = [innerRadius, outerRadius];
  const horizontal = product(radial, cosLat);
  const axes = [
    product(horizontal, sineRange(lon0 + Math.PI * 0.5, lon1 + Math.PI * 0.5)),
    product(horizontal, sineRange(lon0, lon1)),
    product(radial, sinLat),
  ];
  // Pad split-coordinate packing and f32 ray-box arithmetic in world metres.
  return {
    min: axes.map((range) => range[0] - 64),
    max: axes.map((range) => range[1] + 64),
  };
}

function occupiedRegion(weather, width, x0, y0, x1, y1, vertical) {
  let left = x1,
    right = x0,
    upper = y1,
    lower = y0;
  let occupied = 0,
    minimumBase = 255,
    maximumBase = 0,
    maximumCoverage = 0;
  let minimumTop = Infinity,
    maximumTop = 0;
  if (vertical) {
    minimumBase = Infinity;
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * 4;
      if (weather[offset] === 0) {
        continue;
      }
      occupied++;
      maximumCoverage = Math.max(maximumCoverage, weather[offset] / 255);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      upper = Math.min(upper, y);
      lower = Math.max(lower, y + 1);
      const base = vertical
        ? (vertical[offset] + 256 * vertical[offset + 1]) * 0.5
        : weather[offset + 2];
      minimumBase = Math.min(minimumBase, base);
      maximumBase = Math.max(maximumBase, base);
      if (vertical) {
        const top = (vertical[offset + 2] + 256 * vertical[offset + 3]) * 0.5;
        minimumTop = Math.min(minimumTop, top);
        maximumTop = Math.max(maximumTop, top);
      }
    }
  }
  return occupied
    ? {
        texels: [left, upper, right, lower],
        occupied,
        minimumBase,
        maximumBase,
        minimumTop,
        maximumTop,
        maximumCoverage,
      }
    : null;
}

function refineWeatherRegions(weather, width, seeds, limit, vertical) {
  const pending = seeds.slice(),
    leaves = [];
  let leafCount = seeds.length,
    refinements = 0;
  for (let i = 0; i < pending.length; i++) {
    const region = pending[i];
    const [x0, y0, x1, y1] = region.texels;
    const dx = x1 - x0,
      dy = y1 - y0;
    const heterogeneous =
      region.occupied < dx * dy * 0.75 ||
      region.maximumBase - region.minimumBase >= (vertical ? 1000 : 16) ||
      (vertical && region.maximumTop - region.minimumTop >= 1000);
    if (!heterogeneous || (dx <= 4 && dy <= 4)) {
      leaves.push(region);
      continue;
    }
    const xs = dx > 4 ? [x0, Math.floor((x0 + x1) * 0.5), x1] : [x0, x1];
    const ys = dy > 4 ? [y0, Math.floor((y0 + y1) * 0.5), y1] : [y0, y1];
    const children = [];
    for (let y = 1; y < ys.length; y++) {
      for (let x = 1; x < xs.length; x++) {
        const child = occupiedRegion(
          weather,
          width,
          xs[x - 1],
          ys[y - 1],
          xs[x],
          ys[y],
          vertical,
        );
        if (child) {
          children.push(child);
        }
      }
    }
    // Reserve all unprocessed leaves before spending the refinement budget.
    // A budget miss keeps the complete parent rather than dropping coverage.
    if (leafCount + children.length - 1 > limit) {
      leaves.push(region);
      continue;
    }
    leafCount += children.length - 1;
    refinements++;
    pending.push(...children);
  }
  return { leaves, refinements };
}

function minimumWeatherBase(weather, width, height, texels) {
  const [x0, y0, x1, y1] = texels;
  let minimum = 255;
  // Coverage and height are filtered independently. Clear neighbours can lower
  // the interpolated base, so include them, repeat longitude and clamp latitude.
  // The second texel also covers the angular rounding margin of sectorBounds.
  for (let y = Math.max(0, y0 - 2); y < Math.min(height, y1 + 2); y++) {
    for (let x = x0 - 2; x < x1 + 2; x++) {
      const wrappedX = ((x % width) + width) % width;
      minimum = Math.min(minimum, weather[(y * width + wrappedX) * 4 + 2]);
    }
  }
  return minimum / 255;
}

function validVerticalHeights(bytes, width, height, bottom, top) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== width * height * 4) {
    return false;
  }
  for (let i = 0; i < bytes.length; i += 4) {
    const base = (bytes[i] + 256 * bytes[i + 1]) * 0.5;
    const cap = (bytes[i + 2] + 256 * bytes[i + 3]) * 0.5;
    if (base < bottom || cap > top || cap < base + 1) {
      return false;
    }
  }
  return true;
}

function weatherVerticalRange(bytes, width, height, texels) {
  const [x0, y0, x1, y1] = texels;
  let base = Infinity,
    top = 0;
  // Height and coverage filter independently, including clear texels. Match
  // the bilinear footprint and angular rounding margin of the sector bounds.
  for (let y = Math.max(0, y0 - 2); y < Math.min(height, y1 + 2); y++) {
    for (let x = x0 - 2; x < x1 + 2; x++) {
      const offset = (y * width + (((x % width) + width) % width)) * 4;
      base = Math.min(base, (bytes[offset] + 256 * bytes[offset + 1]) * 0.5);
      top = Math.max(top, (bytes[offset + 2] + 256 * bytes[offset + 3]) * 0.5);
    }
  }
  return [base, top];
}

export function buildCloudWeatherOctree(weather, width, height, options) {
  const { equatorialRadius: a, polarRadius: b, bottom, top } = options;
  const blockSize = options.blockSize ?? 16;
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    weather.length !== width * height * 4 ||
    !Number.isInteger(blockSize) ||
    blockSize < 1 ||
    ![a, b, bottom, top].every(Number.isFinite) ||
    a < b ||
    b + bottom <= 0 ||
    top <= bottom
  ) {
    throw new Error("Invalid cloud weather octree domain.");
  }
  const root = new OctreeNode(new Cartesian3(), a + top + 128, 0, 10, 8);
  const regions = [];
  const verticalRequested = options.verticalHeights !== undefined;
  const verticalBounds =
    options.tightBounds === true &&
    verticalRequested &&
    validVerticalHeights(options.verticalHeights, width, height, bottom, top);
  const vertical = verticalBounds ? options.verticalHeights : undefined;
  const decks = verticalRequested
    ? [[bottom, top]]
    : (options.layers ?? [[bottom, top]]);
  const strength = options.baseHeightStrength ?? 1;
  const tightBounds = verticalRequested
    ? verticalBounds
    : options.tightBounds === true &&
      Number.isFinite(strength) &&
      strength >= 0 &&
      strength <= 1 &&
      decks.length > 0 &&
      decks.length <= 3 &&
      decks.every(
        (deck) =>
          deck.length === 2 &&
          deck.every(Number.isFinite) &&
          deck[0] >= bottom &&
          deck[1] <= top &&
          deck[1] > deck[0],
      );
  const seeds = [];
  for (let y0 = 0; y0 < height; y0 += blockSize) {
    for (let x0 = 0; x0 < width; x0 += blockSize) {
      const x1 = Math.min(x0 + blockSize, width);
      const y1 = Math.min(y0 + blockSize, height);
      if (tightBounds) {
        const seed = occupiedRegion(weather, width, x0, y0, x1, y1, vertical);
        if (seed) {
          seeds.push(seed);
        }
        continue;
      }
      let maximumCoverage = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          maximumCoverage = Math.max(
            maximumCoverage,
            weather[(y * width + x) * 4] / 255,
          );
        }
      }
      if (maximumCoverage === 0) {
        continue;
      }
      seeds.push({ texels: [x0, y0, x1, y1], maximumCoverage });
    }
  }
  const refined = tightBounds
    ? refineWeatherRegions(
        weather,
        width,
        seeds,
        Math.max(seeds.length, Math.floor(16384 / decks.length)),
        vertical,
      )
    : { leaves: seeds, refinements: 0 };
  for (const seed of refined.leaves) {
    const [x0, y0, x1, y1] = seed.texels;
    const encodedBase =
      tightBounds && !verticalBounds
        ? minimumWeatherBase(weather, width, height, seed.texels)
        : 0;
    const heights = verticalBounds
      ? weatherVerticalRange(vertical, width, height, seed.texels)
      : null;
    for (const [deckBottom, deckTop] of tightBounds ? decks : [[bottom, top]]) {
      const baseFraction = heights
        ? Math.max(0, (heights[0] - bottom) / (top - bottom))
        : tightBounds
          ? Math.min(
              1,
              (Math.max(encodedBase * 12000 - deckBottom, 0) * strength) /
                Math.max(deckTop - deckBottom, 1),
            )
          : 0;
      const topFraction = heights
        ? Math.min(1, (heights[1] - bottom) / (top - bottom))
        : 1;
      const bounds = sectorBounds(
        x0,
        y0,
        x1,
        y1,
        width,
        height,
        { ...options, bottom: deckBottom, top: deckTop },
        baseFraction,
        topFraction,
      );
      const center = bounds.min.map((v, i) => (v + bounds.max[i]) * 0.5);
      const region = {
        ...bounds,
        texels: [x0, y0, x1, y1],
        id: regions.length,
        maximumCoverage: seed.maximumCoverage,
      };
      regions.push(region);
      // Use the engine octree's subdivision to group centres, then refit every
      // exported node to the full region bounds. The classification point is
      // never used as a visibility bound or submitted as a scene draw command.
      root.insert({
        boundingVolume: { center: new Cartesian3(...center), radius: 0 },
        region,
      });
    }
  }
  const nodes = [];
  function flatten(node) {
    const index = nodes.length;
    const record = {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
      escape: 0,
      region: -1,
      maximumCoverage: 0,
    };
    nodes.push(record);
    function include(bounds) {
      record.maximumCoverage = Math.max(
        record.maximumCoverage,
        bounds.maximumCoverage,
      );
      for (let axis = 0; axis < 3; axis++) {
        record.min[axis] = Math.min(record.min[axis], bounds.min[axis]);
        record.max[axis] = Math.max(record.max[axis], bounds.max[axis]);
      }
    }
    for (const command of node.commands) {
      const region = command.region;
      nodes.push({
        min: region.min,
        max: region.max,
        escape: nodes.length + 1,
        region: region.id,
        maximumCoverage: region.maximumCoverage,
      });
      include(region);
    }
    for (const child of node.children ?? []) {
      if (child && child.totalCommandCount > 0) {
        include(flatten(child));
      }
    }
    record.escape = nodes.length;
    return nodes[index];
  }
  if (regions.length) {
    flatten(root);
  }
  return {
    root,
    regions,
    nodes,
    tightBounds,
    verticalBounds,
    refinements: refined.refinements,
  };
}

export default buildCloudWeatherOctree;
