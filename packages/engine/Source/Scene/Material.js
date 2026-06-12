import Cartesian2 from "../Core/Cartesian2.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Sampler from "../Renderer/Sampler.js";
import Texture from "../Renderer/Texture.js";
import CubeMap from "../Renderer/CubeMap.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import AspectRampMaterial from "../Shaders/Materials/AspectRampMaterial.js";
import BumpMapMaterial from "../Shaders/Materials/BumpMapMaterial.js";
import CheckerboardMaterial from "../Shaders/Materials/CheckerboardMaterial.js";
import DotMaterial from "../Shaders/Materials/DotMaterial.js";
import ElevationBandMaterial from "../Shaders/Materials/ElevationBandMaterial.js";
import ElevationContourMaterial from "../Shaders/Materials/ElevationContourMaterial.js";
import ElevationRampMaterial from "../Shaders/Materials/ElevationRampMaterial.js";
import FadeMaterial from "../Shaders/Materials/FadeMaterial.js";
import GridMaterial from "../Shaders/Materials/GridMaterial.js";
import NormalMapMaterial from "../Shaders/Materials/NormalMapMaterial.js";
import PolylineArrowMaterial from "../Shaders/Materials/PolylineArrowMaterial.js";
import PolylineDashMaterial from "../Shaders/Materials/PolylineDashMaterial.js";
import PolylineGlowMaterial from "../Shaders/Materials/PolylineGlowMaterial.js";
import PolylineOutlineMaterial from "../Shaders/Materials/PolylineOutlineMaterial.js";
import RimLightingMaterial from "../Shaders/Materials/RimLightingMaterial.js";
import SlopeRampMaterial from "../Shaders/Materials/SlopeRampMaterial.js";
import StripeMaterial from "../Shaders/Materials/StripeMaterial.js";
import WaterMaskMaterial from "../Shaders/Materials/WaterMaskMaterial.js";
import WaterMaterial from "../Shaders/Materials/Water.js";
import {
  DEFAULT_IMAGE_ID,
  DEFAULT_CUBE_MAP_ID,
  materialCache,
  initializeMaterial,
  getInitializationPromises,
} from "./MaterialHelpers.js";

/** @import MaterialUniformBuffer from "./MaterialUniformBuffer.js"; */

