import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";

/**
 * A directional light source that originates from the Moon.
 * <p>
 * <b>Marker class.</b> Like {@link SunLight}, <code>MoonLight</code> carries
 * no per-instance direction — renderers distinguish it from other light types
 * via <code>light instanceof MoonLight</code> and read the current ephemeris
 * direction from <code>frameState.moonDirectionWC</code>, which is populated
 * once per frame by {@link Moon#update} from Simon 1994 lunar positions.
 * </p>
 * <p>
 * This class is <b>not</b> assigned to <code>scene.light</code> automatically.
 * Users who want the Moon to act as the scene's primary light source can opt
 * in explicitly:
 * </p>
 * <pre><code>
 * scene.light = new Cesium.MoonLight();
 * </code></pre>
 *
 * @param {object} [options] Object with the following properties:
 * @param {Color} [options.color=new Color(0.85, 0.88, 1.0, 1.0)] The light's color (cool moonlight tint by default).
 * @param {number} [options.intensity=0.05] The light's intensity. Moonlight is roughly 1/400,000 the irradiance of sunlight, but the renderer uses relative units so 0.05 reads as "dim but visible".
 *
 * @alias MoonLight
 * @constructor
 */
function MoonLight(options) {
  options = options ?? Frozen.EMPTY_OBJECT;
  /**
   * The color of the light.
   * @type {Color}
   * @default new Color(0.85, 0.88, 1.0, 1.0)
   */
  this.color = Color.clone(options.color ?? new Color(0.85, 0.88, 1.0, 1.0));

  /**
   * The intensity of the light.
   * @type {number}
   * @default 0.05
   */
  this.intensity = options.intensity ?? 0.05;
}

export default MoonLight;
