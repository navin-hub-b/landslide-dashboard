import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIO_PRESETS,
  generateScenarioReading,
  injectSimulatedReading,
  startAutoSimulation,
  stopAutoSimulation,
  getSimulationStatus,
} from '../server/modules/demoSimulator.js';
import { store } from '../server/store.js';

describe('Interactive Live Demo & Simulator Module (server/modules/demoSimulator.js)', () => {
  before(() => {
    store._resetForTests();
  });

  after(() => {
    stopAutoSimulation();
    store._resetForTests();
  });

  test('SCENARIO_PRESETS exports all required hazard profiles', () => {
    assert.ok(SCENARIO_PRESETS.safe);
    assert.ok(SCENARIO_PRESETS.warning);
    assert.ok(SCENARIO_PRESETS.high_risk);
    assert.ok(SCENARIO_PRESETS.danger);
    assert.ok(SCENARIO_PRESETS.fault);
  });

  test('generateScenarioReading("safe") produces valid baseline safe reading', () => {
    const reading = generateScenarioReading('safe');
    assert.equal(reading.device, 'ESP32_DEMO_NODE');
    assert.equal(reading.status, 'SAFE');
    assert.ok(reading.risk_score <= 3);
    assert.equal(reading.sensor_fault, false);
    assert.ok(reading.soil_moisture < 40);
  });

  test('generateScenarioReading("warning") produces warning-tier telemetry', () => {
    const reading = generateScenarioReading('warning');
    assert.equal(reading.status, 'WARNING');
    assert.ok(reading.risk_score >= 4 && reading.risk_score <= 6);
  });

  test('generateScenarioReading("high_risk") produces high-risk tier telemetry', () => {
    const reading = generateScenarioReading('high_risk');
    assert.equal(reading.status, 'HIGH_RISK');
    assert.ok(reading.risk_score >= 7 && reading.risk_score <= 9);
  });

  test('generateScenarioReading("danger") produces critical danger tier telemetry', () => {
    const reading = generateScenarioReading('danger');
    assert.equal(reading.status, 'DANGER');
    assert.ok(reading.risk_score >= 10);
    assert.equal(reading.tilt_sensor, true);
    assert.ok(reading.displacement_cm > 5.0);
  });

  test('generateScenarioReading("fault") produces transducer fault status', () => {
    const reading = generateScenarioReading('fault');
    assert.equal(reading.status, 'SENSOR_FAULT');
    assert.equal(reading.sensor_fault, true);
    assert.equal(reading.distance_cm, -1.0);
  });

  test('injectSimulatedReading() stores reading and returns complete risk breakdown', async () => {
    const result = await injectSimulatedReading('danger');
    assert.equal(result.success, true);
    assert.equal(result.data.status, 'DANGER');
    assert.equal(result.risk.status, 'DANGER');
    assert.ok(result.risk.score >= 10);
    assert.ok(store.getLatestReading());
    assert.equal(store.getLatestReading().status, 'DANGER');
  });

  test('startAutoSimulation() and stopAutoSimulation() manage simulator lifecycle', async () => {
    const statusStarted = startAutoSimulation({ intervalMs: 1500, scenario: 'warning' });
    assert.equal(statusStarted.isRunning, true);
    assert.equal(statusStarted.currentScenario, 'warning');

    const statusCheck = getSimulationStatus();
    assert.equal(statusCheck.isRunning, true);

    const statusStopped = stopAutoSimulation();
    assert.equal(statusStopped.isRunning, false);
  });
});