/**
 * A Material defines surface appearance through a combination of diffuse, specular,
 * normal, emission, and alpha components. These values are specified using a
 * JSON schema called Fabric which gets parsed and assembled into glsl shader code
 * behind-the-scenes. Check out the {@link https://github.com/CesiumGS/cesium/wiki/Fabric|wiki page}
 * for more details on Fabric.
 * <br /><br />
 * <style type="text/css">
 *  #materialDescriptions code {
 *      font-weight: normal;
 *      font-family: Consolas, 'Lucida Console', Monaco, monospace;
 *      color: #A35A00;
 *  }
 *  #materialDescriptions ul, #materialDescriptions ul ul {
 *      list-style-type: none;
 *  }
 *  #materialDescriptions ul ul {
 *      margin-bottom: 10px;
 *  }
 *  #materialDescriptions ul ul li {
 *      font-weight: normal;
 *      color: #000000;
 *      text-indent: -2em;
 *      margin-left: 2em;
 *  }
 *  #materialDescriptions ul li {
 *      font-weight: bold;
 *      color: #0053CF;
 *  }
 * </style>
 *
 * Base material types and their uniforms:
 * <div id='materialDescriptions'>
 * <ul>
 *  <li>Color</li>
 *  <ul>
 *      <li><code>color</code>:  rgba color object.</li>
 *  </ul>
 *  <li>Image</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *  </ul>
 *  <li>DiffuseMap</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>channels</code>:  Three character string containing any combination of r, g, b, and a for selecting the desired image channels.</li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *  </ul>
 *  <li>AlphaMap</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>channel</code>:  One character string containing r, g, b, or a for selecting the desired image channel. </li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *  </ul>
 *  <li>SpecularMap</li>
 *  <ul>
 *      <li><code>image</code>: path to image.</li>
 *      <li><code>channel</code>: One character string containing r, g, b, or a for selecting the desired image channel. </li>
 *      <li><code>repeat</code>: Object with x and y values specifying the number of times to repeat the image.</li>
 *  </ul>
 *  <li>EmissionMap</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>channels</code>:  Three character string containing any combination of r, g, b, and a for selecting the desired image channels. </li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *  </ul>
 *  <li>BumpMap</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>channel</code>:  One character string containing r, g, b, or a for selecting the desired image channel. </li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *      <li><code>strength</code>:  Bump strength value between 0.0 and 1.0 where 0.0 is small bumps and 1.0 is large bumps.</li>
 *  </ul>
 *  <li>NormalMap</li>
 *  <ul>
 *      <li><code>image</code>:  path to image.</li>
 *      <li><code>channels</code>:  Three character string containing any combination of r, g, b, and a for selecting the desired image channels. </li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of times to repeat the image.</li>
 *      <li><code>strength</code>:  Bump strength value between 0.0 and 1.0 where 0.0 is small bumps and 1.0 is large bumps.</li>
 *  </ul>
 *  <li>Grid</li>
 *  <ul>
 *      <li><code>color</code>:  rgba color object for the whole material.</li>
 *      <li><code>cellAlpha</code>: Alpha value for the cells between grid lines.  This will be combined with color.alpha.</li>
 *      <li><code>lineCount</code>:  Object with x and y values specifying the number of columns and rows respectively.</li>
 *      <li><code>lineThickness</code>:  Object with x and y values specifying the thickness of grid lines (in pixels where available).</li>
 *      <li><code>lineOffset</code>:  Object with x and y values specifying the offset of grid lines (range is 0 to 1).</li>
 *  </ul>
 *  <li>Stripe</li>
 *  <ul>
 *      <li><code>horizontal</code>:  Boolean that determines if the stripes are horizontal or vertical.</li>
 *      <li><code>evenColor</code>:  rgba color object for the stripe's first color.</li>
 *      <li><code>oddColor</code>:  rgba color object for the stripe's second color.</li>
 *      <li><code>offset</code>:  Number that controls at which point into the pattern to begin drawing; with 0.0 being the beginning of the even color, 1.0 the beginning of the odd color, 2.0 being the even color again, and any multiple or fractional values being in between.</li>
 *      <li><code>repeat</code>:  Number that controls the total number of stripes, half light and half dark.</li>
 *  </ul>
 *  <li>Checkerboard</li>
 *  <ul>
 *      <li><code>lightColor</code>:  rgba color object for the checkerboard's light alternating color.</li>
 *      <li><code>darkColor</code>: rgba color object for the checkerboard's dark alternating color.</li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of columns and rows respectively.</li>
 *  </ul>
 *  <li>Dot</li>
 *  <ul>
 *      <li><code>lightColor</code>:  rgba color object for the dot color.</li>
 *      <li><code>darkColor</code>:  rgba color object for the background color.</li>
 *      <li><code>repeat</code>:  Object with x and y values specifying the number of columns and rows of dots respectively.</li>
 *  </ul>
 *  <li>Water</li>
 *  <ul>
 *      <li><code>baseWaterColor</code>:  rgba color object base color of the water.</li>
 *      <li><code>blendColor</code>:  rgba color object used when blending from water to non-water areas.</li>
 *      <li><code>specularMap</code>:  Single channel texture used to indicate areas of water.</li>
 *      <li><code>normalMap</code>:  Normal map for water normal perturbation.</li>
 *      <li><code>frequency</code>:  Number that controls the number of waves.</li>
 *      <li><code>animationSpeed</code>:  Number that controls the animations speed of the water.</li>
 *      <li><code>amplitude</code>:  Number that controls the amplitude of water waves.</li>
 *      <li><code>specularIntensity</code>:  Number that controls the intensity of specular reflections.</li>
 *  </ul>
 *  <li>RimLighting</li>
 *  <ul>
 *      <li><code>color</code>:  diffuse color and alpha.</li>
 *      <li><code>rimColor</code>:  diffuse color and alpha of the rim.</li>
 *      <li><code>width</code>:  Number that determines the rim's width.</li>
 *  </ul>
 *  <li>Fade</li>
 *  <ul>
 *      <li><code>fadeInColor</code>: diffuse color and alpha at <code>time</code></li>
 *      <li><code>fadeOutColor</code>: diffuse color and alpha at <code>maximumDistance</code> from <code>time</code></li>
 *      <li><code>maximumDistance</code>: Number between 0.0 and 1.0 where the <code>fadeInColor</code> becomes the <code>fadeOutColor</code>. A value of 0.0 gives the entire material a color of <code>fadeOutColor</code> and a value of 1.0 gives the the entire material a color of <code>fadeInColor</code></li>
 *      <li><code>repeat</code>: true if the fade should wrap around the texture coodinates.</li>
 *      <li><code>fadeDirection</code>: Object with x and y values specifying if the fade should be in the x and y directions.</li>
 *      <li><code>time</code>: Object with x and y values between 0.0 and 1.0 of the <code>fadeInColor</code> position</li>
 *  </ul>
 *  <li>PolylineArrow</li>
 *  <ul>
 *      <li><code>color</code>: diffuse color and alpha.</li>
 *  </ul>
 *  <li>PolylineDash</li>
 *  <ul>
 *      <li><code>color</code>: color for the line.</li>
 *      <li><code>gapColor</code>: color for the gaps in the line.</li>
 *      <li><code>dashLength</code>: Dash length in pixels.</li>
 *      <li><code>dashPattern</code>: The 16 bit stipple pattern for the line..</li>
 *  </ul>
 *  <li>PolylineGlow</li>
 *  <ul>
 *      <li><code>color</code>: color and maximum alpha for the glow on the line.</li>
 *      <li><code>glowPower</code>: strength of the glow, as a percentage of the total line width (less than 1.0).</li>
 *      <li><code>taperPower</code>: strength of the tapering effect, as a percentage of the total line length.  If 1.0 or higher, no taper effect is used.</li>
 *  </ul>
 *  <li>PolylineOutline</li>
 *  <ul>
 *      <li><code>color</code>: diffuse color and alpha for the interior of the line.</li>
 *      <li><code>outlineColor</code>: diffuse color and alpha for the outline.</li>
 *      <li><code>outlineWidth</code>: width of the outline in pixels.</li>
 *  </ul>
 *  <li>ElevationContour</li>
 *  <ul>
 *      <li><code>color</code>: color and alpha for the contour line.</li>
 *      <li><code>spacing</code>: spacing for contour lines in meters.</li>
 *      <li><code>width</code>: Number specifying the width of the grid lines in pixels.</li>
 *  </ul>
 *  <li>ElevationRamp</li>
 *  <ul>
 *      <li><code>image</code>: color ramp image to use for coloring the terrain.</li>
 *      <li><code>minimumHeight</code>: minimum height for the ramp.</li>
 *      <li><code>maximumHeight</code>: maximum height for the ramp.</li>
 *  </ul>
 *  <li>SlopeRamp</li>
 *  <ul>
 *      <li><code>image</code>: color ramp image to use for coloring the terrain by slope.</li>
 *  </ul>
 *  <li>AspectRamp</li>
 *  <ul>
 *      <li><code>image</code>: color ramp image to use for color the terrain by aspect.</li>
 *  </ul>
 *  <li>ElevationBand</li>
 *  <ul>
 *      <li><code>heights</code>: image of heights sorted from lowest to highest.</li>
 *      <li><code>colors</code>: image of colors at the corresponding heights.</li>
 * </ul>
 * <li>WaterMask</li>
 * <ul>
 *      <li><code>waterColor</code>: diffuse color and alpha for the areas covered by water.</li>
 *      <li><code>landColor</code>: diffuse color and alpha for the areas covered by land.</li>
 * </ul>
 * </ul>
 * </ul>
 * </div>
 *
 * @alias Material
 *
 * @see {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric wiki page} for a more detailed options of Fabric.
 * @demo {@link https://sandcastle.cesium.com/index.html?id=materials|Cesium Sandcastle Materials Demo}
 *
 * @example
 * // Create a color material with fromType:
 * polygon.material = Cesium.Material.fromType('Color');
 * polygon.material.uniforms.color = new Cesium.Color(1.0, 1.0, 0.0, 1.0);
 *
 * // Create the default material:
 * polygon.material = new Cesium.Material();
 *
 * // Create a color material with full Fabric notation:
 * polygon.material = new Cesium.Material({
 *   fabric: {
 *     type: 'Color',
 *     uniforms: {
 *       color: new Cesium.Color(1.0, 1.0, 0.0, 1.0)
 *     }
 *   }
 * });
 */
