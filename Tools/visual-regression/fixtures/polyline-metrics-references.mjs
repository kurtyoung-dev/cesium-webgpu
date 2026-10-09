// polyline-metrics-references.mjs — the polyline probes' pre-harvest pixel
// arithmetic, copied VERBATIM from the tree at a5b71fc17b (Batch 1561), so
// `metrics-polyline.spec.mjs` can require the kit modules to reproduce it.
//
// @purpose Verbatim pre-harvest pixel bodies of the ten polyline probes (in-page readback loops and Node-side arc/diff helpers), wrapped to take a decoded frame, as the equivalence reference for lib/metrics/colour-mask, line-structure and curve-bow.
// @status ACTIVE
//
// WHAT "VERBATIM" MEANS HERE. Each in-page body read `px` (the
// `getImageData` bytes), `w` and `h` from its own closure; here the same body
// takes them as arguments. Nothing inside a loop, a comparison, a rounding or
// a return shape was changed — the bodies are the regression baseline, and a
// "tidied" copy would only prove the kit agrees with the tidying. The source
// line ranges are given per function so a reviewer can diff each one against
// `git show a5b71fc17b:Tools/visual-regression/<probe>`; the only lines that
// differ are the wrappers that hand back what the original kept in scope (a
// `return { … }` of its counters, an `out` without the page-only fields).
//
// This file is data for a spec, not a kit piece: no probe imports it.

/**
 * `probe-polyline-multimaterial.mjs` :211-:437 — the six hue classes, the
 * per-hue `measure`, `columnHeights`, `arrowProfile` and `outlineCrossSection`.
 */
export function referenceMultimaterial(px, w, h) {
  // Six mutually exclusive hue classifiers. No line can be mistaken for
  // another, so one material's collapse cannot inflate another's count.
  const T = 30;
  const hues = {
    solid: (i) => px[i] > T && px[i + 1] < T && px[i + 2] < T,
    dash: (i) => px[i] < T && px[i + 1] > T && px[i + 2] > T,
    glow: (i) => px[i] > T && px[i + 1] > T && px[i + 2] < T,
    arrow: (i) => px[i] > T && px[i + 1] < T && px[i + 2] > T,
    outline: (i) => px[i] < T && px[i + 1] > T && px[i + 2] < T,
    outlineEdge: (i) => px[i] < T && px[i + 1] < T && px[i + 2] > T,
  };

  function measure(classify) {
    let colored = 0;
    let runs = 0;
    let coloredRows = 0;
    const rowIntensity = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let prev = false;
      let rowHas = false;
      let sum = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const c = classify(i);
        if (c) {
          colored++;
          rowHas = true;
          sum += Math.max(px[i], px[i + 1], px[i + 2]);
          if (!prev) {
            runs++;
          }
        }
        prev = c;
      }
      rowIntensity[y] = sum;
      if (rowHas) {
        coloredRows++;
      }
    }
    let peak = 0;
    for (let y = 0; y < h; y++) {
      if (rowIntensity[y] > peak) {
        peak = rowIntensity[y];
      }
    }
    let fwhm = 0;
    if (peak > 0) {
      const half = peak / 2;
      for (let y = 0; y < h; y++) {
        if (rowIntensity[y] >= half) {
          fwhm++;
        }
      }
    }
    return {
      colored,
      runs,
      coloredRows,
      fwhm,
      runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
    };
  }

  function columnHeights(classify) {
    const heights = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = 0; y < h; y++) {
        if (classify((y * w + x) * 4)) {
          n++;
        }
      }
      heights[x] = n;
    }
    return heights;
  }

  function arrowProfile(classify) {
    const heights = columnHeights(classify);
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++) {
      if (heights[x] > 0) {
        if (x0 < 0) {
          x0 = x;
        }
        x1 = x;
      }
    }
    if (x0 < 0) {
      return null;
    }
    // The shaft is the leading 80% of the span; its median height is robust
    // against the antialiased first and last columns.
    const bodyEnd = x0 + Math.floor((x1 - x0 + 1) * 0.8);
    const samples = [];
    for (let x = x0; x <= bodyEnd; x++) {
      if (heights[x] > 0) {
        samples.push(heights[x]);
      }
    }
    samples.sort((a, b) => a - b);
    const body = samples.length > 0 ? samples[samples.length >> 1] : 0;
    // The head is the trailing run of columns that flare past the shaft,
    // extended to the end of the line so the tip's taper is included.
    const flare = body * 1.5;
    let lastFlare = -1;
    for (let x = x1; x >= x0; x--) {
      if (heights[x] > flare) {
        lastFlare = x;
        break;
      }
    }
    if (lastFlare < 0) {
      return { body, headColumns: 0, headPeak: 0, headFill: null, head: [] };
    }
    let headStart = lastFlare;
    while (headStart > x0 && heights[headStart - 1] > flare) {
      headStart--;
    }
    const head = [];
    let sum = 0;
    let peak = 0;
    for (let x = headStart; x <= x1; x++) {
      head.push(heights[x]);
      sum += heights[x];
      if (heights[x] > peak) {
        peak = heights[x];
      }
    }
    return {
      spanStart: x0,
      spanEnd: x1,
      body,
      headStart,
      headColumns: head.length,
      headPeak: peak,
      headFill: peak > 0 && head.length > 0 ? sum / (peak * head.length) : null,
      head,
    };
  }

  function outlineCrossSection(coreClassify, edgeClassify) {
    const coreHeights = columnHeights(coreClassify);
    let column = -1;
    let best = 0;
    for (let x = 0; x < w; x++) {
      if (coreHeights[x] > best) {
        best = coreHeights[x];
        column = x;
      }
    }
    if (column < 0) {
      return null;
    }
    let coreMin = h;
    let coreMax = -1;
    for (let y = 0; y < h; y++) {
      if (coreClassify((y * w + column) * 4)) {
        if (y < coreMin) {
          coreMin = y;
        }
        coreMax = y;
      }
    }
    let edgeAbove = 0;
    let edgeBelow = 0;
    for (let y = 0; y < h; y++) {
      if (edgeClassify((y * w + column) * 4)) {
        if (y < coreMin) {
          edgeAbove++;
        } else if (y > coreMax) {
          edgeBelow++;
        }
      }
    }
    return { column, coreRows: best, coreMin, coreMax, edgeAbove, edgeBelow };
  }

  const out = {};
  for (const [key, classify] of Object.entries(hues)) {
    out[key] = measure(classify);
  }
  out.arrowProfile = arrowProfile(hues.arrow);
  out.outlineCrossSection = outlineCrossSection(hues.outline, hues.outlineEdge);
  return out;
}

