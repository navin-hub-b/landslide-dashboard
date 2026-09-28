/**
 * ESP32 Hardware Telemetry Ingestion & Validation Module
 *
 * Implements strict type and boundary validation against the ESP32 Landslide Early Warning
 * System specification (Sections 6, 9, 10). Rejects out-of-bounds or malformed sensor data.
 */

import { config } from '../config.js';
import { store } from '../store.js';

// Recognized firmware status strings
export const VALID_STATUSES = new Set([
  'SAFE',
  'WARNING',
  'HIGH_RISK',
  'DANGER',
  'SENSOR_FAULT',
]);

/**
 * Validates the exact JSON fields from the firmware specification with strict numeric ranges.
 *
 * @param {Object} body Incoming JSON payload from ESP32 or test client
 * @returns {{ isValid: boolean, valid: boolean, data?: Object, errors?: string[], message?: string }}
 */
export function validateReading(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      isValid: false,
      valid: false,
      errors: ['Request body must be a valid JSON object'],
      message: 'Request body must be a valid JSON object',
    };
  }

  const sanitized = {};

  // 1. Device identifier (optional in validation, defaults to ESP32_DEVKIT_V1)
  if (body.device !== undefined) {
    if (typeof body.device !== 'string' || body.device.trim() === '') {
      errors.push("Field 'device' must be a non-empty string");
    } else {
      sanitized.device = body.device.trim();
    }
  } else {
    sanitized.device = 'ESP32_DEVKIT_V1';
  }

  // Helper for numeric boundary checks
  const checkNumber = (key, min, max, isInteger = false, allowNegativeOne = false) => {
    const val = body[key];
    if (val === undefined || val === null || val === '') {
      errors.push(`Field '${key}' is required`);
      return;
    }

    if (typeof val === 'boolean') {
      errors.push(`Field '${key}' must be a valid finite number (received boolean: ${val})`);
      return;
    }

    const num = Number(val);
    if (!Number.isFinite(num)) {
      errors.push(`Field '${key}' must be a valid finite number (received: ${val})`);
      return;
    }

    if (isInteger && !Number.isInteger(num)) {
      errors.push(`Field '${key}' must be an integer (received: ${val})`);
      return;
    }

    if (allowNegativeOne && num === -1) {
      sanitized[key] = num;
      return;
    }

    if (num < min || num > max) {
      errors.push(
        `Field '${key}' must be between ${min} and ${max} (received: ${num})`
      );
      return;
    }

    sanitized[key] = num;
  };

  // Helper for boolean checks
  const checkBoolean = (key) => {
    const val = body[key];
    if (val === undefined || val === null || val === '') {
      errors.push(`Field '${key}' is required`);
      return;
    }

    if (typeof val === 'boolean') {
      sanitized[key] = val;
    } else if (val === 'true' || val === '1' || val === 1) {
      sanitized[key] = true;
    } else if (val === 'false' || val === '0' || val === 0) {
      sanitized[key] = false;
    } else {
      errors.push(`Field '${key}' must be a boolean (received: ${val})`);
    }
  };

  // 2. soil_moisture (0.0% to 100.0%)
  checkNumber('soil_moisture', 0, 100);

  // 3. rain_level (0.0% to 100.0%)
  checkNumber('rain_level', 0, 100);

  // 4. tilt_x (-180.0° to +180.0°)
  checkNumber('tilt_x', -180, 180);

  // 5. tilt_y (-180.0° to +180.0°)
  checkNumber('tilt_y', -180, 180);

  // 6. acceleration (0.0 m/s² to 100.0 m/s²)
  checkNumber('acceleration', 0, 100);

  // 7. distance_cm (-1 for timeout fault or 0 to 500 cm)
  checkNumber('distance_cm', 0, 500, false, true);

  // 8. displacement_cm (0.0 cm to 500.0 cm)
  checkNumber('displacement_cm', 0, 500);

  // 9. tilt_sensor (boolean)
  checkBoolean('tilt_sensor');

  // 10. soil_trend (-100.0% to +100.0%)
  checkNumber('soil_trend', -100, 100);

  // 11. rain_trend (-100.0% to +100.0%)
  checkNumber('rain_trend', -100, 100);

  // 12. history_samples (0 to 1000 samples)
  checkNumber('history_samples', 0, 1000, true);

  // 13. sensor_fault (boolean)
  checkBoolean('sensor_fault');

  // 14. status (must be valid enum string)
  if (body.status === undefined || body.status === null || body.status === '') {
    errors.push("Field 'status' is required");
  } else if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status.trim().toUpperCase())) {
    errors.push(
      `Field 'status' must be one of: ${Array.from(VALID_STATUSES).join(', ')} (received: ${body.status})`
    );
  } else {
    sanitized.status = body.status.trim().toUpperCase();
  }

  // 15. Optional supplementary fields from Section 6/9
  if (body.soil_raw !== undefined) {
    checkNumber('soil_raw', 0, 4095, true);
  } else {
    sanitized.soil_raw = 0;
  }

  if (body.rain_raw !== undefined) {
    checkNumber('rain_raw', 0, 4095, true);
  } else {
    sanitized.rain_raw = 0;
  }

  if (body.risk_score !== undefined) {
    checkNumber('risk_score', 0, 100, true);
  } else {
    sanitized.risk_score = 0;
  }

  if (body.uptime_ms !== undefined) {
    checkNumber('uptime_ms', 0, Number.MAX_SAFE_INTEGER, true);
  } else {
    sanitized.uptime_ms = 0;
  }

  // 16. Optional Hardware Deployment Geolocation / GPS Fields
  if (body.gps_valid !== undefined && body.gps_valid !== null && body.gps_valid !== '') {
    if (typeof body.gps_valid === 'boolean') {
      sanitized.gps_valid = body.gps_valid;
    } else if (body.gps_valid === 'true' || body.gps_valid === '1' || body.gps_valid === 1) {
      sanitized.gps_valid = true;
    } else if (body.gps_valid === 'false' || body.gps_valid === '0' || body.gps_valid === 0) {
      sanitized.gps_valid = false;
    } else {
      errors.push(`Field 'gps_valid' must be a boolean (received: ${body.gps_valid})`);
    }
  }

  const latVal = body.latitude !== undefined ? body.latitude : body.lat;
  if (latVal !== undefined && latVal !== null && latVal !== '') {
    const latNum = Number(latVal);
    if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
      errors.push(`Field 'latitude' must be a valid number between -90 and 90 (received: ${latVal})`);
    } else {
      sanitized.latitude = latNum;
    }
  }

  const lngVal = body.longitude !== undefined ? body.longitude : body.lng;
  if (lngVal !== undefined && lngVal !== null && lngVal !== '') {
    const lngNum = Number(lngVal);
    if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
      errors.push(`Field 'longitude' must be a valid number between -180 and 180 (received: ${lngVal})`);
    } else {
      sanitized.longitude = lngNum;
    }
  }

  const altVal =
    body.gps_altitude !== undefined
      ? body.gps_altitude
      : body.altitude_m !== undefined
        ? body.altitude_m
        : body.elevation;
  if (altVal !== undefined && altVal !== null && altVal !== '') {
    const altNum = Number(altVal);
    if (!Number.isFinite(altNum) || altNum < -500 || altNum > 9000) {
      errors.push(`Field 'gps_altitude' / 'altitude_m' must be a valid number between -500 and 9000 (received: ${altVal})`);
    } else {
      sanitized.altitude_m = altNum;
      sanitized.gps_altitude = altNum;
    }
  }

  if (body.gps_speed !== undefined && body.gps_speed !== null && body.gps_speed !== '') {
    const spdNum = Number(body.gps_speed);
    if (!Number.isFinite(spdNum) || spdNum < 0 || spdNum > 500) {
      errors.push(`Field 'gps_speed' must be a valid number >= 0 (received: ${body.gps_speed})`);
    } else {
      sanitized.gps_speed = spdNum;
    }
  }

  if (body.gps_satellites !== undefined && body.gps_satellites !== null && body.gps_satellites !== '') {
    const satNum = Number(body.gps_satellites);
    if (!Number.isInteger(satNum) || satNum < 0 || satNum > 64) {
      errors.push(`Field 'gps_satellites' must be a non-negative integer (received: ${body.gps_satellites})`);
    } else {
      sanitized.gps_satellites = satNum;
    }
  }

  if (body.station_id !== undefined && typeof body.station_id === 'string' && body.station_id.trim() !== '') {
    sanitized.station_id = body.station_id.trim();
  }

  if (body.station_label !== undefined && typeof body.station_label === 'string' && body.station_label.trim() !== '') {
    sanitized.station_label = body.station_label.trim();
  }

  if (errors.length > 0) {
    return {
      isValid: false,
      valid: false,
      errors,
      message: errors.join('; '),
    };
  }

  return {
    isValid: true,
    valid: true,
    data: sanitized,
    value: sanitized,
  };
}