class Material {
  /**
   * @param {object} [options] Object with the following properties:
   * @param {boolean} [options.strict=false] Throws errors for issues that would normally be ignored, including unused uniforms or materials.
   * @param {boolean|Function} [options.translucent=true] When <code>true</code> or a function that returns <code>true</code>, the geometry
   *                           with this material is expected to appear translucent.
   * @param {TextureMinificationFilter} [options.minificationFilter=TextureMinificationFilter.LINEAR] The {@link TextureMinificationFilter} to apply to this material's textures.
   * @param {TextureMagnificationFilter} [options.magnificationFilter=TextureMagnificationFilter.LINEAR] The {@link TextureMagnificationFilter} to apply to this material's textures.
   * @param {object} options.fabric The fabric JSON used to generate the material.
   *
   * @exception {DeveloperError} fabric: uniform has invalid type.
   * @exception {DeveloperError} fabric: uniforms and materials cannot share the same property.
   * @exception {DeveloperError} fabric: cannot have source and components in the same section.
   * @exception {DeveloperError} fabric: property name is not valid. It should be 'type', 'materials', 'uniforms', 'components', or 'source'.
   * @exception {DeveloperError} fabric: property name is not valid. It should be 'diffuse', 'specular', 'shininess', 'normal', 'emission', or 'alpha'.
   * @exception {DeveloperError} strict: shader source does not use string.
   * @exception {DeveloperError} strict: shader source does not use uniform.
   * @exception {DeveloperError} strict: shader source does not use material.
   */
  constructor(options) {
    /**
     * The material type. Can be an existing type or a new type. If no type is specified in fabric, type is a GUID.
     * @type {string}
     * @default undefined
     */
    this.type = undefined;

    /**
     * The glsl shader source for this material.
     * @type {string}
     * @default undefined
     */
    this.shaderSource = undefined;

    /**
     * The WGSL shader source for this material. Populated by
     * `createWGSLMethodDefinition` (in `MaterialHelpers.js`) when the
     * fabric declares a `wgsl: { source, components }` block alongside
     * its `source` / `components`. Empty string when the fabric has no
     * WGSL declarations — WebGPU consumers (Globe material hook) emit a
     * clear error when they're handed a material with empty
     * `wgslShaderSource`. Session 65 Cluster 3 — parallel-WGSL fabric API.
     * @type {string}
     * @default ""
     */
    this.wgslShaderSource = "";

    /**
     * Maps sub-material names to Material objects.
     * @type {object}
     * @default undefined
     */
    this.materials = undefined;

    /**
     * Maps uniform names to their values.
     * @type {object}
     * @default undefined
     */
    this.uniforms = undefined;
    this._uniforms = undefined;

    /**
     * Packed Float32Array-backed uniform storage. Created during
     * initialization from the fabric template. WebGPU renderers use
     * `material._uniformBuffer.gpuData` for zero-copy upload.
     *
     * @type {MaterialUniformBuffer|undefined}
     * @private
     */
    this._uniformBuffer = undefined;

    /**
     * When <code>true</code> or a function that returns <code>true</code>,
     * the geometry is expected to appear translucent.
     * @type {boolean|Function}
     * @default undefined
     */
    this.translucent = undefined;

    this._minificationFilter =
      options.minificationFilter ?? TextureMinificationFilter.LINEAR;
    this._magnificationFilter =
      options.magnificationFilter ?? TextureMagnificationFilter.LINEAR;

    this._strict = undefined;
    this._template = undefined;
    this._count = undefined;

    this._texturePaths = {};
    this._loadedImages = [];
    this._loadedCubeMaps = [];

    this._textures = {};

    // Raw image sources retained for WebGPU texture creation.
    // WebGL Texture objects discard the source after upload, so this map
    // keeps Image/ImageBitmap references alive for the WebGPU path.
    this._imageSources = {};

    this._updateFunctions = [];

    this._defaultTexture = undefined;

    /**
     * Any and all promises that are created when initializing the material.
     * Examples: loading images and cubemaps.
     *
     * @type {Promise[]}
     * @private
     */
    this._initializationPromises = [];

    /**
     * An error that occurred in async operations during material initialization.
     * Only one error is stored.
     *
     * @type {Error|undefined}
     * @private
     */
    this._initializationError = undefined;

    initializeMaterial(options, this, Material);

    // Freeze type after initialization — type is read-only once set.
    Object.defineProperty(this, "type", {
      value: this.type,
      writable: false,
    });

    if (!defined(Material._uniformList[this.type])) {
      Material._uniformList[this.type] = Object.keys(this._uniforms);
    }
  }