/** `probe-polyline-material-primitive.mjs` :120-:159. */
export function referenceMaterialPrimitive(px, w, h) {
  const isColored = (i) => px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30;
  let colored = 0;
  let runs = 0;
  let coloredRows = 0;
  for (let y = 0; y < h; y++) {
    let prevColored = false;
    let rowHasColor = false;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = isColored(i);
      if (c) {
        colored++;
        rowHasColor = true;
        if (!prevColored) {
          runs++;
        }
      }
      prevColored = c;
    }
    if (rowHasColor) coloredRows++;
  }
  return {
    colored,
    runs,
    coloredRows,
    runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
  };
}

/** `probe-polyline-appearance-primitive.mjs` :117-:125. */
export function referenceAppearancePrimitive(px) {
  let cyan = 0;
  let nonBlack = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (r > 10 || g > 10 || b > 10) nonBlack++;
    if (b > 200 && g > 200 && r < 80) cyan++;
  }
  return { cyan, nonBlack };
}

/** `probe-polyline-appearance-2d.mjs` :131-:153 (the cyan count and centroid). */
export function referenceAppearance2d(px, w) {
  let cyan = 0,
    sumX = 0,
    sumY = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 2] > 150 && px[i + 1] > 150 && px[i] < 110) {
      cyan++;
      const p = i / 4;
      sumX += p % w;
      sumY += Math.floor(p / w);
    }
  }
  return {
    cyan,
    cx: cyan ? Math.round(sumX / cyan) : -1,
    cy: cyan ? Math.round(sumY / cyan) : -1,
  };
}

/** `probe-polyline-appearance-pick.mjs` :101-:108 (the on-line samples). */
export function referencePickSamples(px, w) {
  const cyanPts = [];
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 2] > 200 && px[i + 1] > 200 && px[i] < 80) {
      n++;
      const p = i / 4;
      if (n % 200 === 0) cyanPts.push([p % w, Math.floor(p / w)]); // sample
    }
  }
  return { n, cyanPts };
}

