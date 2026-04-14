/**
 * Type declarations for Color.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * Gives WebGPU TypeScript callers proper types for Color instance fields,
 * instance methods, static factory methods, and the large set of CSS
 * named constants (ALICEBLUE, RED, WHITE, etc.) — eliminating the need
 * for `as unknown as` casts at call sites.
 */

/**
 * A color, specified using red, green, blue, and alpha values,
 * which range from 0 (no intensity) to 1.0 (full intensity).
 */
declare class Color {
  /** The red component (0.0 – 1.0). */
  red: number;
  /** The green component (0.0 – 1.0). */
  green: number;
  /** The blue component (0.0 – 1.0). */
  blue: number;
  /** The alpha component (0.0 – 1.0). */
  alpha: number;

  constructor(red?: number, green?: number, blue?: number, alpha?: number);

  // ─── Instance methods ─────────────────────────────────────────────────
  clone(result?: Color): Color;
  equals(other?: Color): boolean;
  equalsEpsilon(other: Color, epsilon?: number): boolean;
  toString(): string;
  toCssColorString(): string;
  toCssHexString(): string;
  toBytes(result?: number[]): number[];
  toRgba(): number;
  brighten(magnitude: number, result: Color): Color;
  darken(magnitude: number, result: Color): Color;
  withAlpha(alpha: number, result?: Color): Color;

  // ─── Static constructors / converters ────────────────────────────────
  static fromCartesian4(
    cartesian: { x: number; y: number; z: number; w: number },
    result?: Color,
  ): Color;
  static fromBytes(
    red?: number,
    green?: number,
    blue?: number,
    alpha?: number,
    result?: Color,
  ): Color;
  static fromAlpha(color: Color, alpha: number, result?: Color): Color;
  static fromRgba(rgba: number, result?: Color): Color;
  static fromHsl(
    hue?: number,
    saturation?: number,
    lightness?: number,
    alpha?: number,
    result?: Color,
  ): Color;
  static fromRandom(
    options?: {
      red?: number;
      minimumRed?: number;
      maximumRed?: number;
      green?: number;
      minimumGreen?: number;
      maximumGreen?: number;
      blue?: number;
      minimumBlue?: number;
      maximumBlue?: number;
      alpha?: number;
      minimumAlpha?: number;
      maximumAlpha?: number;
    },
    result?: Color,
  ): Color;
  static fromCssColorString(color: string, result?: Color): Color | undefined;

  // ─── Pack/unpack ─────────────────────────────────────────────────────
  static readonly packedLength: 4;
  static pack(value: Color, array: number[], startingIndex?: number): number[];
  static unpack(array: number[], startingIndex?: number, result?: Color): Color;

  // ─── Arithmetic ──────────────────────────────────────────────────────
  static byteToFloat(number: number): number;
  static floatToByte(number: number): number;
  static clone(color: Color, result?: Color): Color;
  static equals(left?: Color, right?: Color): boolean;
  static equalsArray(color: Color, array: number[], offset: number): boolean;
  static bytesToRgba(
    red: number,
    green: number,
    blue: number,
    alpha: number,
  ): number;
  static add(left: Color, right: Color, result: Color): Color;
  static subtract(left: Color, right: Color, result: Color): Color;
  static multiply(left: Color, right: Color, result: Color): Color;
  static divide(left: Color, right: Color, result: Color): Color;
  static mod(left: Color, right: Color, result: Color): Color;
  static lerp(start: Color, end: Color, t: number, result: Color): Color;
  static multiplyByScalar(color: Color, scalar: number, result: Color): Color;
  static divideByScalar(color: Color, scalar: number, result: Color): Color;

