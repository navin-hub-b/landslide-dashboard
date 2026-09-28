import { Router } from 'express';
import { store } from '../store.js';
import { config } from '../config.js';
import { calculateRisk, getStatusText } from '../modules/riskCalculator.js';
import {
  validateReading,
  checkApiKey,
  ingestReading,
  getLatestReadingWithFreshness,
  evaluateGpsLocationState,
} from '../modules/hardware.js';
import {
  fetchWeather,
  getWeatherWithFreshness,
  hasMeaningfulCoordinateChange,
} from '../modules/weather.js';
import { evaluateRisk } from '../modules/risk.js';
import {
  evaluateAndNotify,
  sendTestAlert,
  smsStatusSummary,
} from '../modules/notifications.js';
import { normalizeToE164 } from '../modules/phone.js';
import { getTranslations, getTranslation } from '../modules/translations.js';
import { getEvacuationRoute } from '../modules/routing.js';
import {
  SCENARIO_PRESETS,
  generateScenarioReading,
  injectSimulatedReading,
  startAutoSimulation,
  stopAutoSimulation,
  getSimulationStatus,
} from '../modules/demoSimulator.js';

const router = Router();

/**
 * GET /api/health
 * System health and telemetry freshness overview
 */
router.get('/health', (req, res) => {
  const freshness = getLatestReadingWithFreshness();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    freshness,
    stats: store.getStats(),
  });
});

/**
 * Geodesic distance between two geographic coordinates in meters via Haversine formula
 */
export function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Calculates disaster impact envelope, radius, and risk level over the hardware slope area
 */
export function computeHazardAreaRisk(status, hardwareLoc, userLat, userLng) {
  let impactRadiusMeters = 150;
  let secondaryBufferMeters = 400;
  let severity = 'LOW';
  let zoneTitle = 'Stable Baseline Monitoring Area';
  let description = 'Normal geological conditions across slope installation perimeter.';

  switch (status) {
    case 'DANGER':
      impactRadiusMeters = 600;
      secondaryBufferMeters = 1800;
      severity = 'CRITICAL';
      zoneTitle = 'High-Velocity Debris Runout & Impact Zone';
      description = 'Immediate slope failure active! Landslide debris flow, boulder roll, and mud torrents threaten the terrain perimeter.';
      break;
    case 'HIGH_RISK':
      impactRadiusMeters = 400;
      secondaryBufferMeters = 1200;
      severity = 'HIGH';
      zoneTitle = 'Active Incline Shear & Inundation Perimeter';
      description = 'Severe soil saturation or slope incline detected. Significant probability of mass earth movement over the slope corridor.';
      break;
    case 'WARNING':
      impactRadiusMeters = 250;
      secondaryBufferMeters = 750;
      severity = 'MODERATE';
      zoneTitle = 'Hydrological Saturation & Pre-Failure Zone';
      description = 'Elevated ground moisture or rainfall accumulation. Soil cohesion diminishing across slope basin.';
      break;
    case 'SENSOR_FAULT':
      impactRadiusMeters = 200;
      secondaryBufferMeters = 500;
      severity = 'UNKNOWN_FAULT';
      zoneTitle = 'Sensor Telemetry Fault Zone';
      description = 'Transducer fault reported from hardware setup. Visual slope inspection required.';
      break;
  }

  const threatAreaSqKm = Number((Math.PI * Math.pow(impactRadiusMeters / 1000, 2)).toFixed(3));
  const bufferAreaSqKm = Number((Math.PI * Math.pow(secondaryBufferMeters / 1000, 2)).toFixed(3));

  const result = {
    status,
    severity,
    zoneTitle,
    description,
    hardwareNode: {
      latitude: hardwareLoc.latitude,
      longitude: hardwareLoc.longitude,
      altitude_m: hardwareLoc.altitude_m,
      station_id: hardwareLoc.station_id,
      label: hardwareLoc.label,
      isLiveGps: hardwareLoc.isLiveGps,
    },
    impactRadiusMeters,
    secondaryBufferMeters,
    threatAreaSqKm,
    bufferAreaSqKm,
  };

  const parsedUserLat = Number(userLat);
  const parsedUserLng = Number(userLng);
  if (Number.isFinite(parsedUserLat) && Number.isFinite(parsedUserLng)) {
    const distMeters = calculateHaversineDistanceMeters(
      hardwareLoc.latitude,
      hardwareLoc.longitude,
      parsedUserLat,
      parsedUserLng
    );
    const isInsideImpactZone = distMeters <= impactRadiusMeters;
    const isInsideBuffer = distMeters <= secondaryBufferMeters;

    let proximityStatus = 'SAFE_DISTANCE';
    let advisory = 'You are situated outside the immediate slope hazard perimeter.';

    if (isInsideImpactZone) {
      proximityStatus = 'INSIDE_CRITICAL_IMPACT_ZONE';
      advisory = '🚨 DANGER: You are located directly inside the active landslide debris runout zone! Evacuate immediately!';
    } else if (isInsideBuffer) {
      proximityStatus = 'PROXIMITY_WARNING_ZONE';
      advisory = '⚠️ CAUTION: You are near the slope disaster perimeter. Move toward the verified safe shelter.';
    }

    result.userProximity = {
      userCoordinates: { latitude: parsedUserLat, longitude: parsedUserLng },
      distanceMeters: distMeters,
      distanceKm: Number((distMeters / 1000).toFixed(2)),
      isInsideImpactZone,
      isInsideBuffer,
      proximityStatus,
      advisory,
    };
  }

  return result;
}