  /**
   * The {@link TextureMinificationFilter} to apply to this material's textures.
   * @type {TextureMinificationFilter}
   * @default TextureMinificationFilter.LINEAR
   */
  get minificationFilter() {
    return this._minificationFilter;
  }

  set minificationFilter(value) {
    this._minificationFilter = value;
  }

  /**
   * The {@link TextureMagnificationFilter} to apply to this material's textures.
   * @type {TextureMagnificationFilter}
   * @default TextureMagnificationFilter.LINEAR
   */
  get magnificationFilter() {
    return this._magnificationFilter;
  }

  set magnificationFilter(value) {
    this._magnificationFilter = value;
  }

  /**
   * Gets whether or not this material is translucent.
   * @returns {boolean} <code>true</code> if this material is translucent, <code>false</code> otherwise.
   */
  isTranslucent() {
    if (defined(this.translucent)) {
      if (typeof this.translucent === "function") {
        return this.translucent();
      }

      return this.translucent;
    }

    let translucent = true;
    const funcs = this._translucentFunctions;
    const length = funcs.length;
    for (let i = 0; i < length; ++i) {
      const func = funcs[i];
      if (typeof func === "function") {
        translucent = translucent && func();
      } else {
        translucent = translucent && func;
      }

      if (!translucent) {
        break;
      }
    }
    return translucent;
  }

  /**
   * @private
   */
  update(context) {
    this._defaultTexture = context.defaultTexture;

    let i;
    let uniformId;

    const loadedImages = this._loadedImages;
    let length = loadedImages.length;
    for (i = 0; i < length; ++i) {
      const loadedImage = loadedImages[i];
      uniformId = loadedImage.id;
      let image = loadedImage.image;

      // Images transcoded from KTX2 can contain multiple mip levels:
      // https://github.khronos.org/KTX-Specification/#_mip_level_array
      let mipLevels;
      if (Array.isArray(image)) {
        // highest detail mip should be level 0
        mipLevels = image.slice(1, image.length).map(function (mipLevel) {
          return mipLevel.bufferView;
        });
        image = image[0];
      }

      // Retain raw image source for WebGPU texture creation.
      // WebGL Texture discards the source after GPU upload, so the WebGPU
      // renderer reads from _imageSources instead. Only non-compressed
      // images (Image, ImageBitmap, Canvas) can be used with
      // copyExternalImageToTexture; compressed formats use bufferView.
      if (!defined(image.internalFormat)) {
        this._imageSources[uniformId] = image;
      }

      const sampler = new Sampler({
        minificationFilter: this._minificationFilter,
        magnificationFilter: this._magnificationFilter,
      });

      let texture;
      if (defined(image.internalFormat)) {
        texture = new Texture({
          context: context,
          pixelFormat: image.internalFormat,
          width: image.width,
          height: image.height,
          source: {
            arrayBufferView: image.bufferView,
            mipLevels: mipLevels,
          },
          sampler: sampler,
        });
      } else {
        texture = new Texture({
          context: context,
          source: image,
          sampler: sampler,
        });
      }

      // The material destroys its old texture only after the new one has been loaded.
      // This will ensure a smooth swap of textures and prevent the default texture
      // from appearing for a few frames.
      const oldTexture = this._textures[uniformId];
      if (defined(oldTexture) && oldTexture !== this._defaultTexture) {
        oldTexture.destroy();
      }

      this._textures[uniformId] = texture;

      const uniformDimensionsName = `${uniformId}Dimensions`;
      if (this.uniforms.hasOwnProperty(uniformDimensionsName)) {
        const uniformDimensions = this.uniforms[uniformDimensionsName];
        uniformDimensions.x = texture._width;
        uniformDimensions.y = texture._height;
      }
    }

    loadedImages.length = 0;

    const loadedCubeMaps = this._loadedCubeMaps;
    length = loadedCubeMaps.length;

    for (i = 0; i < length; ++i) {
      const loadedCubeMap = loadedCubeMaps[i];
      uniformId = loadedCubeMap.id;
      const images = loadedCubeMap.images;

      const cubeMap = new CubeMap({
        context: context,
        source: {
          positiveX: images[0],
          negativeX: images[1],
          positiveY: images[2],
          negativeY: images[3],
          positiveZ: images[4],
          negativeZ: images[5],
        },
        sampler: new Sampler({
          minificationFilter: this._minificationFilter,
          magnificationFilter: this._magnificationFilter,
        }),
      });

      this._textures[uniformId] = cubeMap;
    }

    loadedCubeMaps.length = 0;

    const updateFunctions = this._updateFunctions;
    length = updateFunctions.length;
    for (i = 0; i < length; ++i) {
      updateFunctions[i](this, context);
    }

    const subMaterials = this.materials;
    for (const name in subMaterials) {
      if (subMaterials.hasOwnProperty(name)) {
        subMaterials[name].update(context);
      }
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   *
   * @see Material#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * material = material && material.destroy();
   *
   * @see Material#isDestroyed
   */
  destroy() {
    const textures = this._textures;
    for (const texture in textures) {
      if (textures.hasOwnProperty(texture)) {
        const instance = textures[texture];
        if (instance !== this._defaultTexture) {
          instance.destroy();
        }
      }
    }

    const materials = this.materials;
    for (const material in materials) {
      if (materials.hasOwnProperty(material)) {
        materials[material].destroy();
      }
    }
    return destroyObject(this);
  }

  /**
   * Creates a new material using an existing material type.
   * <br /><br />
   * Shorthand for: new Material({fabric : {type : type}});
   *
   * @param {string} type The base material type.
   * @param {object} [uniforms] Overrides for the default uniforms.
   * @returns {Material} New material object.
   *
   * @exception {DeveloperError} material with that type does not exist.
   *
   * @example
   * const material = Cesium.Material.fromType('Color', {
   *   color: new Cesium.Color(1.0, 0.0, 0.0, 1.0)
   * });
   */
  static fromType(type, uniforms) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(Material._materialCache.getMaterial(type))) {
      throw new DeveloperError(`material with type '${type}' does not exist.`);
    }
    //>>includeEnd('debug');

    const material = new Material({
      fabric: {
        type: type,
      },
    });

    if (defined(uniforms)) {
      for (const name in uniforms) {
        if (uniforms.hasOwnProperty(name)) {
          material.uniforms[name] = uniforms[name];
        }
      }
    }

    return material;
  }

