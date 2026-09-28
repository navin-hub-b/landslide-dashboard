import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWeather,
  getWeatherWithFreshness,
  startWeatherPolling,
  stopWeatherPolling,
  hasMeaningfulCoordinateChange,
  calculateHaversineDistanceMeters,
} from '../server/modules/weather.js';
import { evaluateGpsLocationState } from '../server/modules/hardware.js';
import { store } from '../server/store.js';
import { config } from '../server/config.js';

describe('Weather Module (server/modules/weather.js)', () => {
  before(() => {
    store._resetForTests();
  });

  after(() => {
    stopWeatherPolling();
    store._resetForTests();
  });

  test('getWeatherWithFreshness() returns NO_DATA when cache is empty', () => {
    store.latestWeather = null;
    const result = getWeatherWithFreshness();
    assert.equal(result.weather, null);
    assert.equal(result.isStale, true);
    assert.equal(result.status, 'NO_DATA');
  });

  test('fetchWeather() calls Open-Meteo and caches real meteorological data', async () => {
    const res = await fetchWeather({
      latitude: config.site?.latitude || 19.1334,
      longitude: config.site?.longitude || 72.9133,
    });

    if (res.success) {
      assert.ok(res.data);
      assert.equal(res.data.source, 'open-meteo');
      assert.ok(Array.isArray(res.data.hourly.precipitation));
      assert.equal(typeof res.data.summary.next24hPrecipitationMm, 'number');

      // Verify cached in store
      const cached = store.getLatestWeather();
      assert.ok(cached);
      assert.equal(cached.source, 'open-meteo');
    } else {
      // If network in sandbox is restricted, verify explicit error object returned
      assert.equal(typeof res.error, 'string');
      assert.ok(res.status);
      assert.ok(['UPSTREAM_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(res.status));
    }
  });

  test('fetchWeather() returns an explicit error object on invalid coordinates or server error', async () => {
    // Open-Meteo returns 400 for latitude > 90
    const errRes = await fetchWeather({ latitude: 999.0, longitude: 999.0 });
    assert.equal(errRes.success, false);
    assert.equal(typeof errRes.error, 'string');
    assert.ok(errRes.error.length > 0);
    // Ensure data is NEVER fabricated
    assert.equal(errRes.data, undefined);
  });

  test('getWeatherWithFreshness() tracks cache age and flags staleness accurately', () => {
    const freshPayload = {
      source: 'test-meteo',
      current: { temperature_c: 26 },
      cachedAt: new Date().toISOString(),
    };
    store.latestWeather = freshPayload;

    const freshRes = getWeatherWithFreshness();
    assert.equal(freshRes.isStale, false);
    assert.equal(freshRes.status, 'FRESH');
    assert.equal(freshRes.ageMinutes, 0);

    // Simulate stale cache (20 minutes ago when threshold is 15 min)
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    store.latestWeather = {
      ...freshPayload,
      cachedAt: staleTime,
    };

    const staleRes = getWeatherWithFreshness();
    assert.equal(staleRes.isStale, true);
    assert.equal(staleRes.status, 'STALE');
    assert.ok(staleRes.ageMinutes >= 15);
  });

  test('startWeatherPolling() initiates timer and stopWeatherPolling() terminates it', () => {
    const timer = startWeatherPolling();
    assert.ok(timer);
    stopWeatherPolling();
  });

  test('fetchWeather() returns NO_GPS_LOCATION when no coords provided and store has no GPS fix', async () => {
    store.clearHardwareLocation();
    const res = await fetchWeather();
    assert.equal(res.success, false);
    assert.equal(res.status, 'NO_GPS_LOCATION');
    assert.equal(res.error, 'Weather unavailable: no current GPS location');
  });

  test('fetchWeather() rejects coordinates (0, 0) as invalid GPS fix', async () => {
    const res = await fetchWeather({ latitude: 0, longitude: 0 });
    assert.equal(res.success, false);
    assert.equal(res.status, 'NO_GPS_LOCATION');
    assert.equal(res.error, 'Weather unavailable: no current GPS location');
  });

  test('hasMeaningfulCoordinateChange() detects movements > 500m accurately', () => {
    // Exact same coordinates: 0m change -> false
    assert.equal(hasMeaningfulCoordinateChange(19.1334, 72.9133, 19.1334, 72.9133, 500), false);

    // Small jitter ~10-20 meters (0.0001 deg lat is ~11 meters) -> false
    assert.equal(hasMeaningfulCoordinateChange(19.1334, 72.9133, 19.1335, 72.9133, 500), false);

    // Large movement ~1.1 km (0.01 deg lat is ~1113 meters) -> true
    assert.equal(hasMeaningfulCoordinateChange(19.1334, 72.9133, 19.1440, 72.9133, 500), true);

    // Missing coordinates -> true (triggers initial fetch)
    assert.equal(hasMeaningfulCoordinateChange(null, null, 19.1334, 72.9133, 500), true);
  });

  test('evaluateGpsLocationState() computes AVAILABLE, STALE, and UNAVAILABLE states accurately', () => {
    // 1. Missing or no reading -> UNAVAILABLE
    const unavail1 = evaluateGpsLocationState(null, null, { isStale: true });
    assert.equal(unavail1.status, 'UNAVAILABLE');

    // 2. gps_valid is false -> UNAVAILABLE
    const unavail2 = evaluateGpsLocationState(
      { latitude: 19.1334, longitude: 72.9133 },
      { gps_valid: false, receivedAt: new Date().toISOString() },
      { isStale: false }
    );
    assert.equal(unavail2.status, 'UNAVAILABLE');

    // 3. Coordinates (0, 0) -> UNAVAILABLE
    const unavail3 = evaluateGpsLocationState(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0, receivedAt: new Date().toISOString() },
      { isStale: false }
    );
    assert.equal(unavail3.status, 'UNAVAILABLE');

    // 4. Valid coordinates, fresh reading -> AVAILABLE
    const nowIso = new Date().toISOString();
    const avail = evaluateGpsLocationState(
      { latitude: 19.1334, longitude: 72.9133, fixTime: nowIso },
      { latitude: 19.1334, longitude: 72.9133, receivedAt: nowIso },
      { isStale: false, ageSeconds: 5 }
    );
    assert.equal(avail.status, 'AVAILABLE');
    assert.equal(avail.coordinates.latitude, 19.1334);
    assert.equal(avail.coordinates.longitude, 72.9133);

    // 5. Valid coordinates, stale reading (>30s) -> STALE
    const staleTime = new Date(Date.now() - 45000).toISOString();
    const stale = evaluateGpsLocationState(
      { latitude: 19.1334, longitude: 72.9133, fixTime: staleTime },
      { latitude: 19.1334, longitude: 72.9133, receivedAt: staleTime },
      { isStale: true, ageSeconds: 45 }
    );
    assert.equal(stale.status, 'STALE');
    assert.equal(stale.coordinates.latitude, 19.1334);
    assert.ok(stale.ageSeconds >= 45);
  });
});
