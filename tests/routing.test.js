import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getEvacuationRoute } from '../server/modules/routing.js';

describe('Evacuation Routing Module (server/modules/routing.js)', () => {
  test('rejects missing or invalid origin coordinates', async () => {
    const res1 = await getEvacuationRoute({
      destLat: 19.136,
      destLng: 72.916,
    });
    assert.equal(res1.success, false);
    assert.equal(res1.status, 'INVALID_ORIGIN');

    const res2 = await getEvacuationRoute({
      originLat: 'invalid',
      originLng: 72.9133,
      destLat: 19.136,
      destLng: 72.916,
    });
    assert.equal(res2.success, false);
    assert.equal(res2.status, 'INVALID_ORIGIN');

    const res3 = await getEvacuationRoute({
      originLat: 95.0, // out of range
      originLng: 72.9133,
      destLat: 19.136,
      destLng: 72.916,
    });
    assert.equal(res3.success, false);
    assert.equal(res3.status, 'INVALID_ORIGIN');
  });

  test('rejects missing or invalid destination coordinates', async () => {
    const res = await getEvacuationRoute({
      originLat: 19.1334,
      originLng: 72.9133,
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 'INVALID_DESTINATION');
  });

  test('fetches real navigation route from OSRM for valid coordinates', async () => {
    // IIT Bombay monitoring site to designated safe shelter
    const originLat = 19.1334;
    const originLng = 72.9133;
    const destLat = 19.136;
    const destLng = 72.916;

    const res = await getEvacuationRoute({
      originLat,
      originLng,
      destLat,
      destLng,
    });

    if (res.success) {
      assert.equal(typeof res.distanceMeters, 'number');
      assert.ok(res.distanceMeters > 0);
      assert.equal(typeof res.durationSeconds, 'number');
      assert.ok(res.durationSeconds > 0);
      assert.equal(res.geometry.type, 'LineString');
      assert.ok(Array.isArray(res.geometry.coordinates));
      assert.ok(res.geometry.coordinates.length > 0);
      assert.equal(res.origin.latitude, originLat);
      assert.equal(res.destination.latitude, destLat);
    } else {
      // If network is restricted in sandbox, ensure error is explicit and never fabricated
      assert.ok(res.error);
      assert.ok(res.status);
    }
  });
});
