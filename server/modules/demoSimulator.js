/**
 * ESP32 Landslide Early Warning System - Live Demo & Telemetry Simulator Module
 *
 * Provides realistic synthetic telemetry streams, hazard scenario switching
 * (SAFE, WARNING, HIGH_RISK, DANGER, SENSOR_FAULT), and auto-cycling simulation
 * to experience the complete early warning lifecycle without physical hardware.
 */

import { store } from '../store.js';
import { calculateRisk, getStatusText } from './riskCalculator.js';
import { validateReading, ingestReading } from './hardware.js';
import { evaluateRisk } from './risk.js';
import { evaluateAndNotify } from './notifications.js';

// Predefined geotechnical scenario profiles matching Section 6 & 10 thresholds
export const SCENARIO_PRESETS = {
  safe: {
    id: 'safe',
    name: 'Normal Baseline (Safe)',
    description: 'Dry, stable sunny slope. Zero ground movement; nominal background readings.',
    soil_moisture: 24.5,
    rain_level: 6.0,
    soil_raw: 1400,
    rain_raw: 950,
    tilt_x: 0.8,
    tilt_y: 0.5,
    acceleration: 9.81,
    displacement_cm: 0.2,
    tilt_sensor: false,
    soil_trend: 0.8,
    rain_trend: 0.4,
    history_samples: 65,
    sensor_fault: false,
    targetScore: 0,
    targetStatus: 'SAFE',
  },
  warning: {
    id: 'warning',
    name: 'Monsoon Saturation (Warning)',
    description: 'Onset of heavy monsoon precipitation. Soil saturation climbing; caution double-beep active.',
    soil_moisture: 62.0,
    rain_level: 52.0,
    soil_raw: 2600,
    rain_raw: 2100,
    tilt_x: 5.5,
    tilt_y: 2.5,
    acceleration: 9.81,
    displacement_cm: 0.8,
    tilt_sensor: false,
    soil_trend: 12.0,
    rain_trend: 4.0,
    history_samples: 85,
    sensor_fault: false,
    targetScore: 5,
    targetStatus: 'WARNING',
  },
  high_risk: {
    id: 'high_risk',
    name: 'Slope Shear & Creep (High Risk)',
    description: 'Sustained downpour and subterranean shear stress. Incline exceeding 10°; rapid alternating alarm siren.',
    soil_moisture: 72.0,
    rain_level: 70.0,
    soil_raw: 3100,
    rain_raw: 2900,
    tilt_x: 12.0,
    tilt_y: 6.5,
    acceleration: 10.2,
    displacement_cm: 2.5,
    tilt_sensor: false,
    soil_trend: 5.0,
    rain_trend: 5.0,
    history_samples: 110,
    sensor_fault: false,
    targetScore: 8,
    targetStatus: 'HIGH_RISK',
  },
  danger: {
    id: 'danger',
    name: 'Imminent Landslide Failure (Danger)',
    description: 'Catastrophic slope displacement! Ultrasonic delta >5cm, mechanical tilt tripped, continuous warble siren & multilingual evacuation banner.',
    soil_moisture: 89.6,
    rain_level: 94.0,
    soil_raw: 3800,
    rain_raw: 3950,
    tilt_x: 23.5,
    tilt_y: 15.2,
    acceleration: 15.8,
    displacement_cm: 7.1,
    tilt_sensor: true,
    soil_trend: 34.0,
    rain_trend: 41.5,
    history_samples: 140,
    sensor_fault: false,
    targetScore: 16,
    targetStatus: 'DANGER',
  },
  fault: {
    id: 'fault',
    name: 'Transducer Wiring Fault (Sensor Fault)',
    description: 'Ultrasonic echo timeout or transducer fault. Yellow warning LED and inspection advisory.',
    soil_moisture: 32.0,
    rain_level: 15.0,
    soil_raw: 1800,
    rain_raw: 1200,
    tilt_x: 1.1,
    tilt_y: 0.9,
    acceleration: 9.81,
    displacement_cm: 0.0,
    tilt_sensor: false,
    soil_trend: 1.0,
    rain_trend: 0.5,
    history_samples: 65,
    sensor_fault: true,
    distance_cm: -1.0,
    targetScore: 0,
    targetStatus: 'SENSOR_FAULT',
  },
};

// Simulation State
const simulationState = {
  isRunning: false,
  intervalId: null,
  intervalMs: 3000,
  currentScenario: 'safe',
  autoCycle: false,
  cycleIndex: 0,
  cycleTicks: 0,
  ticksPerStage: 5, // 5 ticks * 3000ms = 15s per stage
  lastDispatchedAt: null,
  sequenceNumber: 0,
};

