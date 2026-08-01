import Matrix3 from "../../Core/Matrix3.js";
import Quaternion from "../../Core/Quaternion.js";

const scratchInverseViewQuaternion = new Quaternion();
const inverseViewQuaternionCache = new WeakMap<Matrix3, Float64Array>();

function writeNormalizedInverseViewQuaternion(
  data: Float32Array,
  offset: number,
  inverseViewRotation: Matrix3 | undefined,
): boolean {
  const rotation = inverseViewRotation ?? Matrix3.IDENTITY;
  const matrix = rotation as unknown as ArrayLike<number>;
  let cached = inverseViewQuaternionCache.get(rotation);
  let changed = !cached;
  if (cached) {
    for (let i = 0; i < 9; ++i) {
      if (cached[i] !== matrix[i]) {
        changed = true;
        break;
      }
    }
  } else {
    cached = new Float64Array(13);
    inverseViewQuaternionCache.set(rotation, cached);
  }

  if (changed) {
    Quaternion.fromRotationMatrix(rotation, scratchInverseViewQuaternion);
    Quaternion.normalize(
      scratchInverseViewQuaternion,
      scratchInverseViewQuaternion,
    );
    for (let i = 0; i < 9; ++i) {
      cached[i] = matrix[i];
    }
    cached[9] = scratchInverseViewQuaternion.x;
    cached[10] = scratchInverseViewQuaternion.y;
    cached[11] = scratchInverseViewQuaternion.z;
    cached[12] = scratchInverseViewQuaternion.w;
  }

  data[offset] = cached[9];
  data[offset + 1] = cached[10];
  data[offset + 2] = cached[11];
  data[offset + 3] = cached[12];
  return changed;
}

export { writeNormalizedInverseViewQuaternion };

export default writeNormalizedInverseViewQuaternion;
