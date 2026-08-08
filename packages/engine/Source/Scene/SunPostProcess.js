import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import Transforms from "../Core/Transforms.js";
import AdditiveBlend from "../Shaders/PostProcessStages/AdditiveBlend.js";
import BrightPass from "../Shaders/PostProcessStages/BrightPass.js";
import GaussianBlur1D from "../Shaders/PostProcessStages/GaussianBlur1D.js";
import PassThrough from "../Shaders/PostProcessStages/PassThrough.js";
import SolarHalo from "../Shaders/PostProcessStages/SolarHalo.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import {
  SUN_BRIGHT_PASS_AVG_LUMINANCE,
  SUN_BRIGHT_PASS_OFFSET_LEGACY,
  SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
} from "./SolarDiscModel.js";
import PostProcessStage from "./PostProcessStage.js";
import PostProcessStageComposite from "./PostProcessStageComposite.js";
import PostProcessStageSampleMode from "./PostProcessStageSampleMode.js";
import PostProcessStageTextureCache from "./PostProcessStageTextureCache.js";
import SceneFramebuffer from "./SceneFramebuffer.js";

class SunPostProcess {
  /**
   * @param {PixelDatatype} [pixelDatatype=PixelDatatype.UNSIGNED_BYTE] The
   *        output datatype of every stage AND of this pipeline's own scene
   *        framebuffer.
   *
   * C12-19 — THE VACUITY BLOCKER THIS PARAMETER EXISTS TO CLOSE. Every stage
   * below was constructed at `PostProcessStage`'s default `UNSIGNED_BYTE`, and
   * `update()` called `sceneFramebuffer.update(context, viewport)` with no
   * `hdr` argument. So with `scene.sunBloom = true` — the shipped default —
   * the WHOLE SCENE was rendered into an 8-bit framebuffer even under
   * `highDynamicRange = true`, every stage output re-clamped it to 8 bits, and
   * `copy()` handed that back to the HDR scene framebuffer. HDR was defeated
   * on WebGL at defaults, which C12-28 (Batch 932) made load-bearing by
   * defaulting `highDynamicRange` ON for HDR-capable displays.
   *
   * Consequences that are all one bug: the C12-19 disc radiance could never
   * exceed 1 on this path, the C12-18 screen halo was clipped at 1 by stage
   * 6's own output texture, and the bright pass below could never see a
   * luminance above display white no matter how it was tuned — which is why
   * the retune and the datatype land together rather than separately.
   *
   * The caller resolves the datatype (it is the one that has a `Context` and
   * can ask about float-texture support) and reconstructs this object when it
   * changes; `FramebufferOrchestrator` does both.
   */
  constructor(pixelDatatype) {
    const datatype = pixelDatatype ?? PixelDatatype.UNSIGNED_BYTE;
    this._pixelDatatype = datatype;
    this._useHdr = datatype !== PixelDatatype.UNSIGNED_BYTE;
    this._sceneFramebuffer = new SceneFramebuffer();

    // C12-18 — resolved screen-space halo state, refreshed every `update()`
    // from `frameState.sunHalo` (Scene/SunHaloAppearance.js). The zero
    // intensity below is the safe default: `SolarHalo.glsl` adds
    // `haloColor * veil * intensity`, so an un-refreshed frame adds exactly
    // 0.0 rather than a stale halo at the wrong screen position.
    this._haloCenter = new Cartesian2();
    this._haloLimbPx = 1.0;
    this._haloCoreRadii = 1.0;
    this._haloIntensity = 0.0;
    this._haloColor = new Cartesian3(1.0, 1.0, 1.0);

    // C12-19 — bright-pass tuning, refreshed every `update()` from
    // `frameState.sunHalo`. The historical pair is the initial value, so an
    // un-refreshed frame (or a caller that passes no `frameState`) bright-
    // passes exactly as the engine always has.
    this._brightPassThreshold = SUN_BRIGHT_PASS_THRESHOLD_LEGACY;
    this._brightPassOffset = SUN_BRIGHT_PASS_OFFSET_LEGACY;

    const that = this;
    const scale = 0.125;
    const stages = new Array(7);

    stages[0] = new PostProcessStage({
      fragmentShader: PassThrough,
      textureScale: scale,
      forcePowerOfTwo: true,
      sampleMode: PostProcessStageSampleMode.LINEAR,
      pixelDatatype: datatype,
    });

    const brightPass = (stages[1] = new PostProcessStage({
      fragmentShader: BrightPass,
      uniforms: {
        // A guess at the average luminance across the entire scene. This is
        // `key()`'s argument — a scene-exposure heuristic, not a bright-pass
        // parameter — and C12-19 deliberately leaves it alone.
        avgLuminance: SUN_BRIGHT_PASS_AVG_LUMINANCE,
        // C12-19 — DERIVED from the disc's radiance in
        // `SolarDiscModel.solarBrightPassTuning`, not dialled: `threshold`
        // puts the extraction's foot exactly on display white (the shipped
        // 0.25 started at luminance 0.729, i.e. an ordinary bright sky was
        // already blooming) and `offset` puts its half-saturation point on
        // `sqrt(discRadiance)`, the geometric centre of the range it has to
        // span. Both collapse to the historical (0.25, 0.1) bit-for-bit
        // whenever the radiance is 1 — every SDR frame, and every frame with
        // `lighting.enableTrueSolarRadiance === false`.
        threshold: function () {
          return that._brightPassThreshold;
        },
        offset: function () {
          return that._brightPassOffset;
        },
      },
      textureScale: scale,
      forcePowerOfTwo: true,
      pixelDatatype: datatype,
    }));

    this._delta = 1.0;
    this._sigma = 2.0;
    this._blurStep = new Cartesian2();

    stages[2] = new PostProcessStage({
      fragmentShader: GaussianBlur1D,
      uniforms: {
        step: function () {
          that._blurStep.x = that._blurStep.y =
            1.0 / brightPass.outputTexture.width;
          return that._blurStep;
        },
        delta: function () {
          return that._delta;
        },
        sigma: function () {
          return that._sigma;
        },
        direction: 0.0,
      },
      textureScale: scale,
      forcePowerOfTwo: true,
      pixelDatatype: datatype,
    });

    stages[3] = new PostProcessStage({
      fragmentShader: GaussianBlur1D,
      uniforms: {
        step: function () {
          that._blurStep.x = that._blurStep.y =
            1.0 / brightPass.outputTexture.width;
          return that._blurStep;
        },
        delta: function () {
          return that._delta;
        },
        sigma: function () {
          return that._sigma;
        },
        direction: 1.0,
      },
      textureScale: scale,
      forcePowerOfTwo: true,
      pixelDatatype: datatype,
    });

    stages[4] = new PostProcessStage({
      fragmentShader: PassThrough,
      sampleMode: PostProcessStageSampleMode.LINEAR,
      pixelDatatype: datatype,
    });

    this._uCenter = new Cartesian2();
    this._uRadius = undefined;

    stages[5] = new PostProcessStage({
      fragmentShader: AdditiveBlend,
      uniforms: {
        center: function () {
          return that._uCenter;
        },
        radius: function () {
          return that._uRadius;
        },
        colorTexture2: function () {
          return that._sceneFramebuffer.framebuffer.getColorTexture(0);
        },
      },
      pixelDatatype: datatype,
    });

    // C12-18 (absorbs C11-160) — the screen-space solar veiling glare, run
    // LAST so it is added to the fully composited scene rather than being fed
    // back into the bright pass (which would bloom the halo of the halo).
    //
    // CLT-C4 is satisfied here without a second multiply anywhere: the
    // eclipse factor is folded into `u_haloIntensity` for this SYNTHESISED
    // halo, and the bright-pass chain above it derives its bloom from the sun
    // billboard whose ALPHA `Sun.update` already scaled by `sunEclipseAlpha`.
    // At totality both therefore go to zero, which is the whole point of the
    // rider: a corona inside an undimmed halo is the failure mode.
    stages[6] = new PostProcessStage({
      fragmentShader: SolarHalo,
      uniforms: {
        u_haloCenter: function () {
          return that._haloCenter;
        },
        u_haloLimbPx: function () {
          return that._haloLimbPx;
        },
        u_haloCoreRadii: function () {
          return that._haloCoreRadii;
        },
        u_haloIntensity: function () {
          return that._haloIntensity;
        },
        u_haloColor: function () {
          return that._haloColor;
        },
      },
      pixelDatatype: datatype,
    });

    this._stages = new PostProcessStageComposite({
      stages: stages,
    });

    const textureCache = new PostProcessStageTextureCache(this);
    const length = stages.length;
    for (let i = 0; i < length; ++i) {
      stages[i]._textureCache = textureCache;
    }

    this._textureCache = textureCache;
    this.length = stages.length;
  }

