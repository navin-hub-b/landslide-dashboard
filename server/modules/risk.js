/**
 * Landslide Hazard & Risk Assessment Module
 *
 * Combines in-situ ESP32 geotechnical telemetry (Section 6 & 10) with upstream
 * Open-Meteo meteorological precipitation forecasts into a unified early-warning risk score.
 *
 * ==============================================================================
 * ⚠️ PROVISIONAL PROTOTYPE THRESHOLDS & ENGINEERING CAVEAT (Guide Sections 10 & 16)
 * ==============================================================================
 * "These thresholds are illustrative prototype thresholds. They must be calibrated
 *  and validated before any real safety use. This is an educational/research prototype,
 *  not a certified landslide warning device. A reliable field system needs validated
 *  thresholds, redundant sensors, robust power and communication, environmental protection,
 *  site-specific calibration, false-alarm analysis, historical data and a defined
 *  emergency response procedure." (ESP32 Landslide Early-Warning Guide, Sections 10 & 16)
 *
 * Scoring Model:
 *  - Hardware Score: 0 to 18+ pts (exact firmware replication from Section 6)
 *  - Weather Forecast Risk: 0 to 3 pts (dashboard-only addition based on next 6h rain)
 *  - Total Score = Hardware Score + Weather Forecast Score
 *
 * Status Mapping (Provisional):
 *  - SENSOR_FAULT: Hardware fault detected (distance < 0 or MPU error) -> OVERRIDES ALL
 *  - DANGER:       Total Score >= 10 (Red LED, continuous buzzer)
 *  - HIGH_RISK:    Total Score >= 7  (Red LED, repeated beeps)
 *  - WARNING:      Total Score >= 4  (Yellow LED, periodic short beep)
 *  - SAFE:         Total Score 0 - 3 (Green LED, buzzer off)
 *  - UNKNOWN:      Returned when no hardware telemetry has been received yet (never SAFE)
 * ==============================================================================
 */

import { config } from '../config.js';

/**
 * Reproduces the ESP32 firmware's calculateRisk() formula EXACTLY as documented
 * in Section 6 of the implementation guide.
 *
 * @param {Object} reading Validated hardware reading from ESP32
 * @returns {{ score: number, notes: string[], sensorFault: boolean }}
 */
