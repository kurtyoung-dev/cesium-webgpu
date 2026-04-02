/**
 * Converts a geodetic latitude to Web Mercator fraction [0,1].
 * Port of czm_latitudeToWebMercatorFraction.
 * @chunk functions/csm_latitudeToWebMercatorFraction
 */
fn csm_latitudeToWebMercatorFraction(latitude: f32, southLatitude: f32, oneOverInterval: f32) -> f32 {
    let sinLatitude: f32 = sin(latitude);
    let mercatorY: f32 = 0.5 * log((1.0 + sinLatitude) / (1.0 - sinLatitude));
    let sinSouthLatitude: f32 = sin(southLatitude);
    let mercatorSouth: f32 = 0.5 * log((1.0 + sinSouthLatitude) / (1.0 - sinSouthLatitude));
    return (mercatorY - mercatorSouth) * oneOverInterval;
}
