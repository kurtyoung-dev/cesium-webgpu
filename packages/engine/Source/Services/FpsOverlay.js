/**
 * Full-featured FPS HUD that renders an absolutely-positioned Canvas2D
 * panel over a host element (typically the same parent as the Cesium
 * canvas). Reads from a `PerformanceTracker`-shaped data source via a
 * pluggable polling function, so it works equally well against:
 *
 *   1. A local `Scene.performanceTracker` (single-thread case)
 *   2. A `WorkerSceneHost` that posts stats messages back from a
 *      renderer worker
 *   3. Any custom source that implements `getLiveStats()` +
 *      `getLiveFrameTimeSnapshot(n)`
 *
 * The overlay is a self-contained DOM element managed entirely outside
 * the Cesium widget tree — no interaction with `CesiumWidget` /
 * `Viewer` toolbars / credit display. This is deliberate: it must work
 * unmodified for both the in-thread Viewer case and the worker case
 * where the Viewer doesn't even exist on the main thread.
 *
 * ── Layout ─────────────────────────────────────────────────────────
 *
 *  ┌─────────────────────────────────────┐
 *  │  webgpu        avg 58.3 fps  (16.9ms) │
 *  │  ████▆▅▄▃▂▁▂▃▄▅▆▇████ ←60s graph→  │
 *  │  1% low 32   1% high 60    samples  │
 *  └─────────────────────────────────────┘
 *
 * The graph is drawn newest-on-the-right at ~3-4 px per frame at the
 * default 320×80 size, with red markers for frames over the 16.6 ms
 * budget so visual stutters jump out at a glance.
 *
 * @private
 * @module FpsOverlay
 */

import defined from "../Core/defined.js";

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 96;
const DEFAULT_POLL_HZ = 6; // 6 Hz redraw — invisible to the eye, cheap
const DEFAULT_GRAPH_WINDOW_SECONDS = 60;

const COLOR_BG = "rgba(0, 0, 0, 0.65)";
const COLOR_BORDER = "rgba(255, 255, 255, 0.2)";
const COLOR_TEXT = "#ffffff";
const COLOR_LABEL = "rgba(255, 255, 255, 0.7)";
const COLOR_GRAPH_FILL = "rgba(76, 175, 80, 0.7)"; // green for healthy frames
const COLOR_GRAPH_BUDGET_OVER = "rgba(244, 67, 54, 0.85)"; // red for >16.6 ms
const COLOR_GRAPH_BUDGET_LINE = "rgba(255, 255, 255, 0.3)";

/**
 * FPS HUD overlay component. Drives a small Canvas2D element from a
 * pluggable data source. Designed to be created once and torn down
 * cleanly when the host scene is destroyed.
 */
class FpsOverlay {
  /**
   * @param {object} options
   * @param {HTMLElement} options.parent The DOM element to attach the
   *   overlay to. The overlay positions itself absolutely inside this
   *   element, so the parent should be `position: relative` (or any
   *   non-static positioning).
   * @param {object} options.dataSource Object that exposes
   *   `getLiveStats(windowSeconds?)` and `getLiveFrameTimeSnapshot(n)`.
   *   Either a `PerformanceTracker` directly, or a remote source like
   *   `WorkerSceneHost` that satisfies the same shape.
   * @param {string} [options.label="renderer"] Display label shown in
   *   the corner of the panel — useful when multiple overlays are on
   *   screen at once (split-screen WebGL vs WebGPU).
   * @param {number} [options.width=320]
   * @param {number} [options.height=96]
   * @param {number} [options.pollHz=6] Redraw frequency in Hz.
   * @param {number} [options.windowSeconds=60] Rolling window for the graph.
   * @param {string} [options.position="top-left"] One of "top-left",
   *   "top-right", "bottom-left", "bottom-right".
   * @param {number} [options.targetFps=60] Visualised "ideal" FPS line
   *   on the graph. Frames slower than the corresponding budget are
   *   marked red.
   */
  constructor(options) {
    if (!defined(options) || !defined(options.parent)) {
      throw new Error("FpsOverlay requires options.parent");
    }
    if (!defined(options.dataSource)) {
      throw new Error("FpsOverlay requires options.dataSource");
    }
    this._parent = options.parent;
    this._dataSource = options.dataSource;
    this._label = options.label ?? "renderer";
    this._width = options.width ?? DEFAULT_WIDTH;
    this._height = options.height ?? DEFAULT_HEIGHT;
    this._pollHz = options.pollHz ?? DEFAULT_POLL_HZ;
    this._windowSeconds = options.windowSeconds ?? DEFAULT_GRAPH_WINDOW_SECONDS;
    this._position = options.position ?? "top-left";
    this._targetFps = options.targetFps ?? 60;
    this._budgetMs = 1000 / this._targetFps;

    this._isDestroyed = false;
    this._pollIntervalId = null;
    // Cached graph max — smoothed across frames so the y-axis doesn't
    // jitter on every spike. Slowly decays toward the current peak.
    this._smoothedMaxMs = this._budgetMs * 2;

    this._buildDom();
    this._start();
  }