/**
 * Checks whether an incoming request contains a valid API key.
 * If HARDWARE_API_KEY is unconfigured (empty string), authentication is open (prototype default).
 *
 * @param {string|undefined} headerValue Value of the 'X-API-Key' header
 * @returns {boolean} True if authorized
 */
export function checkApiKey(headerValue) {
  const configuredKey =
    config.hardware?.apiKey ||
    config.hardwareApiKey ||
    config.HARDWARE_API_KEY ||
    '';

  // If no API key configured on server, allow all prototype requests
  if (!configuredKey || configuredKey.trim() === '') {
    return true;
  }

  // If key is configured, request header must match
  if (!headerValue || typeof headerValue !== 'string') {
    return false;
  }

  return headerValue.trim() === configuredKey.trim();
}

/**
 * Stamps a verified reading with the server's ISO timestamp and persists it to the store.
 *
 * @param {Object} body Validated reading object
 * @returns {Object} Stored reading object with receivedAt timestamp
 */
export function ingestReading(body) {
  const reading = {
    ...body,
    receivedAt: new Date().toISOString(),
  };

  const stored = store.addReading(reading);
  return stored;
}

/**
 * Retrieves the latest sensor reading and evaluates its telemetry freshness.
 * Flags the reading as stale if it has not been refreshed within config.hardware.staleSeconds.
 *
 * @returns {{ reading: Object|null, isStale: boolean, ageSeconds: number|null, staleThresholdSeconds: number, status: string }}
 */
