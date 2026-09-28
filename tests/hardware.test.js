import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReading,
  checkApiKey,
  ingestReading,
  getLatestReadingWithFreshness,
  VALID_STATUSES,
} from '../server/modules/hardware.js';
import { store } from '../server/store.js';
import { config } from '../server/config.js';
import {
  calculateHaversineDistanceMeters,
  computeHazardAreaRisk,
} from '../server/routes/api.js';

describe('Hardware Module (server/modules/hardware.js)', () => {
  before(() => {
    store._resetForTests();
  });

  after(() => {
    store._resetForTests();
  });

  const validSection9Payload = {
    device: 'ESP32_DEVKIT_V1',
    soil_moisture: 72.5,
    rain_level: 64.2,
    soil_raw: 2100,
    rain_raw: 1800,
    tilt_x: 4.25,
    tilt_y: 2.1,
    acceleration: 9.81,
    distance_cm: 48.2,
    displacement_cm: 1.4,
    tilt_sensor: false,
    soil_trend: 12.2,
    rain_trend: 18.5,
    history_samples: 120,
    risk_score: 5,
    status: 'WARNING',
    sensor_fault: false,
    uptime_ms: 1234567,
  };

  test('validateReading() accepts valid Section 9 example payload', () => {
    const result = validateReading(validSection9Payload);
    assert.equal(result.isValid, true);
    assert.equal(result.data.soil_moisture, 72.5);
    assert.equal(result.data.status, 'WARNING');
    assert.equal(result.data.history_samples, 120);
  });

  test('validateReading() rejects non-object or null input', () => {
    const nullRes = validateReading(null);
    assert.equal(nullRes.isValid, false);
    assert.ok(nullRes.errors[0].includes('valid JSON object'));

    const arrRes = validateReading([]);
    assert.equal(arrRes.isValid, false);

    const strRes = validateReading('hello');
    assert.equal(strRes.isValid, false);
  });

  test('validateReading() rejects out-of-range or non-numeric soil_moisture', () => {
    const highRes = validateReading({ ...validSection9Payload, soil_moisture: 105.0 });
    assert.equal(highRes.isValid, false);
    assert.ok(highRes.errors.some((e) => e.includes('soil_moisture')));

    const negRes = validateReading({ ...validSection9Payload, soil_moisture: -5 });
    assert.equal(negRes.isValid, false);

    const strRes = validateReading({ ...validSection9Payload, soil_moisture: 'dry' });
    assert.equal(strRes.isValid, false);
  });

  test('validateReading() rejects out-of-range tilt angles', () => {
    const tiltRes = validateReading({ ...validSection9Payload, tilt_x: 195 });
    assert.equal(tiltRes.isValid, false);
    assert.ok(tiltRes.errors.some((e) => e.includes('tilt_x')));
  });

  test('validateReading() accepts -1 for ultrasonic distance timeout fault', () => {
    const faultRes = validateReading({ ...validSection9Payload, distance_cm: -1 });
    assert.equal(faultRes.isValid, true);
    assert.equal(faultRes.data.distance_cm, -1);
  });

  test('validateReading() rejects invalid ultrasonic distance below -1 or above 500', () => {
    const negRes = validateReading({ ...validSection9Payload, distance_cm: -2 });
    assert.equal(negRes.isValid, false);

    const farRes = validateReading({ ...validSection9Payload, distance_cm: 650 });
    assert.equal(farRes.isValid, false);
  });

  test('validateReading() validates boolean flags strictly', () => {
    const invalidTilt = validateReading({ ...validSection9Payload, tilt_sensor: 'maybe' });
    assert.equal(invalidTilt.isValid, false);
    assert.ok(invalidTilt.errors.some((e) => e.includes('tilt_sensor')));

    const validTiltStr = validateReading({ ...validSection9Payload, tilt_sensor: 'true' });
    assert.equal(validTiltStr.isValid, true);
    assert.equal(validTiltStr.data.tilt_sensor, true);
  });

  test('validateReading() enforces valid status enums', () => {
    const invalidStatus = validateReading({ ...validSection9Payload, status: 'PANIC' });
    assert.equal(invalidStatus.isValid, false);
    assert.ok(invalidStatus.errors.some((e) => e.includes('status')));

    for (const validStatus of VALID_STATUSES) {
      const res = validateReading({ ...validSection9Payload, status: validStatus });
      assert.equal(res.isValid, true);
      assert.equal(res.data.status, validStatus);
    }
  });

  test('checkApiKey() behaves correctly based on configuration', () => {
    // With empty config.HARDWARE_API_KEY, prototype mode is open
    assert.equal(checkApiKey(undefined), true);
    assert.equal(checkApiKey('random-key'), true);

    // When configured with a secret key
    const origHwKey = config.hardware.apiKey;
    const origKey = config.HARDWARE_API_KEY;
    try {
      config.hardware.apiKey = 'secret-test-key-123';
      config.HARDWARE_API_KEY = 'secret-test-key-123';
      assert.equal(checkApiKey('secret-test-key-123'), true);
      assert.equal(checkApiKey('wrong-key'), false);
      assert.equal(checkApiKey(undefined), false);
    } finally {
      config.hardware.apiKey = origHwKey;
      config.HARDWARE_API_KEY = origKey;
    }
  });

  test('ingestReading() stamps receivedAt and writes to store', () => {
    const stored = ingestReading(validSection9Payload);
    assert.ok(stored.receivedAt);
    assert.equal(store.getLatestReading().soil_moisture, 72.5);
  });

  test('getLatestReadingWithFreshness() accurately computes freshness and staleness', () => {
    // Currently just ingested -> LIVE, not stale
    const fresh = getLatestReadingWithFreshness();
    assert.equal(fresh.isStale, false);
    assert.equal(fresh.status, 'LIVE');
    assert.equal(typeof fresh.ageSeconds, 'number');

    // Simulate stale reading (> 60 seconds ago)
    const staleTime = new Date(Date.now() - 75 * 1000).toISOString();
    store.addReading({ ...validSection9Payload, receivedAt: staleTime });

    const staleRes = getLatestReadingWithFreshness();
    assert.equal(staleRes.isStale, true);
    assert.equal(staleRes.status, 'STALE');
    assert.ok(staleRes.ageSeconds >= 70);
  });

  test('validateReading() accepts optional hardware GPS coordinates and station ID', () => {
    const payloadWithGps = {
      ...validSection9Payload,
      latitude: 11.5367,
      longitude: 76.1384,
      altitude_m: 820,
      station_id: 'WAYANAD_SLOPE_NODE_01',
    };
    const result = validateReading(payloadWithGps);
    assert.equal(result.isValid, true);
    assert.equal(result.data.latitude, 11.5367);
    assert.equal(result.data.longitude, 76.1384);
    assert.equal(result.data.altitude_m, 820);
    assert.equal(result.data.station_id, 'WAYANAD_SLOPE_NODE_01');
  });

  test('validateReading() accepts Section 7 GPS payload fields (gps_valid, gps_altitude, gps_speed, gps_satellites)', () => {
    const gpsGuidePayload = {
      device: 'ESP32_LANDSLIDE_01',
      gps_valid: true,
      latitude: 11.016800,
      longitude: 76.955800,
      gps_altitude: 421.5,
      gps_speed: 0.0,
      gps_satellites: 8,
      soil_moisture: 72.5,
      rain_level: 64.2,
      soil_raw: 2100,
      rain_raw: 1800,
      tilt_x: 4.25,
      tilt_y: 2.10,
      acceleration: 9.81,
      distance_cm: 48.20,
      displacement_cm: 1.40,
      tilt_sensor: false,
      soil_trend: 12.20,
      rain_trend: 18.50,
      history_samples: 120,
      risk_score: 5,
      status: 'WARNING',
      sensor_fault: false,
      uptime_ms: 1234567,
    };
    const result = validateReading(gpsGuidePayload);
    assert.equal(result.isValid, true);
    assert.equal(result.data.gps_valid, true);
    assert.equal(result.data.latitude, 11.016800);
    assert.equal(result.data.longitude, 76.955800);
    assert.equal(result.data.gps_altitude, 421.5);
    assert.equal(result.data.altitude_m, 421.5);
    assert.equal(result.data.gps_speed, 0.0);
    assert.equal(result.data.gps_satellites, 8);
  });

  test('validateReading() rejects out-of-range GPS coordinates', () => {
    const invalidLat = { ...validSection9Payload, latitude: 120.5 };
    const resLat = validateReading(invalidLat);
    assert.equal(resLat.isValid, false);
    assert.ok(resLat.errors.some((e) => e.includes('between -90 and 90')));

    const invalidLng = { ...validSection9Payload, longitude: 250 };
    const resLng = validateReading(invalidLng);
    assert.equal(resLng.isValid, false);
    assert.ok(resLng.errors.some((e) => e.includes('between -180 and 180')));
  });

  test('calculateHaversineDistanceMeters() returns accurate geodesic distance', () => {
    // Distance between Wayanad node (11.5367, 76.1384) and nearby point (11.5390, 76.1390) is ~264m
    const dist = calculateHaversineDistanceMeters(11.5367, 76.1384, 11.5390, 76.1390);
    assert.ok(dist >= 250 && dist <= 280, `Expected distance ~264m, got ${dist}`);

    // Same point returns 0
    const zeroDist = calculateHaversineDistanceMeters(11.5367, 76.1384, 11.5367, 76.1384);
    assert.equal(zeroDist, 0);
  });

  test('computeHazardAreaRisk() calculates critical impact footprint and user proximity', () => {
    const hwLoc = {
      latitude: 11.5367,
      longitude: 76.1384,
      altitude_m: 820,
      station_id: 'WAYANAD_SLOPE_NODE_01',
      label: 'Wayanad Meppadi Hillside Node',
      isLiveGps: true,
    };

    // Case 1: DANGER status (600m impact, 1800m buffer)
    const dangerHazard = computeHazardAreaRisk('DANGER', hwLoc, 11.5390, 76.1390);
    assert.equal(dangerHazard.status, 'DANGER');
    assert.equal(dangerHazard.severity, 'CRITICAL');
    assert.equal(dangerHazard.impactRadiusMeters, 600);
    assert.equal(dangerHazard.secondaryBufferMeters, 1800);
    assert.ok(dangerHazard.threatAreaSqKm > 1.0);
    assert.equal(dangerHazard.userProximity.isInsideImpactZone, true);
    assert.equal(dangerHazard.userProximity.proximityStatus, 'INSIDE_CRITICAL_IMPACT_ZONE');

    // Case 2: User located far away (~5 km) in SAFE status
    const safeHazard = computeHazardAreaRisk('SAFE', hwLoc, 11.5800, 76.1800);
    assert.equal(safeHazard.status, 'SAFE');
    assert.equal(safeHazard.severity, 'LOW');
    assert.equal(safeHazard.impactRadiusMeters, 150);
    assert.equal(safeHazard.userProximity.isInsideImpactZone, false);
    assert.equal(safeHazard.userProximity.proximityStatus, 'SAFE_DISTANCE');
  });
});