  /**
   * Tear down the overlay — removes the DOM element, stops the poll
   * timer, releases all references. Idempotent.
   */
  destroy() {
    if (this._isDestroyed) {
      return;
    }
    this._isDestroyed = true;
    if (this._pollIntervalId !== null) {
      clearInterval(this._pollIntervalId);
      this._pollIntervalId = null;
    }
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._container = null;
    this._canvas = null;
    this._ctx = null;
    this._dataSource = null;
    this._parent = null;
  }

  /**
   * Update the displayed label without recreating the overlay. Useful
   * when the renderer backend changes underneath us (e.g. WebGPU
   * fallback to WebGL).
   * @param {string} label
   */
  setLabel(label) {
    this._label = String(label ?? "");
  }

  /**
   * Replace the data source. Used when a worker host is restarted
   * after a crash — the new worker reports through a fresh stats
   * relay object, but the overlay DOM element should keep going.
   * @param {object} dataSource
   */
  setDataSource(dataSource) {
    if (!defined(dataSource)) {
      throw new Error("FpsOverlay.setDataSource requires a dataSource");
    }
    this._dataSource = dataSource;
  }

  // ─── DOM construction ───────────────────────────────────────────

  _buildDom() {
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.zIndex = "9999";
    container.style.pointerEvents = "none";
    container.style.background = COLOR_BG;
    container.style.border = `1px solid ${COLOR_BORDER}`;
    container.style.borderRadius = "4px";
    container.style.padding = "0";
    container.style.fontFamily =
      "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
    container.style.fontSize = "11px";
    container.style.color = COLOR_TEXT;
    container.style.userSelect = "none";
    container.style.lineHeight = "1.0";
    this._applyPosition(container);

    const canvas = document.createElement("canvas");
    // Backing store at 2× the CSS size for crisp text on HiDPI displays.
    // The browser will downscale the 2× backing during composite.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = this._width * dpr;
    canvas.height = this._height * dpr;
    canvas.style.width = `${this._width}px`;
    canvas.style.height = `${this._height}px`;
    canvas.style.display = "block";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
    }

