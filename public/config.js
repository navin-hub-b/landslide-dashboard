/**
 * IIT Bombay Landslide Early-Warning Dashboard
 * Client-Side Configuration (Zero-Server Architecture)
 */
window.LANDSLIDE_CONFIG = {
  // Set your Firebase Realtime Database URL here:
  // e.g., 'https://<your-project>-default-rtdb.firebaseio.com'
  // When empty, the dashboard seamlessly activates Realistic Simulation Mode so you can demo immediately.
  FIREBASE_DATABASE_URL: '',

  // Default Monitoring Site Coordinates (IIT Bombay Geotechnical site)
  SITE_COORDINATES: {
    lat: 19.1334,
    lng: 72.9133,
    name: 'IIT Bombay Hillside Monitoring Station #1',
    evacuationShelter: {
      lat: 19.1380,
      lng: 72.9170,
      name: 'Central Emergency Evacuation Center',
    },
  },

  // Open-Meteo Weather API Base URL (free, public, CORS-enabled, no API key needed)
  WEATHER_API_URL: 'https://api.open-meteo.com/v1/forecast',

  // Public OSRM Routing URL (free, public, CORS-enabled)
  OSRM_ROUTER_URL: 'https://router.project-osrm.org/route/v1/driving',

  // Geotechnical Warning Thresholds (Section 6/9/10 compliance)
  THRESHOLDS: {
    RAIN_RATE_WARNING_MM_HR: 15.0,
    RAIN_RATE_DANGER_MM_HR: 30.0,
    DISPLACEMENT_WARNING_MM_HR: 2.0,
    DISPLACEMENT_DANGER_MM_HR: 5.0,
    TILT_WARNING_DEG: 5.0,
    TILT_DANGER_DEG: 15.0,
    RISK_SCORE_WARNING: 40,
    RISK_SCORE_DANGER: 70,
  },

  // Telemetry Heartbeat Timing
  TIMING: {
    DEVICE_SEND_INTERVAL_MS: 10000,
    STALE_THRESHOLD_SECONDS: 30,
    DISCONNECT_THRESHOLD_SECONDS: 120,
    WEATHER_POLL_INTERVAL_MS: 15 * 60 * 1000,
  },
};