  /**
   * Creates a new material using an existing material type and returns a promise that resolves when
   * all of the material's resources have been loaded.
   *
   * @param {string} type The base material type.
   * @param {object} [uniforms] Overrides for the default uniforms.
   * @returns {Promise<Material>} A promise that resolves to a new material object when all resources are loaded.
   *
   * @exception {DeveloperError} material with that type does not exist.
   *
   * @example
   * const material = await Cesium.Material.fromTypeAsync('Image', {
   *    image: '../Images/Cesium_Logo_overlay.png'
   * });
   */
  static async fromTypeAsync(type, uniforms) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(Material._materialCache.getMaterial(type))) {
      throw new DeveloperError(`material with type '${type}' does not exist.`);
    }
    //>>includeEnd('debug');

    const initializationPromises = [];
    // Unlike Material.fromType, we need to specify the uniforms in the Material constructor up front,
    // or else anything that needs to be async loaded won't be kicked off until the next Update call.
    const material = new Material({
      fabric: {
        type: type,
        uniforms: uniforms,
      },
    });

    // Recursively collect initialization promises for this material and its submaterials.
    getInitializationPromises(material, initializationPromises);
    await Promise.all(initializationPromises);
    initializationPromises.length = 0;

    if (defined(material._initializationError)) {
      throw material._initializationError;
    }

    return material;
  }
}

// Cached list of combined uniform names indexed by type.
// Used to get the list of uniforms in the same order.
Material._uniformList = {};

Material._materialCache = materialCache;

/**
 * Gets or sets the default texture uniform value.
 * @type {string}
 */
Material.DefaultImageId = DEFAULT_IMAGE_ID;

/**
 * Gets or sets the default cube map texture uniform value.
 * @type {string}
 */
Material.DefaultCubeMapId = DEFAULT_CUBE_MAP_ID;

// ---- Built-in material type registrations ----

/**
 * Gets the name of the color material.
 * @type {string}
 * @readonly
 */
Material.ColorType = "Color";
Material._materialCache.addMaterial(Material.ColorType, {
  fabric: {
    type: Material.ColorType,
    uniforms: {
      color: new Color(1.0, 0.0, 0.0, 0.5),
    },
    components: {
      diffuse: "color.rgb",
      alpha: "color.a",
    },
    // Cluster 3 — WGSL parallel components. Uniform names resolve to
    // members of the material uniform struct at WGSL emit time; the
    // Globe consumer wraps the assembler output with the appropriate
    // bind-group prelude. Texture uniforms (none here) get a paired
    // `<name>Sampler` per the WGSL fabric convention.
    wgsl: {
      components: {
        diffuse: "color.rgb",
        alpha: "color.a",
      },
    },
  },
  translucent: function (material) {
    return material.uniforms.color.alpha < 1.0;
  },
});

/**
 * Gets the name of the image material.
 * @type {string}
 * @readonly
 */
Material.ImageType = "Image";
Material._materialCache.addMaterial(Material.ImageType, {
  fabric: {
    type: Material.ImageType,
    uniforms: {
      image: Material.DefaultImageId,
      repeat: new Cartesian2(1.0, 1.0),
      color: new Color(1.0, 1.0, 1.0, 1.0),
    },
    components: {
      diffuse:
        "texture(image, fract(repeat * materialInput.st)).rgb * color.rgb",
      alpha: "texture(image, fract(repeat * materialInput.st)).a * color.a",
    },
    wgsl: {
      components: {
        diffuse:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).rgb * color.rgb",
        alpha:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).a * color.a",
      },
    },
  },
  translucent: function (material) {
    return material.uniforms.color.alpha < 1.0;
  },
});

/**
 * Gets the name of the diffuce map material.
 * @type {string}
 * @readonly
 */
Material.DiffuseMapType = "DiffuseMap";
Material._materialCache.addMaterial(Material.DiffuseMapType, {
  fabric: {
    type: Material.DiffuseMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channels: "rgb",
      repeat: new Cartesian2(1.0, 1.0),
    },
    components: {
      diffuse: "texture(image, fract(repeat * materialInput.st)).channels",
    },
    wgsl: {
      components: {
        diffuse:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).channels",
      },
    },
  },
  translucent: false,
});

/**
 * Gets the name of the alpha map material.
 * @type {string}
 * @readonly
 */
Material.AlphaMapType = "AlphaMap";
Material._materialCache.addMaterial(Material.AlphaMapType, {
  fabric: {
    type: Material.AlphaMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channel: "a",
      repeat: new Cartesian2(1.0, 1.0),
    },
    components: {
      alpha: "texture(image, fract(repeat * materialInput.st)).channel",
    },
    wgsl: {
      components: {
        alpha:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).channel",
      },
    },
  },
  translucent: true,
});

/**
 * Gets the name of the specular map material.
 * @type {string}
 * @readonly
 */