  /**
   * C12-19 — the datatype this pipeline was built with. `FramebufferOrchestrator`
   * compares it against the datatype the current `scene._hdr` implies and
   * reconstructs on a mismatch, because `PostProcessStage._pixelDatatype` is
   * fixed at construction.
   *
   * @type {PixelDatatype}
   * @readonly
   */
  get pixelDatatype() {
    return this._pixelDatatype;
  }

  get(index) {
    return this._stages.get(index);
  }

  getStageByName(name) {
    const length = this._stages.length;
    for (let i = 0; i < length; ++i) {
      const stage = this._stages.get(i);
      if (stage.name === name) {
        return stage;
      }
    }
    return undefined;
  }

  clear(context, passState, clearColor) {
    this._sceneFramebuffer.clear(context, passState, clearColor);
    this._textureCache.clear(context);
  }

  update(passState, frameState) {
    const context = passState.context;
    const viewport = passState.viewport;

    const sceneFramebuffer = this._sceneFramebuffer;
    // C12-19 — pass the HDR flag through. Without it this framebuffer was
    // always `UNSIGNED_BYTE`, and since the scene renders INTO it whenever
    // `sunBloom` is on, that single missing argument clamped the entire HDR
    // scene to 8 bits before any tonemapper saw it.
    sceneFramebuffer.update(context, viewport, this._useHdr);
    const framebuffer = sceneFramebuffer.framebuffer;

    this._textureCache.update(context);
    this._stages.update(context, false);

    updateSunPosition(this, context, viewport);
    // C12-18 — the halo's screen geometry, amplitude and tint are resolved
    // ONCE per frame in Scene/SunHaloAppearance.js and consumed identically
    // here and by the WebGPU `SunHaloEffect`. `frameState` is optional so an
    // older caller (or a frame before `Sun.update` has run) leaves the stage
    // arithmetically inert rather than throwing.
    updateSolarHalo(this, frameState);

    return framebuffer;
  }

