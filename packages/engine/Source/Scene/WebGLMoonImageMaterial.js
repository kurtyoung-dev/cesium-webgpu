import Cartesian2 from "../Core/Cartesian2.js";
import Color from "../Core/Color.js";
import Material from "./Material.js";

const WebGLMoonImageMaterialType = "WebGLMoonImage";

// Moon-only counterpart of Material.ImageType. The public image/repeat/color
// contract and its gamma/alpha algebra are deliberately identical. Only the
// texture fetch changes when EllipsoidPrimitive opts this private material
// into the explicit-gradient path; generic and translucent image materials
// continue to use Material.ImageType unchanged.
const webGLMoonImageMaterialSource = `
#ifdef LUNAR_ALBEDO_EXPLICIT_GRADIENTS
vec4 sampleWebGLMoonTexture(
    sampler2D textureSampler,
    vec2 textureCoordinates,
    vec2 textureCoordinateScale);
#endif

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    vec2 textureCoordinates = fract(repeat * materialInput.st);
#ifdef LUNAR_ALBEDO_EXPLICIT_GRADIENTS
    vec4 imageColor = sampleWebGLMoonTexture(image, textureCoordinates, repeat);
#else
    vec4 imageColor = texture(image, textureCoordinates);
#endif
    material.diffuse = czm_gammaCorrect(imageColor.rgb * color.rgb);
    material.alpha = imageColor.a * color.a;
    return material;
}
`;

/**
 * Creates the private WebGL Moon material without changing the engine-wide
 * Image material template.
 *
 * @returns {Material}
 * @private
 */
function createWebGLMoonImageMaterial() {
  return new Material({
    fabric: {
      type: WebGLMoonImageMaterialType,
      uniforms: {
        image: Material.DefaultImageId,
        repeat: new Cartesian2(1.0, 1.0),
        color: new Color(1.0, 1.0, 1.0, 1.0),
      },
      source: webGLMoonImageMaterialSource,
    },
    translucent: false,
  });
}

export {
  createWebGLMoonImageMaterial,
  webGLMoonImageMaterialSource,
  WebGLMoonImageMaterialType,
};

export default createWebGLMoonImageMaterial;
