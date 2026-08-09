import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import Event from "../Core/Event.js";
import CesiumMath from "../Core/Math.js";
import GeographicTilingScheme from "../Core/GeographicTilingScheme.js";
import WebMercatorTilingScheme from "../Core/WebMercatorTilingScheme.js";

/**
 * @typedef {object} DebugTileImageryProvider.ConstructorOptions
 *
 * @property {TilingScheme} [tilingScheme=new GeographicTilingScheme()]
 * @property {Ellipsoid} [ellipsoid]
 * @property {Color} [color=Color.YELLOW] Text + border color.
 * @property {number} [tileWidth=256]
 * @property {number} [tileHeight=256]
 * @property {boolean} [showCoords=true] Draw L/X/Y header.
 * @property {boolean} [showRectangle=true] Draw the tile's lat/lon corners.
 * @property {boolean} [showProjection=true] Draw the tiling-scheme projection class.
 * @property {boolean} [showMercatorLimit=true] Annotate tiles that straddle ±85.0511° (Web Mercator MaximumLatitude). These tiles are the ones that go through the WebGPU reprojection path (`Path B` in IMAGERY_PROJECTION.md).
 * @property {boolean} [colorByLevel=false] Tint the border by LOD so adjacent levels are visually distinct. Useful for spotting LOD transitions and missing tiles.
 */

/**
 * Fork-specific debug imagery provider. A richer version of the upstream
 * {@link TileCoordinatesImageryProvider} that labels each tile with:
 *
 *   - L (level), X, Y — tile coordinates
 *   - the geographic rectangle (S/W/N/E corners in degrees)
 *   - the tiling-scheme projection class
 *   - whether the tile straddles the Web Mercator ±85.0511° limit, which is
 *     what sends it through the WebGPU reprojection path
 *
 * Use it as an overlay imagery layer to debug imagery sampling, tile
 * selection, and LOD transitions interactively:
 *
 *     CesiumDebug.tileDebugOverlay();
 *     CesiumDebug.tileDebugOverlay({ colorByLevel: true });
 *     CesiumDebug.tileDebugOverlay(null); // remove
 *
 * The labels are drawn into a canvas at request time, so they're STATIC
 * per tile (don't show per-fragment state like `useWebMercatorT` or
 * `hasReprojection` which are determined at render time — for those use
 * `CesiumDebug.globeFragmentDebug()`).
 *
 * @alias DebugTileImageryProvider
 * @constructor
 * @param {DebugTileImageryProvider.ConstructorOptions} [options]
 */
class DebugTileImageryProvider {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    this._tilingScheme = defined(options.tilingScheme)
      ? options.tilingScheme
      : new GeographicTilingScheme({ ellipsoid: options.ellipsoid });
    this._color = options.color ?? Color.YELLOW;
    this._errorEvent = new Event();
    this._tileWidth = options.tileWidth ?? 256;
    this._tileHeight = options.tileHeight ?? 256;
    this._showCoords = options.showCoords ?? true;
    this._showRectangle = options.showRectangle ?? true;
    this._showProjection = options.showProjection ?? true;
    this._showMercatorLimit = options.showMercatorLimit ?? true;
    this._colorByLevel = options.colorByLevel ?? false;

    this._projectionLabel =
      this._tilingScheme instanceof GeographicTilingScheme
        ? "Geographic"
        : this._tilingScheme instanceof WebMercatorTilingScheme
          ? "WebMercator"
          : (this._tilingScheme?.constructor?.name ?? "Custom");