const CYCLE_ORDER = ['safe', 'warning', 'high_risk', 'danger', 'safe'];

/**
 * Adds gentle natural jitter to float values to simulate physical transducer noise
 */
function addJitter(val, amplitude = 0.5, min = 0, max = 100) {
  const noise = (Math.random() * 2 - 1) * amplitude;
  const result = val + noise;
  return Math.max(min, Math.min(max, Number(result.toFixed(2))));
}

/**
 * Builds a valid Section 6/9 reading matching a preset scenario with optional overrides
 *
 * @param {string} scenarioId 'safe' | 'warning' | 'high_risk' | 'danger' | 'fault'
 * @param {Object} [overrides] Custom sensor values
 * @returns {Object} Validated telemetry payload ready for ingestion
 */
export function generateScenarioReading(scenarioId = 'safe', overrides = {}) {
  const preset = SCENARIO_PRESETS[scenarioId] || SCENARIO_PRESETS.safe;
  const hwLoc = store.getHardwareLocation();

  const isFault = overrides.sensor_fault !== undefined ? Boolean(overrides.sensor_fault) : preset.sensor_fault;
  const isTiltSwitch = overrides.tilt_sensor !== undefined ? Boolean(overrides.tilt_sensor) : preset.tilt_sensor;

  const soil_moisture = overrides.soil_moisture !== undefined
    ? Number(overrides.soil_moisture)
    : addJitter(preset.soil_moisture, 0.8, 0, 100);

  const rain_level = overrides.rain_level !== undefined
    ? Number(overrides.rain_level)
    : addJitter(preset.rain_level, 0.6, 0, 100);

  const tilt_x = overrides.tilt_x !== undefined
    ? Number(overrides.tilt_x)
    : addJitter(preset.tilt_x, 0.4, -90, 90);

  const tilt_y = overrides.tilt_y !== undefined
    ? Number(overrides.tilt_y)
    : addJitter(preset.tilt_y, 0.3, -90, 90);

  const acceleration = overrides.acceleration !== undefined
    ? Number(overrides.acceleration)
    : addJitter(preset.acceleration, 0.2, 0, 50);

  const displacement_cm = overrides.displacement_cm !== undefined
    ? Number(overrides.displacement_cm)
    : addJitter(preset.displacement_cm, 0.15, 0, 500);

  const distance_cm = isFault
    ? -1.0
    : (overrides.distance_cm !== undefined ? Number(overrides.distance_cm) : Number((50.0 - displacement_cm).toFixed(2)));

  const soil_trend = overrides.soil_trend !== undefined ? Number(overrides.soil_trend) : preset.soil_trend;
  const rain_trend = overrides.rain_trend !== undefined ? Number(overrides.rain_trend) : preset.rain_trend;
  const history_samples = overrides.history_samples !== undefined ? Number(overrides.history_samples) : preset.history_samples;

  // Calculate risk using the exact firmware formula
  const risk_score = calculateRisk({
    soilPct: soil_moisture,
    rainPct: rain_level,
    angleX: tilt_x,
    angleY: tilt_y,
    tiltActive: isTiltSwitch,
    accel: acceleration,
    baselineDistance: 50.0,
    displacementCm: displacement_cm,
    histCount: history_samples,
    soilTrend: soil_trend,
    rainTrend: rain_trend,
  });

  const status = getStatusText(risk_score, isFault);

  return {
    device: 'ESP32_DEMO_NODE',
    soil_moisture,
    rain_level,
    soil_raw: overrides.soil_raw ?? preset.soil_raw,
    rain_raw: overrides.rain_raw ?? preset.rain_raw,
    tilt_x,
    tilt_y,
    acceleration,
    distance_cm,
    displacement_cm,
    tilt_sensor: isTiltSwitch,
    soil_trend,
    rain_trend,
    history_samples,
    risk_score,
    status,
    sensor_fault: isFault,
    uptime_ms: Date.now(),
    gps_valid: true,
    latitude: hwLoc.latitude,
    longitude: hwLoc.longitude,
    gps_altitude: hwLoc.altitude_m || 420.0,
    altitude_m: hwLoc.altitude_m,
    gps_speed: 0.0,
    gps_satellites: 9,
    station_id: hwLoc.station_id || 'ESP32_DEMO_NODE',
    station_label: hwLoc.label || 'Demo Slope Sensor Node',
  };
}

