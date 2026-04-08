//This file is automatically rebuilt by the Cesium build process.
import CameraUniforms from './structs/CameraUniforms.js'
import EffectsUniforms from './structs/EffectsUniforms.js'
import LightingUniforms from './structs/LightingUniforms.js'
import LightUniforms from './structs/LightUniforms.js'
import ModelUniforms from './structs/ModelUniforms.js'
import PBRMaterial from './structs/PBRMaterial.js'
import csm_alphaWeight from './functions/csm_alphaWeight.js'
import csm_antialias from './functions/csm_antialias.js'
import csm_applyHSBShift from './functions/csm_applyHSBShift.js'
import csm_approximateSphericalCoordinates from './functions/csm_approximateSphericalCoordinates.js'
import csm_approximateTanh from './functions/csm_approximateTanh.js'
import csm_atmosphereCommon from './functions/csm_atmosphereCommon.js'
import csm_backFacing from './functions/csm_backFacing.js'
import csm_branchFreeTernary from './functions/csm_branchFreeTernary.js'
import csm_cascadeColor from './functions/csm_cascadeColor.js'
import csm_cascadeDistance from './functions/csm_cascadeDistance.js'
import csm_cascadeMatrix from './functions/csm_cascadeMatrix.js'
import csm_cascadeWeights from './functions/csm_cascadeWeights.js'
import csm_clipByPolygons from './functions/csm_clipByPolygons.js'
import csm_columbusViewMorph from './functions/csm_columbusViewMorph.js'
import csm_computeAtmosphereColor from './functions/csm_computeAtmosphereColor.js'
import csm_computeAttenuation from './functions/csm_computeAttenuation.js'
import csm_computeGroundAtmosphereScattering from './functions/csm_computeGroundAtmosphereScattering.js'
import csm_computeScattering from './functions/csm_computeScattering.js'
import csm_computeSpotCone from './functions/csm_computeSpotCone.js'
import csm_computeTextureTransform from './functions/csm_computeTextureTransform.js'
import csm_constants from './functions/csm_constants.js'
import csm_decodeRGB8 from './functions/csm_decodeRGB8.js'
import csm_decompressTextureCoordinates from './functions/csm_decompressTextureCoordinates.js'
import csm_depthClamp from './functions/csm_depthClamp.js'
import csm_distributionGGX from './functions/csm_distributionGGX.js'
import csm_eastNorthUpToEyeCoordinates from './functions/csm_eastNorthUpToEyeCoordinates.js'
import csm_effects from './functions/csm_effects.js'
import csm_ellipsoidContainsPoint from './functions/csm_ellipsoidContainsPoint.js'
import csm_ellipsoidTextureCoordinates from './functions/csm_ellipsoidTextureCoordinates.js'
import csm_equalsEpsilon from './functions/csm_equalsEpsilon.js'
import csm_eyeOffset from './functions/csm_eyeOffset.js'
import csm_eyeToWindowCoordinates from './functions/csm_eyeToWindowCoordinates.js'
import csm_fastApproximateAtan from './functions/csm_fastApproximateAtan.js'
import csm_fog from './functions/csm_fog.js'
import csm_fresnelSchlick from './functions/csm_fresnelSchlick.js'
import csm_gammaCorrection from './functions/csm_gammaCorrection.js'
import csm_geodeticSurfaceNormal from './functions/csm_geodeticSurfaceNormal.js'
import csm_geometrySmith from './functions/csm_geometrySmith.js'
import csm_getDefaultMaterial from './functions/csm_getDefaultMaterial.js'
import csm_getDynamicAtmosphereLightDirection from './functions/csm_getDynamicAtmosphereLightDirection.js'
import csm_getLambertDiffuse from './functions/csm_getLambertDiffuse.js'
import csm_getNormalFromMap from './functions/csm_getNormalFromMap.js'
import csm_getSpecular from './functions/csm_getSpecular.js'
import csm_getWaterNoise from './functions/csm_getWaterNoise.js'
import csm_HSBToRGB from './functions/csm_HSBToRGB.js'
import csm_HSLToRGB from './functions/csm_HSLToRGB.js'
import csm_hue from './functions/csm_hue.js'
import csm_inverseGamma from './functions/csm_inverseGamma.js'
import csm_isEmpty from './functions/csm_isEmpty.js'
import csm_isFull from './functions/csm_isFull.js'
import csm_latitudeToWebMercatorFraction from './functions/csm_latitudeToWebMercatorFraction.js'
import csm_linearToSrgb from './functions/csm_linearToSrgb.js'
import csm_lineDistance from './functions/csm_lineDistance.js'
import csm_log2Depth from './functions/csm_log2Depth.js'
import csm_luminance from './functions/csm_luminance.js'
import csm_metersPerPixel from './functions/csm_metersPerPixel.js'
import csm_modelToWindowCoordinates from './functions/csm_modelToWindowCoordinates.js'
import csm_multiplyWithColorBalance from './functions/csm_multiplyWithColorBalance.js'
import csm_nearFarScalar from './functions/csm_nearFarScalar.js'
import csm_octDecode from './functions/csm_octDecode.js'
import csm_packDepth from './functions/csm_packDepth.js'
import csm_phong from './functions/csm_phong.js'
import csm_planeDistance from './functions/csm_planeDistance.js'
import csm_pointAlongRay from './functions/csm_pointAlongRay.js'
import csm_primitiveIndex from './functions/csm_primitiveIndex.js'
import csm_readDepth from './functions/csm_readDepth.js'
import csm_readNonPerspective from './functions/csm_readNonPerspective.js'
import csm_reverseLogDepth from './functions/csm_reverseLogDepth.js'
import csm_RGBToHSB from './functions/csm_RGBToHSB.js'
import csm_RGBToXYZ from './functions/csm_RGBToXYZ.js'
import csm_sampleOctahedralProjection from './functions/csm_sampleOctahedralProjection.js'
import csm_saturation from './functions/csm_saturation.js'
import csm_shadowDepthCompare from './functions/csm_shadowDepthCompare.js'
import csm_shadowVisibility from './functions/csm_shadowVisibility.js'
import csm_signNotZero from './functions/csm_signNotZero.js'
import csm_srgbToLinear from './functions/csm_srgbToLinear.js'
import csm_tangentToEyeSpaceMatrix from './functions/csm_tangentToEyeSpaceMatrix.js'
import csm_tonemapping from './functions/csm_tonemapping.js'
import csm_transformPlane from './functions/csm_transformPlane.js'
import csm_translateRelativeToEye from './functions/csm_translateRelativeToEye.js'
import csm_translucentPhong from './functions/csm_translucentPhong.js'
import csm_unpackClippingExtents from './functions/csm_unpackClippingExtents.js'
import csm_unpackDepth from './functions/csm_unpackDepth.js'
import csm_unpackFloat from './functions/csm_unpackFloat.js'
import csm_unpackTexture from './functions/csm_unpackTexture.js'
import csm_unpackUint from './functions/csm_unpackUint.js'
import csm_vertexLogDepth from './functions/csm_vertexLogDepth.js'
import csm_windowToEyeCoordinates from './functions/csm_windowToEyeCoordinates.js'
import csm_writeDepthClamp from './functions/csm_writeDepthClamp.js'
import csm_writeLogDepth from './functions/csm_writeLogDepth.js'
import csm_writeNonPerspective from './functions/csm_writeNonPerspective.js'
import csm_XYZToRGB from './functions/csm_XYZToRGB.js'

