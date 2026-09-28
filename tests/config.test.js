import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config, smsIsConfigured } from '../server/config.js';

describe('Server Configuration (server/config.js)', () => {
  test('provides safe defaults for core networking and server options', () => {
    assert.equal(typeof config.PORT, 'number');
    assert.equal(config.PORT, 5000);
    assert.equal(config.CORS_ORIGIN, '*');
    assert.equal(config.NODE_ENV, 'development');
  });

  test('provides safe defaults for hardware ingestion & site telemetry', () => {
    assert.equal(config.HARDWARE_API_KEY, '');
    assert.equal(config.HARDWARE_STALE_SECONDS, 60);
    assert.equal(config.MAX_HISTORY, 360);
    assert.equal(config.SITE_LATITUDE, 19.1334);
    assert.equal(config.SITE_LONGITUDE, 72.9133);
    assert.equal(config.SITE_LABEL, 'IIT Bombay Hillside Station #1');
  });

  test('provides safe defaults for weather settings', () => {
    assert.equal(config.WEATHER_API_URL, 'https://api.open-meteo.com/v1/forecast');
    assert.equal(config.WEATHER_CACHE_MINUTES, 15);
    assert.equal(config.WEATHER_CHECK_INTERVAL_MINUTES, 15);
  });

  test('provides risk thresholds matching Section 6 & 10 of guide', () => {
    assert.equal(config.RISK_THRESHOLD_WARNING, 4);
    assert.equal(config.RISK_THRESHOLD_HIGH, 7);
    assert.equal(config.RISK_THRESHOLD_DANGER, 10);
    assert.equal(config.ALERT_COOLDOWN_MINUTES, 15);
  });

  test('provides SMS provider settings and smsIsConfigured() helper', () => {
    assert.equal(typeof config.SMS_PROVIDER, 'string');
    assert.equal(config.ALLOW_REAL_TEST_SMS, false);

    // Default provider is 'console' -> smsIsConfigured() returns true in dev/test mode
    assert.equal(smsIsConfigured(), true);
  });

  test('provides safe evacuation map & routing settings', () => {
    assert.ok(config.MAP_STYLE_URL.includes('{z}'));
    assert.equal(config.OSRM_BASE_URL, 'https://router.project-osrm.org');
    assert.ok(config.SATELLITE_TILE_URL.includes('{z}'));
    assert.equal(config.SAFE_DEST_LATITUDE, 19.1360);
    assert.equal(config.SAFE_DEST_LONGITUDE, 72.9160);
    assert.equal(config.SAFE_DEST_LABEL, 'Campus Evacuation Center / Safe Shelter');
    assert.equal(config.SAFE_DEST_VERIFIED, true);
  });
});