/** `probe-polyline-appearance-logdepth.mjs` :157-:165. */
export function referenceLogDepth(px) {
  let cyan = 0,
    magenta = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i],
      g = px[i + 1],
      b = px[i + 2];
    if (b > 180 && g > 180 && r < 90) cyan++;
    if (r > 150 && b > 150 && g < 110) magenta++;
  }
  return { cyan, magenta };
}

/** `probe-polyline-image-material.mjs` :101-:125 (counts and mean x). */
export function referenceImageMaterial(px, w) {
  let red = 0,
    blue = 0,
    redSumX = 0,
    blueSumX = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i],
      g = px[i + 1],
      b = px[i + 2];
    const X = (i / 4) % w;
    if (r > 150 && g < 90 && b < 90) {
      red++;
      redSumX += X;
    } else if (b > 150 && g < 90 && r < 90) {
      blue++;
      blueSumX += X;
    }
  }
  return {
    red,
    blue,
    redMeanX: red ? Math.round(redSumX / red) : -1,
    blueMeanX: blue ? Math.round(blueSumX / blue) : -1,
  };
}

/** `probe-polyline-cloud-consume.mjs` :126-:134. */
export function referenceCloudConsume(d) {
  let cyan = 0,
    cloudish = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    if (g > 150 && b > 150 && r < 120) cyan++;
    else if (r > 140 && g > 140 && b > 140 && Math.abs(r - b) < 30) cloudish++;
  }
  return { cyan, cloudish };
}

/** `probe-polyline-geodesic.mjs` :197-:238 — `measureArc`, verbatim. */
export function referenceMeasureArc(rgba, w, h) {
  const cyan = []; // {x, y}
  const cyanY = new Array(w).fill(null);
  const redY = new Array(w).fill(null);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      const r = rgba[i],
        g = rgba[i + 1],
        b = rgba[i + 2];
      if (cyanY[x] === null && r < 80 && g > 140 && b > 140) cyanY[x] = y;
      if (redY[x] === null && r > 150 && g < 90 && b < 90) redY[x] = y;
    }
    if (cyanY[x] !== null) cyan.push({ x, y: cyanY[x] });
  }
  if (cyan.length < 20)
    return { ok: false, maxBow: 0, maxCyanVsRed: 0, cols: cyan.length };

  // Bow: perpendicular distance of cyan path from the line between its ends.
  const a = cyan[0];
  const bb = cyan[cyan.length - 1];
  const dx = bb.x - a.x;
  const dy = bb.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let maxBow = 0;
  for (const p of cyan) {
    const dist = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (dist > maxBow) maxBow = dist;
  }

  // Cyan-vs-red vertical separation over columns where both exist.
  let maxCyanVsRed = 0;
  let bothCols = 0;
  for (let x = 0; x < w; x++) {
    if (cyanY[x] !== null && redY[x] !== null) {
      bothCols++;
      const sep = Math.abs(cyanY[x] - redY[x]);
      if (sep > maxCyanVsRed) maxCyanVsRed = sep;
    }
  }
  return { ok: true, maxBow, maxCyanVsRed, cols: cyan.length, bothCols };
}

/** `probe-polyline-geodesic.mjs` :240-:252 — `diffRGBA` (made synchronous). */
export function referenceDiffRgba(a, b) {
  const n = Math.min(a.length, b.length);
  let mismatch = 0;
  for (let i = 0; i < n; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 24 ||
      Math.abs(a[i + 1] - b[i + 1]) > 24 ||
      Math.abs(a[i + 2] - b[i + 2]) > 24
    )
      mismatch++;
  }
  return (mismatch / (n / 4)) * 100;
}

/** `probe-polyline-geodesic.mjs` :254-:260 — `coverage`. */
export function referenceCoverage(rgba) {
  let c = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 40) c++;
  }
  return c;
}

/** `probe-polyline-taa-velocity.mjs` :686-:699 — `countLinePixels`. */
export function referenceCountLinePixels(image) {
  let count = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Cyan on black: green and blue well above the background, red low.
    if (g > 40 && b > 40 && r < g - 20) {
      count += 1;
    }
  }
  return count;
}
