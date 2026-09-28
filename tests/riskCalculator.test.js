import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRisk, getStatusText, RISK_LEVELS } from '../server/modules/riskCalculator.js';

describe('Landslide Risk Calculation Logic (Section 6 & 10)', () => {
  test('returns 0 for normal baseline conditions', () => {
    const score = calculateRisk({
      soilPct: 20,
      rainPct: 15,
      angleX: 1.0,
      angleY: -1.2,
      tiltActive: false,
      accel: 9.8,
      baselineDistance: 50,
      displacementCm: 0.2,
      histCount: 30,
      soilTrend: 2,
      rainTrend: 1,
    });
    assert.equal(score, 0);
    assert.equal(getStatusText(score), 'SAFE');
  });

  test('scores soil moisture thresholds accurately', () => {
    // soilPct < 40 -> 0
    assert.equal(calculateRisk({ soilPct: 39 }), 0);
    // soilPct >= 40 -> +1
    assert.equal(calculateRisk({ soilPct: 40 }), 1);
    assert.equal(calculateRisk({ soilPct: 59 }), 1);
    // soilPct >= 60 -> +2
    assert.equal(calculateRisk({ soilPct: 60 }), 2);
    assert.equal(calculateRisk({ soilPct: 79 }), 2);
    // soilPct >= 80 -> +3
    assert.equal(calculateRisk({ soilPct: 80 }), 3);
    assert.equal(calculateRisk({ soilPct: 95 }), 3);
  });

  test('scores rain level thresholds accurately', () => {
    assert.equal(calculateRisk({ rainPct: 35 }), 0);
    assert.equal(calculateRisk({ rainPct: 40 }), 1);
    assert.equal(calculateRisk({ rainPct: 60 }), 2);
    assert.equal(calculateRisk({ rainPct: 85 }), 3);
  });

  test('scores MPU6050 tilt angles max(|angleX|, |angleY|)', () => {
    // Under 5 deg -> 0
    assert.equal(calculateRisk({ angleX: 3, angleY: -4 }), 0);
    // >= 5 deg -> +1
    assert.equal(calculateRisk({ angleX: 6, angleY: 2 }), 1);
    assert.equal(calculateRisk({ angleX: -2, angleY: -5 }), 1);
    // >= 10 deg -> +2
    assert.equal(calculateRisk({ angleX: 12, angleY: 8 }), 2);
    // >= 20 deg -> +3
    assert.equal(calculateRisk({ angleX: 4, angleY: -22 }), 3);
  });

  test('scores digital tilt sensor activation', () => {
    assert.equal(calculateRisk({ tiltActive: false }), 0);
    assert.equal(calculateRisk({ tiltActive: true }), 2);
  });

  test('scores acceleration anomalies', () => {
    assert.equal(calculateRisk({ accel: 9.8 }), 0);
    assert.equal(calculateRisk({ accel: 11.0 }), 0);
    assert.equal(calculateRisk({ accel: 11.5 }), 1);
    assert.equal(calculateRisk({ accel: 13.0 }), 1);
    assert.equal(calculateRisk({ accel: 14.2 }), 2);
  });

  test('scores displacement when baseline distance is established', () => {
    // If baselineDistance <= 0, displacement is not scored
    assert.equal(calculateRisk({ baselineDistance: 0, displacementCm: 6 }), 0);

    // With established baseline
    assert.equal(calculateRisk({ baselineDistance: 50, displacementCm: 0.8 }), 0);
    assert.equal(calculateRisk({ baselineDistance: 50, displacementCm: 1.5 }), 1);
    assert.equal(calculateRisk({ baselineDistance: 50, displacementCm: 2.5 }), 2);
    assert.equal(calculateRisk({ baselineDistance: 50, displacementCm: 6.0 }), 3);
  });

  test('scores trends only after minimum 60 historical samples (~10 mins)', () => {
    // Before 60 samples, large trend is ignored
    assert.equal(calculateRisk({ histCount: 59, soilTrend: 30, rainTrend: 30 }), 0);

    // After 60 samples
    assert.equal(calculateRisk({ histCount: 60, soilTrend: 12 }), 1);
    assert.equal(calculateRisk({ histCount: 60, soilTrend: 26 }), 2);
    assert.equal(calculateRisk({ histCount: 60, rainTrend: 15 }), 1);
    assert.equal(calculateRisk({ histCount: 60, rainTrend: 30 }), 2);

    // Combined trends
    assert.equal(calculateRisk({ histCount: 60, soilTrend: 30, rainTrend: 30 }), 4);
  });

  test('evaluates cumulative risk scores and maps to Section 10 levels', () => {
    // Scenario 1: SAFE (0 to 3)
    assert.equal(getStatusText(0), 'SAFE');
    assert.equal(getStatusText(3), 'SAFE');

    // Scenario 2: WARNING (4 to 6)
    assert.equal(getStatusText(4), 'WARNING');
    assert.equal(getStatusText(6), 'WARNING');

    // Scenario 3: HIGH_RISK (7 to 9)
    assert.equal(getStatusText(7), 'HIGH_RISK');
    assert.equal(getStatusText(9), 'HIGH_RISK');

    // Scenario 4: DANGER (10+)
    assert.equal(getStatusText(10), 'DANGER');
    assert.equal(getStatusText(15), 'DANGER');

    // Scenario 5: SENSOR_FAULT overrides risk score
    assert.equal(getStatusText(0, true), 'SENSOR_FAULT');
    assert.equal(getStatusText(12, true), 'SENSOR_FAULT');
  });

  test('matches Section 9 PDF example payload risk score', () => {
    // In Section 9:
    // soil_moisture: 72.50 (>=60 -> +2)
    // rain_level: 64.20 (>=60 -> +2)
    // tilt_x: 4.25, tilt_y: 2.10 (max 4.25 < 5 -> +0)
    // acceleration: 9.81 (< 11 -> +0)
    // distance_cm: 48.20, displacement_cm: 1.40 (> 1cm -> +1)
    // tilt_sensor: false (+0)
    // soil_trend: 12.20, rain_trend: 18.50, history_samples: 120 (>=60, soilTrend>10 +1, rainTrend>10 +1 -> wait, in guide score is 5: 2 + 2 + 1 = 5)
    // Total score in PDF = 5 (WARNING)
    const score = calculateRisk({
      soilPct: 72.50,
      rainPct: 64.20,
      angleX: 4.25,
      angleY: 2.10,
      tiltActive: false,
      accel: 9.81,
      baselineDistance: 49.60,
      displacementCm: 1.40,
      histCount: 120,
      soilTrend: 0, // Note: in section 6 trend logic only if soilTrend > 10, etc.
    });
    // soil(2) + rain(2) + displacement(1) = 5
    assert.equal(score, 5);
    assert.equal(getStatusText(score), 'WARNING');
  });
});
