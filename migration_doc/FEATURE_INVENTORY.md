# Feature Inventory — CesiumJS WebGPU Fork

**Last refreshed:** 2026-05-07
**Purpose:** Exhaustive catalog of every feature in the fork — upstream-inherited, fork-added, work-in-progress, and future/deferred — so that the impact of any change can be scoped against the full feature surface before landing.

**Status taxonomy** (per the user's request — these are the four buckets used throughout):

- **EXISTING** — inherited from upstream CesiumJS and presumed working. WebGPU port may be partial; that gets tracked under WIP.
- **NEW** — fork-specific addition. The WebGPU renderer + abstractions + tooling. Each tagged `(SHIPPED)`, `(SCAFFOLDED)`, or `(EXPERIMENTAL)`.
- **WIP** — partially shipped. Has working code but known gaps. Sourced from `DEFERRED_WORK.md`, `WEBGPU_MIGRATION_BACKLOG.md`, design docs.
- **FUTURE / DEFERRED** — explicitly punted, gated, or research-stage. Sourced from `FUTURE_RESEARCH_2026_05_01.md`, design docs, backlog "future" sections.

**How to use this inventory:**

1. When scoping a change, identify the affected subsystem(s) by name (Globe, 3D Tiles, glTF Models, Classification, Picking, Shadows, Post-process, Performance, Architecture, Build, etc.).
2. Cross-reference all four sections under that subsystem — what exists, what's new, what's WIP, what's future.
3. A change touching globe terrain may also affect 3D Tile classification (shared depth target), CSM cascades (cast list), TAA (motion vectors), pick (depth blit). Use this doc to surface those couplings.
4. If a change implements something currently in WIP or Future, update the matching entry — don't let the inventory go stale.

**Source docs cited (citation tags in parentheses):**

- `(C-R*)` — `migration_doc/DEFERRED_WORK.md`
- `(BACKLOG-§N)` — `migration_doc/WEBGPU_MIGRATION_BACKLOG.md`
- `(R-N)` — `migration_doc/FUTURE_RESEARCH_2026_05_01.md`
- `(Phase-8)` — `migration_doc/PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`
- `(CSM-DESIGN)` — `migration_doc/CSM_DESIGN.md`
- `(TAA-DESIGN)` — `migration_doc/TAA_DESIGN.md`
- `(CELESTIAL §N)` — `migration_doc/CELESTIAL_ATMOSPHERE_DESIGN.md`
- `(WATER §N)` — `migration_doc/WATER_RENDERING_DESIGN.md`
- `(CONTEXT_DECOMPOSITION)` — `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
- `(NEW-*)` — new follow-up entries

---

## Table of Contents

- [A. EXISTING — Upstream Cesium Features Inherited by the Fork](#a-existing--upstream-cesium-features-inherited-by-the-fork)
- [B. NEW — Fork-Specific Additions](#b-new--fork-specific-additions)
- [C. WIP — Work In Progress](#c-wip--work-in-progress)
- [D. FUTURE / DEFERRED](#d-future--deferred)

---

## A. EXISTING — Upstream Cesium Features Inherited by the Fork

These features ship in upstream CesiumJS and are inherited by this fork. Many have full WebGPU ports already; ports that are partial or missing are tracked under WIP/Future below.

### A.1 Globe & Imagery

- EllipsoidTerrainProvider — flat-ellipsoid synthetic terrain (no heights)
- CesiumTerrainProvider — Cesium ion / quantized-mesh terrain server consumer
- ArcGISTiledElevationTerrainProvider — ArcGIS LERC elevation tiles
- GoogleEarthEnterpriseTerrainProvider — Google Earth Enterprise terrain
- VRTheWorldTerrainProvider — VRTheWorld heightmap terrain
- CustomHeightmapTerrainProvider — user-supplied heightmap callback
- Cesium3DTilesTerrainProvider — terrain from a 3D Tiles dataset
- createWorldTerrainAsync / createWorldBathymetryAsync — convenience world-terrain factories
- Terrain payload types — HeightmapTerrainData, QuantizedMeshTerrainData, GoogleEarthEnterpriseTerrainData, Cesium3DTilesTerrainData
- TerrainEncoding / TerrainQuantization / TerrainMesh / TerrainFillMesh — terrain mesh + cracks-fill
- TerrainPicker / incrementallyBuildTerrainPicker — ray-vs-terrain pick acceleration
- sampleTerrain / sampleTerrainMostDetailed / ApproximateTerrainHeights — height sampling
- VerticalExaggeration — global vertical exaggeration transform
- Globe — top-level globe primitive (ocean/water surface controls)
- GlobeSurfaceTileProvider / GlobeSurfaceTile / GlobeSurfaceShaderSet — globe quadtree surface
- GlobeWater — water mask + animated water effect
- GlobeTranslucency / GlobeTranslucencyState / GlobeTranslucencyFramebuffer — translucent globe
- GlobeDepth — global depth buffer (picking, classification, post-processing)
- DepthPlane — far-side depth plane preventing see-through-globe
- Fog — exponential atmospheric fog
- Atmosphere / SkyAtmosphere / GroundAtmosphere — Bruneton scattering on sky and ground
- DynamicAtmosphereLightingType — sun / scene-light / none modes
- SkyBox — six-face cubemap skybox
- SkyBrightness — exposure-based sky brightening
- Sun / SunLight / SunPostProcess — sun billboard + bloom post stage
- Moon / MoonLight — moon billboard + light source
- Stars (CzmBuiltin) — star background rendering
- DynamicEnvironmentMapManager / SpecularEnvironmentCubeMap / BrdfLutGenerator — runtime IBL
- EnvironmentRenderer — driver for sky/sun/moon/atmosphere passes
- CubeMapPanorama / EquirectangularPanorama / Panorama / PanoramaProvider / GoogleStreetViewCubeMapPanoramaProvider — 360 panoramas
- ImageryLayer / ImageryLayerCollection / ImageryProvider — base imagery system
- Imagery providers — ArcGisMapServer, BingMaps, Mapbox/MapboxStyle, OpenStreetMap, GoogleEarthEnterprise / GoogleEarthEnterpriseMaps, Google2D, Azure2D, TileMapService, WebMapService, WebMapTileService, UrlTemplate, SingleTile, Grid, TileCoordinates, Ion, IonImageryProviderFactory, IonWorldImageryStyle
- createWorldImageryAsync — convenience world imagery factory
- Discard policies — DiscardEmptyTileImage, DiscardMissingTileImage, NeverTileDiscard
- ImageryLayerFeatureInfo / GetFeatureInfoFormat — WMS-style feature-info on click
- TimeDynamicImagery — time-driven imagery layer
- ReprojectWebMercatorFS/VS — GPU mercator-to-geographic tile reprojection
- TileImagery / Imagery / ImageryState — per-tile imagery binding state machine
- GeographicProjection / WebMercatorProjection / MapProjection — projections
- GeographicTilingScheme / WebMercatorTilingScheme / TilingScheme — quadtree tiling

### A.2 3D Tiles

- Cesium3DTileset — 3D Tiles 1.x root tileset
- Cesium3DTile / Cesium3DTileContent — tile + content base
- Traversals — Cesium3DTilesetTraversal, BaseTraversal, SkipTraversal, MostDetailedTraversal
- Cesium3DTilesetCache / Cesium3DTilesetStatistics / Cesium3DTilesetHeatmap
- Cesium3DTilePass / Cesium3DTilePassState — render/pick/preload/most-detailed passes
- Cesium3DTileRefine / Cesium3DTileOptimizations / Cesium3DTileOptimizationHint
- 3DTILES_metadata — Cesium3DTilesetMetadata, TilesetMetadata, TileMetadata, GroupMetadata, ContentMetadata
- 3D Tiles Next implicit tiling — Implicit3DTileContent, ImplicitSubtree, ImplicitSubtreeCache, ImplicitSubtreeMetadata, ImplicitTileset, ImplicitTileCoordinates, ImplicitSubdivisionScheme, ImplicitAvailabilityBitstream, ImplicitMetadataView
- B3DM — B3dmParser + B3dmLoader (batched 3D model)
- I3DM — I3dmParser + I3dmLoader (instanced 3D model)
- PNTS — PntsParser + PntsLoader (point cloud)
- CMPT — Composite3DTileContent
- Tileset / Empty / Multiple — Tileset3DTileContent, Empty3DTileContent, Multiple3DTileContent
- Vector tile content — Vector3DTileContent, Vector3DTilePoints/Polygons/Polylines/ClampedPolylines/Geometry/Batch/Primitive
- VectorGltf3DTileContent — vector tile rendered via glTF
- Geometry3DTileContent — pre-tessellated vector geometry tiles
- Gaussian splats — GaussianSplat3DTileContent, GaussianSplatPrimitive, GaussianSplatRenderResources, GaussianSplatSorter, GaussianSplatTextureGenerator
- Voxels — VoxelPrimitive, VoxelProvider, Cesium3DTilesVoxelProvider, VoxelContent, VoxelTraversal
- VoxelShape: VoxelBoxShape, VoxelCylinderShape, VoxelEllipsoidShape, VoxelShapeType
- Voxel internals — Megatexture, SpatialNode, OctreeNode, KeyframeNode, VoxelMetadataOrder, VoxelRenderResources, VoxelCell
- Cesium3DTileStyle / Cesium3DTileStyleEngine / Expression / ConditionsExpression / ExpressionNodeType / StyleExpression — declarative styling
- Cesium3DTileColorBlendMode — HIGHLIGHT/REPLACE/MIX feature color blending
- ClassificationType / ClassificationPrimitive — terrain/3D-Tiles classification
- GroundPrimitive / GroundPolylinePrimitive / OrderedGroundPrimitiveCollection — draped on terrain/tiles
- Batch tables — Cesium3DTileBatchTable, Cesium3DTileFeatureTable, BatchTable, BatchTexture, BatchTableHierarchy
- Cesium3DTileFeature / Cesium3DTilePointFeature — per-feature handles
- Tile bounding volumes — TileBoundingRegion, TileBoundingSphere, TileBoundingS2Cell, TileOrientedBoundingBox, TileBoundingVolume
- MetadataPicking / PickedMetadataInfo / MetadataPickingPipelineStage — metadata-aware picking
- Cesium3DTilesInvalidationFeed / Cesium3DTilesInvalidationFeedAdapter — server-driven invalidation
- TimeDynamicPointCloud — timeline-driven point cloud playback
- createGooglePhotorealistic3DTileset / createOsmBuildingsAsync — convenience factories
- ITwinData / ITwinPlatform — Bentley iTwin platform integration
- I3S provider stack — I3SDataProvider, I3SLayer, I3SNode, I3SSublayer, I3SGeometry, I3SFeature, I3SField, I3SStatistics, I3SSymbology, I3SDecoder
- TilePathEncoding / TilePathResolver — implicit URL encodings

### A.3 glTF Models

- Model / Model3DTileContent — runtime model (3D Tiles Next architecture)
- glTF loaders — GltfLoader, GltfJsonLoader, GltfBufferViewLoader, GltfImageLoader, GltfTextureLoader, GltfIndexBufferLoader, GltfVertexBufferLoader
- GltfDracoLoader — KHR_draco_mesh_compression
- GltfSpzLoader — KHR_spz Gaussian splat compression
- GltfStructuralMetadataLoader / parseStructuralMetadata / parseFeatureMetadataLegacy — EXT_structural_metadata + legacy EXT_feature_metadata
- GltfPipeline (forEach/addBuffer/addDefaults/parseGlb/removeUnusedElements/updateVersion/moveTechniquesToExtension) — in-engine glTF preprocessor (1.0 → 2.0 upgrades)
- NGA_gpm — GltfGpmLoader, GltfGpmLocal, GltfMeshPrimitiveGpmLoader, MeshPrimitiveGpmLocal
- GPM uncertainty types — AnchorPointDirect/Indirect, CorrelationGroup, Spdcf, PpeMetadata, PpeSource, PpeTexture
- ModelSceneGraph / ModelRuntimeNode / ModelRuntimePrimitive / ModelComponents / ModelReader — runtime scene graph
- Animation — ModelAnimation, ModelAnimationCollection, ModelAnimationChannel, ModelAnimationLoop, ModelAnimationState
- Articulation — ModelArticulation, ModelArticulationStage, ArticulationStageType (AGI_articulations)
- Skinning — ModelSkin, ModelSkinData, SkinningPipelineStage
- MorphTargetsPipelineStage — morph target weights
- InstancingPipelineStage / LegacyInstancingStageVS — EXT_mesh_gpu_instancing
- FeatureIdPipelineStage / SelectedFeatureIdPipelineStage — EXT_mesh_features
- ImageBasedLightingPipelineStage / ImageBasedLighting / DynamicEnvironmentMapManager — IBL on PBR
- MaterialPipelineStage / LightingModel / LightingPipelineStage / AlphaPipelineStage / AlphaMode — PBR material + lighting
- CustomShader API — CustomShader, CustomShaderMode, CustomShaderTranslucencyMode, CustomShaderPipelineStage
- MetadataPipelineStage / StructuralMetadata / PropertyTable/Texture/Attribute — metadata sampling in shaders
- ClassificationPipelineStage / ClassificationModelDrawCommand — model-as-classifier path
- PickingPipelineStage / pickModel — per-feature picking
- CPUStylingPipelineStage / PointCloudStylingPipelineStage — CPU-side styling
- WireframePipelineStage / WireframeIndexGenerator — debug wireframe overlay
- PrimitiveOutlineGenerator / PrimitiveOutlinePipelineStage — CESIUM_primitive_outline
- ModelClippingPlanesPipelineStage / ModelClippingPolygonsPipelineStage — model clipping
- ModelColorPipelineStage / ModelSilhouettePipelineStage / ModelSplitterPipelineStage
- GeometryPipelineStage / DequantizationPipelineStage — geometry stage + KHR_mesh_quantization
- AtmospherePipelineStage — atmosphere applied to model fragments
- VerticalExaggerationPipelineStage — RTE vertical exaggeration
- SceneMode2DPipelineStage — Columbus / 2D positions
- BatchTexturePipelineStage — feature-table styling textures
- TextureManager / TextureUniform / UniformType / VaryingType — runtime shader-resource bindings
- ModelMaterialInfo / ModelLightingOptions / ModelAlphaOptions — material parameter records
- ModelStatistics / ModelFeature / ModelFeatureTable — runtime introspection
- KHR material extensions parsed by GltfLoader — KHR_materials_unlit, _pbrSpecularGlossiness, _clearcoat, _emissive_strength, _ior, _specular, _anisotropy, _iridescence, _sheen, _transmission, _volume, _variants, _diffuse_transmission
- KHR texture extensions — KHR_texture_transform, KHR_texture_basisu, KHR_texture_procedurals
- Geometry compression — KHR_mesh_quantization, KHR_draco_mesh_compression, EXT_meshopt_compression
- 3D Tiles Next metadata — EXT_mesh_features, EXT_instance_features, EXT_structural_metadata
- Cesium-specific — CESIUM_RTC, CESIUM_primitive_outline
- AGI_articulations — articulation rigs

### A.4 Geometry Primitives

- Primitive / PrimitiveCollection / PrimitiveState / PrimitivePipeline — base primitive system
- GroundPrimitive / GroundPolylinePrimitive / ClassificationPrimitive — draped/classifying primitives
- GeoJsonPrimitive (upstream PR#13505) — public exported Scene primitive that loads a GeoJSON `FeatureCollection` (Point/LineString/Polygon, incl. holes + MultiPolygon) via `GeoJsonPrimitive.fromGeoJson` and funnels it into the three `Buffer{Point,Polyline,Polygon}Collection`s (§A.5). Its WebGPU parity therefore RIDES ENTIRELY on the Buffer*Collection FeatureRenderers — it has no renderer of its own. The loader's vertex/hole/triangle count → collection-capacity allocation math (`GeoJsonPrimitive.js:454–467` → L108–118) is not yet pixel-verified on WebGPU vs WebGL (no Playwright probe); the alpha/blendOption/boundingVolume Buffer* gaps tracked in DEFERRED_WORK (NEW-BUFFERPRIMITIVE-COLOR-ALPHA / -BLEND-OPTION / -BOUNDING-VOLUME) apply transitively
- GeometryInstance / GeometryInstanceAttribute / GeometryAttribute / GeometryAttributes / Geometry / GeometryFactory / GeometryType / GeometryOffsetAttribute
- GeometryPipeline — geometry transforms (tangent space, encoding, IDL splitting)
- Per-instance attributes — Color, Show, DistanceDisplayCondition, Offset
- BoxGeometry / BoxOutlineGeometry
- SphereGeometry / SphereOutlineGeometry
- EllipsoidGeometry / EllipsoidOutlineGeometry / EllipsoidPrimitive
- CircleGeometry / CircleOutlineGeometry
- EllipseGeometry / EllipseOutlineGeometry
- CylinderGeometry / CylinderOutlineGeometry
- PlaneGeometry / PlaneOutlineGeometry
- PolygonGeometry / PolygonOutlineGeometry / PolygonHierarchy / PolygonPipeline
- CoplanarPolygonGeometry / CoplanarPolygonOutlineGeometry
- RectangleGeometry / RectangleOutlineGeometry
- CorridorGeometry / CorridorOutlineGeometry / CornerType
- WallGeometry / WallOutlineGeometry
- PolylineGeometry / SimplePolylineGeometry / GroundPolylineGeometry / PolylinePipeline
- PolylineVolumeGeometry / PolylineVolumeOutlineGeometry
- FrustumGeometry / FrustumOutlineGeometry
- Debug primitives — DebugCameraPrimitive, DebugModelMatrixPrimitive, DebugAppearance, DebugInspector
- createTangentSpaceDebugPrimitive — tangent/normal/bitangent visualization
- createElevationBandMaterial — elevation banded material factory

### A.5 Collections

- BillboardCollection / Billboard / BillboardTexture / BillboardLoadState / TextureAtlas / SDFSettings — billboards w/ atlas + signed-distance-field text
- LabelCollection / Label / LabelStyle / VerticalOrigin / HorizontalOrigin — text labels
- PointPrimitiveCollection / PointPrimitive — quad-screen-space points
- PolylineCollection / Polyline — polyline collection (separate from PolylineGeometry)
- CloudCollection / CumulusCloud / CloudType — procedural clouds
- PrimitiveCollection — generic primitive grouping
- OrderedGroundPrimitiveCollection — draped primitives ordered by Z
- EntityCluster — billboard/label/point clustering
- BufferPointCollection / BufferPolylineCollection / BufferPolygonCollection / BufferPrimitiveCollection — GPU-instanced buffer-based collections
- renderBufferPointCollection / renderBufferPolylineCollection / renderBufferPolygonCollection — render helpers
- VoxelBoundsCollection — voxel grid bounds visualization

### A.6 Entity / DataSource API

- Entity / EntityCollection / EntityCluster / EntityView / CompositeEntityCollection — declarative entity model
- Properties — Constant, Sampled, TimeIntervalCollection, Composite, Callback, Reference, PropertyArray, PropertyBag
- Position properties — Constant, Sampled, TimeIntervalCollection, Composite, Callback, Scaled, PropertyArray
- Derived — VelocityVectorProperty, VelocityOrientationProperty
- Material properties — Color, Checkerboard, Grid, Image, Stripe, Composite, PolylineArrow, PolylineDash, PolylineGlow, PolylineOutline
- Specialized — NodeTransformationProperty, TerrainOffsetProperty, Rotation
- Graphics types — Billboard, Label, Point, Model, Path, Polyline, Polygon, Rectangle, Ellipse, Ellipsoid, Box, Cylinder, Corridor, Wall, PolylineVolume, Plane, Cesium3DTileset
- Visualizers — Billboard, Label, Point (bulk fast-path via `BulkPointVisualizer` §B.1, Batch 300), Model, Path, Polyline, Geometry, Cesium3DTileset
- GeometryUpdater / GeometryUpdaterSet / GroundGeometryUpdater / DynamicGeometryUpdater / DynamicGeometryBatch
- Static batches — StaticGeometryColor, StaticGeometryPerMaterial, StaticGroundGeometryColor, StaticGroundGeometryPerMaterial, StaticGroundPolylinePerMaterial, StaticOutlineGeometry
- DataSourceDisplay / DataSourceCollection / DataSource / DataSourceClock — datasource framework
- CzmlDataSource — CZML format
- GeoJsonDataSource — GeoJSON / TopoJSON
- KmlDataSource / KmlCamera / KmlLookAt / KmlTour / KmlTourFlyTo / KmlTourWait / exportKml — KML / KMZ + tours + export
- GpxDataSource — GPX track loader
- CustomDataSource — generic user-defined data source
- BoundingSphereState — async bounding-sphere result
- createMaterialPropertyDescriptor / createPropertyDescriptor / createRawPropertyDescriptor — property descriptor factories

### A.7 Particles & Effects

- ParticleSystem / Particle / ParticleEmitter / ParticleBurst — particle system core
- Emitter shapes — BoxEmitter, CircleEmitter, ConeEmitter, SphereEmitter
- CloudCollection / CumulusCloud / CloudNoiseFS — procedural clouds (3D noise + SDF billboards)
- PostProcessStage / PostProcessStageCollection / PostProcessStageComposite / PostProcessStageLibrary / PostProcessStageSampleMode / PostProcessStageTextureCache — post-process framework
- Bloom / BloomComposite / BrightPass — bloom
- AmbientOcclusionGenerate / AmbientOcclusionModulate — SSAO
- DepthOfField — depth-of-field
- FXAA / FXAA3_11 — FXAA antialiasing
- EdgeDetection / Silhouette — edge / silhouette stage
- Brightness / ContrastBias / BlackAndWhite / NightVision / LensFlare — color grading stages
- Tonemapping — Aces, Filmic, ModifiedReinhard, Reinhard, PbrNeutral
- Utility — AdditiveBlend, PassThrough, PassThroughDepth, DepthView, DepthViewPacked
- PointCloudEyeDomeLighting — EDL for point clouds
- SunPostProcess — sun-flare post stage
- AutoExposure — automatic exposure adjustment
- InvertClassification — invert-classification post effect
- AtmosphericConditions — globe atmosphere parameter container

### A.8 Camera & Navigation

- Camera — main camera class (position, direction, up, frustum)
- CameraEventAggregator / CameraEventType / KeyboardEventModifier — input event coalescing
- CameraFlightPath — animated flyTo paths
- CameraHelpers / CameraInternals — camera math helpers
- ScreenSpaceCameraController — default mouse/touch controller
- DeviceOrientationCameraController — gyroscope-driven controller
- ScreenSpaceEventHandler / ScreenSpaceEventType — pointer/touch event abstraction
- Frustums — PerspectiveFrustum, PerspectiveOffCenterFrustum, OrthographicFrustum, OrthographicOffCenterFrustum, CullingVolume, FrustumCommands
- MapMode2D / SceneMode / SceneTransitioner — 2D/Columbus/3D modes + transitions. WebGPU morph (transition) animation audited 2026-06-07 (webgpu-morph-review): globe terrain morph fixed at WebGL parity (Batch 216 — see §B-resolved); remaining gaps tracked in `DEFERRED_WORK.md` "Scene-mode morph pillar" (exaggeration-in-morph/CV skirt walls, PolylineCollection 2D/CV, billboard/label/point morph audit, TAA previousViewProjection at the mode flip, mix-jitter, WebMercator instanceof, model projectTo2D).
- TrackingReferenceFrame / ReferenceFrame — tracked-entity camera frames
- computeFlyToLocationForRectangle — flyTo helper for rectangles
- HeadingPitchRange / HeadingPitchRoll — orientation primitives
- Splitter / SplitDirection — split-screen render direction

### A.9 Picking & Selection

- Picking — main pick API (pick, drillPick, drillPickAsync, pickPosition, pickFromRay, pickFromRayMostDetailed, sampleHeight, clampToHeight, drillPickFromRay)
- PickFramebuffer / PickDepth / PickDepthFramebuffer / PickingRayHelpers — pick framebuffer
- PickedMetadataInfo / MetadataPicking / MetadataPickingPipelineStage — metadata pick path
- pickModel — Model picking entry
- PickingPipelineStage — model-pipeline stage emitting pick IDs
- TerrainPicker / incrementallyBuildTerrainPicker — terrain ray picking
- OcclusionCulling — occlusion-based culling support

### A.10 Time & Animation

- Astronomical time + planetary motion — JulianDate, GregorianDate, TimeStandard, TimeConstants, LeapSecond, EarthOrientationParameters/Sample, Iau2006XysData/Sample, IauOrientationAxes/Parameters, Iau2000Orientation, Simon1994PlanetaryPositions
- Iso8601 — ISO 8601 helpers
- Clock / ClockRange / ClockStep / ClockViewModel — simulation clock
- TimeInterval / TimeIntervalCollection — time intervals
- VideoSynchronizer — sync HTML5 video to scene clock
- Splines — LinearSpline, HermiteSpline, CatmullRomSpline, QuaternionSpline, MorphWeightSpline, SteppedSpline, ConstantSpline
- Interpolation — HermitePolynomialApproximation, LagrangePolynomialApproximation, LinearApproximation, InterpolationAlgorithm, InterpolationType, ExtrapolationType
- EasingFunction — Tween easings
- TweenCollection — runtime tween system

### A.11 Coordinate Systems

- Cartesian2 / Cartesian3 / Cartesian4 — vectors
- Cartographic — lon/lat/height
- Spherical — spherical coordinates
- Stereographic — polar stereographic
- Matrix2 / Matrix3 / Matrix4 — matrices
- Quaternion — quaternion rotations
- TranslationRotationScale — TRS transform record
- Ellipsoid / EllipsoidGeodesic / EllipsoidRhumbLine / EllipsoidTangentPlane / EllipsoidalOccluder — ellipsoid + great-circle / rhumb / tangent helpers
- Transforms — Earth-fixed/inertial, ENU, NED, NEU, body-fixed, fixedFrameToHeadingPitchRoll
- GeographicProjection / WebMercatorProjection / MapProjection — projections
- ReferenceFrame — INERTIAL / FIXED enum
- EncodedCartesian3 — RTE high/low encoding for 64-bit precision
- ApproximateTerrainHeights / scaleToGeodeticSurface / VerticalExaggeration / sampleTerrain / sampleTerrainMostDetailed — terrain-aware coords
- HeadingPitchRange / HeadingPitchRoll — orientation primitives
- NearFarScalar / DistanceDisplayCondition — distance-driven scalar / visibility

### A.12 Math & Geometry Utilities

- Math (CesiumMath) — math constants + helpers
- CubicRealPolynomial / QuadraticRealPolynomial / QuarticRealPolynomial / TridiagonalSystemSolver — solvers
- Bounding volumes — AxisAlignedBoundingBox, OrientedBoundingBox, BoundingSphere, BoundingRectangle, Interval, Plane, Ray, Rectangle, RectangleCollisionChecker
- Intersect / IntersectionTests / Intersections2D — intersection tests
- Visibility — visibility enum (NONE/PARTIAL/FULL)
- Occluder / EllipsoidalOccluder / QuadtreeOccluders — horizon/occluder culling
- PolygonPipeline / PolylinePipeline / PolygonHierarchy / Tipsify — triangulation, subdivision, vertex cache opt
- Geometry construction libs — EllipseGeometryLibrary, CorridorGeometryLibrary, CylinderGeometryLibrary, RectangleGeometryLibrary, WallGeometryLibrary, PolylineVolumeGeometryLibrary, CoplanarPolygonGeometryLibrary
- HeightmapTessellator / HeightmapEncoding — heightmap mesh generation
- WireframeIndexGenerator — line-list index generation
- AttributeCompression — quantization helpers
- Array / geometric utilities — arrayRemoveDuplicates, barycentricCoordinates, binarySearch, pointInsideTriangle, mergeSort, subdivideArray
- HilbertOrder / MortonOrder / S2Cell — space-filling curves + S2 cell math
- Data structures — DoubleEndedPriorityQueue, DoublyLinkedList, Heap, Queue, ManagedArray, AssociativeArray
- Geometry typing — VertexFormat, IndexDatatype, ComponentDatatype, PrimitiveType, WindingOrder, ArcType, GeometryType, GeometryOffsetAttribute, Packable, PackableForInterpolation, Spline
- decodeVectorPolylinePositions — vector-tile polyline decoding

### A.13 Materials

- Material — Fabric-style material system
- Appearances — MaterialAppearance, EllipsoidSurfaceAppearance, PerInstanceColorAppearance, PolylineColorAppearance, PolylineMaterialAppearance, DebugAppearance, Appearance
- ShadowVolumeAppearance — appearance for ground/classification shadow volumes
- MaterialUniformBuffer / MaterialSortIdAllocator / MaterialHelpers — material runtime support
- Built-in material classes — Color, Image, DiffuseMap, AlphaMap, SpecularMap, EmissionMap, BumpMap, NormalMap, Grid, Stripe, Checkerboard, Dot, Water, RimLighting, Fade, PolylineArrow, PolylineDash, PolylineGlow, PolylineOutline, ElevationContour, ElevationRamp, SlopeRamp, AspectRamp, ElevationBand, WaterMask
- CustomShader API — CustomShader, CustomShaderMode, CustomShaderTranslucencyMode, UniformType, VaryingType, TextureUniform, TextureManager
- MaterialStageFS / CustomShaderStageVS+FS — model pipeline material stages
- createElevationBandMaterial — elevation-band ramp factory
- getClipAndStyleCode / getClippingFunction — clipping shader code generation

### A.14 Shadows & Lighting

- ShadowMap / ShadowMapShader / ShadowMapComputations / ShadowMode — shadow map system (directional + point + spot)
- ShadowVolumeAppearance / ShadowVolumeFS / PolylineShadowVolume — shadow volumes for ground/classification
- Light / SunLight / MoonLight / DirectionalLight / LightTypes — scene light types
- ImageBasedLighting / SpecularEnvironmentCubeMap / DynamicEnvironmentMapManager / BrdfLutGenerator — runtime IBL system
- ConvolveSpecularMap / ComputeIrradiance / ComputeRadianceMap — IBL convolution shaders
- Atmosphere / AtmosphericConditions / SkyAtmosphere / GroundAtmosphere / DynamicAtmosphereLightingType — atmospheric lighting
- Fog — distance fog
- Sun / Moon / SkyBox / SkyBrightness / Stars — celestial backdrop + brightness
- EdgeFramebuffer / EdgeDetectionPipelineStage / EdgeVisibilityPipelineStage — model edge detection/visibility

### A.15 Performance / Rendering Infrastructure

- Scene / SceneRenderer / SceneFramebuffer / SceneTransforms / SceneUtilities / SceneDebug / SceneOctree — scene + main render loop
- View / ViewportExecutor / ViewportQuad / FramebufferOrchestrator — view + framebuffer driver
- GlobeDepth / DepthPlane / SceneFramebuffer — depth/framebuffer attachments
- OIT / TranslucentTileClassification / CommandSorter / DerivedCommand / FrustumCommands — OIT, multi-frustum command sorting
- PassState / Pass / DrawCommand / ClearCommand / ComputeCommand / ComputeEngine — pass + command primitives
- RenderState — RenderState, freezeRenderState, BlendingState, BlendEquation, BlendFunction, BlendOption, DepthFunction, StencilFunction, StencilOperation, StencilConstants, CullFace
- RenderLayer / RenderLayerCollection — layered render organization
- Network — RenderScheduler, RequestScheduler, Request, RequestType, RequestState, RequestErrorEvent, TrustedServers
- ResourceCache — ResourceCache, ResourceCacheKey, ResourceCacheStatistics, ResourceLoader, ResourceLoaderState
- Resource — fetch wrapper
- JobScheduler / JobType — multi-frame work scheduling
- TaskProcessor — Web Worker task dispatch
- FrameRateMonitor / PerformanceDisplay / Cesium3DTilesetHeatmap — perf overlays
- Workers — RendererWorker, geometry create-functions (Box/Sphere/Ellipsoid/Cylinder/Polygon/Polyline/Wall/etc.), combineGeometry, decodeDraco, decodeI3S, decodeGoogleEarthEnterprisePacket, transcodeKTX2, gaussianSplatSorter/TextureGenerator, upsampleQuantizedTerrainMesh, createVerticesFromHeightmap/QuantizedTerrainMesh/Cesium3DTilesTerrain/GoogleEarthEnterpriseBuffer, transferTypedArrayTest, incrementallyBuildTerrainPicker, createVectorTileGeometries/Points/Polygons/Polylines/ClampedPolylines
- KTX2 / Draco / glTF pipeline workers — loadKTX2, KTX2Transcoder, DracoLoader, parseGlb
- WebGL2 Renderer — Context, Buffer, VertexArray/VertexArrayFacade, Texture, Texture3D, CubeMap/Face, TextureAtlas/Cache, Sampler, Framebuffer/Multisample/FramebufferManager, Renderbuffer/RenderbufferFormat, ShaderProgram/ShaderBuilder/ShaderSource/ShaderStruct/ShaderFunction/ShaderCache/ShaderDestination, RenderState, AutomaticUniforms, UniformState, PixelDatatype/PixelFormat, MipmapHint, ContextLimits, demodernizeShader, createUniform, createUniformArray, Sync, SharedContext, SharedResourcePool
- CreditDisplay / Credit — attribution rendering
- TexturePacker — runtime texture packer
- FrameState — per-frame state record
- DebugInspector — debug command exposure

### A.16 Widgets & UI

- Widget (engine) — minimal canvas widget
- Viewer (widgets) — full-featured viewer composing all widgets
- Animation — clock playback widget (play/pause/speed)
- BaseLayerPicker — imagery + terrain provider picker
- Cesium3DTilesInspector — 3D tileset debug inspector
- CesiumInspector — globe / scene debug inspector
- VoxelInspector — voxel primitive inspector
- FullscreenButton — fullscreen toggle
- Geocoder — text-to-location search
- HomeButton — fly-to-home control
- InfoBox — selected entity info panel
- NavigationHelpButton — navigation help overlay
- PerformanceWatchdog — FPS warning overlay
- ProjectionPicker — 2D/3D/Columbus mode picker
- SceneModePicker — scene mode selector
- SelectionIndicator — selected entity reticle
- Timeline — scrubbable timeline
- VRButton — WebVR/WebXR toggle
- I3SBuildingSceneLayerExplorer — I3S BSL tree browser
- Knockout VM utilities — ClockViewModel, ToggleButtonViewModel, SvgPathBindingHandler, Command, createCommand, subscribeAndEvaluate
- Geocoder service implementations — BingMapsGeocoderService, CartographicGeocoderService, GoogleGeocoderService, IonGeocoderService, OpenCageGeocoderService, PeliasGeocoderService, IonGeocodeProviderType
- Performance services — FpsOverlay, PerformanceTracker, SnapshotModeService, VisualPerformanceTargetService
- WorkerSceneHost / WorkerSceneProtocol — offscreen-canvas worker scene host
- PinBuilder — programmatic SVG pin generation
- Ion / IonResource — Cesium ion auth + asset loading

---

## B. NEW — Fork-Specific Additions

Added by this fork (the WebGPU migration). Each tagged with status: **(SHIPPED)** = active and consumed; **(SCAFFOLDED)** = infrastructure landed awaiting follow-up; **(EXPERIMENTAL)** = behind a flag or off-by-default.

### B.1 Architecture & Abstractions

- GraphicsContext (Renderer/GraphicsContext.ts) — abstract base unifying WebGL+WebGPU; both `Context.js` and `WebGPUContext.ts` extend it (SHIPPED)
- ContextFactory — single async `createContext(canvas, opts)`; resolves AUTO + fallback (SHIPPED)
- ContextRegistry — singleton tracking every live context by ID; supports split-screen + multi-view (SHIPPED)
- RendererType enum — WEBGL / WEBGPU / WEBGPU_COMPAT / AUTO; `setGlobalDefaultRenderer` + `getDefaultRendererType` (SHIPPED)
- setGlobalDefaultRenderer() runtime hook — variant entry barrels set backend default at module-init (SHIPPED)
- FeatureRendererKey enum — 48 numeric slots for O(1) array-index FR lookups (highest `CONTACT_SHADOWS:48`, `COUNT:49`; 48 of these are wired via `context.registerFeatureRenderer(...)` in `WebGPUFeatureRenderers.ts`) (SHIPPED)
- getFeatureRenderer(key) API on GraphicsContext — replaces `if (context.isWebGPU)` branching in scene code (SHIPPED)
- WebGPUFeatureRenderers.ts — central registration entry: `registerWebGPUFeatureRenderers(context)` wires all active FRs (SHIPPED)
- Renderable structural interface — duck-typed `update(frameState)` contract for scene-graph members (SHIPPED)
- PickTarget / PickKind / PickResult — discriminated union for new non-breaking `getPickResult(color)` API (SHIPPED)
- RenderCommand (Scene/RenderCommand.js) — backend-agnostic command abstraction (SHIPPED)
- WebGPUDrawCommand — TS counterpart of upstream `DrawCommand.js` for WGPU pipelines (SHIPPED)
- WebGPUComputeCommand — counterpart of upstream `ComputeCommand.js` for compute dispatches (SHIPPED)
- WebGPUDerivedCommand — centralized pipeline-descriptor-variant factory. Core rewritten + wired Batch 248 (NEW-DERIVEDCOMMAND-VARIANT-FACTORY): `deriveDescriptor(base, kind, options)` derives PICK / VELOCITY / LOG_DEPTH / DEPTH_ONLY variant descriptors by descriptor mutation + module/entry-point swap under variant-keyed names (`${base.name}::${kind}`), enforcing the scene-FB invariants centrally (MSAA bake from `sceneFBSampleCount`, target-shape re-stamp via `makeSceneFBTargets`, single-sample pick/velocity targets); `resolveVariantPipeline` is the shared sync→async→fallback resolution state machine; `deriveCommand` clones+stamps command-level variants. The dispatch half (`selectCommandVariant` + `cmd.derivedCommands.*`) was already live. First adopter: billboard PICK (replaced `buildBillboardPickDescriptor`; color/velocity resolution delegates too). HDR/SHADOW kinds + absorption of the remaining per-renderer variant surgery are follow-ups; first big consumer is the NEW-COLLECTIONS-LOG-DEPTH epic (SHIPPED — core)
- Renderer-wide logarithmic depth (NEW-COLLECTIONS-LOG-DEPTH / NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION approach A) — LIVE since Batch 251 (`_logDepthWriteEnabled` defaults TRUE; one-line kill switch). Producers in the shared log space: globe terrain (B183), depth plane (B249), lit Phong primitives (B188), Billboard/Label-SDF/Point/Polyline+4 materials/Cloud + ComputeInstance (B250), Model PBR — glTF/3D-Tiles/instanced incl. velocity entries (B251), the full Mat*/PBR/Basic geometry-primitive shader family — 19 Mat*Lit + 19 Mat*Flat + 2 Basic + 2 PBR, the bulk of geometry primitives (B264, NEW-PRIMITIVE-MAT-LOG-DEPTH; FLAT camera UB gained the matching logDepth tail, `FLAT_CAMERA_BYTES` 160→176), the experimental Buffer* collection family — BufferPoint/Polyline/Polygon (B265, NEW-BUFFER-LOG-DEPTH; the old `WebGPUBufferPrimitiveRenderer` stub map's 1-arg/no-op `csm_*LogDepth` replaced with the canonical 2-arg chunks, near/far/factor in the shared CameraUniforms `.w` pad lanes, `preprocessShader` gains a `defines` arg + `(name,defines)` cache key), the ray-cast EllipsoidPrimitive (B266, NEW-ELLIPSOIDPRIM-LOG-DEPTH; camera UB grew `projection`+`logDepth` 240→320 B, FS recovers eye-distance via projection→`csm_writeLogDepth`; end-to-end PIXEL-verified B269 after BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE fixed — bounding-box geometry replaced the FOV-less screen quad + `_computedModelMatrix` hoisted above the FR branch), and the Vector3DTile classifier family — Polygon/Polyline/ClampedPolyline (B266, NEW-CLASSIFIER-LOG-DEPTH; the `less-equal` Polygon+Polyline write per-vertex log z so the volume tests against the log globe, the `depthCompare:always` ClampedPolyline reverses the log encode in its FS `windowToEyeCoordinates` before inverse-projecting — mirrors GroundPrimitive; e2e pixel-verify blocked on absent `.vctr` test data, see DEFERRED_WORK). Consumers: GroundPrimitive + Vector3DTileClampedPolyline classifier log reverse (encode near/far), VS_THREE_POINT billboard globe-depth compare (space-aware), CPU pickPosition (pre-existing useLogDepth branch now matched by the GPU encode). Far-range depth ties resolve at sub-meter precision — the Batch-229 bug-2 case (billboard 1000 m above ground at 220 km, ~0.03 hyperbolic quanta) renders, verified + kill-switch-reproduced by probe-collections-far-camera.mjs. **Batch 267 final sweep:** ALL geometry/opaque producers are now in the shared log space — the full z-fight gate (probe-logdepth-zfight + probe-buffer-logdepth-zfight + probe-ellipsoidprim-logdepth) and all 11 standing gates are green, the kill switch flips every producer together (ON→OFF→ON flip legs clean, 0 validation errors), and `Moon.wgsl`'s intentional near-omitting encode is documented (safe — parked at the far plane). The ONLY residual hyperbolic producers are the two standalone non-geometry families — `WebGPUPointCloudRenderer` (PNTS/EDL) + `WebGPUGaussianSplatRenderer` (grep-confirmed no frag_depth/LOG_DEPTH) — tracked NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT; off-by-default depth CONSUMERS (post-process readers, HiZ, GroundPolyline/model recon) tracked NEW-LOG-DEPTH-REMAINING-CONSUMERS (§C / DEFERRED_WORK). (SHIPPED — geometry/opaque renderer-wide)
- WebGPUPassState — unified PassState wrapper for WGPU (SHIPPED)
- Co-located `.d.ts` interop pattern — sibling `.d.ts` overrides JS inference for cross-module TS calls (SHIPPED)
- Renderer/Context.d.ts — published TS surface for the JS WebGL Context class (SHIPPED)
- OffscreenContextSupport.ts — abstraction allowing GraphicsContext to work with `OffscreenCanvas` (SCAFFOLDED)
- WebGPUDevicePool — single-device-per-adapter pool reused across multiple contexts on same GPU (SHIPPED)
- WebGPUContextDeviceLoss — device-loss host adapter, listens + dispatches to subscribers (SHIPPED)
- WebGPUDeviceLossRecovery — re-acquires adapter+device, rebuilds caches on lost-device event (SHIPPED)
- WebGPUDeviceInvalidationBus — pub/sub bus letting subsystems clear caches on device invalidation (SHIPPED)
- WebGPUResourceCacheRegistry — registry of cache-clear callbacks invoked on device loss (SHIPPED)
- WebGPUFrameStatistics — per-frame draw/dispatch/buffer counters (SHIPPED)
- WebGPUParityManager — orchestrates feature-parity flags between WebGL and WebGPU code paths (SHIPPED)
- BulkPointVisualizer (DataSources/BulkPointVisualizer.js) — backend-agnostic Entity→flat-buffer bulk fast-path (Phase 10 of the Large Dynamic Objects roadmap; Batch 300, NEW-ENTITY-BULK-FASTPATH). Drop-in replacement for `PointVisualizer` in `DataSourceDisplay.defaultVisualizersCallback`. Classifies each `point` entity into a STATIC lane (every consumed PointGraphics property is `ConstantProperty`, position is a `ConstantPositionProperty`, no `availability`, height-reference resolves to NONE, clustering off) vs a DYNAMIC lane. Static entities are written ONCE into a flat-buffer `PointPrimitiveCollection` (`id = entity`, so `scene.pick` returns the Entity) and then SKIPPED entirely by the per-frame update loop — eliminating the dominant legacy cost of re-reading ~10 `Property.getValueOrDefault` values per entity every frame. Dynamic / clamped / time-windowed entities (and ALL entities while clustering is enabled) transparently delegate to a wrapped `PointVisualizer` so their behaviour is byte-identical to the legacy path. `EntityCollection.collectionChanged.changed` re-classifies an entity in place on a definition change. Measured (`probe-entity-bulk.mjs`): at 20k static point entities the per-frame `DataSourceDisplay.update()` cost is ~0.01–0.02 ms (flat, count-independent) vs the per-entity path's ~15–17 ms — an **800×–1400× per-frame speedup** on BOTH WebGL and WebGPU; all 20k route through the static lane (staticCount=20000, fallbackCount=0); 20k points render on both backends; `scene.pick` returns the originating Entity on WebGL. (SHIPPED — points. Billboard/Label bulk lanes + CZML/GeoJSON ingest hints + GPU keyframe kernel for `SampledPositionProperty` entities are tracked in DEFERRED_WORK under NEW-ENTITY-BULK-FASTPATH-BILLBOARD-LABEL / NEW-ENTITY-BULK-CZML-HINT / NEW-ENTITY-GPU-KEYFRAME-KERNEL.)
- EntityCluster GPU bin/count (Phase 10; Batch 301, NEW-ENTITYCLUSTER-GPU) — backend-agnostic GPU acceleration of `EntityCluster`'s screen-space proximity declutter. **`Shaders/WebGPU/Compute/EntityClusterGridGPU.wgsl`** + **`Renderer/WebGPU/WebGPUEntityClusterDispatcher.ts`** (the `ENTITY_CLUSTER_GPU` FeatureRenderer, slot 50) run a single O(N) compute pass that hashes every visible screen-space point into a uniform grid (cell edge = `pixelRange`) and accumulates per-cell occupancy + representative + per-point cell-id, replacing the per-frame `new KDBush(...)` build (O(N log N)) that doesn't scale to 50k+ markers. **`DataSources/EntityClusterGPU.js`** (consulted ONLY via `context.getFeatureRenderer(ENTITY_CLUSTER_GPU)` — no `isWebGPU` branch) runs the sequential representative-selection + 3×3-neighbour merge on the CPU but over the reduced non-empty-cell set; `EntityCluster.js`'s declutter consumes the (one-frame-stale, async-readback) grid. WebGL2 keeps the unchanged CPU KDBush path. **Batch 308 (NEW-ENTITYCLUSTER-GPU-MERGE parity half):** the CPU merge in `clusterWithGrid` previously absorbed the WHOLE unclaimed 3×3 cell neighbourhood unconditionally (a 3×3 block spans 3·pixelRange → over-merged points up to ~3× the merge radius apart, so the WebGPU rep count was systematically below the WebGL KDBush path). The absorb is now GATED on screen-space pixel distance to the seed — a neighbour cell merges only when its representative is within `pixelRange` of the seed's representative, and within an absorbed cell only the members within `pixelRange` of the seed are pulled in (mirroring the CPU bbox range query) — plus a per-POINT greedy claim-on-accept (matching the CPU `point.clustered` semantics, no double-count). Measured (`probe-entitycluster-gpu.mjs`): 2000 dense point entities cluster on both backends, the GPU dispatcher runs (10 dispatches), zoom-out merges (near→far 49→3 on WebGPU), cross-backend parity ratio **1.02** (WebGPU 49 reps vs WebGL 48; was 0.42 before the gate), 0 errors. (SHIPPED — GPU bin/count + parity-tightened CPU merge. The fully-GPU parallel merge — union-find over the grid, no readback — is still tracked in DEFERRED_WORK under NEW-ENTITYCLUSTER-GPU-MERGE.)

### B.2 WebGPU Pipeline Infrastructure

- WebGPUShaderModuleCache — per-device dedupe keyed by `(sourceId, defines)` Uint32 (SHIPPED)
- WebGPUShaderPreprocessor — pure `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` directive evaluator (SHIPPED)
- WebGPUShaderDefines — `ShaderDefine` bitmask + `ShaderSourceId` registry (33 source IDs; highest `ELLIPSOID_PRIMITIVE:33`) (SHIPPED)
- WebGPURenderPipelineCache — central LRU cache of GPU render pipelines keyed by descriptor hash (SHIPPED)
- WebGPUComputePipelineCache — sibling cache for compute pipelines (SHIPPED)
- AsyncResourceMonitor — per-context inflight-resource event bus that wakes the Scene's `requestRenderMode` hibernation when async pipeline / image-decode / compute-pipeline work resolves; supports `foreground` vs `background` priority (warm-on-suspicion via `cache.warm()`) and multi-context `ownerSceneIds` filtering. Closes BUG-WEBGPU-PIPELINE-ASYNC class (SHIPPED — NEW-WEBGPU-PIPELINE-READY-SIGNAL)
- AsyncResourceTelemetry — perf-side subscriber that aggregates per-`AsyncResourceKind` p50/p95/p99 latency, throughput, and failure rates over a rolling window; surfaced via `WebGPUPerformanceManager.getAsyncResourceStats()` and the diagnostics dump (SHIPPED — NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER)
- WebGPURenderBundleManager — record/replay GPU render bundles for static command sets (SHIPPED)
- RenderStateToPipelineVariant — maps Cesium RenderState → unique pipeline variant key (SHIPPED)
- WebGPUPipelineDescriptorBuilder — fluent builder constructing GPURenderPipelineDescriptors (SHIPPED)
- WebGPUBindGroupCache — dedup of `createBindGroup()` calls across frames; bounded LRU + optional age eviction so identity-churn can't grow it unboundedly (Batch 293) (SHIPPED)
- WebGPUGlobeBindGroupCache — per-tile bind-group cache for the globe surface renderer: groups 0/1/2 keyed on bound-resource identity (group 0 = ring-page identity only since the dynamic-offset conversion, group 1 = 16 imagery view ids, group 2 = waterMask/ocean/material ids) with 600-frame age eviction + debug-pragma'd counters (incl. per-group `byGroup` breakdown) via `CesiumDebug.globeBindGroups()`; steady-state tile bind-group creations 68/frame → 0 (SHIPPED — NEW-GLOBE-BINDGROUP-CACHE, Batch 241)
- Globe group-0 dynamic-offset UBO — camera+tile UB bind group built once over the ring page (offset 0) with `hasDynamicOffset: true` on both bindings; the per-draw slice offset is supplied via `setBindGroup(0, bg0, [cameraOffset, tileOffset])`, so group-0 bind groups survive sustained camera motion (cache keys on page identity, not byte offset) — group-0 creations during 120 panning frames: ~15 → 0, cache entries capped at ~pageCount (SHIPPED — NEW-GLOBE-DYNAMIC-OFFSET-UBO, Batch 292)
- Globe pass dispatch — inline per-frame render bundle REMOVED (measured ~0.3-0.4 ms net-negative + uncacheable due to baked-in rotating dynamic offsets); `executeGlobeDispatch` dispatches opaque terrain straight through `executeBatch` (SHIPPED — NEW-GLOBE-RENDERBUNDLE-CACHE dropped-as-net-negative, Batch 292)
- WebGPUBindGroupLayoutHelpers — typed helpers used by 86 of 88 BGL creation sites (SHIPPED)
- WebGPUBindGroupReflection — runtime introspection of WGSL bind-group layouts (SHIPPED)
- WebGPUUniformGroupManager — tier-3 caching for shared per-pass uniform groups (SHIPPED)
- WebGPUEffectsBindGroup — single bind group consolidating CSM/edges/fog/point lights — Batch 122 reduced 8 → 4 BGs (SHIPPED)
- WebGPUAutoUniforms — auto-bound camera/frame state UBO slots (SHIPPED)
- WebGPUStorageBufferPool — recycled storage buffer allocator for per-frame transient SSBOs (SHIPPED)
- WebGPURingBufferAllocator — sub-allocator for transient uniform/storage data with frame-level reset (SHIPPED)
- WebGPUBuffer / WebGPUBufferMapper — mappable buffer wrapper + read/write helpers (SHIPPED)
- WebGPUTexture / Texture3D / TextureArray — typed wrappers around GPUTexture variants (SHIPPED)
- WebGPUTextureAtlas — packed atlas backing billboard/label rendering (SHIPPED)
- WebGPUTextureUtilities — shared format-conversion + view helpers (SHIPPED)
- WebGPUMipmapGenerator — compute-shader mipmap generator for arbitrary 2D textures (SHIPPED)
- WebGPUVideoTextureManager — VideoFrame-backed external textures for video imagery (ORPHANED — never instantiated; CesiumJS routes video imagery through `WebGPUImageUpload.copyExternalImageToTexture` per-frame instead. Audit C.6, Batch 159)
- WebGPUImageUpload — async image-bitmap → texture upload queue (SHIPPED)
- WebGPUVertexArrayFacade — VAO-shaped wrapper exposing upstream-VertexArray semantics (SHIPPED)
- WebGPUResidentInstanceBuffer — resident CPU instance array + GPU vertex buffer + stable `_index→slot` map with full-vs-partial sync predicate, dirty-range coalescing (gap ≤ 4 slots; >40% changed-fraction whole-buffer fallback), and slot-aligned velocity prev mirror; O(changed) partial `writeBuffer` for sparse-dynamic collections (Batch 229 — NEW-RESIDENT-INSTANCE-BUFFER-MGR; consumed by WebGPUBillboardRenderer (Batch 229) + WebGPUPointPrimitiveRenderer + WebGPULabelRenderer (Batch 232 — NEW-PARTIAL-WRITE-WIRE-BPL complete; the label wiring deliberately full-rebuilds on ANY glyph dirty because glyph dirty granularity is unsound for per-slot writes — settled label frames still upload nothing)) (SHIPPED)
- WebGPUSampler / FramebufferManager / MultisampleFramebuffer — resource lifetime wrappers (SHIPPED)
- WebGPURenderTarget / SceneFramebuffer — render-target abstraction + scene-FB owner (SHIPPED)
- WebGPUHDRRenderTarget — rg11b10ufloat HDR target with readback ring (SHIPPED)
- WebGPUF16Utils — pack/unpack helpers for `shader-f16` feature (SHIPPED)
- WebGPUSubgroupUtils — subgroup-feature wrapper for compute dispatches (SHIPPED)
- WebGPUSync — fence-style buffer-readback synchronization helper (SHIPPED)
- WebGPUResourceManager — resource lifetime registry tied to context destruction (SHIPPED)
- WebGPURTEAssertions — debug assertions enforcing RTE 64-bit precision contract (SHIPPED)
- WebGPUContextLimitsInit — adapter-limits probe + opt-in to higher tiers (SHIPPED)
- WebGPUFeatureFlags — `DESIRED_FEATURES` registry + `requiredFeatures` builder for `requestDevice` (SHIPPED)
- WebGPUIndirectDrawManager — indirect-draw buffer manager for GPU-driven rendering paths (SCAFFOLDED)
- WGSLBuiltins / WGSLShaderBuilder / WGSLShaderPreprocessor — shader source assembly + chunk inlining (SHIPPED)
- chunks/CsmBuiltins.js — 96 WGSL helper functions ported from GLSL `czm_*` (one barrel `import csm_* from './functions/csm_*.js'` per helper) (SHIPPED)
- chunks/structs — shared WGSL UBO struct chunks (CameraUniforms, EffectsUniforms, LightUniforms, LightingUniforms, ModelUniforms) (SHIPPED)

### B.3 WebGPU Feature Renderers

- WebGPUGlobeSurfaceRenderer — full quadtree terrain renderer (SHIPPED)
- WebGPUGlobeSurface helpers — Shaders/Layouts/Pipelines/Textures/TileBuffers/CameraUB/TileUB/Wireframe (Batch 145-153 decomposition into 9 helpers) (SHIPPED)
- Globe default-limit fallback layout — per-device imagery slot count (16 full / 1 reduced via `ShaderDefine.GLOBE_IMAGERY_REDUCED`) so the globe terrain pipeline layout fits the WebGPU spec floor `maxSampledTexturesPerShaderStage = 16` (SwiftShader CI, compat/low-end adapters); multi-layer tiles multi-pass at 1 layer/blend-pass on reduced devices; full 16-slot single-pass layout unchanged on capable adapters. Gates: probe-globe-default-limits.mjs + variant-smoke `--webgpu-adapter swiftshader` (SHIPPED — NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT, Batch 246)
- WebGPUGlobeDepth — packed depth target + readback (SHIPPED)
- WebGPUGlobeTranslucencyState — translucent-globe depth/pass orchestration (SHIPPED)
- WebGPUDepthPlane — horizon depth fill (SHIPPED)
- WebGPUModelRenderer — full glTF Model render path with PBR + KHR extensions (SHIPPED)
- WebGPUModelPipelineCache — per-model pipeline cache (SHIPPED)
- WebGPUModelInstancing — EXT_mesh_gpu_instancing draw-instanced path (SHIPPED — Batch 245 fixed the v1.140-merge regression where ANY instanced model crashed the WebGPU render loop in `VertexArray` bind (`context._vertexAttribDivisors` uninitialized on WebGPUContext; see DEFERRED_WORK `NEW-WEBGPU-INSTANCED-VA-DIVISORS` ✅). Required gate: `probe-pickmodel-instanced.mjs` — both instancing paths render at WebGL-parity pixel counts AND WebGPU CPU `pickModel` picks instanced models at exact positions. Same batch restored upstream's `!hasNormals → UNLIT` lighting selection in `extractMaterialInfo` — no-NORMAL primitives rendered black on WebGPU)
- WebGPUModelMorphTargets — morph-target weighted blending in vertex stage (SHIPPED)
- WebGPUModelFeatureId — FEATURE_ID_n attribute + texture lookup for batch-table styling (SHIPPED)
- WebGPUBillboardRenderer — Billboard collection on WGPU (SHIPPED in 3D as of Batch 218 — renders with WebGL parity at close camera; bug 2 far-surface depth + 2D/CV no-render remain — see DEFERRED_WORK "WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER". Batch 229: instance upload moved onto WebGPUResidentInstanceBuffer — static collections upload 0 B/frame, sparse edits partial-write only changed slots; far-surface depth root-caused to missing collection log-depth — RESOLVED Batches 249-251: renderer-wide log depth live, far-camera markers verified at 220 km via probe-collections-far-camera.mjs. Phase 3 Slices 2-3 (2026-06-13): renders at the correct projected position in elevated 2D/CV; MORPH BLEND verified working — `_actualPosition` is CPU-morph-blended by `SceneTransforms.computeActualEllipsoidPosition`, so no WGSL dual-stream path is needed (probe-collections-morph-blend.mjs). Slice 2b (2026-06-13, NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH): `noDepthTest` pipeline variant + `OrthographicOffCenterFrustum` depth-range cache invalidation → COLUMBUS_VIEW coplanar billboard now renders (0 → 37 px). SCENE2D coplanar billboard RESOLVED Batch 269 (NEW-SCENE2D-GLOBE-PASS-OVERWRITE): 0 → 37 px — the globe-pass non-3D `boundingVolume: undefined` (Batch 167) exploded the 2D frustum split 1→9 and the nearer-frustum opaque globe overwrote the far-frustum marker; fixed by supplying the 2D-projected bounding sphere + `cull=false` in non-3D, byte-matching WebGL's 1-frustum split. SIZE PARITY RESOLVED Batch 275 (NEW-BILLBOARD-SIZE-PARITY): billboards rendered ≈¼ WebGL area in ALL modes because `imageRect` fell back to the whole atlas `(0,0,1,1)` instead of the per-image sub-rect — fixed by packing `bb.computeTextureCoordinates()` like WebGL; ratio 0.23 → 1.00 (3D/2D/CV) via probe-collections-2dcv-morph.mjs. HiDPI: `highResMultiplier` now = `frameState.pixelRatio` so DPR>1 doesn't shrink billboards.)
- WebGPULabelRenderer — SDF text label collection (SHIPPED in 3D as of Batch 219 — glyph-atlas/BV fix via `BillboardCollection.prepareForFeatureRenderer`; bug 2 + 2D/CV remain — see DEFERRED_WORK WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER. Phase 3 Slices 2-3 (2026-06-13): labels project + morph-blend correctly in 2D/CV/morph (CPU `_actualPosition` blend, probe-collections-morph-blend.mjs). Slice 2b (2026-06-13, NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH): `noDepthTest` SDF pipeline variant for settled 2D/CV. SCENE2D coplanar labels RESOLVED Batch 269 (NEW-SCENE2D-GLOBE-PASS-OVERWRITE): 0 → 139 px (same globe-pass 2D-frustum-split fix as billboard). SIZE + LAYOUT PARITY RESOLVED Batch 275 (NEW-BILLBOARD-SIZE-PARITY): glyphs were ¼-area (same whole-atlas `imageRect` fallback) AND stacked at one spot (renderer omitted each glyph's `_translate` advance) — fixed by packing `computeTextureCoordinates()` + `pixelOffset + _translate`; label now FULL-size, bbox byte-matches WebGL 80×24, ratio 0.26 → ≈1.0. Residual: small label anchor offset (P3, baseline/horizontal-origin nuance, not size).)
- WebGPUPolylineRenderer — Polyline collection with arrow/dash/glow/outline materials (SHIPPED — 3D + 2D + Columbus View + Morph. Phase 3 Slice 4 / Batch 3 landed the scene-mode path 2026-06-13: segment + pick builders encode `SceneTransforms.computeActualEllipsoidPosition` per endpoint (CPU morph lerp), full-frustum log-depth encode, and a `noDepthTest` pipeline variant for the settled 2D/CV co-planar-with-map case — WGSL byte-identical, SCENE3D unchanged. Verified `probe-collections-2dcv-morph.mjs` polyline 2D 0.96 / CV 0.89 / 3D 0.96 vs WebGL. See DEFERRED_WORK MORPH-POLYLINE-COLLECTION-2D for the deferred IDL-split + mid-morph-velocity follow-ups)
- WebGPUPointPrimitiveRenderer — PointPrimitive collection (SHIPPED in 3D as of Batch 219 — bug-1 BV + bug-3 clip-z fix; bug 2 far-surface depth resolved via log-depth. Phase 3 Slices 2-3 (2026-06-13): projects + morph-blends in 2D/CV. Slice 2b (2026-06-13, NEW-COLLECTIONS-2DCV-COPLANAR-DEPTH): `noDepthTest` pipeline variant → COLUMBUS_VIEW coplanar point now renders (0 → 231 px). SCENE2D coplanar points RESOLVED Batch 269 (NEW-SCENE2D-GLOBE-PASS-OVERWRITE): 0 → 250 px (same globe-pass 2D-frustum-split fix as billboard))
- WebGPUCloudRenderer — CloudCollection procedural-noise cloud impostors; quad sizing in METERS matching upstream `scale` semantics since Batch 253 (NEW-CLOUD-SCALE-METERS — was screen-pixels, full-screen white-out at far cameras once log depth let clouds win the depth test). FS is a simplified 2D-noise impostor, NOT WebGL's volumetric raymarch — appearance gap tracked NEW-CLOUD-IMPOSTOR-FS-PARITY in DEFERRED_WORK (SHIPPED)
- WebGPUBufferPoint/Polyline/Polygon/PrimitiveRenderer — vector-tile collections via storage buffers (SHIPPED — the Polygon/Polyline/Point WGSL `#import` resolution + 1-arg depth helpers + camera `.xyz` + MSAA sample-count were actually broken until Batch 180; modern glTF-vector `sample-us-states` now renders WebGL↔WebGPU, verified via `probe-bufferpolygon-vector-tile.mjs`). **Dynamic geometry fixed B270 (NEW-UPSTREAM-13465-BUFFERPOINT-STALENESS, port of upstream #13465):** `setPosition`/`setPositions`/`setHoles`/`setTriangles` now set the primitive `_dirty` flag so a position change AFTER first render re-encodes the moved primitive — previously the repack (gated on `_dirty`) skipped it and the GPU kept the stale position on BOTH backends. Verified `probe-buffer-point-update.mjs` (cyan point moves >= 80px within 2 frames vs a static control, WebGPU + WebGL pixel-matched) + new `BufferPointCollectionSpec` unit test. Side note: a single-point WebGL `gl.POINTS` collection can drop its lone vertex on sub-data update (NEW-BUFFERPOINT-WEBGL-SINGLE-VERTEX-DROPOUT, pre-existing, >= 2 points fine)
- WebGPUEllipsoidPrimitiveRenderer / WebGPUEllipsoidRenderer — analytic ray-cast ellipsoid primitive. Renders a radii-scaled bounding-box geometry (B269, matching WebGL EllipsoidVS — replaced the old FOV-less screen quad) whose eye-space surface gives the FS correct per-pixel rays. Log depth (NEW-ELLIPSOIDPRIM-LOG-DEPTH, B266) now end-to-end PIXEL-verified: the FS recovers the hit's clip-space w via `camera.projection` and writes log frag_depth so the shell composes against the log globe. BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE ✅ RESOLVED (B269): the Scene now computes `_computedModelMatrix` BEFORE the feature-renderer branch (Scene Logic Extractor) so the WebGPU path sees a valid invertible transform; the renderer reads `_computedModelMatrix` instead of the raw `modelMatrix`. Verified `probe-ellipsoidprim-logdepth.mjs` (18280 green px, ON≈OFF 1.000, far-camera no bleed-through, 0 validation errors). BUG-ELLIPSOIDPRIM-WEBGPU-TRANSLUCENT-DOUBLE-BLEND ✅ RESOLVED (B276): a translucent (alpha<1) shell blended ~1.5× too opaque because the command carried no `boundingVolume`/`executeInClosestFrustum` and so binned into both frustum slices (drew twice); the renderer now mirrors WebGL's `boundingVolume` + `executeInClosestFrustum` + `Pass.TRANSLUCENT` wiring and the box uses `cullMode:"back"` (one face/pixel) — `probe-ellipsoidprim-translucent.mjs` translucent/opaque ratio 0.748→0.499, WebGL hoist re-verified. (SHIPPED)
- WebGPUSunRenderer / WebGPUMoon — Sun + Moon billboards (in WebGPUEnvironmentRenderer) (SHIPPED)
- WebGPUSkyAtmosphereRenderer — sky atmosphere ray-march (SHIPPED)
- Ground atmosphere (WebGPU) — shaded in-`GlobeTerrain.wgsl` via `csm_computeGroundAtmosphereScattering` + `WebGPUAtmosphereLUT` transmittance/inscatter tier, params in the globe camera/tile UBs (matches WebGL's in-GlobeFS integration) (SHIPPED — Session 65 Batch 9). The earlier separate-pass `WebGPUGroundAtmosphereRenderer` + `Environment/GroundAtmosphere.wgsl` (Nishita ray-marcher) was a parity misread whose output UB nothing ever bound; DELETED Batch 239 (reference impl in git history at `05b6da60d1`; `FeatureRendererKey.GROUND_ATMOSPHERE` slot 29 retired in place)
- WebGPUCubeMapPanoramaRenderer — equirect → cubemap projection for skybox (SHIPPED)
- WebGPUEnvironmentRenderer — orchestrates Sun/Moon/SkyAtmosphere ordering (SHIPPED)
- WebGPUShadowMapRenderer — single-source shadow map cast/receive (SHIPPED)
- WebGPUCSMRenderer — CSM Slice 1+2a; RTE-precise per-cascade VPs + slope-scaled bias; soft-shadow 3x3 PCF box kernel (Batch 289). **Batch 298:** the cascade light-eye was on the WRONG side (`eye = center − lightDir·2r` → looked back toward the sun, mirrored the cast depth); fixed to `eye = center + lightDir·2r` (`forward = −lightDir`). The globe-terrain GROUND now casts+receives CSM shadows correctly (was lit-everywhere). PCF VERIFIED softening both the primitive self-shadow AND the globe ground cast shadow; `probe-csm-cast-dispatch.mjs` + 5/6 `probe-csm-soft-shadow.mjs` sub-checks PASS, 0 device errors. Debug hooks added for the trace: `debugCascadeMatrices` / `debugReadCascadeDepth` / `debugScanCascadeLayer` (+ `COPY_SRC` on the cascade texture). See NEW-CSM-SOFT-SHADOW-PCF / NEW-CSM-GLOBE-RECEIVE-PROJECTION-MISS / NEW-CSM-CASCADE-GROUND-FIT. **Batch 306:** ground-clamped the cascade fit (`_rayEllipsoidEntryDistance` ray/ellipsoid solve → `computeVisibleGroundFar` clamps the split distribution + `_computeFrustumCornersWorldSpace(groundClamp=true)` collapses corners onto the globe) so the near cascade stops ballooning to the horizon for low top-down cameras (cascade-0 ~12→0.18 m/texel). `probe-csm-soft-shadow.mjs` now 6/6 PASS (edge parity 50×→1.24×) — **CSM soft-shadows fully COMPLETE.** (SHIPPED)
- WebGPUCSMCastPass — dedicated cast pass for all 7 shadow cast variants (SHIPPED; Batch 296 FIXED the cast no-dispatch; Batch 298 FIXED the receive-side projection miss via the cascade light-eye sign — globe ground now receives cast shadows; Batch 306 ground-clamped the cascade fit → crisp WebGL-parity edge). (SHIPPED cast + receive + edge parity — CSM soft-shadows COMPLETE)
- WebGPUGroundPrimitiveRenderer — depth-sample classifier (post-ADR-2026-04-28). FLAT-COLOR shipped in ALL scene modes (SCENE3D + SCENE2D + Columbus View, Batch 170; MORPHING Batch 164). **Flat textured materials (Color/Stripe/Checkerboard/Grid) + planar/spherical UV SHIPPED Batch 185** (`88b111e49c`): the `packExtents` wrapper-chain walk at `WebGPUGroundPrimitiveRenderer.js:313` fixed the actual root cause — a 1-hop-too-deep inner-`_primitive` lookup wrote `materialMeta.x = 0`, flipping `dsColorFS` to the flat-color fast path (it was NOT a globe depth-precision blocker). Verified via `probe-classifier-textured-materials` (Stripe varR 0.01→1.74, Checkerboard varR→1.43, Grid renders cells+lines, 0 device errors). Residual: far-corner reconstruction-precision degradation (`NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`, §C.4 — Checkerboard degrades toward the far corner, Stripe clean; legitimately log-depth-gated). (SHIPPED flat textured all-modes; far-corner precision WIP)
- WebGPUGroundPolylineRenderer — terrain-clamped polyline classifier; Arrow/Stripe/Image materials (SHIPPED)
- WebGPUVector3DTilePrimitiveRenderer — extruded polygon classification. SCENE3D SHIPPED; SCENE2D + Columbus View implemented Batch 178 (CPU-reprojected ENU buffer, e2e-visual UNVERIFIED for lack of `.vctr` test data); MORPHING still gated. Log depth B266 (NEW-CLASSIFIER-LOG-DEPTH; VS per-vertex log-z so the volume's `less-equal` test composes with the log globe, shared color/pick/stencil/velocity). (SHIPPED 3D; 2D/CV WIP-unverified)
- WebGPUVector3DTilePolylinesRenderer — non-clamped 3D polyline classification. SCENE3D + MORPHING shipped; SCENE2D/CV still gated (NEW-CLASSIFIER-2D-CV-MORPH). Log depth B266 (NEW-CLASSIFIER-LOG-DEPTH; VS log-z for the `less-equal` Pass.TRANSLUCENT test, color+velocity). (SHIPPED 3D)
- WebGPUVector3DTileClampedPolylinesRenderer — terrain-clamped polyline classifier on Vector3DTiles. SCENE3D + MORPHING shipped; SCENE2D/CV still gated (NEW-CLASSIFIER-2D-CV-MORPH). Log depth B266 (NEW-CLASSIFIER-LOG-DEPTH; `depthCompare:always` so no VS write — FS `windowToEyeCoordinates` reverses the log encode before inverse-projecting the sampled scene depth). (SHIPPED 3D)
- WebGPUPointCloudRenderer — pnts/3D-tiles point cloud rendering (SHIPPED)
- WebGPUPointCloudEyeDomeLighting — EDL post-effect for point clouds (SHIPPED)
- WebGPUPointCloudLODProcessor — LOD selection + DecoupledScan deterministic path (SHIPPED)
- WebGPUVoxelRenderer — VoxelPrimitive ray-march. NOTE (triage Batch 172): code-read found this is a PLACEHOLDER gradient ray-marcher (no provider / megatexture / octree traversal wired); `VoxelPrimitive.update` returns early so `_traversal` is never built. Real voxel-data rendering + per-cell pick (C-R9-VOXEL-CELL-PICK) remain genuinely open. **The upstream PR#13517 default voxel shader (default-shader for common metadata types) is UNREACHABLE on WebGPU** — because `VoxelPrimitive.update()` short-circuits when the VOXEL_PRIMITIVE FR is registered it never reaches the `processVoxelProperties` / `buildVoxelDrawCommands` / `buildVoxelCustomShader` path, the renderer is a hardcoded RGB-density ray-marcher on a 4×4×4 gradient placeholder texture, and there is no WGSL transpilation of the CustomShader GLSL. The PR#13517 default shader is one piece of a feature whose entire WebGPU data path is unimplemented (XL scaffold; tracked §C.5 C-R9-VOXEL-CELL-PICK). (SCAFFOLDED — not real voxel data; PR#13517 default-shader / CustomShader / metadata-typed path unreachable)
- WebGPUGaussianSplatRenderer — Gaussian splat rendering (3DGS); back-to-front depth sort consumed via a sorted-index storage buffer (the VS reads `splats[sortedIndices[ii]]`) + logarithmic frag_depth producer (Batch 288, NEW-SPLAT-SORT-CONSUME-INDEXES / NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT splat half). WIP boundary: single-pack command occluded by opaque geometry in multi-frustum scenes — NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE (SHIPPED, with tracked multi-frustum follow-up)
- WebGPUInvertClassification — inverted-stencil classification mask (SHIPPED)
- WebGPUClippingPlaneCollection — uniform-buffer plane list, optional native `clip-distances` path (SHIPPED)
- WebGPUClippingPolygonCollection — SDF-atlas based polygon clipping (SHIPPED)
- WebGPUClipDistancePrecompute — precomputes distance-to-plane uniform packing (SHIPPED)
- WebGPUImageBasedLighting — diffuse + specular IBL lookup for PBR (SHIPPED; Batch 287 completed the split-sum BRDF LUT consumption + world-fixed reference-frame reflection — see NEW-MODEL-IBL-BRDF-LUT / NEW-MODEL-IBL-REFERENCE-FRAME, now 1:1 with WebGL ImageBasedLightingStageFS::textureIBL)
- WebGPUDynamicEnvironmentMapManager — per-position dynamic env map probes (SHIPPED)
- WebGPUBrdfLutGenerator — one-time BRDF integration LUT (compute-driven) (SHIPPED)
- Forward+ clustered lighting — `WebGPUClusterBoundsRenderer` + `WebGPUClusterAssignRenderer` (16×9×24 grid compute passes) + `WebGPUClusteredLightingDispatcher` (per-frame orchestration) + `ClusteredLighting.wgsl` FS chunk consumed by ModelPBRComplete (group-3 effects bindings 18-22) AND all 19 primitive `Mat*Lit` material shaders (group-2 or group-3 via the `__CL_GROUP__` token substitution, Batches 154-155). Multi-light point/spot/directional per-pixel diffuse+specular beyond the single sun. Resolves FEAT-SURVEY-40. (SHIPPED Batches 153-155; Model PBR + all Lit Mat consumers live. Remaining: Phong primitive shaders + a Sandcastle demo.)
- WebGPUIBLPipeline — irradiance + radiance prefilter compute orchestration (SHIPPED)
- WebGPUImageryReprojection — reprojects WMS/WMTS imagery to web-mercator at upload (SHIPPED)
- WebGPUWeatherRenderer — weather particle system orchestrator (SCAFFOLDED)
- WebGPUComputeInstanceRenderer — feature-agnostic GPU-resident compute-instance system (Phase 3 of the Large Dynamic Objects roadmap; Batch 230 orbital MVP generalized in Batch 231, NEW-COMPUTE-INSTANCE-SYSTEM). Per-instance param floats upload once to a storage buffer; a USER-SUPPLIED WGSL kernel (`csm_computeInstance(index, time)`, composed with `ComputeInstanceScaffold.wgsl` — engine owns bindings/entry/bounds-check/RTE split; composed modules cached per source string per device) repopulates a 64-B instance-record buffer each frame; instanced draw vertex-pulls `instances[instance_index]` — positions never leave the GPU, per-frame CPU upload is one time scalar + camera UB. Scene API: `ComputeInstanceCollection` (FR key 49 `COMPUTE_INSTANCE_COLLECTION`, renamed in place from the Batch-230 orbital key; `_consumeDirtyState` discipline). The engine has ZERO orbital knowledge — the circular-orbit kernel + element layout + LEO/MEO/GEO generation are Sandcastle/probe content. Batch 235 (NEW-COMPUTE-INSTANCE-BV-TAA): user-contract `boundingSphere` option/property threads onto the command (`boundingVolume` + `cull`; positions are GPU-resident so the bound is the caller's promise), and TAA motion vectors via a two-buffer prev-position ping-pong (kernel writes `instanceBuffers[pingPongIndex]`; the other slot binds as `prevInstances` for the `vertexVelocityMain`/`fragmentVelocityMain` entry points; `cmd.velocityCommand` attaches only when `frameState.taaEnabled` — lazy allocation keeps the TAA-off path zero-cost). Batch 277 (NEW-ORBITAL-J2-KERNEL): `ComputeInstanceScaffold.wgsl` gained df64 (two-float / double-single, ~46-bit) arithmetic helpers (`csm_df64_add`/`_mul`/`_sin`/`_cos`/`_reducePi`/`_split` via Dekker/Knuth EFTs) + a `positionLow` field on `ComputeInstanceOut` + `csm_emitDF64` packer, so kernels can OPT INTO an exact RTE high/low split (fixes the "low part always 0" limitation; f32 kernels that set only `out.position` stay back-compatible). The Sandcastle orbital kernel upgraded from circular to secular-J2 mean-element + Kepler + ECI→ECEF GMST, using df64 for the precision-sensitive mean-anomaly/GMST accumulation. Batch 278 (NEW-ORBITAL-SGP4-KERNEL): the headline accuracy feature — near-earth **SGP4** (Vallado, WGS-72) as a SECOND demo/probe kernel on the same scaffold (the engine stays orbital-agnostic). CPU FP64 pre-conditioning (`sgp4init`: de-Kozai + all time-independent secular/drag/periodic constants, deep-space flag) packs 42 lanes with the secular rates as df64 pairs; the GPU df64 kernel does ONLY the per-frame SGP4 update (secular advance + long/short-period periodics + Kepler + TEME→ECEF GMST). Near-earth only (period ≥ 225 min flagged + skipped; SDP4 deferred). Real-TLE Sandcastle "WebGPU SGP4 Satellites" (ISS/NOAA-19/Starlink shells by inclination; GPS/GEO skipped). Verified via `probe-orbital-catalog.mjs` (regression gate, BV supplied) + `probe-compute-instance-generic.mjs` (non-orbital Lissajous kernel + BV/TAA-on/TAA-off assertions) + `probe-orbital-j2.mjs` (GPU df64 kernel vs JS FP64 reference: 15 m LEO error over 30 days, 145× better than an f32 control) + `probe-orbital-sgp4.mjs` (GPU SGP4 vs python-sgp4 2.25 reference vectors: worst **55 m** over a full day, deep-space flagged/skipped, demo render+move via the real collection); Sandcastle "WebGPU Orbital Catalog" + "WebGPU SGP4 Satellites". Batch 279 (NEW-ORBITAL-GPU-PICKING): GPU pick pass for GPU-resident instances — positions live only in the kernel-written buffer (no CPU hit-test), so picking RASTERIZES the same instanced quads with a per-instance pick color (`vertexPickMain`/`fragmentPickMain` + a `pickColors` storage binding @2; `prevInstances` moved to @3) into the single-attachment pick FBO; the renderer lazily allocates one `context.createPickId({collection, instanceIndex, primitive}, "compute-instance")` per instance + a dedicated pick BGL/pipeline + `pickOnly` command on the first `frameState.passes.pick` frame, so `scene.pick` over an instance returns the engine's domain-agnostic `{collection, instanceIndex}` record (the demo maps index → satellite). New `allowPicking` option/property (default true). Verified `probe-compute-instance-pick.mjs` (each of 3 instances picks its own index, empty→undefined, 0 errors; pick-Y convention verified identical to PointPrimitiveCollection). Batch 280 (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK): the system now RENDERS on WebGL2 (which has no compute). `ComputeInstanceCollection` gained an optional `cpuKernel` `(out, index, timeSeconds, params) => void` (used ONLY on the non-compute backend; WebGPU ignores it); a new backend-agnostic `Renderer/WebGLComputeInstanceRenderer.js` runs it over all instances on the main thread each frame, RTE-splits the positions with `EncodedCartesian3` (the same AGI split `czm_translateRelativeToEye` reconstructs against — so positions match the WebGPU leg), packs 11-float records into a DYNAMIC_DRAW VBO, and issues one instanced quad draw (`ComputeInstanceWebGL{VS,FS}.glsl`, RTE + log depth via the CZM automatic uniforms, same anti-aliased dot + quad expansion as `ComputeInstanceRender.wgsl`). The WebGL FR is lazily registered on the WebGL `Context` under FR key 49 (scene file reaches it via `getFeatureRenderer`, never importing a backend renderer); without a `cpuKernel` the collection still renders nothing on WebGL2. The orbital Sandcastle ships `cpuKernel = orbitalCpuKernel` (secular-J2 on the CPU); `Tools/visual-regression/j2-cpu-kernel.mjs` factors the shared FP64 propagator. Verified `probe-compute-instance-webgl2.mjs` (WebGL renders 6418 px + moves 179% + centroid within 0.42 px of WebGPU + 0 errors on both backends). Batch 281 (NEW-ORBITAL-DEVICE-LIMITS-PROBE): VALIDATED the system scales to a literal **1,000,000**-instance catalog within WebGPU device limits — NO multi-SSBO split is required at 1M. At the orbital FPI=10 the three SSBOs at 1M are records=61 MB (64 B/rec), params=38 MB, pick=15 MB; all clear even the spec-DEFAULT 128 MB `maxStorageBufferBindingSize` (⌊128 MB/64 B⌋≈2.10M records/binding, ~2× headroom). The FIRST ceiling the system hits as N grows is `maxComputeWorkgroupsPerDimension` — the scaffold dispatch is `ceil(N/64)` on X only, so the single-dim dispatch caps at 65,535·64 = **4,194,240 instances** (1M needs just 15,625 workgroups); `@workgroup_size(64)` ≪ the 256-default `maxComputeInvocationsPerWorkgroup`. Past ~4.19M the dispatch must tile X (chunked dispatch + base-index uniform) before any storage split; past ~2.10M on a 128-MB-binding adapter the records SSBO would need the elements/positions split — both are documented next steps, neither needed for 1M. Verified `probe-orbital-1m.mjs` (own device with explicit maxed limits, composes the shipped scaffold + a golden-angle-shell kernel + the shipped render WGSL, dispatches 15,625 WGs @ 1M and renders the instanced quads → 21,064 cyan px, 0 validation errors; backs off to a VRAM-budgeted count on a small adapter and still computes the theoretical 1M headroom). Batch 283 (Phase-5 demo polish): extended the WebGL2 CPU-kernel fallback to the SECOND headline demo — "WebGPU SGP4 Satellites" now ships a `cpuKernel` (the time-dependent SGP4 update over the same 42 packed param lanes; inline in the demo, factored into `Tools/visual-regression/sgp4-cpu-kernel.mjs`, matching the validated FP64 reference to < 1 m over a full day), and BOTH compute-instance demos now read `?renderer=webgpu|webgl` (default webgpu) so a user can exercise the WebGL2 fallback straight from the demo URL. New gate `probe-compute-instance-webgl2-demos.mjs` drives the real standalone Sandcastle URLs on both backends (compositor canvas screenshot + frame-differencing, since Sandcastle holds the viewer in a local const): per (demo, renderer) asserts renders + moves + correct-backend-armed + 0 errors (all 4 legs PASS). Batch 286 (NEW-COMPUTE-INSTANCE-PICKPOSITION): `scene.pickPosition` over a compute-instance now returns THAT instance's world position on BOTH backends (Phase-6 picking parity). `Scene/Picking.js` object-picks at the cursor first and, when the front record is a compute-instance (duck-typed `getInstanceWorldPosition` + `instanceIndex`, gated on a context frame-stamp so non-compute-instance scenes are untouched), returns the instance position directly instead of unprojecting scene depth (a sub-pixel dot's center never coincides with the sampled depth, and on WebGPU the translucent dots don't write depth). WebGPU `getWebGPUInstanceWorldPosition` reads the picked 64-B record slot back via `copyBufferToBuffer` + `mapAsync` (instance buffers gained `COPY_SRC`) and sums positionHigh+positionLow, bridged by the same one-frame-stale per-index sync cache as `PickDepth.getDepth`. WebGL2 re-runs the `cpuKernel` for the picked index (synchronous), and gained a NEW per-instance WebGL pick path (`ComputeInstanceWebGLPick{VS,FS}.glsl` + one `createPickId` per instance on a dedicated pick VAO) — previously WebGL compute-instances were unpickable. Verified `probe-compute-instance-pickposition.mjs` (3 instances, both backends, pickPosition within 50 m — measured 0.00 m, empty→undefined, sync contract, 0 errors). Batch 309 (NEW-SAMPLED-POSITION-KERNEL): the SECOND kernel family on this substrate (the orbital propagators were the first) — `Scene/SampledPositionKernel.js`, a REUSABLE engine artifact (unlike the demo-owned orbital kernels, because the layout is pure mechanics). `SampledPositionKernel.create({maxKeyframes,color,pixelSize})` bakes a per-instance keyframe budget into a matched **(WGSL kernel + JS cpuKernel + floatsPerInstance + `packInstance(keyframes,epoch)` + `sample(lanes,t)`)** Family; lane layout `[keyframeCount, (t,x,y,z)×maxKeyframes]` (stride `1+4·maxKeyframes`). The GPU/CPU kernels LINEARLY interpolate the bracketing keyframes at the scene clock (degree-1 `LinearApproximation`) and CLAMP outside the span (HOLD = `ExtrapolationType.HOLD`) — the GPU-resident analogue of `SampledPositionProperty` for the non-derivable dense-keyframe regime (CZML position tracks / telemetry). No renderer changes (kernel + cpuKernel are user-supplied strings/functions the substrate already accepts). New "WebGPU Keyframe Catalog" Sandcastle (random great-circle waypoint tracks, LOOP_STOP clock, `?renderer=` selectable). Verified `probe-sampled-position-kernel.mjs` (3 instances × 4 keyframes, 4 query times incl. on-keyframe + before-first/after-last HOLD, both backends; GPU-resident position read back via `getInstanceWorldPosition` matches BOTH `family.sample()` AND a CPU `SampledPositionProperty` within 80 m — measured worst 0.1 m; renders + moves + 0 errors). Hermite/Lagrange (non-linear `SampledPositionProperty` parity) tracked NEW-SAMPLED-POSITION-KERNEL-HERMITE (DEFERRED — linear is exact for the dense regime). (SHIPPED; the Worker/WASM offload of the CPU kernel + SDP4 deep-space + HDR-mode pick + Hermite keyframes tracked in DEFERRED_WORK under NEW-COMPUTE-INSTANCE-WEBGL2-WORKER / NEW-SAMPLED-POSITION-KERNEL-HERMITE plus the NEW-ORBITAL entries)
- WebGPUVolumetricFogRenderer — froxel-grid volumetric fog with HG sun + moon in-scattering, sun-shadow-map god rays, 3-octave value-noise varying density (Phases 5a-5d) (SHIPPED, default off via `atmosphericConditions.volumetricFog.enabled`)
- WebGPUProceduralCloudRenderer — Schneider-style volumetric raymarched clouds (HG dual-lobe phase + Beer-Powder lighting + 3D FBM density + light-ray marching). Phase 6 main render path. (SHIPPED, default off via `atmosphericConditions.clouds.enableVolumetric` / legacy `globe.showProceduralClouds`)
- WebGPUViewportQuad — utility full-screen quad command (SHIPPED)
- WebGPUSceneRenderer — top-level scene-render orchestrator (SHIPPED)
- WebGPUSceneRenderer helpers — PickPass / EnvironmentalEffects / GlobePass / TranslucentPass / 3DTilePasses / PassRedirect / FrameReset / FrustumLoop / PostFrustumChain / EnsureResources (Batch 133-142 decomposition into 10 helpers) (SHIPPED)

### B.4 WebGPU Compute Shaders

- BrdfLutGenerate.wgsl — one-time BRDF LUT compute pass (SHIPPED)
- IrradianceConvolution.wgsl — diffuse irradiance cubemap generation (SHIPPED)
- RadiancePrefilter.wgsl — specular mipchain prefilter for IBL (SHIPPED)
- PolygonSignedDistance.wgsl — SDF atlas for clipping polygons (SHIPPED)
- AtmosphereLUT.wgsl — precomputed transmittance + scattering LUT (SHIPPED — Phase 1.3a/1.3c wired; per-pixel ray-march fallback for orbit cameras where LUT V-coord clamps)
- AtmosphereLUT.wgsl full-Bruneton extension — multiple-scattering (256×128) + irradiance (256×64) LUTs (SHIPPED — Track V-A1, Batch 306). `computeMultipleScattering` gathers single-scatter radiance over a Fibonacci-sphere + integrates higher orders; `computeIrradiance` = direct sun (transmittance·muSun) + cosine-weighted diffuse-sky integral. Read transmittance + single-scatter as sampled `@group(1)` inputs (own `extParams` uniform). `dispatchAtmosphereExtendedLUT` chained after the sun dispatch in `WebGPUSkyAtmosphereRenderer`. Foundation for V-A2 aerial-perspective + V-A3 atmosphere-derived lighting. Shader-verified by `probe-atmo-luts.mjs` (MS brightens sky ~19× over single; irradiance positive + sun-zenith falloff). **Runtime-dormant** pending `NEW-WEBGPU-COMPUTE-ENGINE-WIRING` (no `ctx.computeEngine` → `dispatchCompute` no-ops for all compute tasks).
- Aerial-perspective post-process — unified per-pixel atmosphere over the WHOLE scene (SHIPPED — Track V-A2, Batch 311; NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS). `AerialPerspectiveEffect` (`WebGPUAerialPerspectiveEffect.ts`) + `AerialPerspective.wgsl`: a fullscreen pass that, per pixel by scene depth, multiplies scene colour by atmospheric transmittance (`exp(−OD)` from a marched optical depth) and adds analytic Rayleigh+Mie single-scatter inscatter (parity port of `computeScattering`), composing `sceneColor·T + inscatter` over terrain + 3D tiles + models + geometry. Recovers eye-distance from LOG depth + the world view ray as `inverseViewRotation × eyeDir` (FP32-precise; avoids the world-pos-difference cancellation NaN). Runs FIRST in the post-process chain so the haze participates in bloom/tonemap. Opt-in `scene.aerialPerspective = true`; the in-globe ground-atmo+fog drape is gated OFF when active (`frameState.aerialPerspective` → globe surface UBs) to avoid double-apply. **Analytic, not LUT-sampled** — the inscatter LUT's azimuth parameterization is broken (NEW-ATMOSPHERE-LUT-SUN-RELATIVE) and the compute engine is dormant (NEW-WEBGPU-COMPUTE-ENGINE-WIRING), so this is correct + runtime-functional today; the transmittance LUT view is bound (white placeholder) for the V-A3 follow-on. Verified by `probe-aerial-perspective.mjs` (far band brightens + desaturates; no double-darken; globe renders; 0 errors). Near-field intensity tuning + runtime-mutable config tracked NEW-ATMO-AERIAL-PERSPECTIVE-NEARFIELD-TUNE.
- Atmosphere-derived sun + sky lighting (mixed mask) — sun + sky light from the atmosphere for discrete models (SHIPPED — Track V-A3, Batch 312; NEW-ATMO-DERIVED-LIGHTING). `Scene/AtmosphereDerivedLighting.js` (backend-neutral): a CPU Beer-Lambert sun-ray optical-depth march (same Rayleigh+Mie model the LUTs bake + V-A2 uses) → the sun's transmitted COLOUR (near-white at zenith, warm toward the horizon) + a horizon-falloff INTENSITY, plus a desaturated cool sky-irradiance ambient. Sun ZENITH measured against the local up at the viewed site (camera position dir), not the pole. `Scene.updateFrameState` (gated `aerialPerspective && isWebGPU && light instanceof SunLight`) re-derives into a private `_atmosphereDerivedLight` swapped into `frameState.light` (never mutates `scene.light`) + publishes `frameState.atmosphereSkyIrradiance`; the WebGPU model renderer reads the sun for free (`frameState.light.color/.intensity`) + uses the ambient as its `ambientColor` floor (falls back to the neutral 0.2 floor off/WebGL). Mixed mask: terrain = V-A2 post-process; models = light-source PBR, one coherent atmosphere; no double-LIGHTING (V-A2 applies extinction+inscatter, not Lambertian shading). **Analytic, not LUT-sampled** — same reason as V-A2 (compute engine dormant, NEW-WEBGPU-COMPUTE-ENGINE-WIRING); the module is the seam to swap to transmittance(sun)+irradiance(sky) LUT reads (NEW-ATMO-DERIVED-LIGHTING-LUT-CONSUMPTION). Verified by `probe-atmo-lighting.mjs` (derived sun warms+dims HIGH→LOW; model+terrain both warm at sunset; ON warmer than OFF; 0 errors; low-sun PNG is a coherent golden sunset over model+terrain).
- Dual-light atmosphere (sun + moon scattering) — Phase 1.3c (SHIPPED) — two LUT pairs sampled at runtime, moon contribution scaled by `frameState.moonPhaseFraction × dualLightControl.z` intensity multiplier; gated on `atmosphericConditions.lighting.enableDualLightAtmosphere` (default ON per B14)
- Sky-brightness modulation for stars — Phase 1.3a (SHIPPED) — CPU-side brightness estimate → `frameState.skyBrightness` → cubemap panorama smoothstep with `cloudCover` multiply (`CubeMapPanorama.wgsl::105-129`)
- Bright-star catalog starfield (WebGPU) — Track V-C, Batch 313 (SHIPPED — NEW-STARS-BRIGHT-CATALOG). Real Yale Bright Star Catalog (BSC5, public-domain) subset (`Scene/BrightStarCatalog.js`, ~230 brightest stars `[raJ2000°,decJ2000°,vmag,B−V]`) rendered as instanced HDR point sprites (`Renderer/WebGPU/WebGPUStarFieldRenderer.ts` — TS-converted Batch 314 (NEW-TS-CONVERT-JS-RENDERERS first slice, zero behavior change); `Shaders/WebGPU/Catalog/StarField.wgsl`, `FeatureRendererKey.STAR_FIELD`=51) additively into the scene FB so bloom makes bright stars glow. Magnitude→brightness via the Pogson scale (gamma-compressed `[LO,HI]` band + magnitude-driven size boost); B−V→blackbody-temperature→Planckian-locus RGB. Catalog directions are TEME/J2000-inertial, rotated into the Earth-fixed frame each frame by `Transforms.computeTemeToPseudoFixedMatrix` (same as SkyBox) so constellations land at correct RA/Dec for the scene clock; camera-altitude-gated daytime fade. Backend-agnostic `Scene/StarField.js` (FR-seam) owned by `SkyBox` (toggle `scene.skyBox.starField.show`); `Scene.updateEnvironment` routes the command to `environmentState.starFieldCommand`, injected AFTER `skyBoxCommand` so it augments (draws on top of) the cubemap. Verified by `probe-stars-catalog.mjs` (Sirius-aimed center cluster, RA/Dec correctness, Pogson intensity liveness, 0 errors). WebGL keeps cubemap-only stars (NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK deferred).
- MoonLight class — Phase 2 1.2c v2 (SHIPPED) — `scene.light = new MoonLight()` opt-in, default `(0.85, 0.88, 1.0, 1.0)` cool tint at intensity 0.05
- Moon phase + earthshine — Phase 2 1.2c v2 (SHIPPED) — CPU-side phase fraction from sun/moon dot product; lit hemisphere `smoothstep(0, 0.3, phase)` gated; unlit hemisphere soft blue-grey earthshine ambient (`vec3(0.4, 0.5, 0.7) × 0.08 × (1 - rawNdotL)`)
- `czm_getDynamicAtmosphereLightDirection` parity (NONE / SCENE_LIGHT / SUNLIGHT enum) — Batch 20 (SHIPPED) — per-fragment `normalize(positionWC)` for NONE case, scene-light direction for SCENE_LIGHT, sun for SUNLIGHT
- FrustumCull.wgsl — GPU frustum culling for >50K objects, dispatched by WebGPUGPUCuller (SCAFFOLDED — WASM/JS culling active)
- HiZPyramid.wgsl / HiZPyramidFromDepth.wgsl — hierarchical-Z pyramid build from prev-frame depth (WIP — built+dispatched every frame in the density gate via WebGPUSceneRenderer, FORK-41 Batch 291)
- OcclusionTest.wgsl — bounding-sphere vs Hi-Z occlusion test (WIP — depth-space reconciled + false-cull/mip-index fixed Batch 291; command-drop GATED OFF (`_hiZConsumeEnabled` default false / `CesiumDebug.hiZConsume`) pending one residual max-Z footprint-coverage fix — see DEFERRED_WORK FORK-41)
- PointCloudSort.wgsl — bitonic GPU sort on point distance² (EXPERIMENTAL — `useGPUSort` flag default false)
- PointCloudLOD.wgsl + PointCloudLODScanCompact.wgsl — visibility-tag + scan-compact LOD pipeline; atomic-path full-workgroup (256-visible) compaction no longer corrupts the slot-255 point — broadcast offset moved off the live `sharedVisible[255]` slot onto a dedicated `sharedGlobalOffset` scalar (Batch 293, NEW-POINTCLOUDLOD-SLOT255-OFFBYONE) (SHIPPED)
- GPUSortKeys.wgsl — packed 64-bit sort keys for >50K draw commands (SCAFFOLDED)
- WeatherParticles.wgsl + WeatherParticleRender.wgsl — particle simulation + render (SCAFFOLDED)
- ComputeInstanceScaffold.wgsl + ComputeInstanceRender.wgsl — engine scaffolding for user compute-instance kernels (bindings + entry point + bounds check + RTE output write; composed with the user's `csm_computeInstance` snippet at pipeline build) + storage-buffer-vertex-pull instanced point render (Batch 231 generalization of the Batch-230 OrbitalPropagate/OrbitalCatalogRender pair; the orbital propagation math left the engine and is demo content) (SHIPPED; low part of the RTE output is 0 until the df64 kernel upgrade)
- VolumetricFog.wgsl — froxel-grid density injection + HG light-scattering with sun-shadow-map sampling + front-to-back integration (Phases 5a-5d shipped) (SHIPPED)
- DecoupledLookbackScan.wgsl — single-dispatch inclusive prefix sum (Merrill & Garland 2016) (SHIPPED)
- AutoExposure.wgsl — luminance histogram + average-exposure compute (SHIPPED)
- JS dispatchers — WebGPUDecoupledScan, WebGPUGPUCuller, WebGPUHiZOcclusionDispatcher, WebGPUGPUSortKeysDispatcher, WebGPUPointCloudSortDispatcher (SHIPPED dispatchers; underlying shader status mixed)

### B.5 WebGPU Post-Process Effects

- WebGPUPostProcessPipeline — compositing pipeline orchestrating all post stages; required for canvas blit (SHIPPED)
- WebGPUPostProcessStageCollection — equivalent of upstream `PostProcessStageCollection.js` (SHIPPED)
- WebGPUPostProcessEffects — top-level entry coordinating Bloom/AO/etc. (SHIPPED)
- WebGPUBloomEffect — multi-pass bloom (BrightPass → GaussianBlur → AdditiveBlend → Composite); Batch 240: bright pass is a 1:1 ContrastBias.glsl port (HSB brightness + contrast curve), all six WebGL bloom uniforms mapped (NEW-BLOOM-UNIFORM-PARITY) (SHIPPED)
- WebGPUAmbientOcclusionEffect — SSAO/GTAO 4-pass: AmbientOcclusionGenerate + GTAOGenerate + Modulate (SHIPPED)
- WebGPUDepthOfFieldEffect — DoF 3-pass blur with focus-distance ramp (SHIPPED)
- WebGPUGodRayEffect — radial god-rays from sun direction (SHIPPED)
- WebGPUTAAEffect — TAA with RTE depth-reprojection motion vectors + history validity gate (SHIPPED Slice 1+2; per-model MRT 2c-2e WIP. Batch 244: the resolve stage went LIVE — `configureWebGPUPostProcessPipeline` lazy-adds the effect on the first `scene.taaEnabled` frame and consumes `motionTex`; first activation fixed a TAA.wgsl depth-mip compile error, a depth+filtering-sampler pipeline rejection (dedicated non-filtering depthSampler), and the G-buffer raw-`scene.msaaSamples` scene-pass kill — NEW-TAA-EFFECT-NEVER-ADDED ✅ SHIPPED, gated by probe-taa-resolve.mjs; pre- vs post-tonemap clamp retune stays open under NEW-TAA-PIPELINE-ORDER-RECONCILE)
- WebGPUSSREffect — Screen-Space Reflections (SHIPPED)
- WebGPUAutoExposure — auto-exposure based on luminance histogram (SHIPPED)
- Tonemapping.wgsl + Tonemapping_f16.wgsl — 5 tonemapping operators; f16 variant gated on `shader-f16` (SHIPPED)
- ColorGrading.wgsl — per-channel curve grading (SHIPPED)
- FXAA.wgsl — full-screen FXAA (SHIPPED)
- EdgeDetection.wgsl / Silhouette.wgsl — edge + silhouette stages (SHIPPED)
- LensFlare.wgsl — sun-direction lens-flare ghosts (SHIPPED)
- BlackAndWhite / Brightness / NightVision — built-in adjustment effects (SHIPPED)
- ContrastBias.wgsl — contrast/bias upstream-equivalent (SHIPPED)
- GaussianBlur1D.wgsl — separable Gaussian blur primitive used by Bloom/DoF/SSAO (SHIPPED)
- PassThrough.wgsl / PassThroughDepth.wgsl — depth/color blits (SHIPPED)
- OITComposite.wgsl — weighted-average OIT compositing (SHIPPED)
- AdjustTranslucent.wgsl — translucent-pass alpha adjustment (SHIPPED)
- CompareAndPackTranslucentDepth.wgsl — packed translucent depth source for classifier (SHIPPED)
- CompositeTranslucentClassification.wgsl — accumulation composite (SCAFFOLDED — depth-sample architecture made it a no-op)
- GlobeDepthCopy.wgsl — packed-depth blit (SHIPPED)
- DepthView.wgsl — debug depth visualization (SHIPPED)
- DepthPlane.wgsl — horizon-plane fill (SHIPPED)
- DeferredGBuffer.wgsl + DeferredLighting.wgsl — deferred-lighting prepass (SCAFFOLDED — never registered as FR)
- VolumetricFogComposite.wgsl — full-screen pass that samples the integrated froxel volume in (screen UV, linearized depth) and alpha-over-composites into scene color (SHIPPED)
- BloomComposite/BrightPass/GodRayComposite/GodRayGenerate/AdditiveBlend.wgsl — supporting stage shaders (SHIPPED)
- ScreenSpaceReflections.wgsl — SSR ray-march (SHIPPED)

### B.6 WebGPU Subsystems

- WebGPUOIT — Order-Independent Transparency; weighted-average via the MRT (accumulation + revealage) composite path only. **WGF-2: dual-source-blending single-pass OIT is NOT wired** — `WebGPUOIT.ts` carries only the MRT fallback (no `blend_src` / `src1` output, no `dual-source-blending` feature request); the single-pass dual-source path is a docstring aspiration (lines 16-17), confirmed never wired (`PHASE_5_MODERN_WEBGPU_DESIGN.md`). (SHIPPED — MRT fallback only; dual-source NOT wired)
- WebGPUGlobeDepth — packed globe-depth subsystem with copy-readback for picking (SHIPPED)
- WebGPUEdgeFramebuffer — MRT edge target + 16-bit feature-id channel split across rgba8 (SHIPPED — framebuffer/MRT infra only; the `EdgeDisplayMode` tri-mode + edge data-path gaps are tracked in §C.3 NEW-EDGE-DISPLAY-MODE-WEBGPU)
- WebGPUEdgeVisibilityEmitter — generates per-fragment edge intensity for Model edges (SHIPPED-partial — consumes only the per-triangle 2-bit `edgeVis.visibility` encoding and ignores `model.edgeDisplayMode`; `EDGES_ONLY` direct pass + `SURFACES_ONLY` default-suppression + the lineStrings / authored-silhouetteNormals / per-edge-color data paths are NOT wired — see §C.3 NEW-EDGE-DISPLAY-MODE-WEBGPU)
- WebGPUTranslucentTileClassification — Batch 47 multi-frustum classification target + composite (SCAFFOLDED — composite no-op per ADR; texture retained per dead-code audit rule)
- WebGPUInvertClassification — inverted-stencil classification mask (SHIPPED)
- WebGPUSceneFramebuffer — owns color/depth/MSAA targets for the scene (SHIPPED)
- WebGPUPickFramebuffer — async pick framebuffer with staleness validation (PlayCanvas pattern) (SHIPPED)
- WebGPUPickCommandHelpers — shared pick-command construction extracted from 5 renderers (Batch 59) (SHIPPED)
- WebGPUPostProcessPipeline — composite pipeline; mandatory for WGPU canvas blit (SHIPPED)
- WebGPUPerformanceManager — frame timing + telemetry consolidator (SHIPPED)
- WebGPUTimestampProfiler — timestamp-query GPU pass profiling (gated on `timestamp-query`) (SHIPPED)
- WebGPUCpuPassProfiler — CPU-side per-pass timing (R-7a forward work, Batch 165) (SHIPPED)
- WebGPUFrameStatistics — per-frame buffer/texture/dispatch counters (SHIPPED)
- WebGPUDevicePool / WebGPUDeviceLossRecovery / WebGPUDeviceInvalidationBus / WebGPUResourceCacheRegistry — device-loss + cache-clear subsystem (SHIPPED)
- WebGPUContextDeviceLoss — host adapter for `device.lost` promise consumers (SHIPPED)
- WebGPUFramebufferManager / MultisampleFramebuffer — MSAA + framebuffer lifecycle (SHIPPED)

### B.7 Build & Tooling

- Three build variants — buildCesiumDual / buildCesiumWebGPUOnly / buildCesiumWebGLOnly / buildAllVariants (SHIPPED)
- bundleVariantPlugin.js — esbuild `onResolve` hook redirecting backend-specific imports to stubs (SHIPPED)
- WEBGPU_COMPAT_EXEMPTIONS — exemption list for backend-neutral files under Renderer/WebGPU/ (SHIPPED)
- scripts/stubs/emptyShader.js — `export default ""` stub for GLSL shader leaves in webgpu-only build (SHIPPED)
- scripts/stubs/emptyModule.js — Proxy-based throw-on-access stub for WebGPU files in webgl-only build (SHIPPED)
- ESM code-splitting wiring — keeps `await import("./WebGPU/WebGPUContext.js")` dynamic in dual ESM build (SHIPPED)
- Variant entry barrels (Source/Cesium.js, CesiumWebGLOnly.js, CesiumWebGPUOnly.js) — generated by `createCesiumJs(variant)` (SHIPPED)
- Side-effects declaration in root package.json — preserves setGlobalDefaultRenderer() call (SHIPPED)
- Tools/variant-smoke-test.mjs — Playwright-based smoke test for each variant. Batch 242: pixel gate moved inside `scene.postRender` with a poll-until-non-uniform deadline (the deferred-read version raced the compositor and false-failed webgl-only) (SHIPPED)
- CI `variants` job (.github/workflows/dev.yml) — `buildAllVariants` + webgl-only runtime smoke on every push/PR; closes the no-CI-runs-variants blind spot (NEW-VARIANT-CI, Batch 242). The dual + webgpu-only SwiftShader-WebGPU smokes are LOCAL-REQUIRED, not hosted: the first hosted run died on SwiftShader Vulkan instance device-lost mid-frame, not no-adapter (Batch 259, FQ-6, NEW-CI-SWIFTSHADER-WEBGPU-DEVICE-LOST) (SHIPPED)
- Tools/visual-regression/sandcastle-smoke.mjs — LOCAL-REQUIRED Sandcastle WebGPU gate (Batch 242, the DepthPlane lesson): 3 renderer-pinned gallery demos (Orbital Catalog / Clustered Lighting / Point Light Shadows) asserted non-black + non-uniform + WebGPU-device-armed + 0 console/validation errors (SHIPPED)
- Tools/visual-regression/probe-compute-instance-webgl2-demos.mjs — LOCAL-REQUIRED Phase-5 gate (Batch 283): drives the two compute-instance Sandcastle demos ("WebGPU Orbital Catalog" / "WebGPU SGP4 Satellites") on BOTH `?renderer=webgl` (CPU-kernel fallback) and `?renderer=webgpu` (compute), asserting per (demo, backend) renders + moves (frame-differenced) + correct-backend-armed + 0 errors (SHIPPED)
- Tools/visual-regression/probe-sampled-position-kernel.mjs — gate for the SampledPositionKernel family (Batch 309, NEW-SAMPLED-POSITION-KERNEL): 3 instances × 4 keyframes queried at 4 times (mid-segment, on-keyframe, before-first/after-last HOLD) on both backends; reads each GPU-resident interpolated position back via `getInstanceWorldPosition` and asserts it matches BOTH `family.sample()` AND a CPU `SampledPositionProperty` (linear, HOLD) within 80 m, plus renders + moves + 0 errors (SHIPPED)
- Tools/visual-regression/capture-and-diff.mjs — pixel-diff harness for WebGL vs WebGPU on split-screen page (SHIPPED)
- Tools/visual-regression/scenes.json + baseline + output dirs — scene catalogue for regression suite (SHIPPED)
- ~20 ad-hoc visual-regression diagnostic scripts — probe-imagery, canvas-black-trace, ground-polyline-smoke, etc. (SHIPPED)
- Tools/visual-regression/cross-backend-sandcastle-runner.mjs — runs every gallery `.html` against both backends. Uses (1) Playwright `addInitScript` Proxy over `window.Cesium` since the module namespace is frozen, (2) wrapper trap on `window.startup` so the proxied namespace forwards into the demo's local `Cesium` parameter, (3) `page.route` HTML rewrite that flips sync `new Cesium.Viewer(` → `await Cesium.Viewer.createAsync(` when forcing WebGPU (sync constructor has no WebGPU code path). Captures per-demo JSON + screenshots + console/page errors (SHIPPED — Session 62)
- Tools/visual-regression/analyze-cross-backend-report.mjs — categorizes the per-demo JSON into both-fail / one-fail / both-OK + low/medium/high diff buckets, surfaces actual console/page errors (the prior `capture-and-diff` reported "OK" if canvas had non-zero size — even when WebGPU spewed shader compile errors. The new analyzer makes real bugs visible.) (SHIPPED — Session 62)
- Tools/audit-feature-renderers.mjs — verifies every FR registered in WebGPUFeatureRenderers.ts is reachable (SHIPPED)
- Tools/shader-pipeline/naga-wasm-tools — Naga-wasm spike tooling for WGSL ↔ SPIR-V translation (EXPERIMENTAL)
- scripts/build.js stripPragmaPlugin — extended to handle both .js and .ts (SHIPPED)
- scripts/build.js glslToJavaScript .wgsl-mirror exemption — Session 62 fix: the function's leftover-deletion sweep was erasing all `.js` mirrors of `.wgsl` files (wgsl mirrors are managed by `wgslToJavaScript`, not glslToJavaScript). Each chokidar GLSL-watcher invocation broke the bundle until the next gulp build. Added `!packages/${workspace}/Source/Shaders/WebGPU/**/*.js` to the include patterns. (SHIPPED — Session 62)
- server.js chokidar `.wgsl` watcher — Session 62 fix: original watcher accepted `.glsl` only, so `.wgsl` edits never triggered bundle-cache invalidation and the dev server kept serving the pre-edit bundle from memory. Extended to accept both extensions; routes `.wgsl` events to `wgslToJavaScript` (separate function from the GLSL pipeline). Both invalidate the same caches. (SHIPPED — Session 62)
- scripts/codemod-* — fork modernization codemods (es6-class, indexof-to-includes, replace-any-types, split-material-ubo) (SHIPPED)
- scripts/createMissingWgslChunks.js / createWgslStandaloneShaders.js / generateWgslJs.js — WGSL build pipeline (SHIPPED)
- scripts/compileSlang.js — Slang shader compilation experiment (EXPERIMENTAL)
- scripts/lebab-batch.js — bulk var → const/let modernization tool (SHIPPED)
- scripts/run-build-no-tsc.mjs — fast iterative build skipping tsc check (SHIPPED)
- Apps/WebGPUTest/ — 20+ standalone test harnesses (split-screen-comparison.html, scene-webgpu-init-test.html, etc.) (SHIPPED)
- Sandcastle gallery WebGPU-prefixed demos (Apps/Sandcastle/gallery/WebGPU *.html) — user-visible showcases for fork-specific features that have no WebGL equivalent OR pin the WebGPU renderer for backend-specific UX:
  - WebGPU Many Imagery Layers (8-layer stack, hue/gamma/alpha verification — Batch 58 globe imagery cap widening) (SHIPPED)
  - WebGPU Edge Visibility / Edge Feature ID — `EXT_mesh_primitive_edge_visibility` glTF extension + per-edge feature picking (SHIPPED-partial — the demo's per-triangle visibility + feature picking work, but the `EdgeDisplayMode` tri-mode and the lineStrings / silhouetteNormals / per-edge-color data paths are gapped; see §C.3 NEW-EDGE-DISPLAY-MODE-WEBGPU)
  - WebGPU Translucent Classification — multi-frustum 3-pass technique (SHIPPED)
  - WebGPU Voxel Pick / Model Pick — WebGPU-optimized picking paths (SHIPPED)
  - WebGPU Point Light Shadows — point-light shadow maps (Batches 34/57/63; no WebGL receiver yet) (SHIPPED)
  - WebGPU Async Resource Monitor — live UI for `context.asyncResources` event bus + `context.asyncResourceTelemetry` p50/p95/p99 latency table; toolbar buttons trigger fly-to + globe translucency to force pipeline cooks (SHIPPED — Session 62)
  - WebGPU Temporal Anti-Aliasing — `scene.taaEnabled` toggle (existing public API; first sandcastle showcase) (SHIPPED — Session 62)
  - WebGPU God Rays — `scene.godRayEnabled` + `scene.godRayConfig` (density/decay/weight/exposure/sampleCount); auto-projects sun position through view-projection per frame (SHIPPED — Session 62)
  - WebGPU Screen Space Reflections — `scene.enableSSR` + `scene.ssr*` knobs; ray-marches against depth buffer (SHIPPED — Session 62; gated on FEAT-GAP-01 normal G-buffer for full fidelity)
  - WebGPU Weather Particles — `scene.enableWeather` + `scene.weatherType` (rain/snow/fog/hail) + intensity + wind (SHIPPED — Session 62)
  - WebGPU Vector Tile Buffer Rendering — `BufferPointCollection` storage-buffer-backed batch rendering of 50K points (SHIPPED — Session 62)

### B.8 Backend-Specific Optimizations

- WASM bridges — WasmCullBridge / WasmSortBridge / WasmHeightmapBridge / WasmQuantizedMeshBridge / WasmRTEBridge / WasmMatrixBridge / WasmPointCloudBridge (SHIPPED). `WasmRTEBridge.batchEncodeRange` (Batch 271, NEW-WASMRTE-SUBRANGE-ENCODE) adds in-place sub-range `[srcOffset,count)→[dstOffset,..)` encoding over the existing `batch_rte_encode` kernel (no new Rust export) for incremental-repack hot paths; same batch fixed the latent missing-`memory`-export bug that was silently forcing the RTE WASM path onto its JS fallback. `batchEncodeRange` is now WIRED (Batch 272, NEW-BUFFERCOLL-WASM-ENCODE-WIRE, SHIPPED) into the BufferPointCollection repack hot paths on BOTH backends — `WebGPUBufferPointRenderer.repackPointDirty` + `Scene/renderBufferPointCollection.js` route the POSITION high/low lanes through the batch encode when `_dirtyCount >= 2000` (threshold tuned down from 5000 in Batch 273), keeping color/pick/outline interleave scalar; the fround-split batch encode is pixel-equivalent to the AGI-split `EncodedCartesian3` after RTE reconstruction (probe diffs 0px WebGPU / 3px WebGL). **Benchmarked (Batch 273, NEW-BUFFERCOLL-ENCODE-BENCHMARK, SHIPPED):** `Tools/wasm-encode-benchmark.mjs` (Node real-kernel CPU: WASM ~1.2x at 10k-50k, ties at 100k) + `Tools/visual-regression/probe-buffercoll-encode-benchmark.mjs` (both-backend end-to-end repack+upload ms/frame + WebGL-vs-WebGPU no-regression). The DOMINANT win is hoisting the position encode out of the per-primitive `EncodedCartesian3` loop (~25-40% faster repack at ≥1500 points on both backends), NOT WASM SIMD — so the threshold gates the encode-strategy hoist, which wins even with the kernel dark. **Bundle WASM load FIXED (Batch 274, NEW-WASM-BRIDGE-BUNDLE-LOAD, SHIPPED):** all 7 bridges now load + execute the real kernel in the bundled build (ESM + IIFE + CJS) — the glue specifier is resolved via the shared `Scene/resolveWasmGlueUrl.js` helper (`buildModuleUrl("ThirdParty/Workers/cesium_wasm.js")`, the same base-URL resolver `TaskProcessor` uses), Cull/Sort are kept external so esbuild no longer inlines the glue (which mis-resolved the sibling `.wasm` URL), and the missing-`memory`-export fix is applied bridge-wide (Matrix/QMesh/PointCloud/Heightmap now capture `_wasmExports` + use `_wasmMemory()`). Proven by `Tools/visual-regression/probe-wasm-bundle-load.mjs` (7 bridges `wasmReady`, 0 `cesium_wasm*` 404s, RTE kernel byte-identical to its JS twin with no silent fallback, in ESM mode AND `--iife` against `Build/Cesium/Cesium.js`). The optional wider color/outline kernel for Polygon/Polyline (NEW-WASM-WIDE-INSTANCE-KERNEL) is DEFERRED — the benchmark showed the color-pack loop is not the residual bottleneck.
- WasmFeatureDetection.js — shared SIMD detect / version match / `free_buffer` for all bridges (SHIPPED)
- WasmArenaSlots.js — per-bridge buffer slots replacing FORK-45 shared mutex arena (SCAFFOLDED — sequential bridges work today)
- packages/wasm-naga/ — Rust source + vendored WASM runtime for Naga shader translator (EXPERIMENTAL)
- 64-bit RTE precision infrastructure — `EncodedCartesian3.d.ts` + WGSL `(positionHigh, positionLow)` vertex format + `mvpRelativeToEye` UBO field (SHIPPED)
- WebGPURTEAssertions.ts — runtime guards enforcing no `mvp * vec4(position, 1.0)` slips in (SHIPPED)
- previousViewProjection UBO field on every renderer's CameraUniforms struct (DP-H41) (SHIPPED)
- Define-bitmask preprocessor — `(sourceId, defines)` Uint32 cache key (SHIPPED)
- GPU render bundle wiring — opt-in via WebGPURenderBundleManager (3 active sites: globe terrain, environment, volumetric fog) (SHIPPED)
- Compute-driven LOD via WebGPUDecoupledScan — deterministic point-cloud visible-set extraction (SHIPPED)
- Compressed-vertex GPU decode via COMPRESSED_VERTICES define (DP-H19-SHADER-DECODE Batch 27) (SHIPPED)
- WebGPUGPUCuller GPU-side frustum culling dispatcher (SCAFFOLDED — JS/WASM cull active)
- WebGPUHiZOcclusionDispatcher Hi-Z occlusion dispatcher (SCAFFOLDED)
- WebGPUGPUSortKeysDispatcher packed-key GPU command sort (SCAFFOLDED — JS multi-level comparator default for <50K)
- LRU pipeline cache (Batch 126) — bounded cache for hot-path pipelines + post-process bind groups (SHIPPED)
- Effects bind-group consolidation (Batch 122) — 8 → 4 bind groups via per-tile UBO + atlas (SHIPPED)
- Per-tile clipping BG cache (Batch 55) — kills ~12k createBindGroup + ~36k createView per second (SHIPPED)
- Adaptive WebGPU limit opt-ins (Batch 121) — per-adapter capability probe → tier selection (SHIPPED)
- KHR glTF extensions — KHR_texture_transform + 6 KHR material extensions (clearcoat, specular, anisotropy, iridescence, sheen, volume, transmission) (SHIPPED Batches 90/95/102-105/107)
- Soft point-light shadows via 5-tap PCF (Batch 63) (SHIPPED)
- Cube depth sampling for point-light shadows (Batch 57) (SHIPPED)
- Globe receive of point-light shadows (Batch 108) (SHIPPED)
- C-R7-SHADER-MODULE-DEDUP full sweep: Model PBR (Batch 162), Vector 3D Tile family (Batch 163), BufferPrimitive family (Batch 164), GroundPrimitive + GroundPolyline + SkyAtmosphere + EllipsoidPrimitive closure (Batch 185) (SHIPPED — every Cesium-authored WGSL renderer routes through `WebGPUShaderModuleCache.getOrCreate`)
- NEW-ADVANCED-MOTION-VECTORS family — per-particle / per-cell / per-feature motion vectors for advanced primitives + classifiers (PointCloud Batch 168/169, CloudCollection Batch 170, GaussianSplat Batches 171-172, Voxel Batch 173, Vector3DTilePrimitive Batch 178, Vector3DTile{Polylines,ClampedPolylines} Batch 179, GroundPrimitive Batch 180, GroundPolyline Batch 183) (SHIPPED — full classifier + advanced-primitive coverage; emission gates ACTIVATED in Batch 234 — all read the canonical `frameState.taaEnabled` published by `Scene.updateFrameState`, which did not exist when these batches landed, so Batch 234 was the first real execution — NEW-COLLECTIONS-TAA-GATE-DORMANT)
- NEW-GLOBE-TRANSLUCENCY-MULTI-PASS — 3-pass technique (depth-only back-face → translucent back-face → translucent front-face) via direct command emission with cull-mode-specific pipeline variants. Cache-key suffixes `_DOB` and `_TBF` (Batches 177 + 182 + 183 underground+translucent gate fix) (SHIPPED)
- NEW-DRILLPICK-ASYNC — `Scene.drillPickAsync(windowPosition, limit, width, height)` returns a Promise that drills through stacked features by awaiting each pick before mutating `show`. Renderer-agnostic via `pickFramebuffer.endAsync` (Batch 184) (SHIPPED)
- NEW-MODEL-NODE-TRANSFORMS-PREV — per-runtime-node prev modelMatrix capture for TAA velocity on articulated rigs (Batch 175) (SHIPPED)
- KHR_materials_iridescence Belcour 2017 analytical formula (Batch 181) (SHIPPED — supersedes the LUT-based design)
- KHR_materials_transmission thickness coupling — refraction UV offset modulated by `1 + 4 × thicknessForKHR` (Batch 176) (SHIPPED)
- FORK-34 — WebGPU `scene.pickAsync` works (Batch 207). Fixed 5 compounding pick-pass bugs (no command encoder during pick → `beginPickFrame`; pick FBO format ≠ pipeline target → match `scenePipelineFormat` + R/B readback swap; log-depth swap hid the pick command; MRT base commands with no pick variant invalidated the whole pick command buffer → skip unless `pickOnly`/`_isPickCommand`; `a > 0` readback gate rejected every pick id → gate on RGB). Box `Primitive` pick at full WebGL parity; globe-containing scenes pickable. (SHIPPED — closes deferred entry)
- NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION — `scene.pickPosition`/`pickPositionWorldCoordinates`/camera zoom-to-cursor return real world positions on WebGPU (Batch 252; layer 3 of the Batch-221 NEW-PICKDEPTH-CAPABILITY-READBACK fix, now FULLY resolved). Full-frustum log reconstruction in `Picking` gated on the new `GraphicsContext.pickDepthFullFrustumLogEncode` capability getter (WebGPU mirrors the log-depth master switch — kill switch auto-restores the SAFE undefined → ray-pick fallback); `PickDepth.getDepth` bridges the async GPU readback through a one-frame-stale sync cache (±4 px / ≤4 rendered-frame validity; number|undefined, never a Promise — all consumers are synchronous); `SceneTransforms.drawingBufferToWorldCoordinates` consumes window depth directly as NDC z under the WebGPU [0,1] depth-range convention; plus a both-backend `handleZoom` degenerate-axis NaN guard. Parity evidence: probe-pickposition-webgpu.mjs — dLon/dLat 0.00000°, dH 4.1 m vs WebGL, cold cache converges frame 1, wheel-zoom descends on target, 0 errors. Opaque-Model pickPosition coverage completed by DP-H45 (Batch 257): post-OPAQUE depth re-pack in `WebGPUSceneRendererFrustumLoop.ts` so picking over a glTF Model returns the model top, not the globe behind it (probe-pickposition-model-webgpu.mjs: WebGPU h matches WebGL within 30 m; pre-fix WebGPU returned the globe ~174 km off). The same reconstruction now also backs WebGPU sampleHeight/clampToHeight (NEW-PICK-RAY-ASYNC, Batch 284). Metadata/voxel center-pixel readback completed by NEW-PICK-METADATA-READBACK (Batch 285). (SHIPPED)

- NEW-PICK-RAY-ASYNC — `scene.sampleHeight`/`scene.clampToHeight` return a real globe/tileset surface height/position on WebGPU (Batch 284; sibling of NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION). The offscreen ray-render depth path can't recover a position on async-readback backends (its PickDepth instances never get `update()`, and the shared globe-depth is LOG-encoded against the MAIN camera, not the offscreen one), so `Picking._reconstructHeightSurfaceWebGPU` reuses the main scene's already-rendered depth: project the target into the live view (`SceneTransforms.worldToWindowCoordinates`), reject off-screen positions, then read the surface beneath that pixel via `Picking.pickPositionWorldCoordinates` (the Batch-252 full-frustum log reconstruction). Inherits the one-frame-stale sync cache (cold→undefined→converge in 1-2 frames; number|undefined for sampleHeight, Cartesian3|undefined for clampToHeight — never a Promise). Limitation: resolves only for in-view positions, and the reconstructed point is on the camera ray through the pixel (near-nadir matches within metres; oblique drifts). pickFromRay over an ARBITRARY ray is scoped out — it returns the hit object with `position` undefined and emits `oneTimeWarning("WebGPU.pickFromRay.noPosition", …)` (no throw); arbitrary-ray async position needs an offscreen GlobeDepth pack + per-view readback (deferred). Evidence: probe-pick-ray-async.mjs — WebGPU sampleHeight cold→converge frame 1, dH 3.5 m vs WebGL, clampToHeight at exact (-75,40), pickFromRay undefined+warning no-throw, 0 errors; probe-sampleheight-webgpu.mjs rewritten to the working-parity assertion. (SHIPPED)
- NEW-PICK-METADATA-READBACK — `WebGPUPickFramebuffer.readCenterPixel` (consumed by `scene.pickMetadata` → `Picking.pickMetadata` and `scene.pickVoxel` → `Picking.pickVoxelCoordinate`) now reads the JUST-RENDERED metadata/voxel pass on WebGPU instead of a stale pixel from the previous regular `scene.pick()` color pass (Batch 285). Pre-fix it sliced `_lastReadPixels` (only populated by the color path) so the metadata/voxel pixel was never read, and it had no re-entrancy guard. Fix mirrors `PickDepth.getDepth`: `readCenterPixel` arms its own guarded (`_centerReadbackInFlight`) 1×1 `copyTextureToBuffer` readback of the current center pixel, returns a one-frame-stale cache keyed to (center coord ±2 px + `_updateCount` frame stamp ≤4 picks), normalizes `bgra8unorm`→`[R,G,B,A]`; cold query → `[0,0,0,0]` + arm, converges 1-2 frames later. `Picking.pickMetadata`/`pickVoxelCoordinate` now `context.endFrame()` BEFORE `readCenterPixel` so the render is submitted ahead of the readback copy (no-op on WebGL). Bonus: fixed the WebGPU Voxel COLOR pipeline's missing `multisample.count = context._msaaSamples` bake (`WebGPUVoxelRenderer.ts`) that crashed the scene pass with an attachment-state mismatch on any MSAA scene. Evidence: probe-pick-metadata.mjs — exercises the shared readback against a known-pickable Box's pick FBO (WebGPU converges to the same non-zero pick color WebGL reads sync; guard exists + clears; 0 errors across 20 rapid re-reads). Asset gaps documented: live voxel-coordinate parity blocked by the SCAFFOLDED placeholder voxel renderer (`C-R9-VOXEL-CELL-PICK`), and full metadata decode needs an ion `EXT_structural_metadata` tileset (no local asset) — both noted, the shared readback mechanism itself is verified. (SHIPPED — closes deferred entry)
- C-R9-MODEL-FEATURE-PICK — WebGPU b3dm/glTF per-feature pick resolves to a `Cesium3DTileFeature` / `ModelFeature` with readable batch-table properties (Batch 209). Fixed the pick FS gating the per-feature texture lookup on alpha (0 for keys <2^24 → gate on RGB) + registered `batchTexture._owner.getFeature(fid)` (the real feature object WebGL registers) instead of a bare `{primitive,id}`. `feature.getProperty(...)` works; verified identical to WebGL. (SHIPPED — closes deferred entry, moved from §C WIP)
- C-R9-MODEL-PICK-TRANSLUCENT — full dual-path translucent pick (Batches 186 + 192). First slice: BLEND alphaMode pick with `depthWriteEnabled: false` + `baseColor.a < 0.004` discard. Second slice: `Scene.pickHoverAsync` (stochastic dither alpha-test via Jimenez IGN — guaranteed stutter-free at 60fps hover) + `Scene.pickPreciseAsync` (stencil-coordinated 2-pass — deterministic geometrically-closest translucent fragment wins). Coalesce + defer mitigations for worst-case both-fired-same-frame cost. (SHIPPED — closes deferred entry)
- Stochastic dither alpha-test infrastructure (Batch 192) — `csm_stochasticDither.wgsl` chunk + `STOCHASTIC_DITHER_ALPHA` ShaderDefine bit. Currently consumed by hover pick; downstream hooks opened in voxel ray-march and TAA jitter for future amortization. (SHIPPED)
- Stencil-coordinated multi-pipeline pick render (Batch 192) — single render pass, multi-pipeline-switch coordination via stencil ref. `STENCIL_PICK_WINNER` ShaderDefine bit. Pattern reusable for any future winner-take-all pass. Stencil reference activation fixed in Batch 194 audit. (SHIPPED)
- TAA blue-noise jitter (Batch 195) — `ignJitter(frameIndex, axis)` replaces Halton 2/3 with Jimenez Interleaved Gradient Noise for sub-pixel jitter. Better temporal decorrelation under TAA accumulation; first downstream consumer of Batch 192's csm_stochasticDither infrastructure. (SHIPPED)
- Voxel ray-march IGN ray-start jitter (Batch 196) — anti-aliases sample positions across pixels via fragment-stage IGN, reducing banding artifacts in volumetric renders. Compounds with TAA blue-noise jitter for temporal smoothing. Second downstream consumer of csm_stochasticDither. (SHIPPED)
- Per-object cache device-loss recovery walk (Batch 197 closes C-R12-PER-OBJECT-CACHES) — `clearPerObjectCaches(scene)` recursively walks `scene.primitives`/`groundPrimitives` and clears `_webgpuCache` on shadowMap + postProcessStages during device-loss. Belt-and-suspenders correctness. (SHIPPED)
- WebGPU timestamp-query auto-enable on first `Scene.pickPreciseAsync` (Batch 197 closes B192-N2) — defer mitigation now reads `performanceManager.frameTimings.totalGpuMs` and pushes precise pick to next frame when last frame >12ms. Auto-opted-in only when precise pick is actually used. (SHIPPED)
- User-supplied WGSL post-process stages (Batches 198 + 199 + 204 close NEW-POSTPROCESS-USER-WGSL fully) — `Scene.postProcessStages.add(...)` user stages with `wgslFragmentShader: string` uniform compile + chain. **Batch 198 first slice:** single bind group (source texture + sampler + 64-byte UBO), iteration-order uniform packing. **Batch 199 audit fixes:** HDR precision via `_intermediateFormat`; auto-exposure ordering corrected. **Batch 204 second slice:** `wgslUniformSchema` for named-uniform packing with vec2/3/4 alignment; `wgslNumberOfPasses` multi-pass support with ping-pong textures and per-pass index. Future deferred: texture/sampler bindings beyond source pair, GLSL→WGSL transpiler. (SHIPPED — closes deferred entry)
- HDR-DISPLAY canvas HDR output first slice (Batch 200) — `Scene.useHDRCanvasOutput` opt-in flag skips tonemap when set alongside `Scene.highDynamicRange`. Forward HDR-encoded scene color to canvas for OS/display gamut + tone curve handling on HDR-10 / Dolby Vision displays. Canvas configure side (rgba16float + display-p3 + extended toneMapping) deferred to a follow-up slice. (SHIPPED — first slice; **B200-D1 audit note 2026-05-07: colorGrading still runs on HDR data when tonemap skipped — produces wrong saturation/lift/gain. B200-D2: FXAA's SDR-tuned edge thresholds also misfire on HDR. Both fix in Batch 205.**)
- FEAT-GAP-09 aerial-perspective LUT progress (Batches 201-202) — 6 more primitive LIT shaders wired (BumpMapLit, NormalMapLit, GridLit, StripeLit, CheckerLit, RimLightingLit). 12 of ~44 primitive shaders now consume the LUT; high-traffic shaders covered. (PROGRESS — incremental closure)
- NEW-FEATURE-ID-VERTEX-ATTR — vertex-attribute feature ID + EXT_mesh_features `_FEATURE_ID_0` + `FeatureIdImplicitRange` synthesis (Batches 130 + 188) (SHIPPED — closes b3dm per-feature-pick path)
- C-R10-GLOBE-POINT-LIGHT — globe terrain receives cube/point-light shadows via `globeSamplePointShadow` + `globeComputeShadowFactorPointLight`; matched ordering with model FS (point-light first, CSM second, 2D shadow last) (Batch 108) (SHIPPED — closed via doc-sync Batch 190)

### B.9 Debug & Diagnostics

- CesiumDebug global console helpers — help / snapshot / pipelineStatus / postProcess / canvasPixels / logImageryProbe (SHIPPED)
- CesiumDebug.showDepth/hideDepth — depth-buffer grayscale overlay via WebGPUDebugDepthOverlay (SHIPPED)
- CesiumDebug.showWireframe/hideWireframe — wireframe overlay via WebGPUGlobeSurfaceWireframe (SHIPPED)
- CesiumDebug.showFrustums — colorize frustum splits via WebGPUDebugFrustumOverlay (SHIPPED)
- CesiumDebug.showCommands — command-count HUD overlay (SHIPPED)
- CesiumDebug.toggleFPS — FPS counter (SHIPPED)
- CesiumDebug.cpuPassCost(t/f) — CPU per-pass cost dump for R-7a profiling (SHIPPED, Batch 165)
- WebGPUDebugDepthOverlay / WebGPUDebugFrustumOverlay — debug overlay renderers (SHIPPED)
- viewer.scene.getDebugSnapshot() / logDebugSnapshot() — full state dump for Playwright debugging (SHIPPED)
- WGSL pragma stripping via stripPragmaPlugin extension to .ts — debug code stripped in production (SHIPPED)
- _diagShouldLog() predicate pattern — pragma-aware throttle returning `false` in production (SHIPPED)
- BUG-12 clear-loop sentinel — re-entry/infinite-loop guard with throttled console.error (SHIPPED)
- BUG-13 null PP-views guard — null source/destination texture-view check at render-pass boundaries (SHIPPED)
- BUG-15 index-overflow guard — buffer-size validation before draw, clamp to safe value (SHIPPED)
- WebGPUCollectionRendererBase — shared base for the collection feature renderers; folds the resident-instance-manager per-frame flow (lazy create + capture→sync→consume ordering), scene-format-gen pipeline invalidation, settled-2D/CV coplanar-depth flag/key, per-device shader-module-cache accessor, the re-entry/null-target/overflow sentinels, and grow-on-demand pick buffer mgmt. Billboard + Point migrated (Batch 302); Cloud + Polyline migrated (Batch 307 — folded the shader-module-cache accessor + re-entry sentinel for both, plus `computeNoDepthTest` for Polyline; each keeps its unique non-resident/bucket-shaped pack + pipeline logic). Label still pending its own stage (full-rebuild-on-any-dirty + atlas-guid path). (SHIPPED, Batch 307, NEW-COLLECTION-RENDERER-BASE)
- Collection error sentinels — the three mandated permanent sentinels in the collection base: re-entry/infinite-loop guard (sane-limit depth, synchronous-bracketed), null-target guard (null buffer for non-zero visible count), size-validation/overflow guard (pick writeBuffer clamp). Unit-tested 10/10 (SHIPPED, Batch 302, NEW-COLLECTIONS-ERROR-SENTINELS)
- BUG-11 canvas-black-screen probe scripts (Batches 89-93) (SHIPPED)
- WebGPUParityManager log-once guards — preserves single-emit semantics for parity warnings (SHIPPED)
- Async pick with staleness validation — PlayCanvas pattern in WebGPUPickFramebuffer (SHIPPED)
- Async-aligned depth picking — `.then()` chains depth + ray for WebGPU camera (SHIPPED)
- Depth-readback guards — prevent camera jitter when readback fails (SHIPPED)

### B.10 Compat / Migration Layer

- WebGLCompatibilityStub.ts — full WebGL2-shaped facade over a WebGPU device (SHIPPED, rewritten Session 35)
- WebGPUContextWebGLStubInit.ts — builds the stub during context init (SHIPPED)
- WebGLStateConverters.ts — WebGL enum → WebGPU descriptor field translators (SHIPPED)
- WebGLStubPipelineExtractor.ts — extracts pipeline state from WebGL-style call sequences (SHIPPED)
- Stubs/WebGLStub{Buffer,Framebuffer,PipelineState,Shader,Texture,Types}.ts — per-resource stubs (SHIPPED)
- WebGPUNagaTranspiler.ts — Naga-wasm-driven WGSL ↔ SPIR-V/MSL/HLSL translation surface (EXPERIMENTAL)
- WebGPUShaderTranslator.ts — pluggable GLSL → WGSL translation entry point (EXPERIMENTAL)
- packages/wasm-naga/ — vendored Rust + WASM Naga build with test harnesses (EXPERIMENTAL)
- cesium-js-types.d.ts + webgpuTypeHelpers.ts — ambient TypeScript surface for cross-module JS/TS interop (SHIPPED)
- loadCubeMapWebGPU.ts — WGPU-specific cubemap loader paralleling upstream `loadCubeMap.js` (SHIPPED)

---

## C. WIP — Work In Progress

Partially shipped features with known gaps. Working code exists but the feature isn't fully wired or has limitations.

### C.1 Globe & Imagery

- ~~BUG-11 globe geometry never rasterizes~~ — ✅ STALE/RESOLVED (Wave 0 verify, Batch 211). The globe demonstrably rasterizes on WebGPU (probe-globe-rasterizes.mjs: N. America + oceans + atmosphere limb, WebGL color parity, 0 GPU errors). The "never rasterizes / canvas BLACK" framing outlived the code. Residual narrows to the imagery-tile dark-patch symptom (WEBGPU_DEBUGGING_LOG.md:3982); the orthogonal pickPosition-returns-no-depth issue is FORK-34/C-R9 (separate). (BACKLOG-§1)
- C-R1-GLOBE-RENDERSTATE: GlobeSurfaceRenderer builds variants from hardcoded state instead of upstream `command.renderState` (C-R1-GLOBE-RENDERSTATE)
- ~~BUG-3 SCENE2D blank~~ — ✅ RESOLVED (Batch 215). Columbus View always worked; SCENE2D rendered only a thin left-edge sliver. The Batch-214 "corrupted ortho" diagnosis observed a real SYMPTOM (two ortho widths per frame, ~30× apart) but the prior root-cause guesses (missing 2D bounding volume; ortho-width re-derived from the per-band camera-Z compress) were both DISPROVEN at runtime: WebGL's `camera.frustum` left/right shows the **identical** two-value pattern and renders fine, and the camera-Z compress (`numFrustums>1` branch) isn't even taken at the default 2D view (`numFrustums===1`).
  - ACTUAL root cause: `execute2DViewportCommands` (`ViewportExecutor.js`) renders the 2D infinite-scroll wrap by splitting the frame into **two viewport halves**, calling `executeCommands` **twice per frame** — each with its own off-center `camera.frustum` and `passState.viewport` sub-rect (THAT is the "two widths"/"alternation" the instrumentation saw — two halves of one frame, not frame-to-frame drift). WebGL accumulates both halves into one framebuffer (clear on the first half only, blit at scene level). WebGPU's `executeCommands` ran its FULL pipeline each call (scene-FB clear + frustum loop + post-process blit to canvas), so the second half cleared away the first half → only one viewport half (the sliver) survived.
  - Fix: accumulate both halves into the scene framebuffer and blit once. `executeCommandsInViewport` sets `scene._exec2DSceneFbLoad` (2nd half → open scene-FB color with `loadOp:"load"` instead of clear) and `scene._exec2DDeferComposite` (1st half of a split → skip the post-frustum chain / blit); `execute2DViewportCommands` sets `scene._is2DViewportSplit`. `SceneRenderer.executeCommands` forwards them as `config.sceneFbLoad`/`config.deferComposite` to the WebGPU renderer, which (a) opens the scene-FB pass with the per-half viewport (`_viewportX/Width`, was hard-coded full-canvas) + conditional `loadOp`, (b) skips `executePostFrustumChain` on the deferred half, and (c) balances the perf/profiler `beginFrame`(1st half)/`endFrame`(2nd half) pair. All flags default false → the non-2D / single-viewport path is byte-for-byte unchanged. Files: `ViewportExecutor.js`, `SceneRenderer.js`, `WebGPUSceneRenderer.ts`, `WebGPUSceneRendererPassRedirect.ts`. Verified WebGL parity: 2D nonBlackPct 96.8%↔96.8%, CV 81.5% unchanged, 3D unaffected, 0 console/device errors; PNGs show the full flat map with the wrap seam working (probe-2dcv-verify.mjs, probe-2d-blank-where.mjs). (BACKLOG-§1)
- ~~MORPH globe terrain — splay during transition~~ — ✅ RESOLVED (Batch 216, from the webgpu-morph-review audit). During every 3D⇄CV / 3D⇄2D transition the WebGPU globe terrain exploded apart (tiles splayed to the screen edges around a black hole) for the WHOLE animation, snapping correct only at the endpoints — because `scene._mode` stays MORPHING until the final frame, so the buggy branch ran throughout. Root cause: the WGSL MORPHING branch (`GlobeTerrain.wgsl:1103-1113`) multiplies a WORLD-space morph position (`position3DWC = exaggeratedPosition + center3D`) by the **center-baked** `modifiedModelView(Projection)`, double-counting the ~6.4 Mm tile center per tile. WebGL's `getPositionMorphingMode` (GlobeVS.glsl:172-182) uses **plain `czm_modelView`/`czm_projection`** (the globe command's modelMatrix is identity), reserving the center-baked matrix for the tile-LOCAL planar/3D paths. Fix: `WebGPUGlobeSurfaceCameraUB.ts` now packs a PLAIN view (zero RTC center) for `sceneMode === 0` so the morph branch's matrices equal WebGL's. Also fixed (Batch 216): ground polylines froze at their flat 2D shape mid-morph — `WebGPUGroundPolylineRenderer.js:1666` read a nonexistent `uniformState.morphTime` (always undefined → 0.0 during the whole morph); corrected to `frameState.morphTime`, matching the sibling ground-primitive renderer. Verified across the full morphTime range (probe-morph-midframe.mjs: sphere→half-flat→flat-map, no splay, WebGL parity; 2D/CV/3D non-regression; 0 errors; PNGs read). Remaining morph gaps deferred — see `DEFERRED_WORK.md` "Scene-mode morph pillar" (exaggeration-in-morph/CV needs WebGL-faithful skirt handling — the naive ungate shatters terrain into skirt walls, reverted; PolylineCollection 2D/CV; collection audit; TAA prev-VP; etc.). (BACKLOG-§1)
- ~~BUG-1 stars/skybox / sun~~ — ✅ RESOLVED (Batch 214). stars/skyBox already rendered; the "sun absent" was a MISDIAGNOSIS — the sun was a tiny aspect-squashed glow-less ellipse (20×11 px) easily lost against the stars, NOT actually missing, and the mvpRTE projection was correct. Two real defects in `WebGPUEnvironmentRenderer.js`: (1) `packSunUniforms` hard-coded `sunSize=(0.02,0.02)` NDC — never derived from the solar angular radius/glow length and not aspect-corrected. Fixed: NDC half-extent = `(SOLAR_RADIUS / camera→sun dist) * projection[0|5] * (1 + 2*glowLengthTS)` (proj[0]/[5] auto-correct aspect → circular). (2) `createSunTexture` made the disc fill 85% of the texture with no flare. Fixed: replicated WebGL `SunTextureFS.glsl` — small central disc (`u_radiusTS`) + soft glow halo (`1-smoothstep(0,0.55,r)`) + 6 lens-flare bursts; the FS is now a near-passthrough sample (was adding a redundant exp glow). Verified at WebGL parity (probe-sun-pixel-check.mjs: WebGPU disc 12×13 + glow 60×63/2912px vs WebGL 14×14 + 60×63/2931px; PNGs visually identical). Follow-up: dynamic `sun.glowFactor` (currently default 1.0) + the canonical Environment/Sun.wgsl horizon-occlusion (the renderer uses the inline SUN_SHADER_WGSL). (BACKLOG-§1)
- DP-H19-SHADER-DECODE-RUNTIME: GPU compressed-vertex decode scaffold landed; runtime flip + per-shader expansion remaining (BACKLOG-§Recent)

### C.2 3D Tiles

- C-R1-CLASSIFICATION primitives need 3-pass renderState (stencil-depth/color/pick) routed through pipeline variants (C-R1-CLASSIFICATION)
- C-R1-TILE-BATCH per-feature `Cesium3DTileBatchTable` renderState (depthMask flip, custom blend) not consumed by WebGPU model emission (C-R1-TILE-BATCH)
- ~~NEW-BG-CONSOLIDATION: ModelPBR 8 bind groups > spec default 4 → breaks b3dm on Edge/Vulkan~~ — ✅ STALE/RESOLVED (Wave 0 verify, Batch 211): b3dm renders correctly on WebGPU/Edge with WebGL parity, 0 near-black px, 0 GPU validation errors (probe-b3dm-render-edge.mjs, BatchTableHierarchy on Edge). The bind-group ceiling was addressed earlier (ModelPBRComplete declares groups 0-3); the "b3dm black on Edge" framing is stale. (NEW-BG-CONSOLIDATION)
- ~~C-R9-MODEL-FEATURE-PICK code wired but un-testable~~ — RESOLVED (Batch 209): b3dm/glTF per-feature pick returns a Cesium3DTileFeature/ModelFeature with readable properties, at WebGL parity. Moved to §B SHIPPED. (C-R9-MODEL-FEATURE-PICK)
- 3D Tiles tile pop-in motion-vector NaN reject for TAA disocclusion deferred to TAA Slice 4 (TAA-DESIGN)
- 3D Tiles per-tile cascade culling deferred to CSM Slice 4 (CSM-DESIGN)
- TILE-ARCH-SHADER-STRATEGY: monolithic shader trade-off silently drops KHR extensions; gates ~30% of Phase 7 items (BACKLOG-§Phase 8)
- FEAT-3DT2-02 property-texture + feature-ID WGSL sampling audit incomplete (FEAT-3DT2-02)
- FEAT-3DT2-03 ellipsoid-aware RTE — non-WGS84 (Mars/Moon) tilesets are positionally wrong (FEAT-3DT2-03)
- FEAT-3DT2-05 Draco/KTX2/meshopt WebGPU end-to-end audit pending (FEAT-3DT2-05)
- Tile↔Hi-Z wiring: dispatcher exists but consumes ViewportExecutor command lists, not tile bounding volumes (Phase-8a)

### C.3 glTF Models + KHR Extensions

- ~~NEW-KHR-ANISO-TANGENT: anisotropy approximated via view-relative tangent~~ — ✅ RESOLVED (Batch 210). Direct-light path already used the authored TANGENT (AUDIT_2026_05_02 B.5); Batch 210 adds the IBL anisotropic bent-normal (`ModelPBRComplete.wgsl` ~2659), matching WebGL `ImageBasedLightingStageFS.glsl:78-86` (bend about `cross(N, rotatedTangent)`). NOTE: pixel-parity vs WebGL is currently blocked by a SEPARATE pre-existing WebGL GLSL compile bug on TestKhrAnisotropy.gltf (`computeTangent`/`normalTexCoords` undeclared @0:366) — see NEW-WEBGL-ANISO-GLSL-BROKEN below. (NEW-KHR-ANISO-TANGENT)
- ~~NEW-KHR-IRIDESCENCE-LUT: hue-shift approximation~~ — ✅ ALREADY SHIPPED (Batch 181, doc was stale). `ModelPBRComplete.wgsl:2107-2226` implements the Belcour 2017 analytical thin-film integral (spec-compliant; no LUT needed — per-wavelength sensitivity baked as Gaussian fits). (NEW-KHR-IRIDESCENCE-LUT)
- ~~NEW-KHR-TRANSMISSION-THICKNESS: fixed 0.05 refraction offset~~ — ✅ ALREADY SHIPPED (Batch 176, doc was stale). `ModelPBRComplete.wgsl:2469` couples the refraction UV step to volume thickness via `thicknessStepScale = 1.0 + 4.0 * thicknessForKHR`. (NEW-KHR-TRANSMISSION-THICKNESS)
- NEW-WEBGL-ANISO-GLSL-BROKEN (found Batch 210): the **WebGL** model FS fails to compile for KHR_materials_anisotropy assets — `ERROR 0:366 'normalTexCoords' undeclared` + `'computeTangent' no matching overloaded function` (rendering halts with the error dialog). Pre-existing, NOT a WebGPU issue; blocks WebGL-vs-WebGPU anisotropy pixel-diffs. Likely the anisotropy GLSL stage references a normal-texture varying/function absent in the anisotropy-without-normal-texture permutation. Separate WebGL fix. (NEW-WEBGL-ANISO-GLSL-BROKEN)
- ~~KHR_lights_punctual not wired in WebGPU model path; shader hardcodes 1 sun + ambient~~ — ✅ RESOLVED: loader (Batch 134) + LightCollection + Forward+ clustered consumer (Batch 153) deliver multi-light point/spot/directional per-pixel lighting beyond the sun in ModelPBRComplete. Lit Mat shaders still sun-only pending Batch 154+. (Phase-8 §2)
- KHR_materials_variants / IOR / clearcoat-IOR coupling unwired on WebGPU (Phase-8 §2)
- 5 default textures bound on every model draw even when unused (cost on every fragment) (Phase-8 §2)
- NEW-EDGE-DISPLAY-MODE-WEBGPU (found by WEBGPU_PARITY_AUDIT_2026-06, post-merge v1.142): the WebGPU model-edge path (`WebGPUEdgeFramebuffer` MRT infra + `WebGPUEdgeVisibilityEmitter`, §B.6) is only PARTIALLY realized vs upstream `EdgeDisplayMode`. Two tri-mode gaps + three data-path gaps: **(tri-mode)** `SURFACES_ONLY` (the DEFAULT) must HIDE all extension edges, but the emitter gates only on `defined(edgeGltfPrimitive?.edgeVisibility)` and never reads `model.edgeDisplayMode`, so any edge-bearing glTF emits edges in the default mode (visible divergence on the most common CAD/BIM config); `EDGES_ONLY` (CAD wireframe) renders surfaces with NO edges — the inverse of intent — because there is no `CESIUM_3D_TILE_EDGES_DIRECT` pass (slot 12) in the WebGPU frustum loop (commands binned there silently never execute), the emitter hardcodes `Pass.CESIUM_3D_TILE_EDGES`, and the surface command is emitted unconditionally with no EDGES_ONLY suppression. **(data paths)** the WebGPU extractor consumes only the per-triangle 2-bit `edgeVis.visibility` encoding and early-returns otherwise, so it is missing (1) explicit `lineStrings` edges (BENTLEY/styled-gltf-lines assets yield zero WebGPU edges), (2) the authored `silhouetteNormals` signed-byte accessor (WebGPU re-derives face normals from adjacency → silhouette classification can diverge, and the PR#13421 degenerate-triangle repro can't be confirmed clean since the synthesized normal biases the dot-product differently), and (3) per-edge / per-lineString `materialColor` overrides (WebGPU applies one primitive-level color, no `a_edgeColor` equivalent). Files: `WebGPUModelRenderer.js`, `WebGPUEdgeVisibilityEmitter.ts`, `WebGPUSceneRendererFrustumLoop.ts`, `WebGPUSceneRenderer3DTilePasses.ts`, `WebGPUSceneRenderer.ts`. Tracked in DEFERRED_WORK NEW-EDGE-DISPLAY-MODE-WEBGPU. (NEW-EDGE-DISPLAY-MODE-WEBGPU)

### C.4 Classification

- ADR-2026-04-28 architecture migration in progress — depth-sampling classifier replacing stencil; multi-frustum work folded into Sessions 3+ (ADR-2026-04-28)
- NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION: flat textured GroundPrimitive materials render (Batch 185, see §B.3), but the textured classifier degrades toward the far corner — a real eye-space reconstruction-precision artifact (standard-depth `windowToEye` catastrophic cancellation near `storedDepth ≈ 0.9999997`). Stripe (1-D) hides it; Checkerboard (2-D) exposes it. **UNBLOCKED as of Batch 251** — renderer-wide log depth is LIVE (master switch TRUE; the classifier's log consumer-reverse runs, probe-classifier-scenemode at WebGL parity in all 3 modes); re-verify the far-corner case via probe-classifier-textured-materials.mjs and close. Canonical detail in `WEBGPU_DEBUGGING_LOG.md`. (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION)
- NEW-GS-CLASSIFICATION-DEPTH: Gaussian Splat translucent tiles classify against globe-depth, not splat-depth (NEW-GS-CLASSIFICATION-DEPTH)
- C-R8-GROUND-POLYLINE-NATIVE: ~~RESOLVED 2026-04-30 (Batch 116 + viewport-zero VS extrusion fix); now ships full classifier velocity in Batch 183~~ (C-R8-GROUND-POLYLINE-NATIVE — moved to §B)
- C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES: per-feature pick reserved but not written; distinct depth-source per pass not yet routed; `DEBUG_SHOW_VOLUME` mode unimplemented (C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES)
- Volumetric tile classification multi-frustum accumulation paused (folded into Migration Session 3) (C-R8-TRANSLUCENT-MULTI-FRUSTUM)

### C.5 Picking

- ~~C-R9-MODEL-PICK-TRANSLUCENT~~: closed Batch 192 — dual-path API (`Scene.pickHoverAsync` for stutter-free 60fps hover via stochastic dither, `Scene.pickPreciseAsync` for click-pick determinism via stencil-coordinated 2-pass) supersedes the original "OIT-quality A-buffer" plan that turned out to be architecturally blocked by WebGPU primitives. (C-R9-MODEL-PICK-TRANSLUCENT — moved to §B)
- C-R9-VOXEL-CELL-PICK: per-cell granularity unsupported (cell coords don't fit in 4-byte pickColor). Broader: the WebGPU voxel data path is an XL placeholder scaffold — `VoxelPrimitive.update()` short-circuits when the VOXEL_PRIMITIVE FR is registered, so it never reaches CustomShader / `processVoxelProperties` / `buildVoxelDrawCommands` / `buildVoxelCustomShader`; `WebGPUVoxelRenderer.ts` is a hardcoded RGB-density ray-marcher on a 4×4×4 gradient placeholder, and there is no WGSL transpilation of CustomShader GLSL. Consequently the upstream **PR#13517 default voxel shader for common metadata types is UNREACHABLE** on WebGPU — it is one piece of a feature whose entire data path is unimplemented (provider/megatexture/octree traversal all unwired). (C-R9-VOXEL-CELL-PICK)
- Picking 6.1 main scene depth-blit shader still pending (globe depth blit done) (BACKLOG-§4)
- Pick layer filtering bitmask (6.2), octree pick acceleration (6.3) unwired (BACKLOG-§4)
- ~~C-R1-COLLECTIONS-PER-ENCODER: 5 collections don't call `applyPerEncoderState`~~ — ✅ STALE/RESOLVED (verified Batch 210). All five named collections DO forward their renderState to the draw command, so `WebGPUDrawCommand.execute` runs `applyPerEncoderState`: Billboard (`_rsOpaque`/`_rsTranslucent`), Cloud (`WebGPUCloudRenderer.ts:738` `_rs`), Point (`WebGPUPointPrimitiveRenderer.js:1125,1327`), Polyline (`_opaqueRS`/`_translucentRS`), Label (`WebGPULabelRenderer.js:1129,1151` `labelRS`). (NOTE: the separate Buffer* collections — BufferPoint/Polyline/Polygon — expose no custom render-state API, so there is nothing to forward there yet; revisit if they gain one.) (C-R1-COLLECTIONS-PER-ENCODER)
- TAA Slice 4 needs picking depth-readback un-jittering (TAA-DESIGN)

### C.6 Shadows / Lighting

- CSM Slice 2d Mat-Lit receivers — closed by audit; doc-only recipe preserved (CSM-DESIGN)
- CSM Slice 3 altitude-adaptive splits (orbital regime collapse) pending (CSM-DESIGN)
- CSM Slice 3 moon dual-light cascades pending (CSM-DESIGN)
- CSM Slice 3 VSM-style soft shadows via rg32float variance pending (CSM-DESIGN)
- CSM Slice 4 3D Tiles per-tile cascade culling pending (CSM-DESIGN)
- CSM Slice 4 snapshot-mode freezable contract pending (CSM-DESIGN)
- CSM Slice 4 WebGL backend parity path pending (CSM-DESIGN)
- C-R10-GLOBE-POINT-LIGHT: globe terrain doesn't receive cube/point-light shadows (C-R10-GLOBE-POINT-LIGHT)
- C-R10-CAST-LINEAR-DEPTH: alternative linear-depth cast pipeline unimplemented (perf micro-opt) (C-R10-CAST-LINEAR-DEPTH)
- SHADOW-LAYOUT-QUANTIZED: quantized terrain (stride-8 u16, stride-12 f16) not in shadow cast variant table (SHADOW-LAYOUT-QUANTIZED)
- Sun-below-horizon depth test against inner sphere needs wiring into Sun.wgsl (CELESTIAL §4.1)

### C.7 Post-process & Effects

- TAA Slice 2b: per-model MRT motion vectors for skinned/morphed/instanced primitives pending (TAA-DESIGN)
- TAA Slice 3 YCoCg variance clipping (3×3 neighborhood) pending — current is tonemap-space AABB (TAA-DESIGN)
- TAA Slice 3 particle `previousPositionWC` pending (TAA-DESIGN)
- TAA Slice 4 CSM+TAA shadow-edge motion correctness verification pending (TAA-DESIGN)
- TAA Slice 4 WebGL parity path (MRT motion + GLSL accumulate) pending (TAA-DESIGN)
- ParityManager landed FEAT-SURVEY-07; WebGPUTAAEffect refactor to delegate `_historyIndex` still pending (FEAT-SURVEY-07)
- FEAT-SURVEY-06 decoupled-lookback prefix-sum WGSL landed; consumer wiring (cull compaction, indirect-draw compaction) still uses legacy two-pass (FEAT-SURVEY-06)
- FEAT-GAP-09 aerial-perspective LUT consumer — 12 of ~44 primitive shaders now wired (PhongTexturedColor + PhongColor + PBRSimple + PBRTextured + MatColorLit + MatImageLit + MatBumpMapLit + MatNormalMapLit + MatGridLit + MatStripeLit + MatCheckerLit + MatRimLightingLit). ~32 remaining (mostly less-common material variants — Mat{Aspect,Slope,Elev}Ramp, Mat{Aspect,Slope,Elev}Contour, Mat{Alpha,Bump,Specular,Normal,Emission}Map{Flat}, Mat{Checker,Color,Dot,Fade,Grid,Stripe,Water}Flat, MatWaterLit, etc.); pick variants intentionally excluded (fog would corrupt pickColor). Closed for high-traffic shaders; remainder rides along incremental upgrade rule. (FEAT-GAP-09)
- WGF-1 hardware `clip-distances` — SHIPPED-partial (globe path live); remainder tracked as WGF-1-EXPAND below.
- WGF-1-EXPAND clip-distances only wired in globe; Primitive shaders have struct but no VS output; Models lack clipping plane support entirely (WGF-1-EXPAND)
- WGF-1-INTERSECTION mode clipping with hardware clip distances (currently union-only) (WGF-1-INTERSECTION)
- WGF-3 `shader-f16` — SHIPPED-partial (Tonemapping path live); remainder tracked as WGF-3-EXPAND below.
- WGF-3-EXPAND shader-f16 only in Tonemapping; ColorGrading/FXAA/Bloom/etc. variants pending (WGF-3-EXPAND)
- WGF-4-EXPAND RTE assertions in 5 of 8 camera packers (Cloud/Ellipsoid/Splat/PointCloud/Voxel pending) (WGF-4-EXPAND)
- HDR-DISPLAY canvas HDR output (skip tonemap on wide-gamut displays) pending (HDR-DISPLAY)
- AUTO-EXPOSURE-TUNE adaptation rate not exposed (AUTO-EXPOSURE-TUNE)
- OPEN-1-DIAGNOSE sky atmosphere shader compile failure root cause TBD (OPEN-1-DIAGNOSE)
- Volumetric fog Phase 5a-5d SHIPPED (height fog + HG scattering + sun-shadow god rays + 3D-noise varying density); `atmosphericConditions.volumetricFog.enabled` defaults FALSE per B18 lock so users still opt-in. Phase 5f temporal reprojection polish deferred (CELESTIAL §4.8)
- Volumetric clouds Phase 6 main render path SHIPPED via `WebGPUProceduralCloudRenderer` (Schneider HG dual-lobe + Beer-Powder + 3D FBM); `atmosphericConditions.clouds.enableVolumetric` defaults FALSE per B15 lock. Phase 6c (cloud shadows in volumetric fog froxel) + 6d (quality dial) + 6b (≥100km 2D fast-path crossfade, may be unnecessary given single-renderer arch) — deferred to future session (CELESTIAL §4.6)
- Volumetric clouds Phase 6 (`enableVolumetricClouds`) opt-in; ships after froxel infrastructure 5a-5d (CELESTIAL §4.6)
- Varying atmosphere density (`enableVaryingAtmosphereDensity`) defaults FALSE; no-op when volumetric fog off (CELESTIAL §4.9)

### C.8 Performance & Compute

- ~~C-R7-SHADER-MODULE-DEDUP~~: closed Batch 185 — every Cesium-authored WGSL renderer now routes through `WebGPUShaderModuleCache.getOrCreate` (C-R7-SHADER-MODULE-DEDUP — moved to §B)
- WebGPUModelRenderer + WebGPUAutoExposure don't route through central pipeline cache (`WebGPUComputePipelineCache` doesn't exist) (BACKLOG-§Recent)
- BUILD-VAR-MEASURE: variant size measurement run incomplete (BUILD-VAR-MEASURE)
- BUILD-VAR-RUNTIME-TEST: cross-variant browser smoke test pending (BUILD-VAR-RUNTIME-TEST)
- WebGPUContext.ts decomposition in progress — 4354 LOC, 6 high-value extraction candidates queued (CONTEXT_DECOMPOSITION)
- WebGPUSceneRenderer.ts decomposition in progress past Batches 133-142 (CONTEXT_DECOMPOSITION)
- Indirect drawing for 3D Tiles (4.6) — opt-in flag landed S26; needs consumer renderer with homogeneous pipeline+bindgroup runs (BACKLOG-§4.6)
- ✅ HIZ-OCCLUSION-CONSUMER — **FULLY FIXED (Batches 212+213); was a P0 black-screen.** Wave 0 found the Hi-Z/GPU-cull consumer black-screened any dense (≥2400 opaque-cmd) WebGPU scene (0 px, 702 validation errors caught by the Batch 208 gate). Now: dense scenes render at **WebGL parity (WebGPU 86.9% vs WebGL 87.0% non-bg) with ZERO validation errors**, Hi-Z actually culling. No regression on normal scenes (gate clean). Five root causes (the agent's scoping found 2; there were 5):
  - (1) **Three** compute dispatches (`gpuCullCommands`, `_dispatchHiZForNextFrame`, `_dispatchGPUSortKeys`) recorded `beginComputePass` while the MRT scene render pass was open → "CommandEncoder is locked while RenderPassEncoder is open" → whole command buffer invalidated. Fixed: bracket each with `endCurrentRenderPass()` + **`_resumeScenePass()`** (NOT `resumeDefaultRenderPass` — that resumes the single-target canvas pass and breaks MRT pipeline compatibility; `_resumeScenePass` reopens the MRT "Scene Framebuffer Render Pass" with the G-buffer slot-1 attachment). (`WebGPUSceneRenderer.ts`)
  - (2) `HiZ_Sampler` was filtering (`linear`) but `Occlusion_BGL` binding(2) is `non-filtering` and the Hi-Z texture is `unfilterable-float` → double validation violation. Fixed: `nearest` (the pyramid build uses textureLoad, occlusion wants point sampling). (`WebGPUHiZOcclusionDispatcher.ts`)
  - (3) gpuCull readback had no in-flight guard → re-copied into the mapped staging buffer → "[Buffer] used in submit while mapped". Fixed: per-frustum `_gpuCullReadbackInFlight` guard.
  - (4+5) **Readback map-vs-submit races (Batch 213).** The async `mapAsync` was issued from the mid-frame dispatch BEFORE the frame's submit, on a SINGLE staging buffer → "used in submit while pending map / while mapped" (the catastrophic-buffer-invalidation tail; ~174 errors/frame remained after Batch 212). Fixed by giving BOTH readback paths a **2-slot staging ring + deferred mapAsync**: the copy targets one slot while the OTHER (written+submitted last frame) is mapped; the decode is cached and returned by `readResults`/`readbackVisibility`. (`WebGPUHiZOcclusionDispatcher.ts` occlusion staging ring; `WebGPUGPUCuller.ts` visibility+count staging ring.) Verified zero gate errors at full parity. probe-hiz-occlusion-consumer.mjs / -control.mjs. (BACKLOG-§7 → DONE)
- PointCloudSort dispatcher landed 2026-04-09; consumer integration in point cloud collection pending (BACKLOG-§7)
- GPUSortKeys WGSL + dispatcher exist; SOA buffers + bind group factory + RenderScheduler integration pending (BACKLOG-§7)
- C-R12-PER-OBJECT-CACHES: device-loss invalidation event subscriber walk doesn't reach `model._webgpuCache`/`clippingPlanes._webgpuCache` (C-R12-PER-OBJECT-CACHES)
- OPTION-B-BILLBOARD: `WebGPUBillboardRenderer.js` still uses old monolithic UBO pattern (OPTION-B-BILLBOARD)
- OPTION-B-VISUAL: visual smoke test of 25 material types after Option B split not run (OPTION-B-VISUAL)
- Material UBO field-name alignment audit incomplete (silent data-corruption risk) (BACKLOG-§Material UBO)

### C.9 Architecture / Build

- TS-DEBT-3 268 `: any` annotations across 40 WebGPU .ts files (TS-DEBT-3)
- TS-DEBT-4 33 `as any` casts across 10 WebGPU .ts files (TS-DEBT-4)
- TS-DEBT-5 ~10 remaining `as unknown as` casts (TS-DEBT-5)
- TS-DEBT-6 co-located .d.ts for DrawCommand/BoundingSphere/Ellipsoid/etc. — high-payoff queued (TS-DEBT-6)
- TS-DEBT-7 tighten ambient `CesiumOpaque*` types (TS-DEBT-7)
- TS-DEBT-8 `@private` → `@internal` JSDoc sweep (TS-DEBT-8)
- TS-DEBT-9 11 remaining `Record<string, unknown>` cleanups (TS-DEBT-9)
- TS-DEBT-10 ~100 `unknown` parameter/return triage in Renderer/ (TS-DEBT-10)
- ES6-VAR ~196 files var→const/let codemod pending (ES6-VAR)
- ES6-INDEXOF .indexOf→.includes codemod pending (ES6-INDEXOF)
- FORK-19b spec coverage: 105+ source files, ~50 specs (target ~150) (FORK-19b)
- FORK-9 ~32 `: any` casts in WebGPU .ts files (FORK-9)
- FORK-16/20/21/22 test page consolidation — preprocessor reimpl, mixed loaders, inline WGSL (FORK-16/20/21/22)
- FORK-30 `@webgpu/types` pinned to ^0.1.69 (FORK-30)
- WORKER-1 Phase 1 of Option B (worker Scene functional baseline) pending (WORKER-1)
- WORKER-2/3/4/5/6/7/8/9 worker subsystem follow-ups (WORKER-1..9)
- Active bugs BUG-5/6 edge cases (BACKLOG-§1)
- Phase 0 toggle audit prep PR for `scene.globe.atmosphericConditions.*` canonical home pending (CELESTIAL §12)
- Water Phase 1+ (entire WaterClassificationProvider + Gerstner waves + bathymetry + per-type taxonomy) — design only (WATER §1)
- NEW-9 upstream PR to formally reserve quantized-mesh extension ID 0x05 for water classification (NEW-9)

---

## D. FUTURE / DEFERRED

Explicitly punted, gated on external dependencies, or research-stage. Sourced from FUTURE_RESEARCH, design docs, and "future" sections of the backlog.

### D.1 Globe & Imagery

- R-3 (1) WebNN imagery super-resolution prototype (Chrome-only, ~3 sessions) (R-3)
- R-3 (2) WebNN on-device imagery segmentation (land-cover/cloud/road masks) (R-3)
- R-3 (3) AI-driven LOD selection — skipped (no pre-trained model) (R-3)
- FEAT-GAP-06 bent-normal ambient for terrain (pre-baked or screen-space) (FEAT-GAP-06)
- FEAT-SURVEY-44 virtual-texture clipmap terrain — research-only (collides with quadtree) (FEAT-SURVEY-44)

### D.2 3D Tiles

- Phase 8a normal G-buffer + depth prepass — single highest-leverage infra gap (Phase-8a / FEAT-GAP-01)
- Phase 8a ParityManager broader adoption (auto-exposure history, Hi-Z previous) (Phase-8a)
- Phase 8a shader variant strategy (~20 coarse pipelines + prewarm) decision + prototype (Phase-8a)
- Phase 8a ellipsoid-aware RTE audit fix (non-WGS84 tilesets) (Phase-8a)
- Phase 8b TileStoreGPU DOD storage layer (~5 weeks): MegaBuffer + Resident Drawer + sharedSourceBuffer + dynamic-offset UBO + WGSL styling compiler + property-texture audit + WBOIT (Phase-8b)
- FEAT-3DT2-01 styling expression → WGSL compiler (restricted subset → full) (FEAT-3DT2-01)
- FEAT-3DT2-04 NGA_GPM point-cloud uncertainty visualization (FEAT-3DT2-04)
- TILE-DEBT-01 buffer pool / recycler (TILE-DEBT-01)
- TILE-PERF-01 pipeline pre-warm on tileset load (TILE-PERF-01)
- TILE-ARCH-01 cross-tile mesh dedup (TILE-ARCH-01)
- TILE-PERF-02 KTX2 transcode on worker (TILE-PERF-02)
- TILE-WASM-01 WASM SIMD tile traversal (3-4× speedup) (TILE-WASM-01)
- TILE-ARCH-02 tile-level render bundle cache (TILE-ARCH-02)
- TILE-PERF-03 shared UBO for tile-invariant data (TILE-PERF-03)
- TILE-PERF-04 early-out on static camera (TILE-PERF-04)
- FEAT-GAP-07 impostors for far-LOD 3D Tiles + vegetation (FEAT-GAP-07)
- NEW-VEGETATION-SYSTEM planetary vegetation epic (trees/grass/rocks, globe + 3D Tiles, dual-backend) — V1 scatter, V2 mesh-LOD chain + GPU select, V3 octahedral impostor (FEAT-GAP-07), V4 VegetationPBR shader pair, V5 grass/rocks profiles; 3D-Tiles LOD is explicit-authored (no client auto-gen), so consume authored LOD tiles or add client auto-LOD; `3DTILES_vegetation_scatter` convention; biome/ecoregion/landcover data layer (Köppen-Geiger + RESOLVE Ecoregions 2017 + ESA WorldCover, all CC-BY-4.0 — no MIT-licensed global vegetation data exists). Unbuilt — canonical design: `migration_doc/VEGETATION_SYSTEM_DESIGN.md`; tracked as `DEFERRED_WORK.md` NEW-VEGETATION-SYSTEM (NEW-VEGETATION-SYSTEM)
- FEAT-SURVEY-20 MegaBuffer (subsumed under Phase 8b) (FEAT-SURVEY-20)
- FEAT-SURVEY-23 dynamic-offset UBO orchestration (FEAT-SURVEY-23)
- FEAT-SURVEY-24 GPU Resident Drawer / persistent instance table (FEAT-SURVEY-24)
- FEAT-SURVEY-25 sharedSourceBuffer compute-cull fanout (FEAT-SURVEY-25)
- FEAT-SURVEY-21 WBOIT for horizon alpha-sort (FEAT-SURVEY-21)
- FEAT-SURVEY-45 octree + CPU raycast visitor inside tiles (FEAT-SURVEY-45)
- Phase 8 §9.B SSE batch computation, cached frustum plane-masks, batch BS tests (Phase-8 §9.B)
- Phase 8 §9.C GPU compute opportunities — SSE/LOD on GPU, BVH on GPU, GPU pick stall-free, compute skinning, compute morph, per-tile impostor baking, compute instance selection, GPU LOD morph (Phase-8 §9.C)
- Phase 8 §9.D WASM bridges — glTF accessor decode, style evaluator, feature BVH, content dedup hash, RTE encoding hot path, transform cascade (Phase-8 §9.D)
- Phase 8 §9.E memory — vertex quantization preservation, texture dedup, selective LOD reduction, half-precision materials, shared sampler/UBO pools, async eviction (Phase-8 §9.E)
- Phase 8 §9.F threading — tile decode worker audit, traversal-on-worker, parallel multi-viewpoint LOD, cooperative loading (Phase-8 §9.F)
- Phase 8 §9.G architecture — per-tile bundle cache, tileset hierarchical GPU state, LOD-independent vs LOD-specific data split, tileset readiness contract (Phase-8 §9.G)

### D.3 glTF Models + KHR Extensions

- FEAT-SURVEY-02 KHR_materials_clearcoat full BRDF (gated on Phase 8a shader strategy) (FEAT-SURVEY-02)
- FEAT-SURVEY-03 KHR_materials_sheen full BRDF (gated on Phase 8a) (FEAT-SURVEY-03)
- FEAT-SURVEY-04 KHR_materials_anisotropy full per-tangent BRDF (gated on Phase 8a) (FEAT-SURVEY-04)
- KHR_materials_iridescence full thin-film LUT path (gated on Phase 8a) (Phase-8c)
- Constant-LOD stage WGSL forward-port (`ConstantLodStageFS/VS.glsl`) (BACKLOG-§6)
- Edge visibility WGSL forward-port (`EdgeVisibilityStageVS.glsl`) (BACKLOG-§6)
- WASM glTF accessor decode bridge (TILE-DEBT) (TILE-WASM-glTF)

### D.4 Classification

- FEAT-GAP-08 decals projected onto terrain + 3D Tiles (gated on Phase 8a normal G-buffer) (FEAT-GAP-08)
- Vector tile rendering — full upstream issue #2132 (BACKLOG-§9)

### D.5 Picking

- R-5 single-buffer GPU picking (MapGPU-style 2nd MRT) — analyzed and recommended NOT to pursue (negative ROI) (R-5)
- Picking 6.4 GPU multi-hit (storage buffer linked list) future (BACKLOG-§4)
- Picking 6.5 rectangle selection future (BACKLOG-§4)
- Picking 6.6 entity.pickPriority future (BACKLOG-§4)
- Picking 6.7 CPU hybrid pick (geometric ray intersection) future (BACKLOG-§4)

### D.6 Shadows / Lighting

- FEAT-SURVEY-08 ESM soft shadow filter (after CSM lands) (FEAT-SURVEY-08)
- FEAT-SURVEY-09 VSM soft shadow with light-bleed clamping (after CSM) (FEAT-SURVEY-09)
- FEAT-SURVEY-10 PCSS soft shadow (after CSM) (FEAT-SURVEY-10)
- ~~FEAT-SURVEY-40 clustered forward lighting (depends on KHR_lights_punctual)~~ — ✅ SHIPPED Batch 153 (Slice 5d). Moved to §B.6; Model PBR consumer live, all 19 Lit Mat shaders shipped (Batches 154–158). Remaining: Phong primitive shaders + a Sandcastle demo. (FEAT-SURVEY-40)
- FEAT-SURVEY-46 DDGI per-tile probe cages (FEAT-SURVEY-46)
- FEAT-SURVEY-47 Adaptive Probe Volumes streaming SH grid (deferred — needs camera-anchored probe redesign) (FEAT-SURVEY-47)
- FEAT-GAP-05 terrain contact shadows / SSCS (FEAT-GAP-05)
- Phase 8c env probes with parallax correction (gated on Phase 8a) (Phase-8c)
- Earthshine Earth-radiosity model (current is constant blue tint) (CELESTIAL §4.2)

### D.7 Post-process & Effects

- FEAT-SURVEY-22 GPU particle emitter with ease curves + atlas sprites (FEAT-SURVEY-22)
- FEAT-SURVEY-26 box/sphere environment probes with parallax (FEAT-SURVEY-26)
- FEAT-SURVEY-27 RedGPU post-effect suite (chromatic aberration, film grain, sharpen, etc.) (FEAT-SURVEY-27)
- FEAT-SURVEY-28 Kawase dual-filter bloom (mobile profile) (FEAT-SURVEY-28)
- FEAT-SURVEY-41 FFT + Gerstner + FBM ocean water (planetary patching needed) (FEAT-SURVEY-41)
- FEAT-SURVEY-42 ghost-cell halo synchronizer for froxel borders (FEAT-SURVEY-42)
- FEAT-SURVEY-43 grass/foliage material + vegetation instancing (FEAT-SURVEY-43)
- FEAT-SURVEY-48 STP upscaler (gated on TAA motion vectors) (FEAT-SURVEY-48)
- FEAT-GAP-02 motion blur (camera + per-object) — gated on TAA motion vectors (FEAT-GAP-02)
- FEAT-GAP-03 planar reflections (water/wet surfaces) (FEAT-GAP-03)
- FEAT-GAP-04 refraction / caustics (water + glass buildings) (FEAT-GAP-04)
- BACKLOG-§9 subsurface scattering (skin/foliage/marble) (BACKLOG-§9)
- BACKLOG-§9 parallax occlusion mapping (BACKLOG-§9)
- BACKLOG-§9 light probes / SH lighting for indirect baked illumination (BACKLOG-§9)
- Volumetric lighting / god rays (separate from FEAT-SURVEY-05 GodRay which landed) (BACKLOG-§9)
- Color grading LUT-based color correction (BACKLOG-§9)
- Procedural textures for globe (cloud layers, aurora) (BACKLOG-§9)
- Terrain blend/splat mapping multi-texture close-range (BACKLOG-§9)
- Weather: aurora borealis, sandstorm/dust, lightning, wet surfaces (BACKLOG-§9)
- Ocean refraction/caustics water-quality substack (Phase-8e)
- Tessendorf FFT ocean upgrade for Phase 4 of water doc (WATER §4.3)
- Gulf-stream-style flow advection for rivers; ML-based water segmentation; JRC GSW seasonal data (WATER §4.1.1)
- Water type GLACIER + ICE_SHELF reserved future slots (WATER §4.2)

### D.8 Performance & Compute

- R-1 NTC Inference-on-Sample (browser-gated 12-18 mo on subgroup_matrix) (R-1)
- R-1a NTC Inference-on-Load (bandwidth optimization, ~4 sessions, workload-gated) (R-1a)
- R-1b NTC Latent-Resident Transcode Pool (VRAM win, ~6-8 sessions, web-specific) (R-1b)
- R-7a expand GPURenderBundle to 3D Tiles opaque models (R-7a)
- R-7b expand GPURenderBundle to translucent/OIT collect pass (R-7b)
- R-7c expand GPURenderBundle to pick pass (R-7c)
- R-7d expand GPURenderBundle to shadow cast pass (R-7d)
- R-7e expand GPURenderBundle to Vector 3D Tiles (R-7e)
- R-7f expand GPURenderBundle to Buffer primitives (R-7f)
- WGF-4 standard layout UBOs (~20% UBO size reduction) (WGF-4)
- WGF-7 enhanced texture formats — wire when new compute kernel needs richer format (WGF-7)
- `dual-source-blending` single-pass weighted blended OIT (BACKLOG-§8)
- `chromium-experimental-multi-draw-indirect` (pairs with WebGPUIndirectDrawManager) (BACKLOG-§8)
- `chromium-experimental-read-write-storage-texture` for in-place compute (BACKLOG-§8)
- `chromium-experimental-unorm16-texture-formats` for compact terrain (BACKLOG-§8)
- `GPUExternalTexture` zero-copy video import for video-on-terrain (BACKLOG-§8)
- `indirect-first-instance` GPU-driven per-instance indexing (BACKLOG-§8)
- `bgra8unorm-storage` direct compute write to swap chain (BACKLOG-§8)
- `timestamp-query` automated perf regression tests (BACKLOG-§8)
- WASM expansion: glTF decode, batch transform, terrain mesh stitching, quadtree traversal, KTX2 ASTC/ETC2→BC transcode (BACKLOG-§10)
- New compute shaders: terrain LOD selection, 3D Tile GPU culling, general particle simulation, ocean FFT, Gaussian Splat radix sort (BACKLOG-§11)
- FORK-41 4 of 12 compute shaders awaiting consumer wiring (HiZ/OcclusionTest/PointCloudSort/GPUSortKeys) (FORK-41)
- FORK-45 single global WASM arena — needs per-bridge slots for parallel-frame future (FORK-45)
- Bind group caching by content hash (50% fewer creations) (BACKLOG-§11)
- Texture atlas consolidation (30-50% fewer draws) (BACKLOG-§11)
- Command buffer reuse via double-buffer encoders (BACKLOG-§11)
- TS-DEBT-1 WebGPUContext public underscore field getter refactor (TS-DEBT-1)
- TS-DEBT-2 `getGPUBuffer()` helper to drop `'buffer' in vb` narrowing (TS-DEBT-2)
- TS-DEBT-11 re-tighten `CesiumAnyDrawCommand.boundingVolume` after DrawCommand.d.ts (TS-DEBT-11)

### D.9 Architecture / Build

- ES6-ASYNC-AUDIT post-codemod async method audit (ES6-ASYNC-AUDIT)
- ES6 modernization remaining ~96 files (method aliases, multi-class files, partial conversions, perf-critical math, urijs in Specs) (BACKLOG-§12)
- FORK-29 Slang cross-compilation — remove or commit (blocked on naga-wasm spike) (FORK-29)
- STUB-NAGA lazy-load `naga-wasm` for runtime GLSL→WGSL translation (STUB-NAGA)
- BUILD-IIFE-INFLATION IIFE bundle size optimization (code-split limited by format) (BUILD-IIFE-INFLATION)
- Phase 6 naga-wasm productionization — bind-set remap, vertex location remap, specialization-constant injection, WebGL stub retirement (BACKLOG-§Phase 6)
- BUILD-VAR-SCENE-AUDIT Option A real WebGPU FRs for vector3D / classification / depth-plane / ground-polyline (replaces defensive guards) (BACKLOG-§BUILD-VAR)
- WebGPUContext.ts decomposition extraction candidates: `_initializeWebGLStub` (~230 LOC), DeviceInvalidationBus (~35), `_clearAllCaches` (~40), feature flag plumbing (~80), enum conversions (~18), statistics (~30) (CONTEXT_DECOMPOSITION)
- WebGPUSceneRenderer.ts pass orchestration extraction continuing past batches 133-142 (CONTEXT_DECOMPOSITION)
- 42 open upstream issues unaddressed — camera (7), entity/datasource (7), rendering (6), memory leaks (6), 2D/CV (4), 3D Tiles (5), terrain/imagery (3), model/glTF (4), legacy (5) (BACKLOG-§13)
- Console noise reduction (4.8) ~12 `console.warn/error` to route through `context.log` (BACKLOG-§4.8)
- WORKER-Naga in worker; cross-browser Firefox/Safari worker rAF fallback (WORKER-7/8)

### D.10 Research-grade

- R-1 NTC inference-on-feedback — not viable on web (no Sampler Feedback / sparse residency) (R-1)
- R-1 pure-compute Inference-on-Sample without subgroup_matrix — 10-50× too slow (R-1)
- R-2a audit Scene.frameState cross-source attribute unification (R-2a)
- R-2b unified feature-id texture for source-agnostic post-process (R-2b)
- R-2c GPU-driven cross-source LOD selector (thesis-shaped, 5+ sessions) (R-2c)
- R-4 off-thread Rust/WASM MVT vector tile path (~6-8 sessions for v1) (R-4)
- R-6 MIL-STD-2525D/E military symbology (demand-gated, 2-3 sessions) (R-6)
- Future Cesium `EXT_texture_ntc` Khronos vendor extension draft (R-1)
- Multi-planet rendering (Jupiter/Venus visible from Earth surface) — explicit non-goal (CELESTIAL §1)
- High-precision JPL DE405/DE430 ephemerides — explicit non-goal (CELESTIAL §1)
- Lunar libration / topography in moon rendering — explicit non-goal (CELESTIAL §1)
- Wrenninge-style multi-scattering through froxel grid — out of scope (CELESTIAL §1)
- Per-froxel shadow queries from every light — too expensive (CELESTIAL §1)
- Underwater participating media (god rays, caustics) — separate scope (CELESTIAL §1)
- Full SPH/FLIP fluid simulation — out of scope (water doc) (WATER §1)
- Physically-correct subsurface scattering (Jerlov accuracy) — non-goal (WATER §1)
- Tide simulation — non-goal (offset injection only) (WATER §1)
- River network hydrology / flow rate from elevation — non-goal (WATER §1)
- Ray Tracing — not in WebGPU spec yet (BACKLOG-§9)
- Mesh Shaders — not in WebGPU spec yet (BACKLOG-§9)
- Variable Rate Shading — not in WebGPU spec (BACKLOG-§9)
- Terrain GPU tessellation — WebGPU has no tessellation stage; would need compute + indirect (BACKLOG-§9)

---

## Maintenance

- **When you ship a feature** that resolves a WIP entry, move it from §C to §B (and update its tag from SCAFFOLDED to SHIPPED).
- **When a future entry becomes WIP**, move it from §D to §C with a brief summary of where the partial implementation stands.
- **When a new feature lands** without an existing inventory slot, add it to §B under the appropriate subsystem.
- **Don't delete entries** when scope is dropped — flip their status to "explicit non-goal" with the rationale, so future work doesn't re-discover and re-pursue them.
- **Refresh date at top** when the inventory is meaningfully updated.
- **Always cross-reference** when scoping a change — the rule that motivated this doc is to surface coupling early, not after a regression.
