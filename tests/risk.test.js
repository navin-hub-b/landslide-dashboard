import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHardwareRisk,
  calculateWeatherRisk,
  statusFromScore,
  evaluateRisk,
} from '../server/modules/risk.js';

describe('Landslide Hazard & Risk Assessment Module (server/modules/risk.js)', () => {
  const normalReading = {
    device: 'ESP32_DEVKIT_V1',
    soil_moisture: 20,
    rain_level: 10,
    tilt_x: 1.0,
    tilt_y: -1.0,
    acceleration: 9.8,
    distance_cm: 50.0,
    displacement_cm: 0.2,
    tilt_sensor: false,
    soil_trend: 1.0,
    rain_trend: 0.5,
    history_samples: 30,
    status: 'SAFE',
    sensor_fault: false,
  };

  test('calculateHardwareRisk() reproduces Section 6 formula exactly', () => {
    const normal = calculateHardwareRisk(normalReading);
    assert.equal(normal.score, 0);
    assert.equal(normal.sensorFault, false);

    // Test cumulative addition of all factors
    const highRiskReading = {
      ...normalReading,
      soil_moisture: 85, // >=80 -> +3
      rain_level: 65,    // >=60 -> +2
      tilt_x: 12,        // >=10 -> +2
      tilt_sensor: true, // active -> +2
      acceleration: 13.5,// >13 -> +2
      displacement_cm: 3,// >2 -> +2
      history_samples: 70,
      soil_trend: 15,    // >10 -> +1
      rain_trend: 28,    // >25 -> +2
    };
    // Expected: 3 + 2 + 2 + 2 + 2 + 2 + 1 + 2 = 16
    const res = calculateHardwareRisk(highRiskReading);
    assert.equal(res.score, 16);
    assert.equal(res.sensorFault, false);
    assert.ok(res.notes.length >= 8);
  });

  test('calculateHardwareRisk() flags sensorFault on negative distance or fault flag', () => {
    const fault1 = calculateHardwareRisk({ ...normalReading, distance_cm: -1 });
    assert.equal(fault1.sensorFault, true);

    const fault2 = calculateHardwareRisk({ ...normalReading, sensor_fault: true });
    assert.equal(fault2.sensorFault, true);
  });

  test('calculateWeatherRisk() returns 0 and marks unusable for missing, stale, or error weather', () => {
    // Null weather
    const nullWx = calculateWeatherRisk(null);
    assert.equal(nullWx.score, 0);
    assert.equal(nullWx.usable, false);

    // Stale weather
    const staleWx = calculateWeatherRisk({
      isStale: true,
      weather: { hourly: { precipitation: [15, 12, 10] } },
    });
    assert.equal(staleWx.score, 0);
    assert.equal(staleWx.usable, false);

    // Errored weather
    const errorWx = calculateWeatherRisk({
      weather: { status: 'ERROR', hourly: null },
    });
    assert.equal(errorWx.score, 0);
    assert.equal(errorWx.usable, false);

    // Weather unavailable due to no current GPS location
    const noGpsWx = calculateWeatherRisk({
      isAvailableForCurrentGps: false,
      status: 'NO_GPS_LOCATION',
      weather: { hourly: { precipitation: [15, 12, 10] } },
    });
    assert.equal(noGpsWx.score, 0);
    assert.equal(noGpsWx.usable, false);
    assert.ok(noGpsWx.notes[0].includes('no current GPS location'));
  });

  test('calculateWeatherRisk() adds up to +3 pts for forecast precipitation in next 6h', () => {
    // Heavy rain (max in next 6h >= 10 mm) -> +3
    const heavy = calculateWeatherRisk({
      hourly: { precipitation: [2.0, 12.5, 4.0, 1.0, 0, 0] },
    });
    assert.equal(heavy.usable, true);
    assert.equal(heavy.score, 3);
    assert.equal(heavy.maxNext6hPrecipitationMm, 12.5);

    // Moderate rain (max in next 6h >= 2.5 mm, < 6.25 mm) -> +1
    const moderate = calculateWeatherRisk({
      hourly: { precipitation: [0.5, 3.2, 1.0, 0, 0, 0] },
    });
    assert.equal(moderate.usable, true);
    assert.equal(moderate.score, 1);

    // Dry / light rain (max < 2.5 mm) -> 0
    const dry = calculateWeatherRisk({
      hourly: { precipitation: [0.1, 0.2, 0.4, 0, 0, 0] },
    });
    assert.equal(dry.usable, true);
    assert.equal(dry.score, 0);
  });

  test('statusFromScore() enforces SENSOR_FAULT precedence and threshold mapping', () => {
    // SENSOR_FAULT unconditionally overrides score
    assert.equal(statusFromScore(0, true), 'SENSOR_FAULT');
    assert.equal(statusFromScore(15, true), 'SENSOR_FAULT');

    // Thresholds
    assert.equal(statusFromScore(0), 'SAFE');
    assert.equal(statusFromScore(3), 'SAFE');
    assert.equal(statusFromScore(4), 'WARNING');
    assert.equal(statusFromScore(6), 'WARNING');
    assert.equal(statusFromScore(7), 'HIGH_RISK');
    assert.equal(statusFromScore(9), 'HIGH_RISK');
    assert.equal(statusFromScore(10), 'DANGER');
    assert.equal(statusFromScore(18), 'DANGER');
  });

  test('evaluateRisk() returns UNKNOWN (never SAFE) when reading is missing', () => {
    const noReadingRes = evaluateRisk({ reading: null, weather: null });
    assert.equal(noReadingRes.status, 'UNKNOWN');
    assert.equal(noReadingRes.score, null);
    assert.equal(noReadingRes.hardware, null);
    assert.notEqual(noReadingRes.status, 'SAFE');
  });

  test('evaluateRisk() produces full breakdown combining hardware and weather', () => {
    const reading = {
      ...normalReading,
      soil_moisture: 65, // +2
      rain_level: 65,    // +2
    }; // hw score = 4 (WARNING)

    const weather = {
      hourly: { precipitation: [1.0, 11.0, 2.0, 0, 0, 0] }, // heavy rain in 6h -> +3
    };

    const evaluation = evaluateRisk({
      reading,
      readingIsStale: false,
      weather,
    });

    assert.equal(evaluation.hardwareScore, 4);
    assert.equal(evaluation.weatherScore, 3);
    assert.equal(evaluation.totalScore, 7);
    // Combined score 7 triggers HIGH_RISK!
    assert.equal(evaluation.status, 'HIGH_RISK');
    assert.ok(evaluation.notes.length >= 3);
  });
});