/**
 * GET /api/state
 * Aggregated endpoint returning current hardware telemetry + weather cache +
 * comprehensive risk assessment + site configuration + hardware node location + hazard area risk.
 */
router.get('/state', (req, res) => {
  const hwFreshness = getLatestReadingWithFreshness();
  const hardwareLoc = store.getHardwareLocation();
  const gpsLocationState = evaluateGpsLocationState(hardwareLoc, hwFreshness.reading, hwFreshness);
  const isGpsAvailable = gpsLocationState.status === 'AVAILABLE';

  const wxFreshness = getWeatherWithFreshness();
  const isWeatherCurrent = isGpsAvailable && !wxFreshness.isStale && wxFreshness.weather !== null;

  const weatherState = {
    cached: wxFreshness.weather,
    isStale: wxFreshness.isStale,
    ageMinutes: wxFreshness.ageMinutes,
    status: isWeatherCurrent ? wxFreshness.status : (isGpsAvailable ? wxFreshness.status : 'NO_GPS_LOCATION'),
    isAvailableForCurrentGps: isWeatherCurrent,
    statusMessage: isWeatherCurrent
      ? 'Weather forecast active'
      : (isGpsAvailable ? 'Weather forecast loading' : 'Weather unavailable: no current GPS location'),
    fetchedCoordinates: wxFreshness.weather?.fetchedCoordinates || (wxFreshness.weather?.latitude ? { latitude: wxFreshness.weather.latitude, longitude: wxFreshness.weather.longitude } : null),
    fetchedAt: wxFreshness.weather?.fetchedAt || wxFreshness.weather?.cachedAt || null,
  };

  const riskAssessment = evaluateRisk({
    reading: hwFreshness.reading,
    readingIsStale: hwFreshness.isStale,
    weather: {
      ...wxFreshness,
      isAvailableForCurrentGps: isWeatherCurrent,
    },
  });

  const hazardArea = computeHazardAreaRisk(
    riskAssessment.status,
    hardwareLoc,
    req.query.userLat,
    req.query.userLng
  );

  res.json({
    success: true,
    hardware: {
      latest: hwFreshness.reading,
      isStale: hwFreshness.isStale,
      ageSeconds: hwFreshness.ageSeconds,
      status: hwFreshness.status,
    },
    gpsLocationState,
    weather: weatherState,
    risk: riskAssessment,
    sms: smsStatusSummary(),
    dedup: store.getAlertDedup(),
    site: store.getSiteLocation(),
    hardwareLocation: hardwareLoc,
    hazardArea,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/sensor-data
 * Primary telemetry ingestion endpoint targeted by ESP32 DevKit V1 firmware.
 * Checks API key, validates numeric fields against firmware specification,
 * stamps receivedAt, stores in the JSON-file-backed store, and evaluates risk.
 * Triggers emergency notification workflow on elevated risk.
 */
router.post('/sensor-data', async (req, res) => {
  // 1. Check API key authorization (open if unconfigured in prototype)
  const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
  if (!checkApiKey(apiKeyHeader)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing X-API-Key header',
    });
  }

  // 2. Validate payload fields and numeric boundaries
  const validation = validateReading(req.body);
  if (!validation.isValid) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: validation.errors,
      message: validation.message,
    });
  }

  // 3. Ingest reading into store with timestamp
  const stored = ingestReading(validation.data);

  // If the hardware telemetry reports its deployment coordinates, update hardwareLocation:
  if (validation.data.latitude !== undefined && validation.data.longitude !== undefined) {
    const isLive =
      validation.data.gps_valid !== undefined
        ? Boolean(validation.data.gps_valid)
        : (validation.data.latitude !== 0 && validation.data.longitude !== 0);

    store.setHardwareLocation({
      latitude: validation.data.latitude,
      longitude: validation.data.longitude,
      altitude_m: validation.data.altitude_m,
      station_id: validation.data.station_id || validation.data.device,
      label: validation.data.station_label,
      isLiveGps: isLive,
      gps_satellites: validation.data.gps_satellites,
      gps_speed: validation.data.gps_speed,
      fixTime: stored.receivedAt,
    });

    // Check if weather should be refetched for new coordinates
    const hasValidCoords = isLive && validation.data.latitude !== 0 && validation.data.longitude !== 0;
    if (hasValidCoords) {
      const cached = store.getLatestWeather();
      const needsWeather =
        !cached ||
        hasMeaningfulCoordinateChange(
          validation.data.latitude,
          validation.data.longitude,
          cached.requestedLatitude ?? cached.latitude,
          cached.requestedLongitude ?? cached.longitude,
          500
        );

      if (needsWeather) {
        fetchWeather({
          latitude: validation.data.latitude,
          longitude: validation.data.longitude,
        }).catch((err) => {
          console.warn(`[Weather] Async update notice on GPS update: ${err.message}`);
        });
      }
    }
  }

  // 4. Immediately evaluate unified hardware + weather risk
  const hwLoc = store.getHardwareLocation();
  const gpsLocationState = evaluateGpsLocationState(hwLoc, stored, { isStale: false });
  const isGpsAvailable = gpsLocationState.status === 'AVAILABLE';

  const riskAssessment = evaluateRisk({
    reading: stored,
    readingIsStale: false,
    weather: {
      weather: store.getLatestWeather(),
      isStale: false,
      isAvailableForCurrentGps: isGpsAvailable,
    },
  });

  // 5. Evaluate notification rules and dispatch emergency alerts if necessary
  const notification = await evaluateAndNotify(riskAssessment);

  return res.status(201).json({
    success: true,
    message: 'Sensor data recorded successfully',
    data: stored,
    risk: riskAssessment,
    notification,
  });
});