  // ─── Named color constants ───────────────────────────────────────────
  // All CSS 3 / X11 named colors as readonly Color constants. Complete list
  // derived from Color.js; extending this list requires no code change.
  static readonly ALICEBLUE: Color;
  static readonly ANTIQUEWHITE: Color;
  static readonly AQUA: Color;
  static readonly AQUAMARINE: Color;
  static readonly AZURE: Color;
  static readonly BEIGE: Color;
  static readonly BISQUE: Color;
  static readonly BLACK: Color;
  static readonly BLANCHEDALMOND: Color;
  static readonly BLUE: Color;
  static readonly BLUEVIOLET: Color;
  static readonly BROWN: Color;
  static readonly BURLYWOOD: Color;
  static readonly CADETBLUE: Color;
  static readonly CHARTREUSE: Color;
  static readonly CHOCOLATE: Color;
  static readonly CORAL: Color;
  static readonly CORNFLOWERBLUE: Color;
  static readonly CORNSILK: Color;
  static readonly CRIMSON: Color;
  static readonly CYAN: Color;
  static readonly DARKBLUE: Color;
  static readonly DARKCYAN: Color;
  static readonly DARKGOLDENROD: Color;
  static readonly DARKGRAY: Color;
  static readonly DARKGREY: Color;
  static readonly DARKGREEN: Color;
  static readonly DARKKHAKI: Color;
  static readonly DARKMAGENTA: Color;
  static readonly DARKOLIVEGREEN: Color;
  static readonly DARKORANGE: Color;
  static readonly DARKORCHID: Color;
  static readonly DARKRED: Color;
  static readonly DARKSALMON: Color;
  static readonly DARKSEAGREEN: Color;
  static readonly DARKSLATEBLUE: Color;
  static readonly DARKSLATEGRAY: Color;
  static readonly DARKSLATEGREY: Color;
  static readonly DARKTURQUOISE: Color;
  static readonly DARKVIOLET: Color;
  static readonly DEEPPINK: Color;
  static readonly DEEPSKYBLUE: Color;
  static readonly DIMGRAY: Color;
  static readonly DIMGREY: Color;
  static readonly DODGERBLUE: Color;
  static readonly FIREBRICK: Color;
  static readonly FLORALWHITE: Color;
  static readonly FORESTGREEN: Color;
  static readonly FUCHSIA: Color;
  static readonly GAINSBORO: Color;
  static readonly GHOSTWHITE: Color;
  static readonly GOLD: Color;
  static readonly GOLDENROD: Color;
  static readonly GRAY: Color;
  static readonly GREY: Color;
  static readonly GREEN: Color;
  static readonly GREENYELLOW: Color;
  static readonly HONEYDEW: Color;
  static readonly HOTPINK: Color;
  static readonly INDIANRED: Color;
  static readonly INDIGO: Color;
  static readonly IVORY: Color;
  static readonly KHAKI: Color;
  static readonly LAVENDER: Color;
  static readonly LAVENDAR_BLUSH: Color;
  static readonly LAVENDERBLUSH: Color;
  static readonly LAWNGREEN: Color;
  static readonly LEMONCHIFFON: Color;
  static readonly LIGHTBLUE: Color;
  static readonly LIGHTCORAL: Color;
  static readonly LIGHTCYAN: Color;
  static readonly LIGHTGOLDENRODYELLOW: Color;
  static readonly LIGHTGRAY: Color;
  static readonly LIGHTGREY: Color;
  static readonly LIGHTGREEN: Color;
  static readonly LIGHTPINK: Color;
  static readonly LIGHTSEAGREEN: Color;
  static readonly LIGHTSKYBLUE: Color;
  static readonly LIGHTSLATEGRAY: Color;
  static readonly LIGHTSLATEGREY: Color;
  static readonly LIGHTSTEELBLUE: Color;
  static readonly LIGHTYELLOW: Color;
  static readonly LIME: Color;
  static readonly LIMEGREEN: Color;
  static readonly LINEN: Color;
  static readonly MAGENTA: Color;
  static readonly MAROON: Color;
  static readonly MEDIUMAQUAMARINE: Color;
  static readonly MEDIUMBLUE: Color;
  static readonly MEDIUMORCHID: Color;
  static readonly MEDIUMPURPLE: Color;
  static readonly MEDIUMSEAGREEN: Color;
  static readonly MEDIUMSLATEBLUE: Color;
  static readonly MEDIUMSPRINGGREEN: Color;
  static readonly MEDIUMTURQUOISE: Color;
  static readonly MEDIUMVIOLETRED: Color;
  static readonly MIDNIGHTBLUE: Color;
  static readonly MINTCREAM: Color;
  static readonly MISTYROSE: Color;
  static readonly MOCCASIN: Color;
  static readonly NAVAJOWHITE: Color;
  static readonly NAVY: Color;
  static readonly OLDLACE: Color;
  static readonly OLIVE: Color;
  static readonly OLIVEDRAB: Color;
  static readonly ORANGE: Color;
  static readonly ORANGERED: Color;
  static readonly ORCHID: Color;
  static readonly PALEGOLDENROD: Color;
  static readonly PALEGREEN: Color;
  static readonly PALETURQUOISE: Color;
  static readonly PALEVIOLETRED: Color;
  static readonly PAPAYAWHIP: Color;
  static readonly PEACHPUFF: Color;
  static readonly PERU: Color;
  static readonly PINK: Color;
  static readonly PLUM: Color;
  static readonly POWDERBLUE: Color;
  static readonly PURPLE: Color;
  static readonly RED: Color;
  static readonly ROSYBROWN: Color;
  static readonly ROYALBLUE: Color;
  static readonly SADDLEBROWN: Color;
  static readonly SALMON: Color;
  static readonly SANDYBROWN: Color;
  static readonly SEAGREEN: Color;
  static readonly SEASHELL: Color;
  static readonly SIENNA: Color;
  static readonly SILVER: Color;
  static readonly SKYBLUE: Color;
  static readonly SLATEBLUE: Color;
  static readonly SLATEGRAY: Color;
  static readonly SLATEGREY: Color;
  static readonly SNOW: Color;
  static readonly SPRINGGREEN: Color;
  static readonly STEELBLUE: Color;
  static readonly TAN: Color;
  static readonly TEAL: Color;
  static readonly THISTLE: Color;
  static readonly TOMATO: Color;
  static readonly TRANSPARENT: Color;
  static readonly TURQUOISE: Color;
  static readonly VIOLET: Color;
  static readonly WHEAT: Color;
  static readonly WHITE: Color;
  static readonly WHITESMOKE: Color;
  static readonly YELLOW: Color;
  static readonly YELLOWGREEN: Color;
}

export default Color;