/**
 * Ingests a simulated reading, updates state, and evaluates risk & notifications
 *
 * @param {string} scenarioId
 * @param {Object} [overrides]
 * @returns {Promise<Object>} Execution result with reading, risk, and notification
 */
export async function injectSimulatedReading(scenarioId = 'safe', overrides = {}) {
  const readingPayload = generateScenarioReading(scenarioId, overrides);
  const validation = validateReading(readingPayload);

  if (!validation.isValid) {
    throw new Error(`Simulation validation failed: ${validation.errors.join('; ')}`);
  }

  // 1. Ingest into store ring buffer
  const stored = ingestReading(validation.data);

  // 2. Evaluate unified hardware + weather risk
  const riskAssessment = evaluateRisk({
    reading: stored,
    readingIsStale: false,
    weather: store.getLatestWeather(),
  });

  // 3. Dispatch notifications (SMS deduplication / simulated provider)
  const notification = await evaluateAndNotify(riskAssessment);

  simulationState.lastDispatchedAt = new Date().toISOString();
  simulationState.sequenceNumber += 1;

  return {
    success: true,
    data: stored,
    risk: riskAssessment,
    notification,
    simulation: {
      isRunning: simulationState.isRunning,
      currentScenario: scenarioId,
      autoCycle: simulationState.autoCycle,
      sequenceNumber: simulationState.sequenceNumber,
    },
  };
}

/**
 * Starts automated periodic telemetry simulation on the server
 *
 * @param {Object} options
 * @param {number} [options.intervalMs] Frequency in milliseconds (default: 3000ms)
 * @param {string} [options.scenario] Initial scenario ('safe' | 'warning' | 'high_risk' | 'danger')
 * @param {boolean} [options.autoCycle] Whether to progressively cycle through all hazard stages
 * @param {number} [options.ticksPerStage] Number of samples per scenario in autoCycle mode
 */
export function startAutoSimulation(options = {}) {
  stopAutoSimulation();

  simulationState.intervalMs = Math.max(1000, Number(options.intervalMs || 3000));
  simulationState.currentScenario = options.scenario || simulationState.currentScenario || 'safe';
  simulationState.autoCycle = Boolean(options.autoCycle ?? false);
  simulationState.ticksPerStage = Math.max(2, Number(options.ticksPerStage || 5));
  simulationState.cycleTicks = 0;
  simulationState.isRunning = true;

  // Immediately fire the first reading
  injectSimulatedReading(simulationState.currentScenario).catch((err) => {
    console.error('[DemoSimulator] Initial simulation error:', err.message);
  });

  // Set recurring interval
  simulationState.intervalId = setInterval(async () => {
    try {
      if (simulationState.autoCycle) {
        simulationState.cycleTicks += 1;
        if (simulationState.cycleTicks >= simulationState.ticksPerStage) {
          simulationState.cycleTicks = 0;
          simulationState.cycleIndex = (simulationState.cycleIndex + 1) % CYCLE_ORDER.length;
          simulationState.currentScenario = CYCLE_ORDER[simulationState.cycleIndex];
        }
      }

      await injectSimulatedReading(simulationState.currentScenario);
    } catch (err) {
      console.error('[DemoSimulator] Interval tick error:', err.message);
    }
  }, simulationState.intervalMs);

  return getSimulationStatus();
}

/**
 * Stops background automated telemetry simulation
 */
export function stopAutoSimulation() {
  if (simulationState.intervalId) {
    clearInterval(simulationState.intervalId);
    simulationState.intervalId = null;
  }
  simulationState.isRunning = false;
  return getSimulationStatus();
}

/**
 * Retrieves the current status and settings of the simulator
 */
export function getSimulationStatus() {
  return {
    isRunning: simulationState.isRunning,
    intervalMs: simulationState.intervalMs,
    currentScenario: simulationState.currentScenario,
    autoCycle: simulationState.autoCycle,
    cycleIndex: simulationState.cycleIndex,
    ticksPerStage: simulationState.ticksPerStage,
    lastDispatchedAt: simulationState.lastDispatchedAt,
    sequenceNumber: simulationState.sequenceNumber,
    availableScenarios: Object.keys(SCENARIO_PRESETS).map((key) => ({
      id: key,
      name: SCENARIO_PRESETS[key].name,
      description: SCENARIO_PRESETS[key].description,
      targetStatus: SCENARIO_PRESETS[key].targetStatus,
      targetScore: SCENARIO_PRESETS[key].targetScore,
    })),
  };
}
