import Cartesian3 from "../../Core/Cartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";

const scratchInverseModel = new Matrix4();
const scratchCameraWorld = new Cartesian3();
const scratchCameraLocal = new Cartesian3();

/**
 * Pack f64 world camera/frustum state into RTC-relative model-local culling
 * params. Point SOA data stays immutable and small even when RTC_CENTER is an
 * Earth-scale ECEF anchor; animated model matrices only change these arrays.
 */
function updatePointCloudLodLocalFrame(
  model,
  cameraWorld,
  planes,
  rtc,
  cameraPositionLocal,
  localPlanes,
  modelLinear,
) {
  Matrix4.inverse(model, scratchInverseModel);
  scratchCameraWorld.x = cameraWorld.x;
  scratchCameraWorld.y = cameraWorld.y;
  scratchCameraWorld.z = cameraWorld.z;
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    scratchCameraWorld,
    scratchCameraLocal,
  );
  cameraPositionLocal[0] = scratchCameraLocal.x - rtc.x;
  cameraPositionLocal[1] = scratchCameraLocal.y - rtc.y;
  cameraPositionLocal[2] = scratchCameraLocal.z - rtc.z;

  for (let i = 0; i < 6; i++) {
    const p = planes?.[i];
    const px = p?.x ?? 0.0;
    const py = p?.y ?? 0.0;
    const pz = p?.z ?? 0.0;
    const pw = p?.w ?? 0.0;
    let x = px * model[0] + py * model[1] + pz * model[2] + pw * model[3];
    let y = px * model[4] + py * model[5] + pz * model[6] + pw * model[7];
    let z = px * model[8] + py * model[9] + pz * model[10] + pw * model[11];
    let w = px * model[12] + py * model[13] + pz * model[14] + pw * model[15];
    w += x * rtc.x + y * rtc.y + z * rtc.z;
    const magnitude = Math.hypot(x, y, z);
    if (magnitude > 0.0) {
      const inverseMagnitude = 1.0 / magnitude;
      x *= inverseMagnitude;
      y *= inverseMagnitude;
      z *= inverseMagnitude;
      w *= inverseMagnitude;
    }
    const offset = i * 4;
    localPlanes[offset] = x;
    localPlanes[offset + 1] = y;
    localPlanes[offset + 2] = z;
    localPlanes[offset + 3] = w;
  }

  modelLinear[0] = model[0];
  modelLinear[1] = model[4];
  modelLinear[2] = model[8];
  modelLinear[3] = 0.0;
  modelLinear[4] = model[1];
  modelLinear[5] = model[5];
  modelLinear[6] = model[9];
  modelLinear[7] = 0.0;
  modelLinear[8] = model[2];
  modelLinear[9] = model[6];
  modelLinear[10] = model[10];
  modelLinear[11] = 0.0;
}

export { updatePointCloudLodLocalFrame };
export default { updatePointCloudLodLocalFrame };