Material.SpecularMapType = "SpecularMap";
Material._materialCache.addMaterial(Material.SpecularMapType, {
  fabric: {
    type: Material.SpecularMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channel: "r",
      repeat: new Cartesian2(1.0, 1.0),
    },
    components: {
      specular: "texture(image, fract(repeat * materialInput.st)).channel",
    },
    wgsl: {
      components: {
        specular:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).channel",
      },
    },
  },
  translucent: false,
});

/**
 * Gets the name of the emmision map material.
 * @type {string}
 * @readonly
 */
Material.EmissionMapType = "EmissionMap";
Material._materialCache.addMaterial(Material.EmissionMapType, {
  fabric: {
    type: Material.EmissionMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channels: "rgb",
      repeat: new Cartesian2(1.0, 1.0),
    },
    components: {
      emission: "texture(image, fract(repeat * materialInput.st)).channels",
    },
    wgsl: {
      components: {
        emission:
          "textureSampleLevel(image, imageSampler, fract(repeat * materialInput.st), 0.0).channels",
      },
    },
  },
  translucent: false,
});

/**
 * Gets the name of the bump map material.
 * @type {string}
 * @readonly
 */
Material.BumpMapType = "BumpMap";
Material._materialCache.addMaterial(Material.BumpMapType, {
  fabric: {
    type: Material.BumpMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channel: "r",
      strength: 0.8,
      repeat: new Cartesian2(1.0, 1.0),
    },
    source: BumpMapMaterial,
  },
  translucent: false,
});

/**
 * Gets the name of the normal map material.
 * @type {string}
 * @readonly
 */
Material.NormalMapType = "NormalMap";
Material._materialCache.addMaterial(Material.NormalMapType, {
  fabric: {
    type: Material.NormalMapType,
    uniforms: {
      image: Material.DefaultImageId,
      channels: "rgb",
      strength: 0.8,
      repeat: new Cartesian2(1.0, 1.0),
    },
    source: NormalMapMaterial,
  },
  translucent: false,
});

/**
 * Gets the name of the grid material.
 * @type {string}
 * @readonly
 */
Material.GridType = "Grid";
Material._materialCache.addMaterial(Material.GridType, {
  fabric: {
    type: Material.GridType,
    uniforms: {
      color: new Color(0.0, 1.0, 0.0, 1.0),
      cellAlpha: 0.1,
      lineCount: new Cartesian2(8.0, 8.0),
      lineThickness: new Cartesian2(1.0, 1.0),
      lineOffset: new Cartesian2(0.0, 0.0),
    },
    source: GridMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.color.alpha < 1.0 || uniforms.cellAlpha < 1.0;
  },
});

/**
 * Gets the name of the stripe material.
 * @type {string}
 * @readonly
 */
Material.StripeType = "Stripe";
Material._materialCache.addMaterial(Material.StripeType, {
  fabric: {
    type: Material.StripeType,
    uniforms: {
      horizontal: true,
      evenColor: new Color(1.0, 1.0, 1.0, 0.5),
      oddColor: new Color(0.0, 0.0, 1.0, 0.5),
      offset: 0.0,
      repeat: 5.0,
    },
    source: StripeMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.evenColor.alpha < 1.0 || uniforms.oddColor.alpha < 1.0;
  },
});

/**
 * Gets the name of the checkerboard material.
 * @type {string}
 * @readonly
 */
Material.CheckerboardType = "Checkerboard";
Material._materialCache.addMaterial(Material.CheckerboardType, {
  fabric: {
    type: Material.CheckerboardType,
    uniforms: {
      lightColor: new Color(1.0, 1.0, 1.0, 0.5),
      darkColor: new Color(0.0, 0.0, 0.0, 0.5),
      repeat: new Cartesian2(5.0, 5.0),
    },
    source: CheckerboardMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.lightColor.alpha < 1.0 || uniforms.darkColor.alpha < 1.0;
  },
});

/**
 * Gets the name of the dot material.
 * @type {string}
 * @readonly
 */
Material.DotType = "Dot";
Material._materialCache.addMaterial(Material.DotType, {
  fabric: {
    type: Material.DotType,
    uniforms: {
      lightColor: new Color(1.0, 1.0, 0.0, 0.75),
      darkColor: new Color(0.0, 1.0, 1.0, 0.75),
      repeat: new Cartesian2(5.0, 5.0),
    },
    source: DotMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.lightColor.alpha < 1.0 || uniforms.darkColor.alpha < 1.0;
  },
});

/**
 * Gets the name of the water material.
 * @type {string}
 * @readonly
 */
Material.WaterType = "Water";
Material._materialCache.addMaterial(Material.WaterType, {
  fabric: {
    type: Material.WaterType,
    uniforms: {
      baseWaterColor: new Color(0.2, 0.3, 0.6, 1.0),
      blendColor: new Color(0.0, 1.0, 0.699, 1.0),
      specularMap: Material.DefaultImageId,
      normalMap: Material.DefaultImageId,
      frequency: 10.0,
      animationSpeed: 0.01,
      amplitude: 1.0,
      specularIntensity: 0.5,
      fadeFactor: 1.0,
    },
    source: WaterMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return (
      uniforms.baseWaterColor.alpha < 1.0 || uniforms.blendColor.alpha < 1.0
    );
  },
});

/**
 * Gets the name of the rim lighting material.
 * @type {string}
 * @readonly
 */
Material.RimLightingType = "RimLighting";
Material._materialCache.addMaterial(Material.RimLightingType, {
  fabric: {
    type: Material.RimLightingType,
    uniforms: {
      color: new Color(1.0, 0.0, 0.0, 0.7),
      rimColor: new Color(1.0, 1.0, 1.0, 0.4),
      width: 0.3,
    },
    source: RimLightingMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.color.alpha < 1.0 || uniforms.rimColor.alpha < 1.0;
  },
});