export function calculateHardwareRisk(reading) {
  if (!reading || typeof reading !== 'object') {
    return { score: 0, notes: ['No reading provided'], sensorFault: false };
  }

  let s = 0;
  const notes = [];

  // Extract fields with fallbacks
  const soilPct = Number(reading.soil_moisture ?? 0);
  const rainPct = Number(reading.rain_level ?? 0);
  const angleX = Number(reading.tilt_x ?? 0);
  const angleY = Number(reading.tilt_y ?? 0);
  const tiltActive = reading.tilt_sensor === true || reading.tilt_sensor === 'true';
  const accel = Number(reading.acceleration ?? 0);
  const distanceCm = Number(reading.distance_cm ?? -1);
  const displacementCm = Number(reading.displacement_cm ?? 0);
  const histCount = Number(reading.history_samples ?? 0);
  const soilTrend = Number(reading.soil_trend ?? 0);
  const rainTrend = Number(reading.rain_trend ?? 0);

  // Sensor fault detection: distance < 0 (ultrasonic timeout) or explicit sensor_fault flag
  const sensorFault = Boolean(
    reading.sensor_fault === true ||
    reading.sensor_fault === 'true' ||
    distanceCm < 0
  );

  if (sensorFault) {
    notes.push('Hardware sensor fault active (ultrasonic timeout < 0 or MPU failure)');
  }

  // 1. Soil Moisture Tiers (0-3 pts)
  // Firmware: if(soilPct>=80)s+=3; else if(soilPct>=60)s+=2; else if(soilPct>=40)s++;
  if (soilPct >= 80) {
    s += 3;
    notes.push(`Soil saturated (${soilPct.toFixed(1)}% >= 80%): +3 pts`);
  } else if (soilPct >= 60) {
    s += 2;
    notes.push(`Soil very wet (${soilPct.toFixed(1)}% >= 60%): +2 pts`);
  } else if (soilPct >= 40) {
    s += 1;
    notes.push(`Soil moist (${soilPct.toFixed(1)}% >= 40%): +1 pt`);
  }

  // 2. Rain Sensor Tiers (0-3 pts)
  // Firmware: if(rainPct>=80)s+=3; else if(rainPct>=60)s+=2; else if(rainPct>=40)s++;
  if (rainPct >= 80) {
    s += 3;
    notes.push(`Heavy rain sensor reading (${rainPct.toFixed(1)}% >= 80%): +3 pts`);
  } else if (rainPct >= 60) {
    s += 2;
    notes.push(`Moderate-heavy rain sensor reading (${rainPct.toFixed(1)}% >= 60%): +2 pts`);
  } else if (rainPct >= 40) {
    s += 1;
    notes.push(`Light-moderate rain sensor reading (${rainPct.toFixed(1)}% >= 40%): +1 pt`);
  }

  // 3. MPU6050 Incline Angle (0-3 pts)
  // Firmware: float tilt=max(abs(angleX),abs(angleY));
  // if(tilt>=20)s+=3; else if(tilt>=10)s+=2; else if(tilt>=5)s++;
  const tilt = Math.max(Math.abs(angleX), Math.abs(angleY));
  if (tilt >= 20) {
    s += 3;
    notes.push(`Severe slope tilt angle (${tilt.toFixed(1)}° >= 20°): +3 pts`);
  } else if (tilt >= 10) {
    s += 2;
    notes.push(`Moderate slope tilt angle (${tilt.toFixed(1)}° >= 10°): +2 pts`);
  } else if (tilt >= 5) {
    s += 1;
    notes.push(`Slight slope tilt angle (${tilt.toFixed(1)}° >= 5°): +1 pt`);
  }

  // 4. Digital Tilt Switch (+2 pts)
  // Firmware: if(tiltActive)s+=2;
  if (tiltActive) {
    s += 2;
    notes.push('Digital tilt switch triggered (mechanical incline displacement): +2 pts');
  }

  // 5. Total Acceleration Anomalies (0-2 pts)
  // Firmware: if(accel>13)s+=2; else if(accel>11)s++;
  if (accel > 13) {
    s += 2;
    notes.push(`Strong ground vibration/acceleration (${accel.toFixed(2)} m/s² > 13 m/s²): +2 pts`);
  } else if (accel > 11) {
    s += 1;
    notes.push(`Elevated acceleration/vibration (${accel.toFixed(2)} m/s² > 11 m/s²): +1 pt`);
  }

  // 6. Ultrasonic Displacement (0-3 pts)
  // Firmware: if(baselineDistance>0) { if(displacementCm>5)s+=3; else if(displacementCm>2)s+=2; else if(displacementCm>1)s++; }
  // Note: if distanceCm > 0 and displacement is calculated:
  if (distanceCm > 0 && displacementCm > 0) {
    if (displacementCm > 5) {
      s += 3;
      notes.push(`Severe ground displacement (${displacementCm.toFixed(2)} cm > 5 cm): +3 pts`);
    } else if (displacementCm > 2) {
      s += 2;
      notes.push(`Significant ground displacement (${displacementCm.toFixed(2)} cm > 2 cm): +2 pts`);
    } else if (displacementCm > 1) {
      s += 1;
      notes.push(`Minor ground displacement (${displacementCm.toFixed(2)} cm > 1 cm): +1 pt`);
    }
  }

  // 7. 1-Hour Trend Analysis (0-4 pts)
  // Firmware: if(histCount>=60) { if(soilTrend>25)s+=2; else if(soilTrend>10)s++; if(rainTrend>25)s+=2; else if(rainTrend>10)s++; }
  if (histCount >= 60) {
    if (soilTrend > 25) {
      s += 2;
      notes.push(`Rapid soil moisture increase (+${soilTrend.toFixed(1)}% > 25%): +2 pts`);
    } else if (soilTrend > 10) {
      s += 1;
      notes.push(`Rising soil moisture trend (+${soilTrend.toFixed(1)}% > 10%): +1 pt`);
    }

    if (rainTrend > 25) {
      s += 2;
      notes.push(`Rapid rainfall accumulation trend (+${rainTrend.toFixed(1)}% > 25%): +2 pts`);
    } else if (rainTrend > 10) {
      s += 1;
      notes.push(`Increasing rainfall trend (+${rainTrend.toFixed(1)}% > 10%): +1 pt`);
    }
  }

  return {
    score: s,
    notes,
    sensorFault,
  };
}

/**
 * Calculates dashboard-only weather forecast risk contribution (up to +3 pts).
 * Inspects maximum forecast precipitation in the next 6 hours.
 *
 * Missing, stale, or errored weather must contribute 0 and be marked unusable,
 * never silently treated as low-risk.
 *
 * @param {Object} weather Cached weather object or freshness wrapper
 * @returns {{ score: number, usable: boolean, isUsable: boolean, maxNext6hPrecipitationMm: number|null, notes: string[] }}
 */
