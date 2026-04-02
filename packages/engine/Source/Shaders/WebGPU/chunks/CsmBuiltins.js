//This file is automatically rebuilt by the Cesium build process.
import CameraUniforms from './structs/CameraUniforms.js'
import LightingUniforms from './structs/LightingUniforms.js'
import LightUniforms from './structs/LightUniforms.js'
import ModelUniforms from './structs/ModelUniforms.js'
import PBRMaterial from './structs/PBRMaterial.js'
import csm_alphaWeight from './functions/csm_alphaWeight.js'
import csm_approximateSphericalCoordinates from './functions/csm_approximateSphericalCoordinates.js'
import csm_branchFreeTernary from './functions/csm_branchFreeTernary.js'
import csm_cascadeColor from './functions/csm_cascadeColor.js'
import csm_cascadeMatrix from './functions/csm_cascadeMatrix.js'
import csm_cascadeWeights from './functions/csm_cascadeWeights.js'
import csm_clipByPolygons from './functions/csm_clipByPolygons.js'
import csm_columbusViewMorph from './functions/csm_columbusViewMorph.js'
import csm_constants from './functions/csm_constants.js'
import csm_decodeRGB8 from './functions/csm_decodeRGB8.js'
import csm_decompressTextureCoordinates from './functions/csm_decompressTextureCoordinates.js'
import csm_distributionGGX from './functions/csm_distributionGGX.js'
import csm_effects from './functions/csm_effects.js'
import csm_ellipsoidContainsPoint from './functions/csm_ellipsoidContainsPoint.js'
import csm_fastApproximateAtan from './functions/csm_fastApproximateAtan.js'
import csm_fog from './functions/csm_fog.js'
import csm_fresnelSchlick from './functions/csm_fresnelSchlick.js'
import csm_gammaCorrection from './functions/csm_gammaCorrection.js'
import csm_geometrySmith from './functions/csm_geometrySmith.js'
import csm_getNormalFromMap from './functions/csm_getNormalFromMap.js'
import csm_getWaterNoise from './functions/csm_getWaterNoise.js'
import csm_HSBToRGB from './functions/csm_HSBToRGB.js'
import csm_linearToSrgb from './functions/csm_linearToSrgb.js'
import csm_luminance from './functions/csm_luminance.js'
import csm_metersPerPixel from './functions/csm_metersPerPixel.js'
import csm_multiplyWithColorBalance from './functions/csm_multiplyWithColorBalance.js'
import csm_nearFarScalar from './functions/csm_nearFarScalar.js'
import csm_octDecode from './functions/csm_octDecode.js'
import csm_packDepth from './functions/csm_packDepth.js'
import csm_phong from './functions/csm_phong.js'
import csm_planeDistance from './functions/csm_planeDistance.js'
import csm_pointAlongRay from './functions/csm_pointAlongRay.js'
import csm_reverseLogDepth from './functions/csm_reverseLogDepth.js'
import csm_RGBToHSB from './functions/csm_RGBToHSB.js'
import csm_RGBToXYZ from './functions/csm_RGBToXYZ.js'
import csm_saturation from './functions/csm_saturation.js'
import csm_shadowDepthCompare from './functions/csm_shadowDepthCompare.js'
import csm_shadowVisibility from './functions/csm_shadowVisibility.js'
import csm_signNotZero from './functions/csm_signNotZero.js'
import csm_srgbToLinear from './functions/csm_srgbToLinear.js'
import csm_tangentToEyeSpaceMatrix from './functions/csm_tangentToEyeSpaceMatrix.js'
import csm_tonemapping from './functions/csm_tonemapping.js'
import csm_transformPlane from './functions/csm_transformPlane.js'
import csm_translateRelativeToEye from './functions/csm_translateRelativeToEye.js'
import csm_unpackDepth from './functions/csm_unpackDepth.js'
import csm_unpackFloat from './functions/csm_unpackFloat.js'
import csm_unpackTexture from './functions/csm_unpackTexture.js'
import csm_writeLogDepth from './functions/csm_writeLogDepth.js'
import csm_XYZToRGB from './functions/csm_XYZToRGB.js'

export default {
    CameraUniforms : CameraUniforms,
    LightingUniforms : LightingUniforms,
    LightUniforms : LightUniforms,
    ModelUniforms : ModelUniforms,
    PBRMaterial : PBRMaterial,
    csm_alphaWeight : csm_alphaWeight,
    csm_approximateSphericalCoordinates : csm_approximateSphericalCoordinates,
    csm_branchFreeTernary : csm_branchFreeTernary,
    csm_cascadeColor : csm_cascadeColor,
    csm_cascadeMatrix : csm_cascadeMatrix,
    csm_cascadeWeights : csm_cascadeWeights,
    csm_clipByPolygons : csm_clipByPolygons,
    csm_columbusViewMorph : csm_columbusViewMorph,
    csm_constants : csm_constants,
    csm_decodeRGB8 : csm_decodeRGB8,
    csm_decompressTextureCoordinates : csm_decompressTextureCoordinates,
    csm_distributionGGX : csm_distributionGGX,
    csm_effects : csm_effects,
    csm_ellipsoidContainsPoint : csm_ellipsoidContainsPoint,
    csm_fastApproximateAtan : csm_fastApproximateAtan,
    csm_fog : csm_fog,
    csm_fresnelSchlick : csm_fresnelSchlick,
    csm_gammaCorrection : csm_gammaCorrection,
    csm_geometrySmith : csm_geometrySmith,
    csm_getNormalFromMap : csm_getNormalFromMap,
    csm_getWaterNoise : csm_getWaterNoise,
    csm_HSBToRGB : csm_HSBToRGB,
    csm_linearToSrgb : csm_linearToSrgb,
    csm_luminance : csm_luminance,
    csm_metersPerPixel : csm_metersPerPixel,
    csm_multiplyWithColorBalance : csm_multiplyWithColorBalance,
    csm_nearFarScalar : csm_nearFarScalar,
    csm_octDecode : csm_octDecode,
    csm_packDepth : csm_packDepth,
    csm_phong : csm_phong,
    csm_planeDistance : csm_planeDistance,
    csm_pointAlongRay : csm_pointAlongRay,
    csm_reverseLogDepth : csm_reverseLogDepth,
    csm_RGBToHSB : csm_RGBToHSB,
    csm_RGBToXYZ : csm_RGBToXYZ,
    csm_saturation : csm_saturation,
    csm_shadowDepthCompare : csm_shadowDepthCompare,
    csm_shadowVisibility : csm_shadowVisibility,
    csm_signNotZero : csm_signNotZero,
    csm_srgbToLinear : csm_srgbToLinear,
    csm_tangentToEyeSpaceMatrix : csm_tangentToEyeSpaceMatrix,
    csm_tonemapping : csm_tonemapping,
    csm_transformPlane : csm_transformPlane,
    csm_translateRelativeToEye : csm_translateRelativeToEye,
    csm_unpackDepth : csm_unpackDepth,
    csm_unpackFloat : csm_unpackFloat,
    csm_unpackTexture : csm_unpackTexture,
    csm_writeLogDepth : csm_writeLogDepth,
    csm_XYZToRGB : csm_XYZToRGB
};