  execute(context) {
    const colorTexture = this._sceneFramebuffer.framebuffer.getColorTexture(0);
    const stages = this._stages;
    const length = stages.length;
    stages.get(0).execute(context, colorTexture);
    for (let i = 1; i < length; ++i) {
      stages.get(i).execute(context, stages.get(i - 1).outputTexture);
    }
  }

  copy(context, framebuffer) {
    if (!defined(this._copyColorCommand)) {
      const that = this;
      this._copyColorCommand = context.createViewportQuadCommand(PassThrough, {
        uniformMap: {
          colorTexture: function () {
            return that._stages.get(that._stages.length - 1).outputTexture;
          },
        },
        owner: this,
      });
    }

    this._copyColorCommand.framebuffer = framebuffer;
    this._copyColorCommand.execute(context);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._textureCache.destroy();
    this._stages.destroy();
    return destroyObject(this);
  }
}

const sunPositionECScratch = new Cartesian4();
const sunPositionWCScratch = new Cartesian2();
const sizeScratch = new Cartesian2();
const postProcessMatrix4Scratch = new Matrix4();

function updateSunPosition(postProcess, context, viewport) {
  const us = context.uniformState;
  const sunPosition = us.sunPositionWC;
  const viewMatrix = us.view;
  const viewProjectionMatrix = us.viewProjection;
  const projectionMatrix = us.projection;

  // create up sampled render state
  let viewportTransformation = Matrix4.computeViewportTransformation(
    viewport,
    0.0,
    1.0,
    postProcessMatrix4Scratch,
  );
  const sunPositionEC = Matrix4.multiplyByPoint(
    viewMatrix,
    sunPosition,
    sunPositionECScratch,
  );
  let sunPositionWC = Transforms.pointToGLWindowCoordinates(
    viewProjectionMatrix,
    viewportTransformation,
    sunPosition,
    sunPositionWCScratch,
  );

  sunPositionEC.x += CesiumMath.SOLAR_RADIUS;
  const limbWC = Transforms.pointToGLWindowCoordinates(
    projectionMatrix,
    viewportTransformation,
    sunPositionEC,
    sunPositionEC,
  );
  const sunSize =
    Cartesian2.magnitude(Cartesian2.subtract(limbWC, sunPositionWC, limbWC)) *
    30.0 *
    2.0;

  const size = sizeScratch;
  size.x = sunSize;
  size.y = sunSize;

  postProcess._uCenter = Cartesian2.clone(sunPositionWC, postProcess._uCenter);
  postProcess._uRadius = Math.max(size.x, size.y) * 0.15;

  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;

  const stages = postProcess._stages;
  const firstStage = stages.get(0);

  const downSampleWidth = firstStage.outputTexture.width;
  const downSampleHeight = firstStage.outputTexture.height;

  const downSampleViewport = new BoundingRectangle();
  downSampleViewport.width = downSampleWidth;
  downSampleViewport.height = downSampleHeight;

  // create down sampled render state
  viewportTransformation = Matrix4.computeViewportTransformation(
    downSampleViewport,
    0.0,
    1.0,
    postProcessMatrix4Scratch,
  );
  sunPositionWC = Transforms.pointToGLWindowCoordinates(
    viewProjectionMatrix,
    viewportTransformation,
    sunPosition,
    sunPositionWCScratch,
  );

  size.x *= downSampleWidth / width;
  size.y *= downSampleHeight / height;

  const scissorRectangle = firstStage.scissorRectangle;
  scissorRectangle.x = Math.max(sunPositionWC.x - size.x * 0.5, 0.0);
  scissorRectangle.y = Math.max(sunPositionWC.y - size.y * 0.5, 0.0);
  scissorRectangle.width = Math.min(size.x, width);
  scissorRectangle.height = Math.min(size.y, height);

  for (let i = 1; i < 4; ++i) {
    BoundingRectangle.clone(scissorRectangle, stages.get(i).scissorRectangle);
  }
}