export function calculateWeatherRisk(weather) {
  const w = weather?.weather ? weather.weather : weather;
  const isStale = weather?.isStale === true;

  // Validate presence, freshness, GPS association, and forecast structure
  if (
    !w ||
    isStale ||
    weather?.isAvailableForCurrentGps === false ||
    !w.hourly ||
    !Array.isArray(w.hourly.precipitation) ||
    w.status === 'ERROR' ||
    w.status === 'UPSTREAM_ERROR' ||
    w.status === 'NO_GPS_LOCATION'
  ) {
    const isGpsIssue = weather?.isAvailableForCurrentGps === false || w?.status === 'NO_GPS_LOCATION';
    return {
      score: 0,
      usable: false,
      isUsable: false,
      maxNext6hPrecipitationMm: null,
      notes: [
        isGpsIssue
          ? 'Weather unavailable: no current GPS location; forecast risk omitted (0 pts)'
          : 'Weather forecast data unavailable, stale, or errored; forecast risk omitted (0 pts, marked unusable)',
      ],
    };
  }

  const heavyMm =
    config.risk?.weatherHeavyRainMm ??
    config.WEATHER_HEAVY_RAIN_MM ??
    10.0;

  const moderateMm =
    config.risk?.weatherModerateRainMm ??
    config.WEATHER_MODERATE_RAIN_MM ??
    2.5;

  // Next 6 hours hourly precipitation array
  const next6h = w.hourly.precipitation
    .slice(0, 6)
    .map(Number)
    .filter(Number.isFinite);

  const maxPrecip = next6h.length > 0 ? Math.max(...next6h) : 0;
  const notes = [];
  let score = 0;

  if (maxPrecip >= heavyMm) {
    score = 3;
    notes.push(
      `Forecast heavy rain (max ${maxPrecip.toFixed(1)} mm/h in next 6h >= ${heavyMm} mm): +3 pts`
    );
  } else if (maxPrecip >= (heavyMm + moderateMm) / 2) {
    score = 2;
    notes.push(
      `Forecast substantial rain (max ${maxPrecip.toFixed(1)} mm/h in next 6h): +2 pts`
    );
  } else if (maxPrecip >= moderateMm) {
    score = 1;
    notes.push(
      `Forecast moderate rain (max ${maxPrecip.toFixed(1)} mm/h in next 6h >= ${moderateMm} mm): +1 pt`
    );
  } else {
    score = 0;
    notes.push(
      `Forecast light or no rain (max ${maxPrecip.toFixed(1)} mm/h in next 6h < ${moderateMm} mm): 0 pts`
    );
  }

  return {
    score,
    usable: true,
    isUsable: true,
    maxNext6hPrecipitationMm: Number(maxPrecip.toFixed(2)),
    notes,
  };
}

/**
 * Maps risk score and sensor fault to standardized status strings.
 * SENSOR_FAULT unconditionally overrides risk scores.
 *
 * @param {number} score Combined integer risk score
 * @param {boolean} sensorFault
 * @returns {"SENSOR_FAULT" | "DANGER" | "HIGH_RISK" | "WARNING" | "SAFE"}
 */
export function statusFromScore(score, sensorFault = false) {
  if (sensorFault) return 'SENSOR_FAULT';

  const warning =
    config.risk?.thresholdWarning ??
    config.RISK_THRESHOLD_WARNING ??
    4;

  const high =
    config.risk?.thresholdHigh ??
    config.RISK_THRESHOLD_HIGH ??
    7;

  const danger =
    config.risk?.thresholdDanger ??
    config.RISK_THRESHOLD_DANGER ??
    10;

  if (score >= danger) return 'DANGER';
  if (score >= high) return 'HIGH_RISK';
  if (score >= warning) return 'WARNING';
  return 'SAFE';
}

/**
 * Evaluates unified landslide hazard risk from hardware telemetry and weather forecast.
 * Returns UNKNOWN (never SAFE) if no reading exists yet.
 *
 * @param {Object} params
 * @param {Object|null} params.reading Latest telemetry reading
 * @param {boolean} [params.readingIsStale]
 * @param {Object|null} [params.weather] Cached weather data
 * @returns {Object} Complete risk evaluation breakdown
 */
export function evaluateRisk({ reading, readingIsStale = false, weather = null }) {
  // If no hardware telemetry has been received yet, status is UNKNOWN (never SAFE)
  if (!reading) {
    return {
      status: 'UNKNOWN',
      score: null,
      totalScore: null,
      hardwareScore: null,
      weatherScore: null,
      hardware: null,
      weather: null,
      readingIsStale: Boolean(readingIsStale),
      isStale: Boolean(readingIsStale),
      sensorFault: false,
      timestamp: new Date().toISOString(),
      notes: ['No telemetry readings recorded yet; risk status is UNKNOWN'],
    };
  }

  const hw = calculateHardwareRisk(reading);
  const wx = calculateWeatherRisk(weather);

  const totalScore = hw.score + wx.score;
  const status = statusFromScore(totalScore, hw.sensorFault);

  const combinedNotes = [...hw.notes];
  if (readingIsStale) {
    const staleSec =
      config.hardware?.staleSeconds ??
      config.HARDWARE_STALE_SECONDS ??
      60;
    combinedNotes.push(
      `Hardware telemetry is STALE (> ${staleSec}s old); assessment reflects last known sensor state`
    );
  }
  combinedNotes.push(...wx.notes);

  return {
    status,
    score: totalScore,
    totalScore,
    hardwareScore: hw.score,
    weatherScore: wx.score,
    hardware: {
      score: hw.score,
      sensorFault: hw.sensorFault,
      notes: hw.notes,
    },
    weather: {
      score: wx.score,
      usable: wx.usable,
      maxNext6hPrecipitationMm: wx.maxNext6hPrecipitationMm,
      notes: wx.notes,
    },
    sensorFault: hw.sensorFault,
    readingIsStale: Boolean(readingIsStale),
    timestamp: new Date().toISOString(),
    notes: combinedNotes,
  };
}
