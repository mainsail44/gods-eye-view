import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * Phase 1 default: fly to Austin, TX on load.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Framing for a single facility-scale feature — a data centre, a cable
 * landing, an installation. High enough to keep the site's surroundings in
 * frame, low enough that the site itself is legible.
 */
export const FACILITY_VIEW_ALTITUDE = 3000;

/**
 * Where in the frame a facility lands, as a fraction of the frame height from
 * the top. Not the centre: the Starlight Local Intel panel that issues these
 * flights floats in the lower-centre lane (see .starlight-intel in
 * overlays.css), and a site centred behind that panel is as good as
 * off-screen. The upper third stays inside the scope mask and clear of the
 * panel at every viewport height the stylesheet lays out.
 */
export const FACILITY_FRAME_Y = 0.3;

/**
 * Fly the camera to a ground coordinate. Unlike the presets above the caller
 * supplies the position, so an unusable one is ignored rather than thrown:
 * callers pass through coordinates that came from outside the application.
 * @param {object} viewer Cesium viewer.
 * @param {{lat:number, lon:number, alt?:number, heading?:number, pitch?:number, frameY?:number}} target
 * @param {number} [duration] Flight duration in seconds.
 */
export function flyToCoordinate(
  viewer,
  {
    lat,
    lon,
    alt = FACILITY_VIEW_ALTITUDE,
    heading = 0,
    pitch = -45,
    frameY = FACILITY_FRAME_Y,
  } = {},
  duration = 2.4,
) {
  if (!viewer || viewer.isDestroyed?.()) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // `destination` is where the camera STANDS, not what it looks at. Standing
  // directly over the target and pitching down 45° put the target 3 km behind
  // the bottom edge of the frame, so every citation click showed an anonymous
  // patch of ground north of the site. Stand off along the line of sight to
  // the site instead, so the site lands where `frameY` says.
  const lookDownDeg = Cesium.Math.clamp(-pitch, 5, 90);
  const headingRad = Cesium.Math.toRadians(heading);
  const sightPitchRad = Cesium.Math.toRadians(-lookDownDeg);
  const standoff =
    lookDownDeg >= 90 ? 0 : alt / Math.tan(Cesium.Math.toRadians(lookDownDeg));
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(lon, lat, 0),
  );
  const destination = Cesium.Matrix4.multiplyByPoint(
    frame,
    new Cesium.Cartesian3(
      -Math.sin(headingRad) * standoff,
      -Math.cos(headingRad) * standoff,
      alt,
    ),
    new Cesium.Cartesian3(),
  );
  // The line of sight to the site is fixed by the stand-off; the camera's own
  // axis is aimed below it by the angle that projects the site to `frameY`.
  // Screen offset is linear in tan, not in angle, hence the atan.
  const fovy = viewer.camera.frustum?.fovy;
  const fraction = Cesium.Math.clamp(Number(frameY) || 0.5, 0.05, 0.95);
  const aimDown = Number.isFinite(fovy)
    ? Math.atan((1 - 2 * fraction) * Math.tan(fovy / 2))
    : 0;
  const pitchRad = Math.max(-Cesium.Math.PI_OVER_TWO, sightPitchRad - aimDown);
  viewer.camera.flyTo({
    destination,
    orientation: { heading: headingRad, pitch: pitchRad, roll: 0.0 },
    duration: Math.max(0.2, duration || 0),
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(viewer) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 600),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