/**
 * C12-18 — copy the frame's resolved halo state onto the instance so the
 * stage's uniform closures read it. Pure transfer: every number here is
 * computed in `Scene/SunHaloAppearance.js` before the backend branch, which
 * is what makes the WebGL stage and the WebGPU effect provably agree.
 *
 * @param {SunPostProcess} postProcess The instance.
 * @param {object} [frameState] The frame state.
 * @private
 */
function updateSolarHalo(postProcess, frameState) {
  const halo = frameState?.sunHalo;
  // C12-19 — the bright-pass pair is transferred even when the halo is not
  // visible. The two are independent: the halo stage can be off (the Sun
  // behind the camera, `enableScreenSpaceSunHalo === false`) while the
  // bright-pass chain above it is still extracting a genuinely HDR sun.
  if (defined(halo) && typeof halo.brightPassThreshold === "number") {
    postProcess._brightPassThreshold = halo.brightPassThreshold;
    postProcess._brightPassOffset = halo.brightPassOffset;
  } else {
    postProcess._brightPassThreshold = SUN_BRIGHT_PASS_THRESHOLD_LEGACY;
    postProcess._brightPassOffset = SUN_BRIGHT_PASS_OFFSET_LEGACY;
  }
  if (!defined(halo) || halo.visible !== true) {
    postProcess._haloIntensity = 0.0;
    return;
  }
  postProcess._haloCenter.x = halo.centerX;
  postProcess._haloCenter.y = halo.centerY;
  postProcess._haloLimbPx = halo.limbPx;
  postProcess._haloCoreRadii = halo.haloCoreRadii;
  postProcess._haloIntensity = halo.haloIntensity;
  postProcess._haloColor.x = halo.haloColorR;
  postProcess._haloColor.y = halo.haloColorG;
  postProcess._haloColor.z = halo.haloColorB;
}

export default SunPostProcess;