/**
 * Gets the name of the fade material.
 * @type {string}
 * @readonly
 */
Material.FadeType = "Fade";
Material._materialCache.addMaterial(Material.FadeType, {
  fabric: {
    type: Material.FadeType,
    uniforms: {
      fadeInColor: new Color(1.0, 0.0, 0.0, 1.0),
      fadeOutColor: new Color(0.0, 0.0, 0.0, 0.0),
      maximumDistance: 0.5,
      repeat: true,
      fadeDirection: {
        x: true,
        y: true,
      },
      time: new Cartesian2(0.5, 0.5),
    },
    source: FadeMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return (
      uniforms.fadeInColor.alpha < 1.0 || uniforms.fadeOutColor.alpha < 1.0
    );
  },
});

/**
 * Gets the name of the polyline arrow material.
 * @type {string}
 * @readonly
 */
Material.PolylineArrowType = "PolylineArrow";
Material._materialCache.addMaterial(Material.PolylineArrowType, {
  fabric: {
    type: Material.PolylineArrowType,
    uniforms: {
      color: new Color(1.0, 1.0, 1.0, 1.0),
    },
    source: PolylineArrowMaterial,
  },
  translucent: true,
});

/**
 * Gets the name of the polyline glow material.
 * @type {string}
 * @readonly
 */
Material.PolylineDashType = "PolylineDash";
Material._materialCache.addMaterial(Material.PolylineDashType, {
  fabric: {
    type: Material.PolylineDashType,
    uniforms: {
      color: new Color(1.0, 0.0, 1.0, 1.0),
      gapColor: new Color(0.0, 0.0, 0.0, 0.0),
      dashLength: 16.0,
      dashPattern: 255.0,
    },
    source: PolylineDashMaterial,
  },
  translucent: true,
});

/**
 * Gets the name of the polyline glow material.
 * @type {string}
 * @readonly
 */
Material.PolylineGlowType = "PolylineGlow";
Material._materialCache.addMaterial(Material.PolylineGlowType, {
  fabric: {
    type: Material.PolylineGlowType,
    uniforms: {
      color: new Color(0.0, 0.5, 1.0, 1.0),
      glowPower: 0.25,
      taperPower: 1.0,
    },
    source: PolylineGlowMaterial,
  },
  translucent: true,
});

/**
 * Gets the name of the polyline outline material.
 * @type {string}
 * @readonly
 */
Material.PolylineOutlineType = "PolylineOutline";
Material._materialCache.addMaterial(Material.PolylineOutlineType, {
  fabric: {
    type: Material.PolylineOutlineType,
    uniforms: {
      color: new Color(1.0, 1.0, 1.0, 1.0),
      outlineColor: new Color(1.0, 0.0, 0.0, 1.0),
      outlineWidth: 1.0,
    },
    source: PolylineOutlineMaterial,
  },
  translucent: function (material) {
    const uniforms = material.uniforms;
    return uniforms.color.alpha < 1.0 || uniforms.outlineColor.alpha < 1.0;
  },
});

/**
 * Gets the name of the elevation contour material.
 * @type {string}
 * @readonly
 */