/**
 * GET /api/sensor-data
 * Returns overview with latest reading, freshness state, and stats
 */
router.get('/sensor-data', (req, res) => {
  const freshness = getLatestReadingWithFreshness();
  res.json({
    success: true,
    latest: freshness.reading,
    freshness: {
      isStale: freshness.isStale,
      ageSeconds: freshness.ageSeconds,
      status: freshness.status,
    },
    stats: store.getStats(),
  });
});

/**
 * GET /api/sensor-data/latest
 * Returns only the most recent sensor reading with freshness evaluation
 */
router.get('/sensor-data/latest', (req, res) => {
  const freshness = getLatestReadingWithFreshness();
  res.json({
    success: true,
    latest: freshness.reading,
    isStale: freshness.isStale,
    ageSeconds: freshness.ageSeconds,
    status: freshness.status,
  });
});

/**
 * GET /api/sensor-data/history (and alias /api/history)
 * Returns historical readings array
 */
router.get(['/sensor-data/history', '/history'], (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  res.json({
    success: true,
    history: store.getHistory(limit),
  });
});

/**
 * POST /api/sensor-data/simulate
 * Injects a realistic synthetic sensor reading for testing and UI demonstration
 */
router.post('/sensor-data/simulate', async (req, res) => {
  const body = req.body || {};

  // If a predefined scenario is requested, use the scenario generator
  if (body.scenario && SCENARIO_PRESETS[body.scenario]) {
    try {
      const result = await injectSimulatedReading(body.scenario, body);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  const soil_moisture = Number(body.soil_moisture ?? (Math.random() * 40 + 20));
  const rain_level = Number(body.rain_level ?? (Math.random() * 30 + 10));
  const tilt_x = Number(body.tilt_x ?? (Math.random() * 4 - 2));
  const tilt_y = Number(body.tilt_y ?? (Math.random() * 4 - 2));
  const acceleration = Number(body.acceleration ?? 9.8);
  const displacement_cm = Number(body.displacement_cm ?? 0.5);
  const tilt_sensor = Boolean(body.tilt_sensor ?? false);
  const soil_trend = Number(body.soil_trend ?? 2.5);
  const rain_trend = Number(body.rain_trend ?? 1.2);
  const history_samples = Number(body.history_samples ?? 65);
  const sensor_fault = Boolean(body.sensor_fault ?? false);

  const risk_score = calculateRisk({
    soilPct: soil_moisture,
    rainPct: rain_level,
    angleX: tilt_x,
    angleY: tilt_y,
    tiltActive: tilt_sensor,
    accel: acceleration,
    baselineDistance: 50,
    displacementCm: displacement_cm,
    histCount: history_samples,
    soilTrend: soil_trend,
    rainTrend: rain_trend,
  });

  const status = getStatusText(risk_score, sensor_fault);
  const hwLoc = store.getHardwareLocation();

  const sampleReading = {
    device: body.device || 'ESP32_SIMULATOR',
    soil_moisture: Number(soil_moisture.toFixed(2)),
    rain_level: Number(rain_level.toFixed(2)),
    soil_raw: 2500,
    rain_raw: 3000,
    tilt_x: Number(tilt_x.toFixed(2)),
    tilt_y: Number(tilt_y.toFixed(2)),
    acceleration: Number(acceleration.toFixed(2)),
    distance_cm: Number((50 - displacement_cm).toFixed(2)),
    displacement_cm: Number(displacement_cm.toFixed(2)),
    tilt_sensor,
    soil_trend: Number(soil_trend.toFixed(2)),
    rain_trend: Number(rain_trend.toFixed(2)),
    history_samples,
    risk_score,
    status,
    sensor_fault,
    uptime_ms: Date.now(),
    latitude: body.latitude !== undefined ? Number(body.latitude) : hwLoc.latitude,
    longitude: body.longitude !== undefined ? Number(body.longitude) : hwLoc.longitude,
    altitude_m: body.altitude_m !== undefined ? Number(body.altitude_m) : hwLoc.altitude_m,
    station_id: body.station_id || hwLoc.station_id,
    station_label: body.station_label || hwLoc.label,
  };

  const validation = validateReading(sampleReading);
  if (!validation.isValid) {
    return res.status(400).json({
      success: false,
      error: 'Simulation data invalid',
      errors: validation.errors,
    });
  }

  const stored = ingestReading(validation.data);

  // Evaluate risk and notifications
  const riskAssessment = evaluateRisk({
    reading: stored,
    readingIsStale: false,
    weather: store.getLatestWeather(),
  });
  const notification = await evaluateAndNotify(riskAssessment);

  res.status(201).json({
    success: true,
    message: 'Simulated reading stored',
    data: stored,
    risk: riskAssessment,
    notification,
  });
});

/**
 * GET /api/demo/status
 * Returns current status of live demo stream, active scenario, and available presets
 */
router.get('/demo/status', (req, res) => {
  res.json({
    success: true,
    ...getSimulationStatus(),
  });
});

/**
 * POST /api/demo/start
 * Starts automated periodic telemetry simulation on the server
 */
router.post('/demo/start', (req, res) => {
  const status = startAutoSimulation(req.body);
  res.json({
    success: true,
    message: 'Live demo automated simulation started',
    ...status,
  });
});

/**
 * POST /api/demo/stop
 * Halts automated telemetry simulation
 */
router.post('/demo/stop', (req, res) => {
  const status = stopAutoSimulation();
  res.json({
    success: true,
    message: 'Live demo automated simulation stopped',
    ...status,
  });
});

/**
 * POST /api/demo/scenario
 * Immediately injects a specific scenario ('safe' | 'warning' | 'high_risk' | 'danger' | 'fault')
 * with full risk assessment and notification evaluation
 */
router.post('/demo/scenario', async (req, res) => {
  try {
    const { scenario = 'safe', ...overrides } = req.body || {};
    const result = await injectSimulatedReading(scenario, overrides);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/weather
 * Returns cached forecast data with freshness indicators.
 * If cache is empty, attempts an on-demand upstream fetch.
 * Returns clear error state if upstream fetch fails — never fabricated data.
 */
router.get('/weather', async (req, res) => {
  let freshness = getWeatherWithFreshness();
  const hwLoc = store.getHardwareLocation();
  const reading = store.getLatestReading();
  const gpsLocationState = evaluateGpsLocationState(hwLoc, reading);
  const isGpsAvailable = gpsLocationState.status === 'AVAILABLE';

  // If no weather cached yet and GPS is available, attempt an on-demand fetch
  if (!freshness.weather && isGpsAvailable && gpsLocationState.coordinates) {
    const fetchResult = await fetchWeather({
      latitude: gpsLocationState.coordinates.latitude,
      longitude: gpsLocationState.coordinates.longitude,
    });
    if (fetchResult.success) {
      freshness = getWeatherWithFreshness();
    }
  }

  const isWeatherCurrent = isGpsAvailable && !freshness.isStale && freshness.weather !== null;

  res.json({
    success: true,
    weather: freshness.weather,
    isStale: freshness.isStale,
    ageMinutes: freshness.ageMinutes,
    staleThresholdMinutes: freshness.staleThresholdMinutes,
    status: isWeatherCurrent ? freshness.status : (isGpsAvailable ? freshness.status : 'NO_GPS_LOCATION'),
    isAvailableForCurrentGps: isWeatherCurrent,
    statusMessage: isWeatherCurrent
      ? 'Weather forecast active'
      : (isGpsAvailable ? 'Weather forecast loading' : 'Weather unavailable: no current GPS location'),
    fetchedCoordinates: freshness.weather?.fetchedCoordinates || (freshness.weather?.latitude ? { latitude: freshness.weather.latitude, longitude: freshness.weather.longitude } : null),
    fetchedAt: freshness.weather?.fetchedAt || freshness.weather?.cachedAt || null,
    gpsLocationState,
  });
});

/**
 * POST /api/weather/refresh
 * Forces an immediate upstream query to Open-Meteo API using hardware GPS coordinates.
 * Returns error if GPS is unavailable or stale.
 */
router.post('/weather/refresh', async (req, res) => {
  const { latitude, longitude } = req.body || {};
  let coords = {};

  if (latitude !== undefined && Number.isFinite(Number(latitude)) && longitude !== undefined && Number.isFinite(Number(longitude))) {
    coords.latitude = Number(latitude);
    coords.longitude = Number(longitude);
  } else {
    // Read hardware GPS coordinates exclusively
    const hwLoc = store.getHardwareLocation();
    const reading = store.getLatestReading();
    const gpsLocationState = evaluateGpsLocationState(hwLoc, reading);

    if (gpsLocationState.status !== 'AVAILABLE' || !gpsLocationState.coordinates) {
      return res.status(409).json({
        success: false,
        error: 'Weather unavailable: no current GPS location',
        status: 'NO_GPS_LOCATION',
        gpsLocationState,
        message: 'Cannot refresh weather: hardware GPS is unavailable or stale',
      });
    }

    coords = {
      latitude: gpsLocationState.coordinates.latitude,
      longitude: gpsLocationState.coordinates.longitude,
    };
  }

  const result = await fetchWeather(coords);

  if (!result.success) {
    const statusCode = result.statusCode || (result.status === 'TIMEOUT' ? 504 : (result.status === 'NO_GPS_LOCATION' ? 409 : 502));
    return res.status(statusCode).json({
      success: false,
      error: result.error,
      status: result.status || 'FETCH_FAILED',
      message: result.error || 'Failed to refresh upstream weather data',
    });
  }

  res.json({
    success: true,
    message: 'Weather data refreshed successfully',
    data: result.data,
  });
});

/**
 * GET /api/recipient
 * Returns current recipient consent record, recipients list, and SMS configuration status
 */
router.get('/recipient', (req, res) => {
  res.json({
    success: true,
    recipient: store.getRecipientConsent(),
    recipients: store.getRecipients(),
    smsStatus: smsStatusSummary(),
  });
});

/**
 * POST /api/recipient
 * Registers or updates recipient phone number for emergency SMS notifications.
 * STRICT REQUIREMENT: Requires affirmative user consent (consent: true) before saving.
 */
router.post('/recipient', (req, res) => {
  const { phone, countryCode, consent, notes, verified } = req.body || {};

  if (consent !== true) {
    return res.status(400).json({
      success: false,
      error: 'Affirmative user consent is required before saving emergency notification recipient (consent must be true)',
    });
  }

  if (!phone || String(phone).trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Phone number is required',
    });
  }

  const phoneRes = normalizeToE164(countryCode || '91', phone);
  if (!phoneRes.valid) {
    return res.status(400).json({
      success: false,
      error: `Invalid phone number: ${phoneRes.error}`,
    });
  }

  const saved = store.setRecipientConsent({
    phone: phoneRes.e164,
    consentGiven: true,
    verified: Boolean(verified),
    notes: notes || '',
  });

  return res.status(201).json({
    success: true,
    message: 'Emergency notification recipient registered successfully with consent',
    recipient: saved,
  });
});

/**
 * DELETE /api/recipient
 * Clears recipient consent and removes registered phone numbers
 */
router.delete('/recipient', (req, res) => {
  const phone = req.query.phone || req.body?.phone;
  store.removeRecipient(phone);
  return res.json({
    success: true,
    message: 'Recipient and consent record removed successfully',
  });
});

/**
 * POST /api/alerts/test
 * Triggers a manual test alert.
 * ALWAYS uses the simulated provider and safe test prefix unless allowRealTestSms is enabled.
 */
router.post('/alerts/test', async (req, res) => {
  try {
    const result = await sendTestAlert(req.body || {});
    if (result.refused || result.success === false) {
      return res.status(400).json({
        success: false,
        message: result.message || 'Test alert refused',
        ...result,
      });
    }
    return res.json({
      success: true,
      message: 'Test alert processed',
      ...result,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/alerts
 * Returns full alert audit log and current deduplication state
 */
router.get('/alerts', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  return res.json({
    success: true,
    alerts: store.getAlertLog(limit),
    dedup: store.getAlertDedup(),
    stats: {
      totalLogged: store.getAlertLog().length,
      lastAlertSentAt: store.getAlertDedup().lastAlertSentAt,
    },
  });
});

/**
 * GET /api/translations
 * Returns emergency warning sign translations across 19 regional Indian languages
 */
router.get('/translations', (req, res) => {
  const includeEnglish = req.query.includeEnglish === 'true';
  const list = getTranslations({ includeEnglish });
  res.json({
    success: true,
    count: list.length,
    translations: list,
  });
});

/**
 * GET /api/map-config
 * Returns map tile configuration, satellite status, and designated safe destination
 */
router.get('/map-config', (req, res) => {
  const styleUrl = config.map?.styleUrl || config.MAP_STYLE_URL;
  const satelliteTileUrl = config.map?.satelliteTileUrl || config.SATELLITE_TILE_URL;
  const satelliteEnabled = Boolean(satelliteTileUrl && String(satelliteTileUrl).trim().length > 0);
  const activeLocation = store.getSiteLocation();
  const safeDestination =
    store.siteLocation?.safeDestination ||
    config.map?.safeDestination || {
      latitude: config.SAFE_DEST_LATITUDE,
      longitude: config.SAFE_DEST_LONGITUDE,
      label: config.SAFE_DEST_LABEL,
      verified: config.SAFE_DEST_VERIFIED,
    };
  const site = {
    latitude: activeLocation.latitude ?? config.SITE_LATITUDE,
    longitude: activeLocation.longitude ?? config.SITE_LONGITUDE,
    label: activeLocation.label ?? config.SITE_LABEL,
    isCustomLocation: activeLocation.isCustomLocation ?? false,
  };

  res.json({
    success: true,
    styleUrl,
    satelliteTileUrl,
    satelliteEnabled,
    safeDestination,
    site,
    osrmBaseUrl: config.map?.osrmBaseUrl || config.OSRM_BASE_URL,
  });
});

/**
 * GET /api/route
 * Computes live evacuation navigation route using OSRM.
 * Origin from query params (originLat/originLng or lat/lng) or config.site.
 * Destination from config.map.safeDestination, returning "no verified destination configured" if unset.
 */
router.get('/route', async (req, res) => {
  const activeLocation = store.getSiteLocation();
  const safeDest =
    store.siteLocation?.safeDestination ||
    config.map?.safeDestination || {
      latitude: config.SAFE_DEST_LATITUDE,
      longitude: config.SAFE_DEST_LONGITUDE,
      label: config.SAFE_DEST_LABEL,
      verified: config.SAFE_DEST_VERIFIED,
    };

  const originLat =
    req.query.originLat !== undefined
      ? req.query.originLat
      : req.query.lat !== undefined
      ? req.query.lat
      : activeLocation?.latitude ?? config.site?.latitude ?? config.SITE_LATITUDE;

  const originLng =
    req.query.originLng !== undefined
      ? req.query.originLng
      : req.query.lng !== undefined
      ? req.query.lng
      : activeLocation?.longitude ?? config.site?.longitude ?? config.SITE_LONGITUDE;

  let destLat = req.query.destLat;
  let destLng = req.query.destLng;
  let destLabel = req.query.destLabel;

  if (destLat === undefined || destLng === undefined) {
    if (
      !safeDest ||
      !safeDest.verified ||
      safeDest.latitude === null ||
      safeDest.latitude === undefined ||
      safeDest.longitude === null ||
      safeDest.longitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        error: 'no verified destination configured',
        message: 'No verified destination configured',
      });
    }
    destLat = safeDest.latitude;
    destLng = safeDest.longitude;
    destLabel = safeDest.label;
  }

  const routeResult = await getEvacuationRoute({
    originLat,
    originLng,
    destLat,
    destLng,
    profile: req.query.profile || 'driving',
  });

  if (!routeResult.success) {
    return res.status(502).json({
      success: false,
      error: routeResult.error,
      status: routeResult.status,
      details: routeResult.details,
    });
  }

  return res.json({
    ...routeResult,
    originLabel: activeLocation?.label || config.site?.label || config.SITE_LABEL || 'Monitoring Site',
    destinationLabel: destLabel || safeDest?.label || 'Safe Shelter',
  });
});

/**
 * GET /api/site/location
 * Returns active monitoring station / device location and safe shelter
 */
router.get('/site/location', (req, res) => {
  return res.json({
    success: true,
    location: store.getSiteLocation(),
  });
});

/**
 * POST /api/site/location
 * Sets user / custom location, refreshes local weather from Open-Meteo,
 * and recalculates risk for the new coordinates.
 */
router.post('/site/location', async (req, res) => {
  try {
    const { latitude, longitude, label, safeDestination } = req.body || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required',
      });
    }

    const updated = store.setSiteLocation({
      latitude,
      longitude,
      label,
      safeDestination,
    });

    // Trigger immediate weather fetch for this new location
    const wxResult = await fetchWeather({
      latitude: updated.latitude,
      longitude: updated.longitude,
    });

    // Recalculate risk with new weather
    const latestReading = store.getLatestReading();
    const riskAssessment = evaluateRisk({
      reading: latestReading,
      readingIsStale: latestReading
        ? (Date.now() - new Date(latestReading.receivedAt).getTime()) / 1000 > config.hardwareStaleSeconds
        : true,
      weather: wxResult.success ? wxResult.data : store.getLatestWeather(),
    });

    return res.json({
      success: true,
      message: `Monitoring location updated to ${updated.label}`,
      location: updated,
      weather: wxResult.data || null,
      risk: riskAssessment,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/hardware/location
 * Returns the physical deployment location of the hardware setup
 * and the calculated disaster hazard area around the slope node.
 */
router.get('/hardware/location', (req, res) => {
  const hwFreshness = getLatestReadingWithFreshness();
  const wxFreshness = getWeatherWithFreshness();
  const riskAssessment = evaluateRisk({
    reading: hwFreshness.reading,
    readingIsStale: hwFreshness.isStale,
    weather: wxFreshness.weather,
  });

  const hardwareLoc = store.getHardwareLocation();
  const hazardArea = computeHazardAreaRisk(
    riskAssessment.status,
    hardwareLoc,
    req.query.userLat,
    req.query.userLng
  );

  return res.json({
    success: true,
    hardwareLocation: hardwareLoc,
    hazardArea,
  });
});

/**
 * POST /api/hardware/location
 * Updates or sets the physical deployment location of the hardware setup.
 */
router.post('/hardware/location', async (req, res) => {
  try {
    const { latitude, longitude, altitude_m, station_id, label, isLiveGps } = req.body || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required for hardware setup location',
      });
    }

    const updated = store.setHardwareLocation({
      latitude,
      longitude,
      altitude_m,
      station_id,
      label,
      isLiveGps,
    });

    const hwFreshness = getLatestReadingWithFreshness();
    const wxFreshness = getWeatherWithFreshness();
    const riskAssessment = evaluateRisk({
      reading: hwFreshness.reading,
      readingIsStale: hwFreshness.isStale,
      weather: wxFreshness.weather,
    });

    const hazardArea = computeHazardAreaRisk(
      riskAssessment.status,
      updated,
      req.query.userLat,
      req.query.userLng
    );

    return res.json({
      success: true,
      message: `Hardware setup location updated to ${updated.label}`,
      hardwareLocation: updated,
      hazardArea,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/sensor-data/reset
 * Resets memory store and persisted store.json
 */
router.post('/sensor-data/reset', (req, res) => {
  store.clear();
  res.json({
    success: true,
    message: 'Store cleared successfully',
  });
});

export default router;
