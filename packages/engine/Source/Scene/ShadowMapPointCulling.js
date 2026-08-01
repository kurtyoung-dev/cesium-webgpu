import Cartesian4 from "../Core/Cartesian4.js";
import CullingVolume from "../Core/CullingVolume.js";
import defined from "../Core/defined.js";

function computePointShadowFaceCullingVolume(frustum, camera, result) {
  const computedVolume = frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );

  if (!defined(result)) {
    result = new CullingVolume();
  }

  // All six face cameras intentionally share one frustum. Its internal
  // culling volume is mutable, so preserve each face by copying into the
  // pass-owned volume while reusing both the volume and its planes.
  const computedPlanes = computedVolume.planes;
  const resultPlanes = result.planes;
  resultPlanes.length = computedPlanes.length;
  for (let i = 0; i < computedPlanes.length; ++i) {
    resultPlanes[i] = Cartesian4.clone(computedPlanes[i], resultPlanes[i]);
  }

  return result;
}

export { computePointShadowFaceCullingVolume };

export default computePointShadowFaceCullingVolume;