Material.ElevationContourType = "ElevationContour";
Material._materialCache.addMaterial(Material.ElevationContourType, {
  fabric: {
    type: Material.ElevationContourType,
    uniforms: {
      spacing: 100.0,
      color: new Color(1.0, 0.0, 0.0, 1.0),
      width: 1.0,
    },
    source: ElevationContourMaterial,
    // WGSL direct port. WebGPU always has derivatives so the GLSL
    // `#if defined(GL_OES_standard_derivatives)` branch always takes
    // the dpdx/dpdy path here. czm_pixelRatio is a constant 1.0 in the
    // WGSL build (renderer reports it via materialInput when needed).
    wgsl: {
      source:
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  let distanceToContour = materialInput.height - spacing * floor(materialInput.height / spacing);\n" +
        "  let dxc = abs(dpdx(materialInput.height));\n" +
        "  let dyc = abs(dpdy(materialInput.height));\n" +
        "  let dF = max(dxc, dyc) * 1.0 * width;\n" +
        "  let a = select(0.0, 1.0, distanceToContour < dF);\n" +
        "  let outColor = czm_gammaCorrect4(vec4<f32>(color.rgb, a * color.a));\n" +
        "  material.diffuse = outColor.rgb;\n" +
        "  material.alpha = outColor.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: false,
});

/**
 * Gets the name of the elevation contour material.
 * @type {string}
 * @readonly
 */
Material.ElevationRampType = "ElevationRamp";
Material._materialCache.addMaterial(Material.ElevationRampType, {
  fabric: {
    type: Material.ElevationRampType,
    uniforms: {
      image: Material.DefaultImageId,
      minimumHeight: 0.0,
      maximumHeight: 10000.0,
    },
    source: ElevationRampMaterial,
    wgsl: {
      source:
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  let scaledHeight = clamp((materialInput.height - minimumHeight) / max(maximumHeight - minimumHeight, 1e-6), 0.0, 1.0);\n" +
        "  var rampColor = textureSampleLevel(image, imageSampler, vec2<f32>(scaledHeight, 0.5), 0.0);\n" +
        "  rampColor = czm_gammaCorrect4(rampColor);\n" +
        "  material.diffuse = rampColor.rgb;\n" +
        "  material.alpha = rampColor.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: false,
});

/**
 * Gets the name of the slope ramp material.
 * @type {string}
 * @readonly
 */
Material.SlopeRampMaterialType = "SlopeRamp";
Material._materialCache.addMaterial(Material.SlopeRampMaterialType, {
  fabric: {
    type: Material.SlopeRampMaterialType,
    uniforms: {
      image: Material.DefaultImageId,
    },
    source: SlopeRampMaterial,
    wgsl: {
      source:
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  let halfPi = 1.5707963267948966;\n" +
        "  var rampColor = textureSampleLevel(image, imageSampler, vec2<f32>(materialInput.slope / halfPi, 0.5), 0.0);\n" +
        "  rampColor = czm_gammaCorrect4(rampColor);\n" +
        "  material.diffuse = rampColor.rgb;\n" +
        "  material.alpha = rampColor.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: false,
});

/**
 * Gets the name of the aspect ramp material.
 * @type {string}
 * @readonly
 */
Material.AspectRampMaterialType = "AspectRamp";
Material._materialCache.addMaterial(Material.AspectRampMaterialType, {
  fabric: {
    type: Material.AspectRampMaterialType,
    uniforms: {
      image: Material.DefaultImageId,
    },
    source: AspectRampMaterial,
    wgsl: {
      source:
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  let twoPi = 6.283185307179586;\n" +
        "  var rampColor = textureSampleLevel(image, imageSampler, vec2<f32>(materialInput.aspect / twoPi, 0.5), 0.0);\n" +
        "  rampColor = czm_gammaCorrect4(rampColor);\n" +
        "  material.diffuse = rampColor.rgb;\n" +
        "  material.alpha = rampColor.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: false,
});

/**
 * Gets the name of the elevation band material.
 * @type {string}
 * @readonly
 */
Material.ElevationBandType = "ElevationBand";
Material._materialCache.addMaterial(Material.ElevationBandType, {
  fabric: {
    type: Material.ElevationBandType,
    uniforms: {
      heights: Material.DefaultImageId,
      colors: Material.DefaultImageId,
    },
    source: ElevationBandMaterial,
    // WGSL port — auto-uniform `heightsDimensions` comes from texture
    // dimensions auto-binding (paired with `heights` / `colors`). The
    // WebGPU build always supports float textures so the `OES_texture_float`
    // branch is the always-taken path.
    wgsl: {
      source:
        "fn elevBandGetHeight(idx: i32, invTexSize: f32) -> f32 {\n" +
        "  let uv = vec2<f32>((f32(idx) + 0.5) * invTexSize, 0.5);\n" +
        "  return textureSampleLevel(heights, heightsSampler, uv, 0.0).x;\n" +
        "}\n" +
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  let height = materialInput.height;\n" +
        "  let dims = vec2<i32>(textureDimensions(heights));\n" +
        "  let invTexSize = 1.0 / f32(dims.x);\n" +
        "  let minHeight = elevBandGetHeight(0, invTexSize);\n" +
        "  let maxHeight = elevBandGetHeight(dims.x - 1, invTexSize);\n" +
        "  if (height < minHeight || height > maxHeight) {\n" +
        "    material.diffuse = vec3<f32>(0.0);\n" +
        "    material.alpha = 0.0;\n" +
        "    return material;\n" +
        "  }\n" +
        "  var idxBelow: i32 = 0;\n" +
        "  var idxAbove: i32 = dims.x;\n" +
        "  var heightBelow: f32 = minHeight;\n" +
        "  var heightAbove: f32 = maxHeight;\n" +
        "  for (var i: i32 = 0; i < 16; i = i + 1) {\n" +
        "    if (idxBelow >= idxAbove - 1) { break; }\n" +
        "    let idxMid = (idxBelow + idxAbove) / 2;\n" +
        "    let heightTex = elevBandGetHeight(idxMid, invTexSize);\n" +
        "    if (height > heightTex) {\n" +
        "      idxBelow = idxMid;\n" +
        "      heightBelow = heightTex;\n" +
        "    } else {\n" +
        "      idxAbove = idxMid;\n" +
        "      heightAbove = heightTex;\n" +
        "    }\n" +
        "  }\n" +
        "  let denom = heightAbove - heightBelow;\n" +
        "  let lerper = select((height - heightBelow) / denom, 1.0, abs(denom) < 1e-9);\n" +
        "  let colorUv = vec2<f32>(invTexSize * (f32(idxBelow) + 0.5 + lerper), 0.5);\n" +
        "  var c = textureSampleLevel(colors, colorsSampler, colorUv, 0.0);\n" +
        "  if (c.a > 0.0) { c = vec4<f32>(c.rgb / c.a, c.a); }\n" +
        "  c = vec4<f32>(czm_gammaCorrect(c.rgb), c.a);\n" +
        "  material.diffuse = c.rgb;\n" +
        "  material.alpha = c.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: true,
});

/**
 * Gets the name of the water mask material.
 * @type {string}
 * @readonly
 */
Material.WaterMaskType = "WaterMask";
Material._materialCache.addMaterial(Material.WaterMaskType, {
  fabric: {
    type: Material.WaterMaskType,
    source: WaterMaskMaterial,
    uniforms: {
      waterColor: new Color(1.0, 1.0, 1.0, 1.0),
      landColor: new Color(0.0, 0.0, 0.0, 0.0),
    },
    wgsl: {
      source:
        "fn czm_getMaterial(materialInput: czm_MaterialInput) -> czm_Material {\n" +
        "  var material: czm_Material = czm_getDefaultMaterial(materialInput);\n" +
        "  var outColor = mix(landColor, waterColor, vec4<f32>(materialInput.waterMask));\n" +
        "  outColor = vec4<f32>(czm_gammaCorrect(outColor.rgb), outColor.a);\n" +
        "  material.diffuse = outColor.rgb;\n" +
        "  material.alpha = outColor.a;\n" +
        "  return material;\n" +
        "}\n",
    },
  },
  translucent: false,
});

export default Material;