    this._defaultAlpha = undefined;
    this._defaultNightAlpha = undefined;
    this._defaultDayAlpha = undefined;
    this._defaultBrightness = undefined;
    this._defaultContrast = undefined;
    this._defaultHue = undefined;
    this._defaultSaturation = undefined;
    this._defaultGamma = undefined;
    this._defaultMinificationFilter = undefined;
    this._defaultMagnificationFilter = undefined;
  }

  // ── ImageryProvider protocol ───────────────────────────────────────

  getTileCredits() {
    return undefined;
  }

  requestImage(x, y, level) {
    const canvas = document.createElement("canvas");
    canvas.width = this._tileWidth;
    canvas.height = this._tileHeight;
    const ctx = canvas.getContext("2d");

    const rect = this._tilingScheme.tileXYToRectangle(x, y, level);
    const southDeg = CesiumMath.toDegrees(rect.south);
    const westDeg = CesiumMath.toDegrees(rect.west);
    const northDeg = CesiumMath.toDegrees(rect.north);
    const eastDeg = CesiumMath.toDegrees(rect.east);

    // Web Mercator maximum latitude — tiles that straddle this need
    // reprojection on a Geographic globe; useful to highlight.
    const MERC_MAX_DEG = 85.05112878;
    const straddlesMercLimit =
      northDeg > MERC_MAX_DEG || southDeg < -MERC_MAX_DEG;

    // Color: either the configured constant, or LOD-shifted hue when
    // colorByLevel is on. The level-shifted color makes adjacent LODs
    // visually distinct so the LOD selection pattern is obvious.
    let strokeColor = this._color;
    if (this._colorByLevel) {
      // Cycle through bright hues by level (modulo 8) — green/cyan/blue/...
      const hueDeg = (level * 47) % 360;
      strokeColor = Color.fromHsl(hueDeg / 360, 0.9, 0.6);
    }
    const cssColor = strokeColor.toCssColorString();
    const cssColorDim = Color.fromAlpha(strokeColor, 0.6).toCssColorString();

    // Tile border. Thicker if at a Web Mercator limit (visual cue).
    ctx.strokeStyle = cssColor;
    ctx.lineWidth = straddlesMercLimit ? 4 : 2;
    ctx.strokeRect(1, 1, this._tileWidth - 2, this._tileHeight - 2);

    // Re-stroke the southern/northern edge in a contrasting color if
    // straddling the Mercator limit, so it's obvious WHICH edge is the
    // troublesome one.
    if (straddlesMercLimit) {
      ctx.strokeStyle = Color.RED.toCssColorString();
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (northDeg > MERC_MAX_DEG) {
        ctx.moveTo(0, 2);
        ctx.lineTo(this._tileWidth, 2);
      }
      if (southDeg < -MERC_MAX_DEG) {
        ctx.moveTo(0, this._tileHeight - 2);
        ctx.lineTo(this._tileWidth, this._tileHeight - 2);
      }
      ctx.stroke();
    }

    // Header — coords. Larger font so it's readable at far zooms.
    ctx.textAlign = "center";
    ctx.fillStyle = cssColor;
    ctx.font = "bold 20px Arial";
    const cx = this._tileWidth / 2;
    let yPos = 32;
    if (this._showCoords) {
      ctx.fillText(`L:${level} X:${x} Y:${y}`, cx, yPos);
      yPos += 28;
    }

    // Projection class — single-line annotation.
    if (this._showProjection) {
      ctx.font = "14px Arial";
      ctx.fillStyle = cssColorDim;
      ctx.fillText(this._projectionLabel, cx, yPos);
      yPos += 22;
    }

    // Rectangle corners — N/W/E/S as a compact block.
    if (this._showRectangle) {
      ctx.font = "13px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = cssColorDim;
      const numFmt = (deg) =>
        Math.abs(deg) < 10 ? deg.toFixed(3) : deg.toFixed(2);
      const lines = [
        `N ${numFmt(northDeg)}°`,
        `W ${numFmt(westDeg)}°`,
        `E ${numFmt(eastDeg)}°`,
        `S ${numFmt(southDeg)}°`,
      ];
      const xText = 12;
      for (const line of lines) {
        ctx.fillText(line, xText, yPos);
        yPos += 16;
      }
      ctx.textAlign = "center";
    }

    // Mercator-limit annotation: explicit text + which edge.
    if (this._showMercatorLimit && straddlesMercLimit) {
      ctx.font = "bold 13px Arial";
      ctx.fillStyle = Color.RED.toCssColorString();
      const which = [];
      if (northDeg > MERC_MAX_DEG) {
        which.push("N");
      }
      if (southDeg < -MERC_MAX_DEG) {
        which.push("S");
      }
      ctx.fillText(
        `Mercator limit (${which.join(",")})`,
        cx,
        this._tileHeight - 14,
      );
    }

    return Promise.resolve(canvas);
  }

  pickFeatures() {
    return undefined;
  }

  // ── Standard ImageryProvider getters ───────────────────────────────

  get proxy() {
    return undefined;
  }
  get tileWidth() {
    return this._tileWidth;
  }
  get tileHeight() {
    return this._tileHeight;
  }
  get maximumLevel() {
    return undefined;
  }
  get minimumLevel() {
    return undefined;
  }
  get tilingScheme() {
    return this._tilingScheme;
  }
  get rectangle() {
    return this._tilingScheme.rectangle;
  }
  get tileDiscardPolicy() {
    return undefined;
  }
  get errorEvent() {
    return this._errorEvent;
  }
  get credit() {
    return undefined;
  }
  get hasAlphaChannel() {
    return true;
  }
}

export default DebugTileImageryProvider;
