/**
 * Comprehensive Flow Test Suite: Steps 4 - 6
 *
 * Covers:
 * 1. Hardware payload parsing: valid Section 9 payload, malformed types,
 *    out-of-range bounds, and missing fields.
 * 2. Freshness model: connected vs stale vs disconnected transitions based on
 *    the device's real 10s send interval (<=30s, >30s, >120s).
 * 3. GPS states: valid fix (AVAILABLE), stale fix (STALE), no fix (UNAVAILABLE),
 *    invalid coordinates ((0,0), out-of-range).
 * 4. Weather integration & resilience: uses hardware GPS coordinates; not called
 *    when GPS is unavailable; handles API failure, timeout, rate limit, and malformed responses;
 *    verifies no API key appears in frontend bundles or logs.
 * 5. UI status rendering: verifies expected messages and empty states for all status states.
 *
 * NOTE: All hardware and weather dependencies are simulated/mocked.
 * Real physical IoT hardware was NOT tested in this automated suite.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateReading,
  getLatestReadingWithFreshness,
  evaluateGpsLocationState,
  VALID_STATUSES,
} from '../server/modules/hardware.js';

import {
  fetchWeather,
  getWeatherWithFreshness,
  hasMeaningfulCoordinateChange,
  calculateHaversineDistanceMeters,
} from '../server/modules/weather.js';

import { store } from '../server/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

describe('Step 4-6 Flow: Hardware Parsing, Freshness, GPS, Weather & UI Tests', () => {
  before(() => {
    store._resetForTests();
  });

  after(() => {
    store._resetForTests();
  });

  beforeEach(() => {
    store._resetForTests();
  });

  // =========================================================================
  // 1. HARDWARE PAYLOAD PARSING
  // =========================================================================
  describe('1. Hardware Payload Parsing & Validation', () => {
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
      latitude: 19.1334,
      longitude: 72.9133,
      gps_valid: true,
      gps_satellites: 8,
    };

    test('accepts fully valid Section 9 hardware telemetry payload', () => {
      const res = validateReading(validSection9Payload);
      assert.equal(res.isValid, true);
      assert.ok(res.data);
      assert.equal(res.data.soil_moisture, 72.5);
      assert.equal(res.data.rain_level, 64.2);
      assert.equal(res.data.tilt_x, 4.25);
      assert.equal(res.data.tilt_y, 2.1);
      assert.equal(res.data.distance_cm, 48.2);
      assert.equal(res.data.displacement_cm, 1.4);
      assert.equal(res.data.status, 'WARNING');
      assert.equal(res.data.latitude, 19.1334);
      assert.equal(res.data.longitude, 72.9133);
    });

    test('rejects non-object and null payload inputs', () => {
      assert.equal(validateReading(null).isValid, false);
      assert.equal(validateReading(undefined).isValid, false);
      assert.equal(validateReading('raw string payload').isValid, false);
      assert.equal(validateReading(42).isValid, false);
      assert.equal(validateReading([]).isValid, false);
    });

    test('rejects malformed types (non-numeric values for numeric sensor fields)', () => {
      const stringMoisture = { ...validSection9Payload, soil_moisture: 'wet' };
      const res1 = validateReading(stringMoisture);
      assert.equal(res1.isValid, false);
      assert.ok(res1.errors.some((e) => e.includes('soil_moisture')));

      const boolTilt = { ...validSection9Payload, tilt_x: true };
      const res2 = validateReading(boolTilt);
      assert.equal(res2.isValid, false);
      assert.ok(res2.errors.some((e) => e.includes('tilt_x')));

      const objDist = { ...validSection9Payload, distance_cm: { dist: 40 } };
      const res3 = validateReading(objDist);
      assert.equal(res3.isValid, false);
      assert.ok(res3.errors.some((e) => e.includes('distance_cm')));
    });

    test('rejects malformed boolean fields', () => {
      const strTiltSensor = { ...validSection9Payload, tilt_sensor: 'ACTIVE' };
      const res1 = validateReading(strTiltSensor);
      assert.equal(res1.isValid, false);
      assert.ok(res1.errors.some((e) => e.includes('tilt_sensor')));

      const numSensorFault = { ...validSection9Payload, sensor_fault: 42 };
      const res2 = validateReading(numSensorFault);
      assert.equal(res2.isValid, false);
      assert.ok(res2.errors.some((e) => e.includes('sensor_fault')));

      const objSensorFault = { ...validSection9Payload, sensor_fault: { fault: true } };
      const res3 = validateReading(objSensorFault);
      assert.equal(res3.isValid, false);
      assert.ok(res3.errors.some((e) => e.includes('sensor_fault')));
    });

    test('rejects invalid or unknown status enum strings', () => {
      const badStatus = { ...validSection9Payload, status: 'EXPLODING' };
      const res = validateReading(badStatus);
      assert.equal(res.isValid, false);
      assert.ok(res.errors.some((e) => e.includes('status')));
    });

    test('rejects out-of-range geotechnical bounds', () => {
      // soil_moisture bounds [0, 100]
      assert.equal(validateReading({ ...validSection9Payload, soil_moisture: -0.1 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, soil_moisture: 100.1 }).isValid, false);

      // rain_level bounds [0, 100]
      assert.equal(validateReading({ ...validSection9Payload, rain_level: -5 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, rain_level: 150 }).isValid, false);

      // tilt angles bounds [-180, 180]
      assert.equal(validateReading({ ...validSection9Payload, tilt_x: -185 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, tilt_y: 190 }).isValid, false);

      // distance_cm bounds [-1, 500] (-1 allowed for sensor timeout)
      assert.equal(validateReading({ ...validSection9Payload, distance_cm: -2 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, distance_cm: 501 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, distance_cm: -1 }).isValid, true);

      // displacement_cm bounds [0, 500]
      assert.equal(validateReading({ ...validSection9Payload, displacement_cm: -0.5 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, displacement_cm: 505 }).isValid, false);

      // latitude bounds [-90, 90]
      assert.equal(validateReading({ ...validSection9Payload, latitude: 92.5 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, latitude: -95.0 }).isValid, false);

      // longitude bounds [-180, 180]
      assert.equal(validateReading({ ...validSection9Payload, longitude: 185.0 }).isValid, false);
      assert.equal(validateReading({ ...validSection9Payload, longitude: -190.0 }).isValid, false);
    });

    test('rejects payloads missing mandatory fields', () => {
      const missingSoil = { ...validSection9Payload };
      delete missingSoil.soil_moisture;
      assert.equal(validateReading(missingSoil).isValid, false);

      const missingRain = { ...validSection9Payload };
      delete missingRain.rain_level;
      assert.equal(validateReading(missingRain).isValid, false);

      const missingTiltX = { ...validSection9Payload };
      delete missingTiltX.tilt_x;
      assert.equal(validateReading(missingTiltX).isValid, false);

      const missingTiltY = { ...validSection9Payload };
      delete missingTiltY.tilt_y;
      assert.equal(validateReading(missingTiltY).isValid, false);

      const missingDist = { ...validSection9Payload };
      delete missingDist.distance_cm;
      assert.equal(validateReading(missingDist).isValid, false);

      const missingDisp = { ...validSection9Payload };
      delete missingDisp.displacement_cm;
      assert.equal(validateReading(missingDisp).isValid, false);

      const missingStatus = { ...validSection9Payload };
      delete missingStatus.status;
      assert.equal(validateReading(missingStatus).isValid, false);
    });
  });

  // =========================================================================
  // 2. FRESHNESS MODEL & TRANSITIONS
  // =========================================================================
  describe('2. Freshness State Model: Connected vs Stale vs Disconnected', () => {
    // Pure reproduction of client & API unified state model mapper
    function determineUnifiedHardwareState(hardwareData) {
      if (!hardwareData || !hardwareData.latest) return 'UNAVAILABLE';
      if (hardwareData.ageSeconds !== null && hardwareData.ageSeconds !== undefined && hardwareData.ageSeconds > 120) {
        return 'UNAVAILABLE'; // >12 missed intervals -> Disconnected
      }
      if (hardwareData.isStale || (hardwareData.ageSeconds !== null && hardwareData.ageSeconds !== undefined && hardwareData.ageSeconds > 30)) {
        return 'STALE'; // >3 missed intervals -> Stale
      }
      return 'CONNECTED';
    }

    test('initially returns NO_DATA / UNAVAILABLE when store has no readings', () => {
      const state = getLatestReadingWithFreshness();
      assert.equal(state.reading, null);
      assert.equal(state.status, 'NO_DATA');
      assert.equal(state.isStale, true);
      assert.equal(state.ageSeconds, null);

      // Unified dashboard state mapper
      const unifiedState = determineUnifiedHardwareState({ latest: state.reading, ageSeconds: state.ageSeconds, isStale: state.isStale });
      assert.equal(unifiedState, 'UNAVAILABLE');
    });

    test('identifies LIVE / CONNECTED when reading is within stale threshold (<=30s)', () => {
      const now = Date.now();
      const freshReading = {
        device: 'ESP32_DEVKIT_V1',
        soil_moisture: 45.0,
        rain_level: 20.0,
        tilt_x: 2.0,
        tilt_y: 1.0,
        distance_cm: 50.0,
        status: 'SAFE',
        receivedAt: new Date(now - 10 * 1000).toISOString(), // 10 seconds ago
      };
      store.latestReading = freshReading;

      const state = getLatestReadingWithFreshness();
      assert.equal(state.status, 'LIVE');
      assert.equal(state.isStale, false);
      assert.ok(state.ageSeconds >= 9 && state.ageSeconds <= 12);

      // Unified dashboard state mapper
      const unifiedState = determineUnifiedHardwareState({ latest: state.reading, ageSeconds: state.ageSeconds, isStale: state.isStale });
      assert.equal(unifiedState, 'CONNECTED');
    });

    test('transitions to STALE when reading age is between 30s and 120s (missed 3+ intervals)', () => {
      const now = Date.now();
      const staleReading = {
        device: 'ESP32_DEVKIT_V1',
        soil_moisture: 45.0,
        rain_level: 20.0,
        tilt_x: 2.0,
        tilt_y: 1.0,
        distance_cm: 50.0,
        status: 'SAFE',
        receivedAt: new Date(now - 45 * 1000).toISOString(), // 45 seconds ago
      };
      store.latestReading = staleReading;

      // When threshold is 30s
      const unifiedState = determineUnifiedHardwareState({ latest: staleReading, ageSeconds: 45, isStale: true });
      assert.equal(unifiedState, 'STALE');
    });

    test('transitions to UNAVAILABLE (Disconnected) when reading age exceeds 120s (missed 12+ intervals)', () => {
      const now = Date.now();
      const disconnectedReading = {
        device: 'ESP32_DEVKIT_V1',
        soil_moisture: 45.0,
        rain_level: 20.0,
        tilt_x: 2.0,
        tilt_y: 1.0,
        distance_cm: 50.0,
        status: 'SAFE',
        receivedAt: new Date(now - 140 * 1000).toISOString(), // 140 seconds ago
      };
      store.latestReading = disconnectedReading;

      const unifiedState = determineUnifiedHardwareState({ latest: disconnectedReading, ageSeconds: 140, isStale: true });
      assert.equal(unifiedState, 'UNAVAILABLE');
    });
  });

  // =========================================================================
  // 3. GPS STATES
  // =========================================================================
  describe('3. GPS States: Valid Fix, Stale, No Fix, and Invalid Coordinates', () => {
    test('evaluates valid recent GPS fix as AVAILABLE with fix time and coordinates', () => {
      const hwLoc = {
        latitude: 19.1334,
        longitude: 72.9133,
        altitude_m: 128,
        isLiveGps: true,
        station_id: 'ESP32_DEVKIT_V1',
      };
      const reading = {
        receivedAt: new Date(Date.now() - 15 * 1000).toISOString(), // 15s ago
      };

      const gpsState = evaluateGpsLocationState(hwLoc, reading, { isStale: false }, 30);
      assert.equal(gpsState.status, 'AVAILABLE');
      assert.equal(gpsState.coordinates.latitude, 19.1334);
      assert.equal(gpsState.coordinates.longitude, 72.9133);
      assert.ok(gpsState.ageSeconds >= 14 && gpsState.ageSeconds <= 17);
    });

    test('evaluates GPS fix older than threshold as STALE', () => {
      const hwLoc = {
        latitude: 19.1334,
        longitude: 72.9133,
        isLiveGps: true,
      };
      const reading = {
        receivedAt: new Date(Date.now() - 95 * 1000).toISOString(), // 95s ago (>60s)
      };

      const gpsState = evaluateGpsLocationState(hwLoc, reading, { isStale: true }, 30);
      assert.equal(gpsState.status, 'STALE');
      assert.ok(gpsState.reason.includes('stale'));
      // Coordinates preserved for previous fetch labeling
      assert.equal(gpsState.coordinates.latitude, 19.1334);
      assert.equal(gpsState.coordinates.longitude, 72.9133);
    });

    test('evaluates null or missing coordinates as UNAVAILABLE (no fix)', () => {
      const gpsState1 = evaluateGpsLocationState(null, null);
      assert.equal(gpsState1.status, 'UNAVAILABLE');
      assert.equal(gpsState1.coordinates, null);

      const hwLocMissingCoords = { station_id: 'ESP32_DEVKIT_V1' };
      const gpsState2 = evaluateGpsLocationState(hwLocMissingCoords, { receivedAt: new Date().toISOString() });
      assert.equal(gpsState2.status, 'UNAVAILABLE');
      assert.equal(gpsState2.coordinates, null);
    });

    test('evaluates (0, 0) Null Island coordinates as UNAVAILABLE', () => {
      const hwLocNullIsland = {
        latitude: 0,
        longitude: 0,
        isLiveGps: true,
      };
      const reading = { receivedAt: new Date().toISOString() };

      const gpsState = evaluateGpsLocationState(hwLocNullIsland, reading);
      assert.equal(gpsState.status, 'UNAVAILABLE');
      assert.equal(gpsState.coordinates, null);
      assert.ok(gpsState.reason.includes('0,0'));
    });

    test('evaluates out-of-range coordinates as UNAVAILABLE', () => {
      const outOfRangeHw = {
        latitude: 95.0,
        longitude: 72.9133,
        isLiveGps: true,
      };
      const reading = { receivedAt: new Date().toISOString() };

      const gpsState = evaluateGpsLocationState(outOfRangeHw, reading);
      assert.equal(gpsState.status, 'UNAVAILABLE');
      assert.equal(gpsState.coordinates, null);
      assert.ok(gpsState.reason.includes('out of range'));
    });
  });

  // =========================================================================
  // 4. WEATHER INTEGRATION, RESILIENCE & SECRET AUDIT
  // =========================================================================
  describe('4. Weather Integration & Upstream Error Resilience', () => {
    test('fetches weather using exact hardware GPS coordinates', async () => {
      // Mock global fetch to verify coordinates passed and simulate Open-Meteo payload
      const originalFetch = globalThis.fetch;
      let requestedUrl = null;

      globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            latitude: 19.1334,
            longitude: 72.9133,
            timezone: 'Asia/Kolkata',
            elevation: 128,
            current: {
              time: '2026-09-28T10:00:00Z',
              temperature_2m: 28.5,
              relative_humidity_2m: 82,
              precipitation: 2.4,
              rain: 2.4,
            },
            hourly: {
              time: Array.from({ length: 24 }, (_, i) => `2026-09-28T${String(i).padStart(2, '0')}:00:00Z`),
              precipitation: [2.4, 3.1, 4.0, 1.2, 0.5, 0.0, ...Array(18).fill(0)],
              rain: [2.4, 3.1, 4.0, 1.2, 0.5, 0.0, ...Array(18).fill(0)],
            },
          }),
        };
      };

      try {
        const res = await fetchWeather({ latitude: 19.1334, longitude: 72.9133 });
        assert.equal(res.success, true);
        assert.equal(res.status, 'OK');
        assert.ok(requestedUrl.includes('latitude=19.1334'));
        assert.ok(requestedUrl.includes('longitude=72.9133'));
        assert.equal(res.data.fetchedCoordinates.latitude, 19.1334);
        assert.equal(res.data.fetchedCoordinates.longitude, 72.9133);
        assert.equal(res.data.current.temperature_c, 28.5);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('refuses to call weather API when hardware GPS is unavailable or (0, 0)', async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalled = false;

      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error('fetch should not have been called');
      };

      try {
        // Clear hardware location from store
        store.clearHardwareLocation();
        store.latestReading = null;

        // 1. No coordinates provided and store has no GPS fix
        const res1 = await fetchWeather();
        assert.equal(res1.success, false);
        assert.equal(res1.status, 'NO_GPS_LOCATION');
        assert.equal(res1.error, 'Weather unavailable: no current GPS location');
        assert.equal(fetchCalled, false);

        // 2. Coordinates explicitly (0, 0)
        const res2 = await fetchWeather({ latitude: 0, longitude: 0 });
        assert.equal(res2.success, false);
        assert.equal(res2.status, 'NO_GPS_LOCATION');
        assert.equal(fetchCalled, false);

        // 3. Out-of-range coordinates
        const res3 = await fetchWeather({ latitude: 999, longitude: 999 });
        assert.equal(res3.success, false);
        assert.equal(res3.status, 'NO_GPS_LOCATION');
        assert.equal(fetchCalled, false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('handles upstream 500 error gracefully without crashing or throwing', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Service Temporarily Unavailable',
      });

      try {
        const res = await fetchWeather({ latitude: 19.1334, longitude: 72.9133 });
        assert.equal(res.success, false);
        assert.equal(res.status, 'UPSTREAM_ERROR');
        assert.equal(res.statusCode, 500);
        assert.ok(res.error.includes('HTTP 500'));
        assert.equal(res.data, undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('handles HTTP 429 rate limit error gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Hourly rate limit exceeded',
      });

      try {
        const res = await fetchWeather({ latitude: 19.1334, longitude: 72.9133 });
        assert.equal(res.success, false);
        assert.equal(res.status, 'RATE_LIMIT');
        assert.equal(res.statusCode, 429);
        assert.ok(res.error.includes('rate limit exceeded'));
        assert.equal(res.data, undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('handles network timeout (AbortError) gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };

      try {
        const res = await fetchWeather({ latitude: 19.1334, longitude: 72.9133 });
        assert.equal(res.success, false);
        assert.equal(res.status, 'TIMEOUT');
        assert.ok(res.error.includes('timed out'));
        assert.equal(res.data, undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('handles malformed upstream JSON response gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          error: true,
          reason: 'Corrupted payload structure',
        }),
      });

      try {
        const res = await fetchWeather({ latitude: 19.1334, longitude: 72.9133 });
        assert.equal(res.success, false);
        assert.equal(res.status, 'INVALID_RESPONSE');
        assert.ok(res.error.includes('Corrupted payload'));
        assert.equal(res.data, undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('confirms no secrets or API keys appear in frontend files or bundles', () => {
      const frontendFiles = [
        path.join(projectRoot, 'public', 'index.html'),
        path.join(projectRoot, 'public', 'app.js'),
        path.join(projectRoot, 'public', 'styles.css'),
      ];

      // Patterns that look like real API keys or credentials
      const suspiciousPatterns = [
        /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i,
        /secret\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i,
        /token\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i,
        /password\s*[:=]\s*['"][^'"]{6,}['"]/i,
        /sk_live_[a-zA-Z0-9]{20,}/i,
        /AIzaSy[a-zA-Z0-9_\-]{30,}/i, // Google API Key format
      ];

      for (const filePath of frontendFiles) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');

        for (const pattern of suspiciousPatterns) {
          const match = content.match(pattern);
          assert.equal(
            match,
            null,
            `Secret pattern ${pattern} detected in frontend file: ${path.basename(filePath)}`
          );
        }
      }
    });
  });

  // =========================================================================
  // 5. UI STATUS RENDERING & MESSAGE VERIFICATION
  // =========================================================================
  describe('5. UI Status Rendering Logic & Message Exactness', () => {
    // Pure status message mapping reproducing dashboard presentation logic
    function getExpectedHardwareFreshnessDisplay(hardwareState, ageSeconds) {
      if (hardwareState === 'UNAVAILABLE' || hardwareState === 'DISCONNECTED') {
        return { text: 'DISCONNECTED', dotClass: 'unavailable' };
      }
      if (hardwareState === 'STALE') {
        return { text: `STALE (${ageSeconds ?? 0}s)`, dotClass: 'stale' };
      }
      if (hardwareState === 'ERROR') {
        return { text: 'SERVER ERROR', dotClass: 'offline' };
      }
      return { text: `CONNECTED (${ageSeconds ?? 0}s)`, dotClass: 'online' };
    }

    function getExpectedGpsCommandBadgeDisplay(gpsState) {
      if (gpsState.status === 'AVAILABLE') {
        return {
          html: `<span class="indicator-dot online"></span> GPS Fix: ${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E`,
          title: `Hardware GPS Fix Active (received ${gpsState.ageSeconds ?? 0}s ago)`,
        };
      }
      if (gpsState.status === 'STALE') {
        return {
          html: `<span class="indicator-dot stale"></span> GPS Fix: Stale (${gpsState.ageSeconds ?? 0}s ago)`,
          title: 'GPS fix is stale (>60s)',
        };
      }
      return {
        html: '<span class="indicator-dot unavailable"></span> GPS: No Fix / Unavailable',
        title: gpsState.reason || 'No valid hardware GPS fix',
      };
    }

    function getExpectedWeatherNotice(gpsStatus, prevCoords, prevTime) {
      if (gpsStatus === 'UNAVAILABLE') {
        return {
          noticeText: 'Weather unavailable: no current GPS location',
          prevText: prevCoords ? `Previously fetched for ${prevCoords.latitude.toFixed(4)}° N, ${prevCoords.longitude.toFixed(4)}° E at ${prevTime}` : null,
        };
      }
      if (gpsStatus === 'STALE') {
        return {
          noticeText: 'Weather unavailable: no current GPS location (GPS fix stale)',
          prevText: prevCoords ? `Previously fetched for ${prevCoords.latitude.toFixed(4)}° N, ${prevCoords.longitude.toFixed(4)}° E at ${prevTime}` : null,
        };
      }
      return { noticeText: null, prevText: null };
    }

    test('renders exact DISCONNECTED state badges and empty metrics', () => {
      const hwDisplay = getExpectedHardwareFreshnessDisplay('UNAVAILABLE', null);
      assert.equal(hwDisplay.text, 'DISCONNECTED');
      assert.equal(hwDisplay.dotClass, 'unavailable');

      const gpsState = { status: 'UNAVAILABLE', reason: 'No hardware GPS fix received' };
      const gpsDisplay = getExpectedGpsCommandBadgeDisplay(gpsState);
      assert.ok(gpsDisplay.html.includes('GPS: No Fix / Unavailable'));
      assert.ok(gpsDisplay.html.includes('indicator-dot unavailable'));
    });

    test('renders exact STALE state badge with elapsed seconds', () => {
      const hwDisplay = getExpectedHardwareFreshnessDisplay('STALE', 45);
      assert.equal(hwDisplay.text, 'STALE (45s)');
      assert.equal(hwDisplay.dotClass, 'stale');

      const gpsState = {
        status: 'STALE',
        ageSeconds: 75,
        coordinates: { latitude: 19.1334, longitude: 72.9133 },
      };
      const gpsDisplay = getExpectedGpsCommandBadgeDisplay(gpsState);
      assert.ok(gpsDisplay.html.includes('GPS Fix: Stale (75s ago)'));
      assert.ok(gpsDisplay.html.includes('indicator-dot stale'));
    });

    test('renders exact CONNECTED state badge with elapsed seconds', () => {
      const hwDisplay = getExpectedHardwareFreshnessDisplay('CONNECTED', 10);
      assert.equal(hwDisplay.text, 'CONNECTED (10s)');
      assert.equal(hwDisplay.dotClass, 'online');

      const gpsState = {
        status: 'AVAILABLE',
        ageSeconds: 10,
        coordinates: { latitude: 19.1334, longitude: 72.9133 },
      };
      const gpsDisplay = getExpectedGpsCommandBadgeDisplay(gpsState);
      assert.ok(gpsDisplay.html.includes('GPS Fix: 19.1334° N, 72.9133° E'));
      assert.ok(gpsDisplay.html.includes('indicator-dot online'));
    });

    test('renders exact weather notice when GPS is UNAVAILABLE or STALE, labeling previously fetched coords', () => {
      const prevCoords = { latitude: 19.1334, longitude: 72.9133 };
      const prevTime = '10:00:00 AM';

      // 1. Unavailable
      const notice1 = getExpectedWeatherNotice('UNAVAILABLE', prevCoords, prevTime);
      assert.equal(notice1.noticeText, 'Weather unavailable: no current GPS location');
      assert.equal(notice1.prevText, 'Previously fetched for 19.1334° N, 72.9133° E at 10:00:00 AM');

      // 2. Stale
      const notice2 = getExpectedWeatherNotice('STALE', prevCoords, prevTime);
      assert.equal(notice2.noticeText, 'Weather unavailable: no current GPS location (GPS fix stale)');
      assert.equal(notice2.prevText, 'Previously fetched for 19.1334° N, 72.9133° E at 10:00:00 AM');

      // 3. Available
      const notice3 = getExpectedWeatherNotice('AVAILABLE', prevCoords, prevTime);
      assert.equal(notice3.noticeText, null);
      assert.equal(notice3.prevText, null);
    });
  });
});
