import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import app from '../server/index.js';
import { SensorStore, store } from '../server/store.js';
import { config } from '../server/config.js';

describe('SensorStore (In-Memory Buffer)', () => {
  test('adds readings and maintains max history cap', () => {
    const testStore = new SensorStore(5);
    for (let i = 1; i <= 8; i++) {
      testStore.addReading({ readingId: i, risk_score: i });
    }

    assert.equal(testStore.history.length, 5);
    assert.equal(testStore.getLatest().readingId, 8);
    assert.equal(testStore.history[0].readingId, 4); // oldest kept
    assert.equal(testStore.history[4].readingId, 8); // newest
  });

  test('clears store correctly', () => {
    const testStore = new SensorStore(10);
    testStore.addReading({ val: 1 });
    assert.equal(testStore.history.length, 1);
    testStore.clear();
    assert.equal(testStore.history.length, 0);
    assert.equal(testStore.getLatest(), null);
  });
});

describe('API Route Handlers', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Start server on random ephemeral port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('GET /api/health returns ok status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.ok(data.timestamp);
  });

  test('POST /api/sensor-data receives and validates firmware payload', async () => {
    const payload = {
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

    const postRes = await fetch(`${baseUrl}/api/sensor-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.success, true);
    assert.equal(postData.data.device, 'ESP32_DEVKIT_V1');
    assert.equal(postData.data.risk_score, 5);
    assert.equal(postData.data.status, 'WARNING');
    assert.ok(postData.data.receivedAt);

    // Verify GET /api/sensor-data/latest reflects this update
    const getRes = await fetch(`${baseUrl}/api/sensor-data/latest`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.latest.device, 'ESP32_DEVKIT_V1');
    assert.equal(getData.latest.risk_score, 5);
  });

  test('POST /api/sensor-data/simulate creates a mock reading with risk calculation', async () => {
    const simRes = await fetch(`${baseUrl}/api/sensor-data/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        soil_moisture: 85,
        rain_level: 85,
        tilt_x: 22,
      }),
    });

    assert.equal(simRes.status, 201);
    const simData = await simRes.json();
    assert.equal(simData.success, true);
    // soil (>=80 -> +3) + rain (>=80 -> +3) + tilt (>=20 -> +3) = 9 (HIGH_RISK)
    assert.ok(simData.data.risk_score >= 9);
    assert.ok(['HIGH_RISK', 'DANGER'].includes(simData.data.status));
  });

  test('GET /api/sensor-data/history returns array of readings', async () => {
    const res = await fetch(`${baseUrl}/api/sensor-data/history?limit=5`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.history));
    assert.ok(data.history.length >= 1);
  });

  describe('Recipient & Consent Endpoints', () => {
    test('POST /api/recipient rejects without affirmative consent (consent !== true)', async () => {
      const res = await fetch(`${baseUrl}/api/recipient`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '9876543210',
          countryCode: '91',
          consent: false,
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes('Affirmative user consent is required'));
    });

    test('POST /api/recipient accepts with valid number and consent', async () => {
      const res = await fetch(`${baseUrl}/api/recipient`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '9876543210',
          countryCode: '91',
          consent: true,
          notes: 'Test Station Officer',
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.recipient.phone, '+919876543210');
      assert.equal(data.recipient.consentGiven, true);
    });

    test('DELETE /api/recipient removes recipient consent', async () => {
      const res = await fetch(`${baseUrl}/api/recipient`, {
        method: 'DELETE',
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);

      // Verify recipient is cleared
      const checkRes = await fetch(`${baseUrl}/api/recipient`);
      const checkData = await checkRes.json();
      assert.equal(checkData.recipient.phone, null);
      assert.equal(checkData.recipient.consentGiven, false);
    });
  });

  describe('Alerts & Notifications Endpoints', () => {
    test('POST /api/alerts/test executes simulated test alert safely', async () => {
      const res = await fetch(`${baseUrl}/api/alerts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '+919876543210',
          consent: true,
          customNote: 'Smoke test',
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.simulated, true);
      assert.ok(data.message.startsWith('[TEST — not a real emergency]'));
    });

    test('POST /api/alerts/test refuses without a consenting recipient', async () => {
      await fetch(`${baseUrl}/api/recipient`, { method: 'DELETE' });

      const res = await fetch(`${baseUrl}/api/alerts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customNote: 'Attempt without consent' }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.refused, true);
      assert.ok(data.error.includes('No consenting recipient'));
    });

    test('GET /api/alerts returns alert audit log and dedup state', async () => {
      const res = await fetch(`${baseUrl}/api/alerts`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.alerts));
      assert.ok(data.dedup);
    });

    test('POST /api/sensor-data dedupes repeated identical DANGER payloads within cooldown', async () => {
      // Register recipient
      await fetch(`${baseUrl}/api/recipient`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '9876543210',
          countryCode: '91',
          consent: true,
        }),
      });

      // Reset dedup state
      store.updateAlertDedup({ lastStatus: 'SAFE', cooldowns: {} });

      const dangerPayload = {
        device: 'ESP32_DEVKIT_V1',
        soil_moisture: 90,
        rain_level: 80,
        soil_raw: 3500,
        rain_raw: 3500,
        tilt_x: 25,
        tilt_y: 20,
        acceleration: 15,
        distance_cm: 20,
        displacement_cm: 5,
        tilt_sensor: true,
        soil_trend: 15,
        rain_trend: 30,
        history_samples: 100,
        risk_score: 14,
        status: 'DANGER',
        sensor_fault: false,
        uptime_ms: 100000,
      };

      // First DANGER POST -> should fire notification
      const firstRes = await fetch(`${baseUrl}/api/sensor-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dangerPayload),
      });
      assert.equal(firstRes.status, 201);
      const firstData = await firstRes.json();
      assert.equal(firstData.risk.status, 'DANGER');
      assert.equal(firstData.notification.notified, true);

      // Second DANGER POST immediately -> should be suppressed
      const secondRes = await fetch(`${baseUrl}/api/sensor-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dangerPayload),
      });
      assert.equal(secondRes.status, 201);
      const secondData = await secondRes.json();
      assert.equal(secondData.risk.status, 'DANGER');
      assert.equal(secondData.notification.notified, false);
      assert.equal(secondData.notification.suppressed, true);
    });
  });

  describe('Warning Translations Endpoint (/api/translations)', () => {
    test('GET /api/translations returns 19 regional translations', async () => {
      const res = await fetch(`${baseUrl}/api/translations`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.count, 19);
      assert.equal(data.translations.length, 19);

      // Verify Urdu is RTL
      const urdu = data.translations.find((t) => t.code === 'ur');
      assert.ok(urdu);
      assert.equal(urdu.dir, 'rtl');

      // Verify Hindi, Marathi, Bengali
      const hindi = data.translations.find((t) => t.code === 'hi');
      assert.ok(hindi);
      assert.equal(hindi.script, 'Devanagari');
    });

    test('GET /api/translations?includeEnglish=true includes English baseline', async () => {
      const res = await fetch(`${baseUrl}/api/translations?includeEnglish=true`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.count, 20);
      assert.equal(data.translations[0].code, 'en');
    });
  });

  describe('Evacuation Map & Routing Endpoints (/api/map-config & /api/route)', () => {
    test('GET /api/map-config returns map style, satellite status, and safe destination', async () => {
      const res = await fetch(`${baseUrl}/api/map-config`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.styleUrl);
      assert.equal(typeof data.satelliteEnabled, 'boolean');
      assert.ok(data.safeDestination);
      assert.equal(data.safeDestination.verified, true);
      assert.ok(data.site);
    });

    test('GET /api/route computes route to safe destination', async () => {
      const res = await fetch(`${baseUrl}/api/route`);
      // When network is reachable, status is 200; if OSRM is unreachable, status is 502 with explicit error
      assert.ok([200, 502].includes(res.status));
      const data = await res.json();
      if (res.status === 200) {
        assert.equal(data.success, true);
        assert.ok(data.distanceMeters > 0);
        assert.equal(data.geometry.type, 'LineString');
        assert.ok(data.originLabel);
        assert.ok(data.destinationLabel);
      } else {
        assert.equal(data.success, false);
        assert.ok(data.error);
      }
    });

    test('GET /api/route returns "no verified destination configured" when destination is invalid', async () => {
      // Temporarily mark destination as unverified
      const originalVerified = config.map.safeDestination.verified;
      config.map.safeDestination.verified = false;

      try {
        const res = await fetch(`${baseUrl}/api/route`);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.error, 'no verified destination configured');
      } finally {
        config.map.safeDestination.verified = originalVerified;
      }
    });
  });
});
