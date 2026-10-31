// shader-reader-allowlist.mjs — the pinned census of specs that still name an engine
// shader path outside the kit reader.
// @purpose Pinned shrink-only census of specs exempt from shader-reader-hygiene.spec.mjs (raw engine-shader path literals outside readEngineShader/engineShaderPath), each with a one-line reason; the spec fails on a new raw reader or a stale row.
// @status ACTIVE
//
// DATA, not policy. Census taken at a46ed8feeb after the GlobeTerrain readers
// were routed through lib/engine-shader-source.mjs (DX-RAW-GLOBETERRAIN-READERS).
// Shrink-only: the spec asserts every row still exists AND is still flagged, so a
// spec that is migrated must leave this file in the same change. GlobeTerrain rows
// are path data the scanner cannot tell from a read, or readers not migrated
// tonight; every other row reads some other shader raw and is the follow-up's.

/** Spec path (repo-relative) -> one-line reason it is exempt. */
export const SHADER_READER_ALLOWLIST = Object.freeze({
  "Tools/visual-regression/cloud-curved-air-transport.spec.mjs":
    "landed in W3 (Batches 1608-1615) ahead of this gate; raw reads of CloudAerialTransport.wgsl and ProceduralClouds.wgsl, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-finite-air-light.spec.mjs":
    "landed in W3 (Batches 1608-1615) ahead of this gate; raw reads of CloudAirLight, CloudSolarLighting, ProceduralClouds and CloudViewIntegration .wgsl, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-radiance-transport.spec.mjs":
    "landed in W3 (Batches 1608-1615) ahead of this gate; raw reads of CloudViewIntegration.wgsl and ProceduralClouds.wgsl, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-uniform-layout.spec.mjs":
    "landed in W3 (Batches 1608-1615) ahead of this gate; raw read of ProceduralClouds.wgsl, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/ocean-fft-device-harness.spec.mjs":
    "raw read of Ocean/OceanStockhamIFFT.wgsl (path also used to write the built-tree sibling .js); engineShaderPath() can carry it; owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/water-material-water-mask-tail.spec.mjs":
    "lands in the same night's stack ahead of this gate; raw GlobeTerrain read via path.join, a two-line move to readEngineShader owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/water-ocean-stockham-ifft.spec.mjs":
    "lands in the same night's stack ahead of this gate; raw reads of five Ocean/*.wgsl shaders via a template path, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/build-infra/comment-flavour-corpus.spec.mjs":
    "raw read of EnvCubeMipDownsample.wgsl, BufferPointMaterial.wgsl, FrustumCull.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/build-infra/wgsl-chunk-resolution.spec.mjs":
    "raw read of csm_samplePointShadow.wgsl, csm_polylineCommon.wgsl, csm_distributionGGX.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/build-infra/wgsl-comment-strip.spec.mjs":
    "raw read of PrimitivePhongColor.wgsl, FrustumCull.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/c16/comment-flavour-gate.spec.mjs":
    "raw read of Subject.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/c16/comment-marker-guard.spec.mjs":
    "scope strings for the comment-marker lint (isInScope, lint-staged inputs), not reads",
  "Tools/c16/comment-only-diff.spec.mjs":
    "raw read of Subject.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/c16/shader-reader-oit-scope.spec.mjs":
    "raw read of BillboardCollection.wgsl, X.wgsl, Y.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/c16/verify-packaged-notices.spec.mjs":
    "raw read of Thing.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/context-spine/context-spine-spatial-hazards.spec.mjs":
    "raw read of MiniGlobe.wgsl, PrimitiveLit.wgsl, CustomBadCamera.wgsl, Probe.wgsl (fixture shaders, moved here from context-spine.spec.mjs by its split); not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/buffer-polyline-hairpin-join.spec.mjs":
    "raw read of csm_polylineCommon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/buffer-polyline-meters-width.spec.mjs":
    "raw read of BufferPolylineMaterial.wgsl, csm_metersPerPixel.wgsl, csm_polylineCommon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/c11-14-webgl-anisotropy-tangent-fallback.spec.mjs":
    "raw read of ModelPBRComplete.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/c12-29-s5-custom-ellipsoid-gate.spec.mjs":
    "S5 source-footprint path list plus one raw GlobeTerrain read; not migrated tonight (spec carries probe words, not run by the migrating lane)",
  "Tools/visual-regression/c12-29-s5-svs-footprint-gate.spec.mjs":
    "S5 source-footprint path lists fed to the identity hasher; the hasher needs to learn shader decomposition first",
  "Tools/visual-regression/c13-42-godray-fixture.spec.mjs":
    "raw read of GodRayGenerate.wgsl, GodRayGenerate_f16.wgsl, GodRayComposite.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/celestial-g2-gate.spec.mjs":
    "raw read of Tonemapping.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/celestial-gate-class-audit.spec.mjs":
    "evidence-table path data; every shader read goes through the kit-routed readSource",
  "Tools/visual-regression/celestial-uniform-offsets.spec.mjs":
    "raw read of CubeMapPanorama.wgsl, StarField.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/celestial-water-globe-port.spec.mjs":
    "raw read of OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/celestial-water-moonglade.spec.mjs":
    "raw read of OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/celestial-water-sun-glint.spec.mjs":
    "raw read of OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-aerial-path-length.spec.mjs":
    "raw read of ProceduralClouds.wgsl, CloudAerialTransport.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-coverage-response.spec.mjs":
    "raw read of CloudDensityDomain.wgsl, ProceduralClouds.wgsl, ProceduralSkyCubemap.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-density-domain.spec.mjs":
    "raw read of CloudDensityDomain.wgsl, ProceduralClouds.wgsl, ProceduralSkyCubemap.wgsl and 4 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-density-lod.spec.mjs":
    "raw read of CloudDensityDomain.wgsl, ProceduralClouds.wgsl, ProceduralSkyCubemap.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-genus-morphology.spec.mjs":
    "raw read of ProceduralClouds.wgsl, CloudViewIntegration.wgsl, CloudDensityDomain.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-march-emission.spec.mjs":
    "raw read of ProceduralClouds.wgsl, CloudViewIntegration.wgsl, CloudReconstructionAttachments.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-march-transfer.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-morphology-composition.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-noise-mipmaps.spec.mjs":
    "raw read of CloudNoiseMipmap.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-primary-shell.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-reconstruction-attachments.spec.mjs":
    "raw read of CloudReconstructionAttachments.wgsl, ProceduralClouds.wgsl, CloudTemporalResolve.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-shadow-rte.spec.mjs":
    "raw read of ProceduralClouds.wgsl, CloudDensityDomain.wgsl, AerialPerspective.wgsl and 2 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-temporal-rte.spec.mjs":
    "raw read of CloudTemporalResolve.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-tier-lighting-dials.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/cloud-tier-single-source.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/collection-previous-frame-rte.spec.mjs":
    "raw read of BillboardCollection.wgsl, BillboardCollectionSDF.wgsl, PointPrimitiveColor.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/compute-cloud-previous-frame-rte.spec.mjs":
    "raw read of ComputeInstanceRender.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/eclipse-cloud-ibl-response.spec.mjs":
    "shader-path arrays fed to the kit-routed readEngine; no raw read",
  "Tools/visual-regression/eclipse-cloud-response-gate.spec.mjs":
    "text-coverage path list; its GlobeTerrain reads go through readEngineShader",
  "Tools/visual-regression/eclipse-scene-dimming.spec.mjs":
    "shader-path array fed to the kit-routed readEngine; no raw read",
  "Tools/visual-regression/eclipse-sky-totality.spec.mjs":
    "raw read of CubeMapPanorama.wgsl, SkyAtmosphere.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/elevation-contour-modulo-parity.spec.mjs":
    "raw read of PrimitiveMatElevContourFlat.wgsl, PrimitiveMatElevContourLit.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/elevation-contour-pixel-ratio-parity.spec.mjs":
    "raw read of PrimitiveMatElevContourFlat.wgsl, PrimitiveMatElevContourLit.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/environmental-snapshot-gate.spec.mjs":
    "raw read of CloudUpscale.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/eye-cartographic-uniforms.spec.mjs":
    "raw read of csm_eyeToCartographicDelta.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/fog-cheap-coverage-gate.spec.mjs":
    "raw read of VolumetricFog.wgsl, CloudDensityDomain.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/globe-terrain-default-variant-identity.spec.mjs":
    "path constant for `git show <base>:<path>`; the working-tree read goes through readEngineShader",
  "Tools/visual-regression/godray-energy-law.spec.mjs":
    "raw read of GodRayGenerate.wgsl, GodRayGenerate_f16.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/ground-fog-band.spec.mjs":
    "raw read of VolumetricFog.wgsl, CloudDensityDomain.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/gsplat-harness.spec.mjs":
    "raw GlobeTerrain read via readNormalized; not migrated tonight (spec carries probe words, not run by the migrating lane)",
  "Tools/visual-regression/lunar-eclipse-earth-shadow.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/model-light-arena.spec.mjs":
    "raw read of ModelPBRComplete.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/model-previous-frame-rte.spec.mjs":
    "raw read of ModelPBRComplete.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-albedo-asset.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-atmosphere-appearance.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-globe-depth-routing.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-mip-lod-shader.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-normal-map-asset.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-phase-gate.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/moon-phase-terminator.spec.mjs":
    "raw read of Moon.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/ocean-fft-controls.spec.mjs":
    "raw read of OceanSurface.wgsl, OceanInitialSpectrum.wgsl, OceanIFFT.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/ocean-tide-datum.spec.mjs":
    "raw read of OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/pointcloud-voxel-public-correctness.spec.mjs":
    "raw read of PointCloudEDLDepth.wgsl, PointCloudEDL.wgsl, PointCloudLOD.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/polyline-command-bounding-volume.spec.mjs":
    "raw read of PolylineArrow.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/polyline-nearclip-wiring.spec.mjs":
    "raw read of csm_polylineCommon.wgsl, BufferPolylineMaterial.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/previous-frame-rte-reconstruction.spec.mjs":
    "raw read of BillboardCollection.wgsl, BillboardCollectionSDF.wgsl, PointPrimitiveColor.wgsl and 3 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/primitive-material-modulo-parity.spec.mjs":
    "raw read of PrimitiveMatElevContourFlat.wgsl, PrimitiveMatCheckerFlat.wgsl, PrimitiveMatCheckerLit.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs":
    "raw read of PrimitivePhongTexturedColor.wgsl, GTAOGenerate.wgsl, csm_samplePointShadow.wgsl and 4 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/sky-brightness-twilight.spec.mjs":
    "raw read of CubeMapPanorama.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/sky-light-direction.spec.mjs":
    "raw read of SkyAtmosphere.wgsl, ProceduralSkyCubemap.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/sky-shell-star-occlusion.spec.mjs":
    "raw read of SkyAtmosphere.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/solar-glare-star-washout.spec.mjs":
    "raw read of StarField.wgsl, CubeMapPanorama.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/ssr-pass-frame.spec.mjs":
    "raw read of ScreenSpaceReflections.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/star-point-census-live.spec.mjs":
    "raw read of StarField.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/starfield-psf.spec.mjs":
    "raw read of StarField.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/sun-halo-composition.spec.mjs":
    "raw read of SolarHalo.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/water-multi-biome-perf-compile.spec.mjs":
    "raw read of OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/water-underwater-bathymetry-regimes.spec.mjs":
    "raw read of OceanInitialSpectrum.wgsl, OceanSurface.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/weather-map-seam.spec.mjs":
    "raw read of ProceduralClouds.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-ao-lengthcap-units.spec.mjs":
    "raw read of AmbientOcclusionGenerate.wgsl, AmbientOcclusionGenerate_f16.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-ao-sample-pattern-parity.spec.mjs":
    "raw read of AmbientOcclusionGenerate.wgsl, AmbientOcclusionGenerate_f16.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-pick-id-32-bit.spec.mjs":
    "raw read of FeatureIdResolve.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-shadow-receive-contract.spec.mjs":
    "receiver-shader map keys; the GlobeTerrain read goes through readEngineShader",
  "Tools/visual-regression/webgpu-snap-edge-payload.spec.mjs":
    "raw read of ModelPBRComplete.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-snap-payload.spec.mjs":
    "raw read of ModelPBRComplete.wgsl, ClusteredLighting.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/webgpu-sun-bloom-mirror.spec.mjs":
    "raw read of SunBrightPass.wgsl, AdditiveBlend.wgsl; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
  "Tools/visual-regression/wgsl-preprocessor-corpus-equivalence.spec.mjs":
    "walks the whole WGSL corpus by design; the literal names a corpus member",
  "Tools/visual-regression/wgsl-window-coordinates.spec.mjs":
    "raw read of csm_eyeToWindowCoordinates.wgsl, csm_modelToWindowCoordinates.wgsl, csm_metersPerPixel.wgsl and 1 more; not a GlobeTerrain reader, owed to the DX-RAW-SHADER-READERS follow-up",
});
