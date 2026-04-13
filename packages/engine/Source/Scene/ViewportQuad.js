import BoundingRectangle from "../Core/BoundingRectangle.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import ViewportQuadFS from "../Shaders/ViewportQuadFS.js";
import ViewportQuadWGSL from "../Shaders/WebGPU/ViewportQuad.js";
import BlendingState from "./BlendingState.js";
import Material from "./Material.js";

/**
 * A viewport aligned quad.
 *
 * @alias ViewportQuad
 * @constructor
 *
 * @param {BoundingRectangle} [rectangle] The {@link BoundingRectangle} defining the quad's position within the viewport.
 * @param {Material} [material] The {@link Material} defining the surface appearance of the viewport quad.
 *
 * @example
 * const viewportQuad = new Cesium.ViewportQuad(new Cesium.BoundingRectangle(0, 0, 80, 40));
 * viewportQuad.material.uniforms.color = new Cesium.Color(1.0, 0.0, 0.0, 1.0);
 */
class ViewportQuad {
  constructor(rectangle, material) {
    /**
     * Determines if the viewport quad primitive will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = true;

    if (!defined(rectangle)) {
      rectangle = new BoundingRectangle();
    }

    /**
     * The BoundingRectangle defining the quad's position within the viewport.
     *
     * @type {BoundingRectangle}
     *
     * @example
     * viewportQuad.rectangle = new Cesium.BoundingRectangle(0, 0, 80, 40);
     */
    this.rectangle = BoundingRectangle.clone(rectangle);

    if (!defined(material)) {
      material = Material.fromType(Material.ColorType, {
        color: new Color(1.0, 1.0, 1.0, 1.0),
      });
    }

    /**
     * The surface appearance of the viewport quad.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
     * {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}.
     * <p>
     * The default material is <code>Material.ColorType</code>.
     * </p>
     *
     * @type Material
     *
     * @example
     * // 1. Change the color of the default material to yellow
     * viewportQuad.material.uniforms.color = new Cesium.Color(1.0, 1.0, 0.0, 1.0);
     *
     * // 2. Change material to horizontal stripes
     * viewportQuad.material = Cesium.Material.fromType(Cesium.Material.StripeType);
     *
     * @see {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}
     */
    this.material = material;
    this._material = undefined;

    this._overlayCommand = undefined;
    this._rs = undefined;
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * get the draw commands needed to render this primitive.
   * <p>
   * Do not call this function directly.  This is documented just to
   * list the exceptions that may be propagated when the scene is rendered:
   * </p>
   *
   * @exception {DeveloperError} this.material must be defined.
   * @exception {DeveloperError} this.rectangle must be defined.
   */
  update(frameState) {
    if (!this.show) {
      return;
    }

    //>>includeStart('debug', pragmas.debug);
    if (!defined(this.material)) {
      throw new DeveloperError("this.material must be defined.");
    }
    if (!defined(this.rectangle)) {
      throw new DeveloperError("this.rectangle must be defined.");
    }
    //>>includeEnd('debug');

    const rs = this._rs;
    if (!defined(rs) || !BoundingRectangle.equals(rs.viewport, this.rectangle)) {
      this._rs = RenderState.fromCache({
        blending: BlendingState.ALPHA_BLEND,
        viewport: this.rectangle,
      });
    }

    const pass = frameState.passes;
    if (pass.render) {
      const context = frameState.context;

      if (this._material !== this.material || !defined(this._overlayCommand)) {
        // Recompile shader when material changes
        this._material = this.material;

        if (defined(this._overlayCommand)) {
          if (this._overlayCommand.shaderProgram?.destroy) {
            this._overlayCommand.shaderProgram.destroy();
          }
          if (this._overlayCommand.destroy) {
            this._overlayCommand.destroy();
          }
        }

        if (context.isWebGPU) {
          // WebGPU path: use WGSL viewport quad shader
          // Material uniforms are resolved per frame via the uniform map
          const mat = this._material;
          const uniformMap = {
            materialUniforms: () => {
              const u = mat.uniforms;
              if (u?.color) {
                return new Float32Array([
                  u.color.red,
                  u.color.green,
                  u.color.blue,
                  u.color.alpha ?? 1.0,
                ]);
              }
              return new Float32Array([1.0, 1.0, 1.0, 1.0]);
            },
          };
          this._overlayCommand = context.createViewportQuadCommand(
            ViewportQuadWGSL,
            {
              renderState: this._rs,
              uniformMap: uniformMap,
              owner: this,
            },
          );
        } else {
          // WebGL path
          const fs = new ShaderSource({
            sources: [this._material.shaderSource, ViewportQuadFS],
          });
          this._overlayCommand = context.createViewportQuadCommand(fs, {
            renderState: this._rs,
            uniformMap: this._material._uniforms,
            owner: this,
          });
        }
        this._overlayCommand.pass = Pass.OVERLAY;
      }

      this._material.update(context);

      this._overlayCommand.renderState = this._rs;
      this._overlayCommand.uniformMap = this._material._uniforms;
      frameState.commandList.push(this._overlayCommand);
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
   * @see ViewportQuad#destroy
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
   * quad = quad && quad.destroy();
   *
   * @see ViewportQuad#isDestroyed
   */
  destroy() {
    if (defined(this._overlayCommand)) {
      if (this._overlayCommand.shaderProgram?.destroy) {
        this._overlayCommand.shaderProgram.destroy();
        this._overlayCommand.shaderProgram = undefined;
      }
      if (this._overlayCommand.destroy) {
        this._overlayCommand.destroy();
      }
    }
    return destroyObject(this);
  }
}

export default ViewportQuad;