    this._parent.appendChild(container);
    this._container = container;
    this._canvas = canvas;
    this._ctx = ctx;
    this._dpr = dpr;
  }

  _applyPosition(container) {
    const margin = "8px";
    switch (this._position) {
      case "top-right":
        container.style.top = margin;
        container.style.right = margin;
        break;
      case "bottom-left":
        container.style.bottom = margin;
        container.style.left = margin;
        break;
      case "bottom-right":
        container.style.bottom = margin;
        container.style.right = margin;
        break;
      case "top-left":
      default:
        container.style.top = margin;
        container.style.left = margin;
        break;
    }
  }

  // ─── Polling + drawing ──────────────────────────────────────────

  _start() {
    const intervalMs = Math.max(50, Math.floor(1000 / this._pollHz));
    this._pollIntervalId = setInterval(() => {
      if (this._isDestroyed) {
        return;
      }
      this._draw();
    }, intervalMs);
    // Initial paint so the user sees the panel immediately, even
    // before the first poll fires.
    this._draw();
  }

  _draw() {
    const ctx = this._ctx;
    if (!ctx || !this._dataSource) {
      return;
    }
    const stats = this._dataSource.getLiveStats(this._windowSeconds);

    // ── Background ──
    ctx.clearRect(0, 0, this._width, this._height);
    // (the container handles the background fill via CSS, but we still
    //  clear so the canvas itself starts transparent each frame)

    const padding = 6;
    const headerHeight = 14;
    const footerHeight = 14;
    const graphHeight =
      this._height - headerHeight - footerHeight - padding * 2;
    const graphTop = padding + headerHeight;
    const graphLeft = padding;
    const graphRight = this._width - padding;
    const graphWidth = graphRight - graphLeft;

    // ── Header line: label + average FPS ──
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = "left";
    ctx.fillText(this._label, padding, padding);
    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = "right";
    const avgFpsStr =
      stats.sampleCount > 0
        ? `${stats.avgFps.toFixed(1)} fps  ${stats.avgFrameMs.toFixed(1)}ms`
        : "— fps";
    ctx.fillText(avgFpsStr, this._width - padding, padding);

    // ── Graph ──
    if (stats.sampleCount > 0 && graphHeight > 0 && graphWidth > 0) {
      this._drawGraph(ctx, graphLeft, graphTop, graphWidth, graphHeight);
    } else {
      ctx.fillStyle = COLOR_LABEL;
      ctx.textAlign = "center";
      ctx.fillText(
        "(collecting…)",
        graphLeft + graphWidth / 2,
        graphTop + graphHeight / 2 - 5,
      );
    }

    // ── Footer line: 1% low / 1% high / sample count ──
    ctx.font = "10px monospace";
    ctx.fillStyle = COLOR_LABEL;
    ctx.textAlign = "left";
    const footerY = this._height - padding - 10;
    if (stats.sampleCount > 0) {
      ctx.fillText(
        `low ${stats.onePercentLowFps.toFixed(0)}`,
        padding,
        footerY,
      );
      ctx.textAlign = "center";
      ctx.fillText(
        `high ${stats.onePercentHighFps.toFixed(0)}`,
        this._width / 2,
        footerY,
      );
      ctx.textAlign = "right";
      ctx.fillText(`${stats.sampleCount}f`, this._width - padding, footerY);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(`0 samples`, this._width / 2, footerY);
    }
  }

  _drawGraph(ctx, x, y, w, h) {
    const source = this._dataSource;
    if (typeof source.getLiveFrameTimeSnapshot !== "function") {
      return;
    }
    // We draw one bar per frame, oldest on the left, newest on the
    // right. The visual width budget is `w` pixels — anything wider
    // gets one bar per pixel; anything narrower fits the actual frame
    // count. We never decimate, because for a 60s window at 60fps the
    // sample count (3600) is still well within reasonable graph widths.
    const samples = source.getLiveFrameTimeSnapshot(Math.max(w, 1));
    const n = samples.length;
    if (n === 0) {
      return;
    }

    // Decay the smoothed max toward the latest peak so the y-axis is
    // stable but still responsive. We bias the upper bound up by 25%
    // so a frame near the peak doesn't touch the top of the graph.
    let peakMs = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      if (v > peakMs) {
        peakMs = v;
      }
    }
    const targetMax = Math.max(this._budgetMs * 1.5, peakMs * 1.25);
    // Exponential moving average — converges in ~10 polls (≈1.6s).
    this._smoothedMaxMs = this._smoothedMaxMs * 0.85 + targetMax * 0.15;
    const maxMs = this._smoothedMaxMs;

    // Budget reference line at the target FPS budget (e.g. 16.6ms for 60fps).
    const budgetY = y + h - (this._budgetMs / maxMs) * h;
    ctx.strokeStyle = COLOR_GRAPH_BUDGET_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, budgetY);
    ctx.lineTo(x + w, budgetY);
    ctx.stroke();

    // Bar widths: one bar per frame, evenly distributed.
    const barW = Math.max(1, w / n);
    for (let i = 0; i < n; i++) {
      const dt = samples[i];
      const clamped = Math.min(dt, maxMs);
      const barH = Math.max(1, (clamped / maxMs) * h);
      const barX = x + i * barW;
      const barY = y + h - barH;
      ctx.fillStyle =
        dt > this._budgetMs ? COLOR_GRAPH_BUDGET_OVER : COLOR_GRAPH_FILL;
      ctx.fillRect(barX, barY, Math.max(1, barW - 0.5), barH);
    }
  }
}

export default FpsOverlay;
