import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SensorStore } from '../server/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_STORE_PATH = path.resolve(__dirname, 'test_store.json');

describe('JSON File-Backed SensorStore (server/store.js)', () => {
  let store;

  before(() => {
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
    store = new SensorStore({
      filePath: TEST_STORE_PATH,
      maxHistory: 360,
      autoPersist: true,
    });
  });

  after(() => {
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
  });

  test('creates store file on initialization', () => {
    assert.ok(fs.existsSync(TEST_STORE_PATH));
    const content = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
    assert.equal(content.latestReading, null);
    assert.deepEqual(content.history, []);
    assert.deepEqual(content.alertLog, []);
  });

  test('stores latestReading and maintains 360-reading ring buffer', () => {
    for (let i = 1; i <= 370; i++) {
      store.addReading({ readingId: i, risk_score: i % 10 });
    }

    assert.equal(store.history.length, 360);
    assert.equal(store.getLatestReading().readingId, 370);
    assert.equal(store.history[0].readingId, 11); // oldest kept
    assert.equal(store.history[359].readingId, 370); // newest

    // Verify saved to disk
    const onDisk = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
    assert.equal(onDisk.history.length, 360);
    assert.equal(onDisk.latestReading.readingId, 370);
  });

  test('stores and retrieves latestWeather', () => {
    const weatherData = {
      temperature_c: 27.5,
      precipitation_mm: 12.4,
      forecast: 'Rainy',
    };
    store.setLatestWeather(weatherData);

    const retrieved = store.getLatestWeather();
    assert.equal(retrieved.temperature_c, 27.5);
    assert.ok(retrieved.cachedAt);

    const onDisk = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
    assert.equal(onDisk.latestWeather.temperature_c, 27.5);
  });

  test('preserves alertLog audit history (never truncated below 500 entries)', () => {
    // Add 550 alert events
    for (let i = 1; i <= 550; i++) {
      store.addAlertLog({
        type: 'ESCALATION',
        status: i % 2 === 0 ? 'HIGH_RISK' : 'DANGER',
        riskScore: 8,
        message: `Alert event ${i}`,
      });
    }

    assert.equal(store.alertLog.length, 550);
    assert.ok(store.alertLog.length >= 500);

    const recent = store.getAlertLog(10);
    assert.equal(recent.length, 10);
    assert.equal(recent[9].message, 'Alert event 550');
  });

  test('never erases alertLog on system recovery', () => {
    const countBeforeRecovery = store.alertLog.length;

    // Simulate recovery event
    store.addAlertLog({
      type: 'RECOVERY',
      status: 'SAFE',
      riskScore: 1,
      message: 'Slope returned to SAFE threshold',
    });

    // Alert log must retain all past history plus the recovery entry
    assert.equal(store.alertLog.length, countBeforeRecovery + 1);
    const lastEntry = store.alertLog[store.alertLog.length - 1];
    assert.equal(lastEntry.type, 'RECOVERY');
    assert.equal(lastEntry.status, 'SAFE');
  });

  test('tracks alert dedup state and cooldown verification', () => {
    store.recordAlertSent('DANGER');
    const dedup = store.getAlertDedup();
    assert.equal(dedup.lastLevel, 'DANGER');
    assert.ok(dedup.lastAlertSentAt);
    assert.ok(dedup.cooldowns['DANGER']);

    // Within cooldown period (15 minutes), should not permit duplicate alert
    assert.equal(store.canSendAlert('DANGER', 15), false);
    // Unseen level should be permitted
    assert.equal(store.canSendAlert('WARNING', 15), true);
  });

  test('stores recipient phone and consent record', () => {
    store.setRecipientConsent({
      phone: '+919876543210',
      consentGiven: true,
      verified: true,
      notes: 'Campus Safety Officer',
    });

    const consent = store.getRecipientConsent();
    assert.equal(consent.phone, '+919876543210');
    assert.equal(consent.consentGiven, true);
    assert.equal(consent.verified, true);
    assert.ok(consent.consentTimestamp);

    const recipients = store.getRecipients();
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].phone, '+919876543210');
  });

  test('_resetForTests() completely resets in-memory and on-disk state', () => {
    store._resetForTests();

    assert.equal(store.latestReading, null);
    assert.deepEqual(store.history, []);
    assert.equal(store.latestWeather, null);
    assert.deepEqual(store.alertLog, []);
    assert.equal(store.recipientPhoneConsent.phone, null);

    const onDisk = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
    assert.equal(onDisk.latestReading, null);
    assert.deepEqual(onDisk.history, []);
    assert.deepEqual(onDisk.alertLog, []);
  });
});
