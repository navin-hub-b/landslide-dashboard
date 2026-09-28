/**
 * ESP32 Landslide Risk Calculation and Status Determination Module
 * Grounded in Section 6 and Section 10 of the Full Implementation Guide.
 */

export const RISK_LEVELS = {
  SAFE: {
    status: 'SAFE',
    minScore: 0,
    maxScore: 3,
    color: '#10b981', // green
    indication: 'Green LED; buzzer off',
  },
  WARNING: {
    status: 'WARNING',
    minScore: 4,
    maxScore: 6,
    color: '#f59e0b', // yellow/amber
    indication: 'Yellow LED; periodic short beep',
  },
  HIGH_RISK: {
    status: 'HIGH_RISK',
    minScore: 7,
    maxScore: 9,
    color: '#ef4444', // red
    indication: 'Red LED; repeated beeps',
  },
  DANGER: {
    status: 'DANGER',
    minScore: 10,
    maxScore: Infinity,
    color: '#b91c1c', // dark red
    indication: 'Red LED; continuous buzzer',
  },
  SENSOR_FAULT: {
    status: 'SENSOR_FAULT',
    minScore: null,
    maxScore: null,
    color: '#6b7280', // grey
    indication: 'Yellow LED (firmware default) / check sensors',
  },
};

/**
 * Calculates risk score based on sensor metrics
 * @param {Object} metrics Sensor metrics matching firmware parameters
 * @returns {number} Integer risk score
 */
export function calculateRisk({
  soilPct = 0,
  rainPct = 0,
  angleX = 0,
  angleY = 0,
  tiltActive = false,
  accel = 0,
  baselineDistance = 0,
  displacementCm = 0,
  histCount = 0,
  soilTrend = 0,
  rainTrend = 0,
} = {}) {
  let s = 0;

  // 1. Soil Moisture (%)
  if (soilPct >= 80) s += 3;
  else if (soilPct >= 60) s += 2;
  else if (soilPct >= 40) s += 1;

  // 2. Rain Level (%)
  if (rainPct >= 80) s += 3;
  else if (rainPct >= 60) s += 2;
  else if (rainPct >= 40) s += 1;

  // 3. MPU6050 Tilt Angle (degrees: max(|angleX|, |angleY|))
  const tilt = Math.max(Math.abs(angleX), Math.abs(angleY));
  if (tilt >= 20) s += 3;
  else if (tilt >= 10) s += 2;
  else if (tilt >= 5) s += 1;

  // 4. Digital Tilt Switch
  if (tiltActive) s += 2;

  // 5. Total Acceleration (m/s²)
  if (accel > 13) s += 2;
  else if (accel > 11) s += 1;

  // 6. Ultrasonic Displacement (cm)
  if (baselineDistance > 0) {
    if (displacementCm > 5) s += 3;
    else if (displacementCm > 2) s += 2;
    else if (displacementCm > 1) s += 1;
  }

  // 7. Trend Analysis (only evaluated after >= 60 samples, ~10 mins)
  if (histCount >= 60) {
    if (soilTrend > 25) s += 2;
    else if (soilTrend > 10) s += 1;

    if (rainTrend > 25) s += 2;
    else if (rainTrend > 10) s += 1;
  }

  return s;
}

/**
 * Determines status string from risk score and sensor fault state
 * @param {number} riskScore
 * @param {boolean} sensorFault
 * @returns {"SENSOR_FAULT" | "DANGER" | "HIGH_RISK" | "WARNING" | "SAFE"}
 */
export function getStatusText(riskScore, sensorFault = false) {
  if (sensorFault) return RISK_LEVELS.SENSOR_FAULT.status;
  if (riskScore >= 10) return RISK_LEVELS.DANGER.status;
  if (riskScore >= 7) return RISK_LEVELS.HIGH_RISK.status;
  if (riskScore >= 4) return RISK_LEVELS.WARNING.status;
  return RISK_LEVELS.SAFE.status;
}
