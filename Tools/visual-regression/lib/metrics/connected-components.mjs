// connected-components.mjs — flood-fill connected-component labelling for a
// single scalar or RGBA field.
// @purpose Label 4- or 8-connected foreground regions in a field and report per-component area, bbox, centroid and intensity, so structure survives where a band mean cannot see it.
// @status ACTIVE
//
// WHY THIS EXISTS. `QUEUE_2026-08-02_CAMPAIGN15.md` C15-08 states the rule this
// module exists to satisfy: "use isolated component differences,
// point/structure/connected-component metrics, and limb geometry; never use a
// band mean for a faint sparse additive signal." A thin additive curtain (an
// aurora arc, a sparse cloud streak) can carry the same total intensity, and
// therefore the same frame-wide mean, whether it is drawn as one coherent
// shape, scattered into disconnected specks, or omitted in favour of noise at
// the same energy. A band mean cannot tell those apart. Component count, area
// and centroid can — `metrics-structure.spec.mjs` test 3 builds exactly that
// pair (equal mean, unequal structure) and asserts both halves in one test.
//
// RGBA REDUCTION RULE. When `field.data` is RGBA bytes, the per-pixel
// intensity used for both the foreground test and the reported sums is Rec.
// 709 luma: `0.2126*R + 0.7152*G + 0.0722*B` (alpha ignored). This module does
// not import the rest of the fleet's photometry helpers — the lane brief for
// this batch keeps `lib/metrics/*` self-contained across concurrent owners —
// so the constant is restated here rather than shared. `structure-similarity.mjs`
// restates the identical constant so `structureSimilarityRgba` agrees with this
// module on what "intensity" means, by rule rather than by import.
//
// NO RECURSION. A flood fill implemented as function recursion blows the call
// stack on a component the size of the whole frame. Each component here is
// traced with an explicit array used as a stack, and the fill loop carries a
// hard iteration cap (`width*height + 1`, one more than the largest possible
// component) so a defect that revisits pixels fails closed with a thrown error
// instead of spinning.

/**
 * Rec. 709 luma of one RGBA pixel. See the RGBA REDUCTION RULE note above for
 * why this is restated rather than imported.
 *
 * @param {number} r Red, 0-255.
 * @param {number} g Green, 0-255.
 * @param {number} b Blue, 0-255.
 * @returns {number} Luma.
 */
function rec709Luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Validate a `{width, height, data}` field and classify its data layout.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} field Field.
 * @param {string} label Name used in thrown messages ("field").
 * @returns {{isRgba: boolean}} Layout classification.
 */
function classifyField(field, label) {
  if (field === null || typeof field !== "object") {
    throw new Error(`connectedComponents: ${label} must be an object`);
  }
  const { width, height, data } = field;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(
      `connectedComponents: ${label}.width must be a positive integer, got ${width}`,
    );
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(
      `connectedComponents: ${label}.height must be a positive integer, got ${height}`,
    );
  }
  if (
    data === null ||
    typeof data !== "object" ||
    typeof data.length !== "number"
  ) {
    throw new Error(`connectedComponents: ${label}.data must be array-like`);
  }
  const scalarLength = width * height;
  const rgbaLength = scalarLength * 4;
  if (data.length === scalarLength) {
    return { isRgba: false };
  }
  if (data.length === rgbaLength) {
    return { isRgba: true };
  }
  throw new Error(
    `connectedComponents: ${label} ${width}x${height} data length mismatch — ` +
      `got ${data.length}, expected ${scalarLength} (scalar) or ${rgbaLength} (rgba)`,
  );
}

const NEIGHBORS_4 = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);
const NEIGHBORS_8 = Object.freeze([
  ...NEIGHBORS_4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]);

/**
 * Label 4- or 8-connected foreground regions of a field.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} field
 *   Scalar field (`data.length === width*height`) or RGBA field
 *   (`data.length === width*height*4`, reduced per-pixel via Rec. 709 luma).
 * @param {{threshold: number, connectivity?: 4|8, minArea?: number}} options
 *   `threshold` (REQUIRED, no default) — a pixel is foreground when its
 *   intensity is strictly greater than this value. `connectivity` — 4
 *   (von Neumann, default) or 8 (Moore). `minArea` — components with fewer
 *   pixels than this are dropped from the result (default 1, i.e. none
 *   dropped).
 * @returns {{count: number, components: Array<{id: number, area: number,
 *   bbox: {x0: number, y0: number, x1: number, y1: number},
 *   centroid: {x: number, y: number}, sumIntensity: number,
 *   meanIntensity: number}>}} `components` sorted by `area` descending, then
 *   `id` ascending (`id` is assigned in raster discovery order over ALL
 *   discovered components, independent of `minArea`, so the id of a surviving
 *   component does not change when `minArea` changes).
 */
export function connectedComponents(field, options) {
  const { isRgba } = classifyField(field, "field");
  const { width, height, data } = field;

  if (options === null || typeof options !== "object") {
    throw new Error("connectedComponents: options is required");
  }
  if (options.threshold === undefined) {
    throw new Error(
      "connectedComponents: options.threshold is required (no silent default)",
    );
  }
  const threshold = options.threshold;
  const connectivity = options.connectivity ?? 4;
  if (connectivity !== 4 && connectivity !== 8) {
    throw new Error(
      `connectedComponents: options.connectivity must be 4 or 8, got ${connectivity}`,
    );
  }
  const minArea = options.minArea ?? 1;
  const neighborOffsets = connectivity === 8 ? NEIGHBORS_8 : NEIGHBORS_4;

  const intensityAt = isRgba
    ? (idx) => rec709Luma(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2])
    : (idx) => data[idx];

  const visited = new Uint8Array(width * height);
  const rawComponents = [];
  let nextId = 1;
  const stackCap = width * height + 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const seedIdx = y * width + x;
      if (visited[seedIdx]) {
        continue;
      }
      const seedValue = intensityAt(seedIdx);
      if (!(seedValue > threshold)) {
        visited[seedIdx] = 1;
        continue;
      }

      // Explicit-stack flood fill — see the NO RECURSION note in the module
      // header for why this is not a recursive function.
      const stack = [seedIdx];
      visited[seedIdx] = 1;
      let area = 0;
      let sumIntensity = 0;
      let sumX = 0;
      let sumY = 0;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      let iterations = 0;

      while (stack.length > 0) {
        iterations += 1;
        if (iterations > stackCap) {
          throw new Error(
            "connectedComponents: flood fill exceeded the bounded iteration " +
              "guard — a component cannot legitimately exceed width*height pixels",
          );
        }
        const idx = stack.pop();
        const px = idx % width;
        const py = (idx - px) / width;
        area += 1;
        const value = intensityAt(idx);
        sumIntensity += value;
        sumX += px;
        sumY += py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;

        for (const [dx, dy] of neighborOffsets) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx]) {
            continue;
          }
          const nValue = intensityAt(nIdx);
          if (!(nValue > threshold)) {
            visited[nIdx] = 1;
            continue;
          }
          // The union/merge step: an unvisited foreground neighbor joins the
          // CURRENT component rather than starting its own later. This is the
          // line the inertness mutant disables.
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }

      if (area >= minArea) {
        rawComponents.push({
          id: nextId,
          area,
          bbox: { x0, y0, x1, y1 },
          centroid: { x: sumX / area, y: sumY / area },
          sumIntensity,
          meanIntensity: sumIntensity / area,
        });
      }
      nextId += 1;
    }
  }

  rawComponents.sort((a, b) => b.area - a.area || a.id - b.id);
  return { count: rawComponents.length, components: rawComponents };
}