export function getLatestReadingWithFreshness() {
  const latest = store.getLatestReading();
  const staleThreshold =
    config.hardware?.staleSeconds ??
    config.hardwareStaleSeconds ??
    config.HARDWARE_STALE_SECONDS ??
    60;

  if (!latest || !latest.receivedAt) {
    return {
      reading: null,
      isStale: true,
      ageSeconds: null,
      staleThresholdSeconds: staleThreshold,
      status: 'NO_DATA',
    };
  }

  const receivedTime = new Date(latest.receivedAt).getTime();
  const elapsedMs = Date.now() - receivedTime;
  const ageSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const isStale = ageSeconds > staleThreshold;

  return {
    reading: latest,
    isStale,
    ageSeconds,
    staleThresholdSeconds: staleThreshold,
    status: isStale ? 'STALE' : 'LIVE',
    lastReceivedAt: latest.receivedAt,
  };
}

/**
 * Evaluates the hardware GPS location state:
 * - AVAILABLE: Valid fix from hardware, valid non-zero coordinates within geographic range, and fresh telemetry
 * - STALE: Valid coordinates previously received, but telemetry age exceeds staleness threshold
 * - UNAVAILABLE: Missing telemetry, gps_valid is false, coordinates missing/null, coordinates (0, 0), or out of bounds
 *
 * @param {Object|null} [hardwareLoc]
 * @param {Object|null} [reading]
 * @param {Object|null} [freshness]
 * @param {number} [staleThresholdSeconds=30]
 * @returns {{ status: 'AVAILABLE'|'STALE'|'UNAVAILABLE', coordinates: { latitude: number, longitude: number }|null, fixTime: string|null, ageSeconds: number|null, satellites: number|null, speed_kmph: number|null, altitude_m: number|null, reason?: string }}
 */
export function evaluateGpsLocationState(hardwareLoc = null, reading = null, freshness = null, staleThresholdSeconds = 30) {
  const loc = hardwareLoc || store.getHardwareLocation();
  const latest = reading || store.getLatestReading();
  const fresh = freshness || getLatestReadingWithFreshness();

  if (!loc || !latest || !latest.receivedAt) {
    return {
      status: 'UNAVAILABLE',
      coordinates: null,
      fixTime: null,
      ageSeconds: null,
      satellites: null,
      speed_kmph: null,
      altitude_m: null,
      reason: 'No hardware telemetry received yet',
    };
  }

  // Check gps_valid explicitly if provided
  if (latest.gps_valid === false) {
    return {
      status: 'UNAVAILABLE',
      coordinates: null,
      fixTime: null,
      ageSeconds: null,
      satellites: latest.gps_satellites ?? null,
      speed_kmph: null,
      altitude_m: null,
      reason: 'GPS module has no satellite fix',
    };
  }

  const lat = loc.latitude ?? latest.latitude;
  const lng = loc.longitude ?? latest.longitude;

  if (
    lat === null ||
    lat === undefined ||
    lng === null ||
    lng === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return {
      status: 'UNAVAILABLE',
      coordinates: null,
      fixTime: null,
      ageSeconds: null,
      satellites: latest.gps_satellites ?? null,
      speed_kmph: null,
      altitude_m: null,
      reason: 'Invalid or missing GPS coordinates (e.g. 0,0 or out of range)',
    };
  }

  const fixTime = loc.fixTime || loc.updatedAt || latest.receivedAt;
  const fixTimeMs = new Date(fixTime).getTime();
  const ageSeconds = Math.max(0, Math.round((Date.now() - fixTimeMs) / 1000));
  const isStale = fresh.isStale || ageSeconds > staleThresholdSeconds;

  const coordinates = { latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)) };

  if (isStale) {
    return {
      status: 'STALE',
      coordinates,
      fixTime,
      ageSeconds,
      satellites: latest.gps_satellites ?? loc.gps_satellites ?? null,
      speed_kmph: latest.gps_speed ?? loc.gps_speed ?? null,
      altitude_m: latest.altitude_m ?? loc.altitude_m ?? null,
      reason: `GPS fix is stale (${ageSeconds}s old > ${staleThresholdSeconds}s)`,
    };
  }

  return {
    status: 'AVAILABLE',
    coordinates,
    fixTime,
    ageSeconds,
    satellites: latest.gps_satellites ?? loc.gps_satellites ?? null,
    speed_kmph: latest.gps_speed ?? loc.gps_speed ?? null,
    altitude_m: latest.altitude_m ?? loc.altitude_m ?? null,
  };
}
