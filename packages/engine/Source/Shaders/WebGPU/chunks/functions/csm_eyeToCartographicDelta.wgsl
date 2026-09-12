/**
 * Computes the geodetic offset (delta longitude, latitude, and height) from the camera's
 * cartographic position to a point given in eye coordinates.
 *
 * The WGSL twin of `czm_eyeToCartographicDelta`
 * (`Shaders/Builtin/Functions/eyeToCartographicDelta.glsl`), statement for statement.
 * Rather than converting the point's absolute world position to cartographic — too large to
 * process precisely at 32 bits — it works entirely with the small delta between the point and
 * the camera, projecting the eye-space offset onto the ellipsoid's equatorial and meridional
 * planes. The delta gets smaller and more precise as one zooms in.
 * <br /><br />
 * This assumes an ellipsoid of revolution (equatorial radii equal, as with WGS84), so that
 * longitude is exact. The latitude calculation is only first-order accurate, since the meridian
 * is an ellipse rather than a circle.
 *
 * Two things differ from the GLSL, and neither is a change of arithmetic:
 *   - GLSL's two-argument `atan(y, x)` is spelled `atan2(y, x)` in WGSL.
 *   - The three automatic uniforms it reads (`czm_eyeToEnu`, `czm_eyeCartographic`,
 *     `czm_eyeEllipsoidCurvature`) are parameters here. WGSL has no automatic-uniform
 *     injection, and taking them as arguments keeps the chunk usable from any shader whose
 *     camera UB carries them — `GlobeTerrain.wgsl` is the first (floats 244-263, packed by
 *     `WebGPUGlobeSurfaceCameraUB.writeEyeCartographicTail`).
 *
 * `eyeToEnu` is a `mat3x3<f32>`, which WGSL lays out as three vec4 columns; the CPU packer
 * owns that padding. A caller whose camera UB packs it as nine tight floats — GLSL's `mat3`
 * layout — hands this function a rotation that is not a rotation, with no validation error.
 *
 * @chunk functions/csm_eyeToCartographicDelta
 *
 * @param positionEC The position, in eye coordinates, to measure to.
 * @param eyeToEnu Rotation from eye coordinates to the camera's east-north-up frame.
 * @param eyeCartographic The camera's (longitude, latitude) in radians and height in metres.
 * @param eyeEllipsoidCurvature (prime-vertical, meridional) curvature under the camera.
 *
 * @returns The geodetic offset from the camera to `positionEC`, as
 *          (delta longitude, delta latitude in radians, delta height in meters).
 */
fn csm_eyeToCartographicDelta(
  positionEC: vec3<f32>,
  eyeToEnu: mat3x3<f32>,
  eyeCartographic: vec3<f32>,
  eyeEllipsoidCurvature: vec2<f32>
) -> vec3<f32> {
  // A vector representing the camera-to-vertex offset, in an ENU oriented reference frame (centered at the camera)
  let cameraToVertex = eyeToEnu * positionEC;

  let cosLatitude = cos(eyeCartographic.y);
  let sinLatitude = sin(eyeCartographic.y);

  // To derive longitude, project the camera and vertex onto the equatorial plane, in a frame such that the camera lies along the +x axis. In this frame,
  // the vertex's (delta) longitude is simply the atan of its x and y components.
  let primeVerticalRadius = 1.0 / eyeEllipsoidCurvature.x;
  let cameraEquatorialPos = vec2<f32>((primeVerticalRadius + eyeCartographic.z) * cosLatitude, 0.0);
  let vertexEquatorialPos = cameraEquatorialPos + vec2<f32>(-cameraToVertex.y * sinLatitude + cameraToVertex.z * cosLatitude, cameraToVertex.x);
  let deltaLongitude = atan2(vertexEquatorialPos.y, vertexEquatorialPos.x);

  // Deriving latitude is a bit harder: we can't directly project the vertex onto the camera's meridian — the latitude projection is dependent on the longitude.
  // Instead we can rotate the vertex (by -deltaLongitude) onto the camera's meridional plane.  (Note: (unlike the exact longitude case) this is only first-order accurate because the meridian is an ellipse rather than a circle)
  // Using a 2D rotation formula introduces precision issues (subtraction of large-magnitude quantities), so instead we can calculate the vector difference
  // between the vertex and its rotated version, and apply that offset to the cameraToVertex vector. Then, the cameraToVertex vector accurately
  // reflects the difference between the camera and the _rotated_ vertex, so we can then project the camera onto the meridional plane and apply this offset - just as we did for deltaLongitude, above.
  // Best of all, we can do this all with small delta quantities which preserve precision.
  //
  // (I suggest drawing this out -- with the vertex and camera vectors projected onto the equatorial plane, with the camera on the +x axis)
  // Mathematically: if you compare (subtract) vertexEquatorialPos and the same vector rotated onto the camera's meridional plane, you get
  // |dx| = |vertexEquatorialPos| - vertexEquatorialPos.x = (r - x) = r * (1 - cos(deltaLongitude))
  // |dy| = cameraToVertex.x (the east component)
  // (To avoid precision issues, we'll use the identity (1 - cos(x) = 2 * sin^2(x/2)))
  //
  // Since these offsets were produced in the equatorial plane, and cameraToVertex is in the camera's ENU frame, we need to deconstruct along the camera's north and up axes. And we only care about
  // dx, since dy is in the camera's east direction, and that component gets zeroed out when projecting onto the camera's meridional plane.
  let sinHalfLongitude = sin(deltaLongitude * 0.5);
  let dx = length(vertexEquatorialPos) * 2.0 * sinHalfLongitude * sinHalfLongitude;
  let meridionalOffset = vec3<f32>(
    0.0,                                 // east
    cameraToVertex.y - dx * sinLatitude, // north
    cameraToVertex.z + dx * cosLatitude  // up
  );

  // Reframe the camera in a meridional plane, where it lies along the +z axis, and apply the meridionalOffset to get the vertex's position in that plane.
  // Then, deltaLatitude is simply the atan of its x and y components.
  let meridionalRadius = 1.0 / eyeEllipsoidCurvature.y;
  let cameraMeridionalPos = vec2<f32>(meridionalRadius + eyeCartographic.z, 0.0);
  let vertMeridionalPos = cameraMeridionalPos + vec2<f32>(meridionalOffset.z, meridionalOffset.y);
  let deltaLatitude = atan2(vertMeridionalPos.y, vertMeridionalPos.x);

  // Finally, derive the change in height above the ellipsoid. This is the meridional-plane analogue of the dx step above:
  // there we rotated the vertex (in the equatorial plane) to the camera's longitude; here we rotate it (in the meridional plane, by -deltaLatitude)
  // to the camera's latitude, aligning it with the camera's radial (up) direction.
  let sinHalfLatitude = sin(deltaLatitude * 0.5);
  let dz = length(vertMeridionalPos) * 2.0 * sinHalfLatitude * sinHalfLatitude;
  let deltaHeight = meridionalOffset.z + dz;

  return vec3<f32>(deltaLongitude, deltaLatitude, deltaHeight);
}