export default {
    CameraUniforms : CameraUniforms,
    EffectsUniforms : EffectsUniforms,
    LightingUniforms : LightingUniforms,
    LightUniforms : LightUniforms,
    ModelUniforms : ModelUniforms,
    PBRMaterial : PBRMaterial,
    csm_alphaWeight : csm_alphaWeight,
    csm_antialias : csm_antialias,
    csm_applyHSBShift : csm_applyHSBShift,
    csm_approximateSphericalCoordinates : csm_approximateSphericalCoordinates,
    csm_approximateTanh : csm_approximateTanh,
    csm_atmosphereCommon : csm_atmosphereCommon,
    csm_backFacing : csm_backFacing,
    csm_branchFreeTernary : csm_branchFreeTernary,
    csm_cascadeColor : csm_cascadeColor,
    csm_cascadeDistance : csm_cascadeDistance,
    csm_cascadeMatrix : csm_cascadeMatrix,
    csm_cascadeWeights : csm_cascadeWeights,
    csm_clipByPolygons : csm_clipByPolygons,
    csm_columbusViewMorph : csm_columbusViewMorph,
    csm_computeAtmosphereColor : csm_computeAtmosphereColor,
    csm_computeAttenuation : csm_computeAttenuation,
    csm_computeGroundAtmosphereScattering : csm_computeGroundAtmosphereScattering,
    csm_computeScattering : csm_computeScattering,
    csm_computeSpotCone : csm_computeSpotCone,
    csm_computeTextureTransform : csm_computeTextureTransform,
    csm_constants : csm_constants,
    csm_decodeRGB8 : csm_decodeRGB8,
    csm_decompressTextureCoordinates : csm_decompressTextureCoordinates,
    csm_depthClamp : csm_depthClamp,
    csm_distributionGGX : csm_distributionGGX,
    csm_eastNorthUpToEyeCoordinates : csm_eastNorthUpToEyeCoordinates,
    csm_effects : csm_effects,
    csm_ellipsoidContainsPoint : csm_ellipsoidContainsPoint,
    csm_ellipsoidTextureCoordinates : csm_ellipsoidTextureCoordinates,
    csm_equalsEpsilon : csm_equalsEpsilon,
    csm_eyeOffset : csm_eyeOffset,
    csm_eyeToWindowCoordinates : csm_eyeToWindowCoordinates,
    csm_fastApproximateAtan : csm_fastApproximateAtan,
    csm_fog : csm_fog,
    csm_fresnelSchlick : csm_fresnelSchlick,
    csm_gammaCorrection : csm_gammaCorrection,
    csm_geodeticSurfaceNormal : csm_geodeticSurfaceNormal,
    csm_geometrySmith : csm_geometrySmith,
    csm_getDefaultMaterial : csm_getDefaultMaterial,
    csm_getDynamicAtmosphereLightDirection : csm_getDynamicAtmosphereLightDirection,
    csm_getLambertDiffuse : csm_getLambertDiffuse,
    csm_getNormalFromMap : csm_getNormalFromMap,
    csm_getSpecular : csm_getSpecular,
    csm_getWaterNoise : csm_getWaterNoise,
    csm_HSBToRGB : csm_HSBToRGB,
    csm_HSLToRGB : csm_HSLToRGB,
    csm_hue : csm_hue,
    csm_inverseGamma : csm_inverseGamma,
    csm_isEmpty : csm_isEmpty,
    csm_isFull : csm_isFull,
    csm_latitudeToWebMercatorFraction : csm_latitudeToWebMercatorFraction,
    csm_linearToSrgb : csm_linearToSrgb,
    csm_lineDistance : csm_lineDistance,
    csm_log2Depth : csm_log2Depth,
    csm_luminance : csm_luminance,
    csm_metersPerPixel : csm_metersPerPixel,
    csm_modelToWindowCoordinates : csm_modelToWindowCoordinates,
    csm_multiplyWithColorBalance : csm_multiplyWithColorBalance,
    csm_nearFarScalar : csm_nearFarScalar,
    csm_octDecode : csm_octDecode,
    csm_packDepth : csm_packDepth,
    csm_phong : csm_phong,
    csm_planeDistance : csm_planeDistance,
    csm_pointAlongRay : csm_pointAlongRay,
    csm_primitiveIndex : csm_primitiveIndex,
    csm_readDepth : csm_readDepth,
    csm_readNonPerspective : csm_readNonPerspective,
    csm_reverseLogDepth : csm_reverseLogDepth,
    csm_RGBToHSB : csm_RGBToHSB,
    csm_RGBToXYZ : csm_RGBToXYZ,
    csm_sampleOctahedralProjection : csm_sampleOctahedralProjection,
    csm_saturation : csm_saturation,
    csm_shadowDepthCompare : csm_shadowDepthCompare,
    csm_shadowVisibility : csm_shadowVisibility,
    csm_signNotZero : csm_signNotZero,
    csm_srgbToLinear : csm_srgbToLinear,
    csm_tangentToEyeSpaceMatrix : csm_tangentToEyeSpaceMatrix,
    csm_tonemapping : csm_tonemapping,
    csm_transformPlane : csm_transformPlane,
    csm_translateRelativeToEye : csm_translateRelativeToEye,
    csm_translucentPhong : csm_translucentPhong,
    csm_unpackClippingExtents : csm_unpackClippingExtents,
    csm_unpackDepth : csm_unpackDepth,
    csm_unpackFloat : csm_unpackFloat,
    csm_unpackTexture : csm_unpackTexture,
    csm_unpackUint : csm_unpackUint,
    csm_vertexLogDepth : csm_vertexLogDepth,
    csm_windowToEyeCoordinates : csm_windowToEyeCoordinates,
    csm_writeDepthClamp : csm_writeDepthClamp,
    csm_writeLogDepth : csm_writeLogDepth,
    csm_writeNonPerspective : csm_writeNonPerspective,
    csm_XYZToRGB : csm_XYZToRGB
};
