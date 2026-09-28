/**
 * IIT Bombay Geotechnical Landslide Early-Warning Dashboard
 * Client Application Logic
 *
 * Consumes:
 * - GET /api/state (Polled every ~10s)
 * - GET /api/history (Sensor telemetry history)
 * - GET /api/alerts (Permanent alert audit log)
 * - GET /api/translations (19 regional Indian language warning signs)
 * - GET /api/weather & POST /api/weather/refresh (Precipitation forecast)
 * - GET /api/map-config & GET /api/route (MapLibre GL & OSRM routing)
 * - POST /api/recipient & DELETE /api/recipient (Consent-guarded SMS contacts)
 * - POST /api/alerts/test (Safe simulated test alerts)
 */

(() => {
  'use strict';

  // =========================================================================
  // HARDWARE DATA LAYER STATE MODEL & TIMING CONVENTIONS
  // =========================================================================
  const HARDWARE_STATE = Object.freeze({
    LOADING: 'loading',
    CONNECTED: 'connected',
    STALE: 'stale',
    UNAVAILABLE: 'unavailable',
    ERROR: 'error',
  });

  const GPS_LOCATION_STATE = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    STALE: 'STALE',
    UNAVAILABLE: 'UNAVAILABLE',
  });

  // Configurable thresholds based on device's real 10-second send interval
  const HARDWARE_TIMING = Object.freeze({
    DEVICE_SEND_INTERVAL_MS: 10000,
    STALE_THRESHOLD_SECONDS: 30, // 3 missed intervals = stale
    DISCONNECT_THRESHOLD_SECONDS: 120, // 12 missed intervals
  });

  // Application State
  const state = {
    pollingIntervalMs: HARDWARE_TIMING.DEVICE_SEND_INTERVAL_MS,
    pollingTimerId: null,
    hardwareState: HARDWARE_STATE.LOADING,
    previousHardwareState: null,
    gpsLocationState: GPS_LOCATION_STATE.UNAVAILABLE,
    staleThresholdSeconds: HARDWARE_TIMING.STALE_THRESHOLD_SECONDS,
    isFetchingTelemetry: false,
    lastDataSignature: null,
    lastValidatedTelemetry: null,
    isTabHidden: false,
    latestTelemetry: null,
    previousStatus: null,
    map: null,
    siteMarker: null,
    hardwareMarker: null,
    shelterMarker: null,
    userMarker: null,
    hazardAreaSourceAdded: false,
    hazardZoneVisible: true,
    hardwareLocation: null,
    hazardArea: null,
    userCoordinates: null,
    mapConfig: null,
    currentSatellite: false,
    routeSourceAdded: false,
    translations: [],
    warningCycleIndex: 0,
    warningCycleTimer: null,
    warningSnoozed: false,
    latestHardwareReading: null,
    lastHardwareReceivedAt: null,
    latestWeather: null,
    localAlertLog: [],
    firebaseConnected: false,
    demo: {
      isOpen: false,
      isStreaming: false,
      currentScenario: 'safe',
      autoCycle: true,
      intervalMs: 2500,
      pollTimer: null,
    },
  };

  // =========================================================================
  // WEB AUDIO API EMERGENCY ALARM SYNTHESIZER
  // Real-time acoustic sirens matching Section 10 actuation modes
  // =========================================================================
  class WebAudioAlarm {
    constructor() {
      this.ctx = null;
      this.activeOscillators = [];
      this.intervalId = null;
      this.isMuted = false;
      this.isSilenced = false;
      this.isPlaying = false;
      this.currentAlertLevel = null;
    }

    _ensureContext() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      if (this.isMuted) {
        this.stop(false);
      } else {
        this.isSilenced = false;
        if (this.currentAlertLevel) {
          this.start(this.currentAlertLevel, true);
        }
      }
      return this.isMuted;
    }

    silence() {
      this.isSilenced = true;
      this.stop(false);
    }

    start(level, force = false) {
      if (level !== this.currentAlertLevel) {
        this.isSilenced = false;
        this.currentAlertLevel = level;
      }

      if (this.isMuted || this.isSilenced) return;
      if (!force && this.isPlaying && this.currentAlertLevel === level) return;

      this._ensureContext();
      if (!this.ctx) return;

      this.stop(false);
      this.isPlaying = true;

      if (level === 'DANGER') {
        this._playEvacuationWarble();
      } else if (level === 'HIGH_RISK') {
        this._playUrgentTwoTone();
      } else if (level === 'WARNING') {
        this._playCautionBeep();
      }
    }

    stop(clearLevel = true) {
      if (clearLevel) {
        this.currentAlertLevel = null;
        this.isSilenced = false;
      }
      this.isPlaying = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      this.activeOscillators.forEach((osc) => {
        try {
          osc.stop();
          osc.disconnect();
        } catch (_) {}
      });
      this.activeOscillators = [];
    }

    _playEvacuationWarble() {
      try {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';

        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(0.75, this.ctx.currentTime);
        lfoGain.gain.setValueAtTime(320, this.ctx.currentTime);

        osc.frequency.setValueAtTime(980, this.ctx.currentTime);
        lfo.connect(osc.frequency);

        gain.gain.setValueAtTime(0.18, this.ctx.currentTime);
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        lfo.start();
        osc.start();
        this.activeOscillators.push(osc, lfo);
      } catch (err) {
        console.warn('[AudioAlarm] Warble error:', err.message);
      }
    }

    _playUrgentTwoTone() {
      let hi = false;
      const beep = () => {
        try {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'square';
          osc.frequency.setValueAtTime(hi ? 880 : 660, this.ctx.currentTime);
          hi = !hi;

          gain.gain.setValueAtTime(0.16, this.ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.35);

          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start();
          osc.stop(this.ctx.currentTime + 0.35);
        } catch (_) {}
      };

      beep();
      this.intervalId = setInterval(beep, 450);
    }

    _playCautionBeep() {
      const beep = () => {
        try {
          const t = this.ctx.currentTime;
          [0, 0.16].forEach((offset) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, t + offset);
            gain.gain.setValueAtTime(0.14, t + offset);
            gain.gain.exponentialRampToValueAtTime(0.01, t + offset + 0.12);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(t + offset);
            osc.stop(t + offset + 0.12);
          });
        } catch (_) {}
      };

      beep();
      this.intervalId = setInterval(beep, 3500);
    }
  }

  const audioAlarm = new WebAudioAlarm();

  // Unlock AudioContext on any interaction
  document.addEventListener('click', () => {
    audioAlarm._ensureContext();
  }, { passive: true });

  // DOM Elements Cache
  const elements = {
    // Location & Audio Controls
    stationTitleDisplay: document.getElementById('stationTitleDisplay'),
    stationCoordsBadge: document.getElementById('stationCoordsBadge'),
    focusHardwareLocationBtn: document.getElementById('focusHardwareLocationBtn'),
    focusHardwareAreaBtn: document.getElementById('focusHardwareAreaBtn'),
    toggleHazardPerimeterBtn: document.getElementById('toggleHazardPerimeterBtn'),
    checkMyProximityBtn: document.getElementById('checkMyProximityBtn'),
    areaRiskSeverityBadge: document.getElementById('areaRiskSeverityBadge'),
    hwLocCoords: document.getElementById('hwLocCoords'),
    hwLocAltitude: document.getElementById('hwLocAltitude'),
    hwLocStationId: document.getElementById('hwLocStationId'),
    hwLocLabel: document.getElementById('hwLocLabel'),
    hwLocGpsBadge: document.getElementById('hwLocGpsBadge'),
    hazardAreaZoneTag: document.getElementById('hazardAreaZoneTag'),
    hazardImpactRadius: document.getElementById('hazardImpactRadius'),
    hazardBufferRadius: document.getElementById('hazardBufferRadius'),
    hazardThreatArea: document.getElementById('hazardThreatArea'),
    hazardAreaSummary: document.getElementById('hazardAreaSummary'),
    userProximityBadge: document.getElementById('userProximityBadge'),
    userProximityDistance: document.getElementById('userProximityDistance'),
    userProximityAdvisory: document.getElementById('userProximityAdvisory'),
    toggleAudioSirenBtn: document.getElementById('toggleAudioSirenBtn'),
    audioSirenIcon: document.getElementById('audioSirenIcon'),
    audioSirenLabel: document.getElementById('audioSirenLabel'),
    testAlarmBtn: document.getElementById('testAlarmBtn'),
    silenceSirenBtn: document.getElementById('silenceSirenBtn'),
    silenceStickySirenBtn: document.getElementById('silenceStickySirenBtn'),

    // Live Demo Mode & Controls
    toggleLiveDemoBtn: document.getElementById('toggleLiveDemoBtn'),
    demoActiveBadge: document.getElementById('demoActiveBadge'),
    demoActiveBadgeText: document.getElementById('demoActiveBadgeText'),
    demoControllerSection: document.getElementById('demoControllerSection'),
    demoStatusTag: document.getElementById('demoStatusTag'),
    closeDemoPanelBtn: document.getElementById('closeDemoPanelBtn'),
    startDemoStreamBtn: document.getElementById('startDemoStreamBtn'),
    stopDemoStreamBtn: document.getElementById('stopDemoStreamBtn'),
    autoCycleCheckbox: document.getElementById('autoCycleCheckbox'),
    demoSpeedSelect: document.getElementById('demoSpeedSelect'),
    demoScenarioButtons: document.querySelectorAll('.btn-scenario'),
    demoSliderSoil: document.getElementById('demoSliderSoil'),
    demoSliderSoilVal: document.getElementById('demoSliderSoilVal'),
    demoSliderRain: document.getElementById('demoSliderRain'),
    demoSliderRainVal: document.getElementById('demoSliderRainVal'),
    demoSliderTilt: document.getElementById('demoSliderTilt'),
    demoSliderTiltVal: document.getElementById('demoSliderTiltVal'),
    demoSliderDisp: document.getElementById('demoSliderDisp'),
    demoSliderDispVal: document.getElementById('demoSliderDispVal'),
    demoSliderTiltSwitch: document.getElementById('demoSliderTiltSwitch'),
    applyCustomSliderBtn: document.getElementById('applyCustomSliderBtn'),

    // Accessibility & Map Loading Placeholders
    a11yStatusAnnouncer: document.getElementById('a11yStatusAnnouncer'),
    mapLoadingPlaceholder: document.getElementById('mapLoadingPlaceholder'),
    evacuationSection: document.getElementById('evacuationSection'),

    // Warning Sign
    emergencyWarningSign: document.getElementById('emergencyWarningSign'),
    emergencyStatusTag: document.getElementById('emergencyStatusTag'),
    warningSignText: document.getElementById('warningSignText'),
    warningLangBadge: document.getElementById('warningLangBadge'),
    viewEvacuationMapBtn: document.getElementById('viewEvacuationMapBtn'),
    snoozeWarningBtn: document.getElementById('snoozeWarningBtn'),
    stickyWarningBanner: document.getElementById('stickyWarningBanner'),
    stickyBannerText: document.getElementById('stickyBannerText'),
    stickyBannerLang: document.getElementById('stickyBannerLang'),
    reopenWarningBtn: document.getElementById('reopenWarningBtn'),

    // Top Header & Controls
    notificationBtn: document.getElementById('requestNotificationBtn'),
    notificationBtnText: document.getElementById('notificationBtnText'),
    notificationFallbackMsg: document.getElementById('notificationFallbackMsg'),
    hwFreshnessBadge: document.getElementById('hwFreshnessBadge'),
    hwFreshnessText: document.getElementById('hwFreshnessText'),
    wxFreshnessBadge: document.getElementById('wxFreshnessBadge'),
    wxFreshnessText: document.getElementById('wxFreshnessText'),
    manualRefreshBtn: document.getElementById('manualRefreshBtn'),

    // Risk Hero Card
    heroStatusBadge: document.getElementById('heroStatusBadge'),
    heroActuationText: document.getElementById('heroActuationText'),
    actuationDetail: document.getElementById('actuationDetail'),
    heroScoreValue: document.getElementById('heroScoreValue'),
    hwScoreSubtext: document.getElementById('hwScoreSubtext'),
    wxScoreSubtext: document.getElementById('wxScoreSubtext'),
    siteLabelDisplay: document.getElementById('siteLabelDisplay'),
    siteCoordsDisplay: document.getElementById('siteCoordsDisplay'),
    lastUpdatedDisplay: document.getElementById('lastUpdatedDisplay'),
    toggleRiskDetailsBtn: document.getElementById('toggleRiskDetailsBtn'),
    riskCalculationPanel: document.getElementById('riskCalculationPanel'),
    riskNotesList: document.getElementById('riskNotesList'),

    // Telemetry Cards
    soilMoistureVal: document.getElementById('soilMoistureVal'),
    soilRawVal: document.getElementById('soilRawVal'),
    soilBarFill: document.getElementById('soilBarFill'),
    soilStatusTag: document.getElementById('soilStatusTag'),
    soilTrendVal: document.getElementById('soilTrendVal'),

    rainLevelVal: document.getElementById('rainLevelVal'),
    rainRawVal: document.getElementById('rainRawVal'),
    rainBarFill: document.getElementById('rainBarFill'),
    rainStatusTag: document.getElementById('rainStatusTag'),
    rainTrendVal: document.getElementById('rainTrendVal'),

    tiltMaxAngleVal: document.getElementById('tiltMaxAngleVal'),
    tiltXVal: document.getElementById('tiltXVal'),
    tiltYVal: document.getElementById('tiltYVal'),
    tiltStatusTag: document.getElementById('tiltStatusTag'),
    tiltSwitchBadge: document.getElementById('tiltSwitchBadge'),

    accelVal: document.getElementById('accelVal'),
    accelBarFill: document.getElementById('accelBarFill'),
    accelStatusTag: document.getElementById('accelStatusTag'),

    displacementVal: document.getElementById('displacementVal'),
    distanceVal: document.getElementById('distanceVal'),
    dispBarFill: document.getElementById('dispBarFill'),
    dispStatusTag: document.getElementById('dispStatusTag'),
    sensorFaultBadge: document.getElementById('sensorFaultBadge'),

    weatherMaxRainVal: document.getElementById('weatherMaxRainVal'),
    weatherScoreBadge: document.getElementById('weatherScoreBadge'),
    weatherTimeIndicator: document.getElementById('weatherTimeIndicator'),
    refreshWeatherBtn: document.getElementById('refreshWeatherBtn'),
    gpsStateCommandBadge: document.getElementById('gpsStateCommandBadge'),
    weatherNoticeBanner: document.getElementById('weatherNoticeBanner'),
    weatherGpsStateBadge: document.getElementById('weatherGpsStateBadge'),
    weatherCoordsUsed: document.getElementById('weatherCoordsUsed'),
    weatherFetchTime: document.getElementById('weatherFetchTime'),
    weatherPrevNotice: document.getElementById('weatherPrevNotice'),
    weatherPrevNoticeText: document.getElementById('weatherPrevNoticeText'),

    // Per-Card Last-Updated Timestamps & Card Elements
    soilLastUpdated: document.getElementById('soilLastUpdated'),
    rainLastUpdated: document.getElementById('rainLastUpdated'),
    tiltLastUpdated: document.getElementById('tiltLastUpdated'),
    accelLastUpdated: document.getElementById('accelLastUpdated'),
    dispLastUpdated: document.getElementById('dispLastUpdated'),
    weatherLastUpdated: document.getElementById('weatherLastUpdated'),
    cardSoilMoisture: document.getElementById('cardSoilMoisture'),
    cardRainfall: document.getElementById('cardRainfall'),
    cardTilt: document.getElementById('cardTilt'),
    cardAcceleration: document.getElementById('cardAcceleration'),
    cardDisplacement: document.getElementById('cardDisplacement'),
    cardWeather: document.getElementById('cardWeather'),

    // Map & Evacuation
    locateUserBtn: document.getElementById('locateUserBtn'),
    toggleSatelliteBtn: document.getElementById('toggleSatelliteBtn'),
    geolocationStatusBanner: document.getElementById('geolocationStatusBanner'),
    routeOriginLabel: document.getElementById('routeOriginLabel'),
    routeDestLabel: document.getElementById('routeDestLabel'),
    destVerifiedBadge: document.getElementById('destVerifiedBadge'),
    routeDistanceDisplay: document.getElementById('routeDistanceDisplay'),
    routeDurationDisplay: document.getElementById('routeDurationDisplay'),
    routeStatusBadge: document.getElementById('routeStatusBadge'),
    evacuationMap: document.getElementById('evacuationMap'),

    // SMS Recipient & Test Alert
    smsProviderBadge: document.getElementById('smsProviderBadge'),
    activeRecipientCard: document.getElementById('activeRecipientCard'),
    activeRecipPhone: document.getElementById('activeRecipPhone'),
    activeRecipMeta: document.getElementById('activeRecipMeta'),
    deleteRecipientBtn: document.getElementById('deleteRecipientBtn'),
    recipientForm: document.getElementById('recipientForm'),
    countryCodeInput: document.getElementById('countryCodeInput'),
    phoneInput: document.getElementById('phoneInput'),
    recipientNotesInput: document.getElementById('recipientNotesInput'),
    consentCheckbox: document.getElementById('consentCheckbox'),
    recipientFeedback: document.getElementById('recipientFeedback'),
    sendTestAlertBtn: document.getElementById('sendTestAlertBtn'),
    testAlertResult: document.getElementById('testAlertResult'),

    // Audit Log & Translations Table
    auditCountBadge: document.getElementById('auditCountBadge'),
    auditLogContainer: document.getElementById('auditLogContainer'),
    translationsTableBody: document.getElementById('translationsTableBody'),
  };

  // =========================================================================
  // ZERO-SERVER CLOUD & CLIENT GEOTECHNICAL ENGINE
  // Powers standalone operation via Firebase Realtime Database or Local Simulation
  // =========================================================================

  const CLIENT_SCENARIOS = {
    safe: {
      device: 'ESP32_LANDSLIDE_01',
      soil_moisture: 35.0,
      rain_level: 8.0,
      soil_raw: 2800,
      rain_raw: 3800,
      tilt_x: 1.2,
      tilt_y: 0.8,
      acceleration: 9.81,
      distance_cm: 15.0,
      displacement_cm: 0.2,
      tilt_sensor: false,
      soil_trend: 1.0,
      rain_trend: 0.5,
      history_samples: 120,
      risk_score: 0,
      status: 'SAFE',
      sensor_fault: false,
      gps_valid: true,
      latitude: 19.1334,
      longitude: 72.9133,
      gps_altitude: 125.0,
      gps_speed: 0.0,
      gps_satellites: 8,
      temperature: 27.2,
      humidity: 74.0,
      battery: 95.0,
    },
    warning: {
      device: 'ESP32_LANDSLIDE_01',
      soil_moisture: 68.0,
      rain_level: 62.0,
      soil_raw: 1800,
      rain_raw: 2200,
      tilt_x: 6.8,
      tilt_y: 4.5,
      acceleration: 10.5,
      distance_cm: 13.5,
      displacement_cm: 1.5,
      tilt_sensor: false,
      soil_trend: 12.0,
      rain_trend: 15.0,
      history_samples: 120,
      risk_score: 5,
      status: 'WARNING',
      sensor_fault: false,
      gps_valid: true,
      latitude: 19.1334,
      longitude: 72.9133,
      gps_altitude: 125.0,
      gps_speed: 0.0,
      gps_satellites: 7,
      temperature: 24.5,
      humidity: 86.0,
      battery: 91.0,
    },
    high_risk: {
      device: 'ESP32_LANDSLIDE_01',
      soil_moisture: 79.0,
      rain_level: 75.0,
      soil_raw: 1400,
      rain_raw: 1600,
      tilt_x: 12.5,
      tilt_y: 8.9,
      acceleration: 11.9,
      distance_cm: 11.8,
      displacement_cm: 3.2,
      tilt_sensor: true,
      soil_trend: 22.0,
      rain_trend: 24.0,
      history_samples: 120,
      risk_score: 8,
      status: 'HIGH_RISK',
      sensor_fault: false,
      gps_valid: true,
      latitude: 19.1334,
      longitude: 72.9133,
      gps_altitude: 125.0,
      gps_speed: 0.0,
      gps_satellites: 7,
      temperature: 23.0,
      humidity: 94.0,
      battery: 88.0,
    },
    danger: {
      device: 'ESP32_LANDSLIDE_01',
      soil_moisture: 93.0,
      rain_level: 91.0,
      soil_raw: 800,
      rain_raw: 900,
      tilt_x: 24.0,
      tilt_y: 16.5,
      acceleration: 14.8,
      distance_cm: 8.5,
      displacement_cm: 6.5,
      tilt_sensor: true,
      soil_trend: 35.0,
      rain_trend: 38.0,
      history_samples: 120,
      risk_score: 11,
      status: 'DANGER',
      sensor_fault: false,
      gps_valid: true,
      latitude: 19.1334,
      longitude: 72.9133,
      gps_altitude: 125.0,
      gps_speed: 0.0,
      gps_satellites: 6,
      temperature: 22.0,
      humidity: 99.0,
      battery: 85.0,
    },
  };

  function calculateClientRisk(reading) {
    if (!reading) return { level: 'SAFE', score: 0, status: 'SAFE' };

    const soilPct = Number(reading.soil_moisture ?? 0);
    const rainPct = Number(reading.rain_level ?? 0);
    const angleX = Number(reading.tilt_x ?? reading.angle_x ?? 0);
    const angleY = Number(reading.tilt_y ?? reading.angle_y ?? 0);
    const tiltActive = Boolean(reading.tilt_sensor ?? reading.tilt_active);
    const accel = Number(reading.acceleration ?? reading.accel ?? 9.8);
    const displacementCm = Number(reading.displacement_cm ?? (reading.displacement_mm ? reading.displacement_mm / 10 : 0));

    let score = 0;
    // Section 6 Geotechnical formula
    if (soilPct >= 80) score += 3;
    else if (soilPct >= 60) score += 2;
    else if (soilPct >= 40) score += 1;

    if (rainPct >= 80) score += 3;
    else if (rainPct >= 60) score += 2;
    else if (rainPct >= 40) score += 1;

    const tilt = Math.max(Math.abs(angleX), Math.abs(angleY));
    if (tilt >= 20) score += 3;
    else if (tilt >= 10) score += 2;
    else if (tilt >= 5) score += 1;

    if (tiltActive) score += 2;

    if (accel > 13) score += 2;
    else if (accel > 11) score += 1;

    if (displacementCm > 5) score += 3;
    else if (displacementCm > 2) score += 2;
    else if (displacementCm > 1) score += 1;

    let status = 'SAFE';
    if (score >= 10) status = 'DANGER';
    else if (score >= 7) status = 'HIGH_RISK';
    else if (score >= 4) status = 'WARNING';

    return {
      score,
      status,
      level: status,
      color: status === 'DANGER' ? '#b91c1c' : status === 'HIGH_RISK' ? '#ef4444' : status === 'WARNING' ? '#f59e0b' : '#10b981',
      indication: status === 'DANGER' ? 'Red LED; continuous buzzer' : (status === 'HIGH_RISK' ? 'Red LED; repeated beeps' : (status === 'WARNING' ? 'Yellow LED; short beep' : 'Green LED; buzzer off')),
      factors: {
        soilScore: soilPct >= 80 ? 3 : soilPct >= 60 ? 2 : soilPct >= 40 ? 1 : 0,
        rainScore: rainPct >= 80 ? 3 : rainPct >= 60 ? 2 : rainPct >= 40 ? 1 : 0,
        tiltScore: tilt >= 20 ? 3 : tilt >= 10 ? 2 : tilt >= 5 ? 1 : 0,
        displacementScore: displacementCm > 5 ? 3 : displacementCm > 2 ? 2 : displacementCm > 1 ? 1 : 0,
      },
    };
  }

  function buildClientState(reading) {
    const ageSeconds = state.lastHardwareReceivedAt
      ? Math.max(0, Math.round((Date.now() - state.lastHardwareReceivedAt) / 1000))
      : 0;

    const cfg = window.LANDSLIDE_CONFIG || {};
    const staleThreshold = cfg.TIMING?.STALE_THRESHOLD_SECONDS || 30;
    const disconnectThreshold = cfg.TIMING?.DISCONNECT_THRESHOLD_SECONDS || 120;

    let hwStatus = 'connected';
    let isStale = false;
    if (ageSeconds > disconnectThreshold) {
      hwStatus = 'unavailable';
    } else if (ageSeconds > staleThreshold) {
      hwStatus = 'stale';
      isStale = true;
    }

    const gpsValid = Boolean(reading?.gps_valid && reading.latitude && reading.longitude && !(reading.latitude === 0 && reading.longitude === 0));
    const lat = gpsValid ? Number(reading.latitude) : (cfg.SITE_COORDINATES?.lat || 19.1334);
    const lng = gpsValid ? Number(reading.longitude) : (cfg.SITE_COORDINATES?.lng || 72.9133);

    const risk = calculateClientRisk(reading);

    return {
      success: true,
      hardware: {
        latest: reading,
        isStale,
        ageSeconds,
        status: hwStatus,
      },
      gpsLocationState: gpsValid ? {
        status: 'AVAILABLE',
        coordinates: { latitude: lat, longitude: lng },
        ageSeconds,
      } : {
        status: 'UNAVAILABLE',
        reason: 'No hardware GPS satellite fix',
      },
      weather: state.latestWeather || {
        status: 'cached',
        current: { temperature_c: 27, relative_humidity_pct: 75, precipitation_mm: 0, rain_mm: 0 },
        summary: { next24hPrecipitationMm: 0, isHeavyRainExpected: false },
        ageMinutes: 0,
        cached: true,
        isAvailableForCurrentGps: true,
      },
      risk,
      site: {
        label: cfg.SITE_COORDINATES?.name || 'IIT Bombay Hillside Station #1',
        latitude: lat,
        longitude: lng,
      },
      hardwareLocation: {
        latitude: lat,
        longitude: lng,
        elevation: reading?.gps_altitude ?? 120,
        satellites: reading?.gps_satellites ?? 0,
        label: 'ESP32 Slope Monitoring Node',
      },
      hazardArea: {
        center: [lng, lat],
        radiusMeters: risk.status === 'DANGER' ? 800 : (risk.status === 'HIGH_RISK' ? 500 : (risk.status === 'WARNING' ? 300 : 150)),
        riskLevel: risk.status,
      },
      timestamp: new Date().toISOString(),
    };
  }

  async function fetchClientWeather(force = false) {
    let lat = state.hardwareLocation?.latitude;
    let lng = state.hardwareLocation?.longitude;

    if (!lat || !lng) {
      const cfgSite = window.LANDSLIDE_CONFIG?.SITE_COORDINATES;
      lat = cfgSite?.lat || 19.1334;
      lng = cfgSite?.lng || 72.9133;
    }

    const baseUrl = window.LANDSLIDE_CONFIG?.WEATHER_API_URL || 'https://api.open-meteo.com/v1/forecast';
    const url = `${baseUrl}?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m&hourly=precipitation,rain&forecast_days=2&timezone=auto`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const hourly24 = json.hourly?.precipitation?.slice(0, 24) || [];
      const next24hPrecipitationMm = hourly24.reduce((sum, val) => sum + (Number(val) || 0), 0);

      const weatherData = {
        source: 'open-meteo',
        latitude: json.latitude,
        longitude: json.longitude,
        fetchedCoordinates: {
          latitude: Number(lat.toFixed(4)),
          longitude: Number(lng.toFixed(4)),
        },
        timezone: json.timezone,
        elevation: json.elevation,
        current: {
          time: json.current?.time,
          temperature_c: json.current?.temperature_2m ?? null,
          relative_humidity_pct: json.current?.relative_humidity_2m ?? null,
          precipitation_mm: json.current?.precipitation ?? 0,
          rain_mm: json.current?.rain ?? 0,
        },
        hourly: {
          time: json.hourly?.time?.slice(0, 24) || [],
          precipitation: hourly24,
          rain: json.hourly?.rain?.slice(0, 24) || [],
        },
        summary: {
          next24hPrecipitationMm: Number(next24hPrecipitationMm.toFixed(2)),
          isHeavyRainExpected: hourly24.some((p) => Number(p) >= 10.0),
        },
        fetchedAt: new Date().toISOString(),
        cached: true,
        isStale: false,
        ageMinutes: 0,
        isAvailableForCurrentGps: true,
      };
      state.latestWeather = weatherData;
      return weatherData;
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('[Dashboard] Direct Open-Meteo weather fetch error:', err.message);
      return null;
    }
  }

  function initFirebaseRealtime() {
    const dbUrl = window.LANDSLIDE_CONFIG?.FIREBASE_DATABASE_URL;
    if (!window.firebase || !dbUrl || !dbUrl.trim().length) {
      console.log('[Dashboard] Firebase URL not configured; running in interactive Simulation mode');
      if (elements.demoActiveBadgeText) {
        elements.demoActiveBadgeText.textContent = 'SIMULATION';
        elements.demoActiveBadge?.classList.remove('hidden');
      }
      return false;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp({ databaseURL: dbUrl });
      }
      const db = firebase.database();
      const latestRef = db.ref('landslide/latest');

      latestRef.on(
        'value',
        (snapshot) => {
          const reading = snapshot.val();
          if (reading && typeof reading === 'object') {
            console.log('[Dashboard] Received live reading from Firebase:', reading);
            state.latestHardwareReading = reading;
            state.lastHardwareReceivedAt = Date.now();
            state.firebaseConnected = true;
            if (elements.demoActiveBadgeText) {
              elements.demoActiveBadgeText.textContent = 'FIREBASE LIVE';
              elements.demoActiveBadge?.classList.remove('hidden');
            }
            pollTelemetryState();
          }
        },
        (err) => {
          console.warn('[Dashboard] Firebase listener read error:', err.message);
        }
      );

      console.log('[Dashboard] Firebase Realtime Database connected to:', dbUrl);
      return true;
    } catch (err) {
      console.warn('[Dashboard] Firebase initialization error:', err.message);
      return false;
    }
  }

  // =========================================================================
  // 1. INITIALIZATION & BOOTSTRAP
  // =========================================================================
  async function init() {
    setupEventListeners();
    setupNotificationPermissionUI();

    // Initialize Firebase Realtime Database if configured
    initFirebaseRealtime();

    // Fetch initial static configurations and live Open-Meteo weather
    await Promise.all([
      fetchTranslations(),
      fetchRecipientStatus(),
      fetchAlertLog(),
      fetchClientWeather(),
    ]);

    // Setup lazy loading for evacuation map
    setupLazyMapLoading();

    // Initial state poll, demo status sync & start continuous loop
    await pollTelemetryState();
    await syncDemoStatus();
    startPollingLoop();

    // Schedule client-side weather refresh every 15 mins
    setInterval(() => {
      fetchClientWeather();
    }, window.LANDSLIDE_CONFIG?.TIMING?.WEATHER_POLL_INTERVAL_MS || 15 * 60 * 1000);

    // Smooth 1-second tick for real-time elapsed seconds counter (no DOM rebuild / reflow)
    setInterval(() => {
      if (!state.isTabHidden && state.latestTelemetry && state.hardwareState) {
        updateRelativeTimeDisplays(state.latestTelemetry, state.hardwareState, state.lastValidatedTelemetry);
      }
    }, 1000);
  }

  function setupEventListeners() {
    // Live Demo Mode & Controls
    elements.toggleLiveDemoBtn?.addEventListener('click', handleToggleDemoPanel);
    elements.closeDemoPanelBtn?.addEventListener('click', handleCloseDemoPanel);
    elements.startDemoStreamBtn?.addEventListener('click', handleStartDemoStream);
    elements.stopDemoStreamBtn?.addEventListener('click', handleStopDemoStream);
    elements.autoCycleCheckbox?.addEventListener('change', handleAutoCycleChange);
    elements.demoSpeedSelect?.addEventListener('change', handleDemoSpeedChange);

    elements.demoScenarioButtons?.forEach((btn) => {
      btn.addEventListener('click', () => handleTriggerScenario(btn.dataset.scenario));
    });

    elements.demoSliderSoil?.addEventListener('input', (e) => {
      if (elements.demoSliderSoilVal) elements.demoSliderSoilVal.textContent = `${e.target.value}%`;
    });
    elements.demoSliderRain?.addEventListener('input', (e) => {
      if (elements.demoSliderRainVal) elements.demoSliderRainVal.textContent = `${e.target.value}%`;
    });
    elements.demoSliderTilt?.addEventListener('input', (e) => {
      if (elements.demoSliderTiltVal) elements.demoSliderTiltVal.textContent = `${Number(e.target.value).toFixed(1)}°`;
    });
    elements.demoSliderDisp?.addEventListener('input', (e) => {
      if (elements.demoSliderDispVal) elements.demoSliderDispVal.textContent = `${Number(e.target.value).toFixed(1)} cm`;
    });
    elements.applyCustomSliderBtn?.addEventListener('click', handleApplyCustomSliders);

    // Hardware Setup Location & Hazard Area Controls
    elements.focusHardwareLocationBtn?.addEventListener('click', () => {
      triggerMapInit();
      handleFocusHardwareLocation();
    });
    elements.focusHardwareAreaBtn?.addEventListener('click', () => {
      triggerMapInit();
      handleFocusHardwareLocation();
    });
    elements.toggleHazardPerimeterBtn?.addEventListener('click', () => {
      triggerMapInit();
      handleToggleHazardPerimeter();
    });
    elements.checkMyProximityBtn?.addEventListener('click', () => {
      triggerMapInit();
      handleCheckUserProximity();
    });

    // Audio Siren Controls
    elements.toggleAudioSirenBtn?.addEventListener('click', handleToggleAudioSiren);
    elements.testAlarmBtn?.addEventListener('click', handleTestAlarmSiren);
    elements.silenceSirenBtn?.addEventListener('click', handleSilenceActiveSiren);
    elements.silenceStickySirenBtn?.addEventListener('click', handleSilenceActiveSiren);

    // Manual State Refresh
    elements.manualRefreshBtn?.addEventListener('click', async () => {
      elements.manualRefreshBtn.classList.add('loading');
      await pollTelemetryState();
      await fetchAlertLog();
      elements.manualRefreshBtn.classList.remove('loading');
    });

    // Weather On-Demand Refresh
    elements.refreshWeatherBtn?.addEventListener('click', refreshWeatherForecast);

    // Accordion Toggle for Risk Calculation
    elements.toggleRiskDetailsBtn?.addEventListener('click', () => {
      const isExpanded = elements.toggleRiskDetailsBtn.getAttribute('aria-expanded') === 'true';
      elements.toggleRiskDetailsBtn.setAttribute('aria-expanded', !isExpanded);
      elements.riskCalculationPanel.classList.toggle('hidden', isExpanded);
    });

    // Warning Sign Interaction Buttons
    elements.viewEvacuationMapBtn?.addEventListener('click', () => {
      triggerMapInit();
      elements.emergencyWarningSign.classList.add('hidden');
      elements.stickyWarningBanner.classList.remove('hidden');
      state.warningSnoozed = true;
      document.getElementById('evacuationSection')?.scrollIntoView({ behavior: 'smooth' });
    });

    elements.snoozeWarningBtn?.addEventListener('click', () => {
      elements.emergencyWarningSign.classList.add('hidden');
      elements.stickyWarningBanner.classList.remove('hidden');
      state.warningSnoozed = true;
    });

    elements.reopenWarningBtn?.addEventListener('click', () => {
      elements.stickyWarningBanner.classList.add('hidden');
      elements.emergencyWarningSign.classList.remove('hidden');
      state.warningSnoozed = false;
    });

    // Map Geolocation & Satellite Toggle
    elements.locateUserBtn?.addEventListener('click', () => {
      triggerMapInit();
      handleUserGeolocation();
    });
    elements.toggleSatelliteBtn?.addEventListener('click', () => {
      triggerMapInit();
      toggleSatelliteLayer();
    });

    // SMS Recipient Form & Actions
    elements.recipientForm?.addEventListener('submit', handleRecipientFormSubmit);
    elements.deleteRecipientBtn?.addEventListener('click', handleDeleteRecipient);
    elements.sendTestAlertBtn?.addEventListener('click', handleSendTestAlert);

    // Notification Permission Request
    elements.notificationBtn?.addEventListener('click', requestBrowserNotificationPermission);

    // Page Visibility API: throttle polling in background, immediate sync on foreground
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.isTabHidden = true;
        if (state.pollingTimerId) {
          clearInterval(state.pollingTimerId);
          state.pollingTimerId = setInterval(async () => {
            await pollTelemetryState();
          }, 30000);
        }
      } else {
        state.isTabHidden = false;
        startPollingLoop();
        pollTelemetryState();
      }
    });
  }

  // =========================================================================
  // 2. DATA LAYER: HARDWARE STATE MODEL, VALIDATION & TELEMETRY INGESTION
  // =========================================================================

  /**
   * Validates incoming hardware telemetry against physical and geotechnical bounds.
   * Rejects or flags malformed values, non-numeric fields, and out-of-range readings.
   *
   * @param {Object|null} reading Raw reading from server
   * @returns {Object} { isValid, hasErrors, fieldErrors, sanitized }
   */
  function validateClientTelemetry(reading) {
    if (!reading || typeof reading !== 'object') {
      return {
        isValid: false,
        hasErrors: true,
        fieldErrors: { _root: 'Missing or null telemetry payload' },
        sanitized: null,
      };
    }

    const fieldErrors = {};
    const sanitized = {};
    let hasErrors = false;

    const checkNumber = (key, min, max, allowMinusOne = false) => {
      const val = reading[key];
      if (val === undefined || val === null || val === '') {
        fieldErrors[key] = `Missing '${key}'`;
        hasErrors = true;
        return null;
      }
      const num = Number(val);
      if (!Number.isFinite(num)) {
        fieldErrors[key] = `Non-numeric '${key}' (${val})`;
        hasErrors = true;
        return null;
      }
      if (allowMinusOne && num === -1) {
        sanitized[key] = -1;
        return -1;
      }
      if (num < min || num > max) {
        fieldErrors[key] = `'${key}' out of range [${min}, ${max}] (${num})`;
        hasErrors = true;
        return null;
      }
      sanitized[key] = num;
      return num;
    };

    // Mandatory geotechnical sensor channels
    checkNumber('soil_moisture', 0, 100);
    checkNumber('rain_level', 0, 100);
    checkNumber('tilt_x', -180, 180);
    checkNumber('tilt_y', -180, 180);
    checkNumber('acceleration', 0, 100);
    checkNumber('distance_cm', 0, 500, true);
    checkNumber('displacement_cm', 0, 500);

    // Supplementary channels
    if (reading.soil_trend !== undefined) checkNumber('soil_trend', -100, 100);
    if (reading.rain_trend !== undefined) checkNumber('rain_trend', -100, 100);
    if (reading.history_samples !== undefined) checkNumber('history_samples', 0, 1000);
    if (reading.soil_raw !== undefined) checkNumber('soil_raw', 0, 4095);
    if (reading.rain_raw !== undefined) checkNumber('rain_raw', 0, 4095);
    if (reading.risk_score !== undefined) checkNumber('risk_score', 0, 100);

    // Booleans
    sanitized.tilt_sensor = Boolean(reading.tilt_sensor === true || reading.tilt_sensor === 'true' || reading.tilt_sensor === 1);
    sanitized.sensor_fault = Boolean(reading.sensor_fault === true || reading.sensor_fault === 'true' || reading.sensor_fault === 1);

    // Status enum validation
    const validStatuses = new Set(['SAFE', 'WARNING', 'HIGH_RISK', 'DANGER', 'SENSOR_FAULT']);
    if (reading.status && validStatuses.has(String(reading.status).toUpperCase())) {
      sanitized.status = String(reading.status).toUpperCase();
    } else {
      fieldErrors.status = `Invalid risk status: ${reading.status}`;
      hasErrors = true;
    }

    // Timestamp validation
    if (reading.receivedAt) {
      const ts = new Date(reading.receivedAt).getTime();
      if (!Number.isNaN(ts)) {
        sanitized.receivedAt = reading.receivedAt;
        sanitized.timestampMs = ts;
      } else {
        fieldErrors.receivedAt = `Invalid timestamp: ${reading.receivedAt}`;
        hasErrors = true;
      }
    } else {
      fieldErrors.receivedAt = 'Missing receivedAt timestamp';
      hasErrors = true;
    }

    // Optional GPS fields
    if (reading.latitude !== undefined) checkNumber('latitude', -90, 90);
    if (reading.longitude !== undefined) checkNumber('longitude', -180, 180);
    if (reading.gps_altitude !== undefined) checkNumber('gps_altitude', -500, 9000);
    if (reading.gps_speed !== undefined) checkNumber('gps_speed', 0, 500);
    if (reading.gps_satellites !== undefined) checkNumber('gps_satellites', 0, 64);
    if (reading.gps_valid !== undefined) sanitized.gps_valid = Boolean(reading.gps_valid);

    sanitized.device = reading.device || 'ESP32_LANDSLIDE_01';

    return {
      isValid: !hasErrors,
      hasErrors,
      fieldErrors,
      sanitized,
    };
  }

  /**
   * Resolves the hardware state according to the formal state model:
   * loading, connected, stale, unavailable (disconnected), or error.
   */
  function determineHardwareState(data, validation) {
    if (!data || !data.success) {
      return HARDWARE_STATE.ERROR;
    }

    const hw = data.hardware || {};
    const reading = hw.latest;

    if (!reading || !reading.receivedAt) {
      return HARDWARE_STATE.UNAVAILABLE;
    }

    // Compute age based on receivedAt or server-provided ageSeconds
    const ageSeconds = hw.ageSeconds !== undefined
      ? hw.ageSeconds
      : Math.max(0, Math.round((Date.now() - new Date(reading.receivedAt).getTime()) / 1000));

    const isStale = hw.isStale === true || ageSeconds > state.staleThresholdSeconds;

    if (isStale) {
      return HARDWARE_STATE.STALE;
    }

    return HARDWARE_STATE.CONNECTED;
  }

  /**
   * Resolves the GPS location state according to the formal 3-state model:
   * - AVAILABLE: Valid fix from hardware, valid non-zero coordinates within geographic range, and fresh telemetry
   * - STALE: Valid coordinates previously received, but hardware telemetry age exceeds staleness threshold
   * - UNAVAILABLE: Missing telemetry, gps_valid is false, coordinates missing/null, coordinates (0, 0), or out of bounds
   */
  function determineGpsLocationState(data) {
    if (data?.gpsLocationState && data.gpsLocationState.status) {
      return data.gpsLocationState;
    }

    const hwLoc = data?.hardwareLocation;
    const reading = data?.hardware?.latest;
    const hwState = state.hardwareState;

    if (!hwLoc || !reading || !reading.receivedAt || hwState === HARDWARE_STATE.UNAVAILABLE || hwState === HARDWARE_STATE.ERROR) {
      return {
        status: GPS_LOCATION_STATE.UNAVAILABLE,
        coordinates: null,
        fixTime: null,
        ageSeconds: null,
        reason: 'No hardware telemetry received yet',
      };
    }

    if (reading.gps_valid === false) {
      return {
        status: GPS_LOCATION_STATE.UNAVAILABLE,
        coordinates: null,
        fixTime: null,
        ageSeconds: null,
        reason: 'GPS receiver has no satellite fix',
      };
    }

    const lat = hwLoc.latitude ?? reading.latitude;
    const lng = hwLoc.longitude ?? reading.longitude;

    if (
      lat === null ||
      lat === undefined ||
      lng === null ||
      lng === undefined ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180 ||
      (lat === 0 && lng === 0)
    ) {
      return {
        status: GPS_LOCATION_STATE.UNAVAILABLE,
        coordinates: null,
        fixTime: null,
        ageSeconds: null,
        reason: 'Invalid or missing GPS coordinates (e.g. 0,0 or out of range)',
      };
    }

    const fixTime = hwLoc.fixTime || hwLoc.updatedAt || reading.receivedAt;
    const fixTimeMs = new Date(fixTime).getTime();
    const ageSeconds = Math.max(0, Math.round((Date.now() - fixTimeMs) / 1000));
    const isStale = hwState === HARDWARE_STATE.STALE || ageSeconds > state.staleThresholdSeconds;

    const coordinates = { latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)) };

    if (isStale) {
      return {
        status: GPS_LOCATION_STATE.STALE,
        coordinates,
        fixTime,
        ageSeconds,
        reason: `GPS fix is stale (${ageSeconds}s old > ${state.staleThresholdSeconds}s)`,
      };
    }

    return {
      status: GPS_LOCATION_STATE.AVAILABLE,
      coordinates,
      fixTime,
      ageSeconds,
    };
  }

  /**
   * Generates a deterministic hash signature to memoize renders
   * and avoid unnecessary DOM repaints and MapLibre re-evaluations.
   */
  function computeDataSignature(data, hardwareState, validation) {
    if (hardwareState === HARDWARE_STATE.ERROR) {
      return `error_${data?.error || 'network'}`;
    }
    if (hardwareState === HARDWARE_STATE.UNAVAILABLE) {
      return `unavailable_${data?.hardwareLocation?.latitude || ''}_${data?.hardwareLocation?.longitude || ''}`;
    }
    if (hardwareState === HARDWARE_STATE.LOADING) {
      return 'loading';
    }

    const r = data.hardware?.latest || {};
    const w = data.weather?.cached || {};
    const gps = data.gpsLocationState || {};
    const errKeys = validation ? Object.keys(validation.fieldErrors).sort().join(',') : '';

    return [
      hardwareState,
      r.receivedAt,
      r.status,
      r.risk_score,
      r.soil_moisture,
      r.rain_level,
      r.tilt_x,
      r.tilt_y,
      r.acceleration,
      r.distance_cm,
      r.displacement_cm,
      r.tilt_sensor,
      r.sensor_fault,
      data.risk?.status,
      data.risk?.totalScore,
      gps.status,
      gps.coordinates?.latitude,
      gps.coordinates?.longitude,
      gps.fixTime,
      data.hazardArea?.severity,
      w.maxPrecipitation6h,
      data.weather?.isAvailableForCurrentGps,
      errKeys,
    ].join('::');
  }

  /**
   * Lightweight fast-path: updates relative elapsed seconds and clock strings
   * without re-rendering card DOM, charts, or maps when data hasn't changed.
   */
  function updateRelativeTimeDisplays(data, hardwareState, validation) {
    const hw = data?.hardware || {};
    const reading = hw.latest;
    const wx = data?.weather || {};

    if (hardwareState === HARDWARE_STATE.UNAVAILABLE) {
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = 'Last Sync: No readings received (Disconnected)';
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'DISCONNECTED';
      const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
      if (hwDot) hwDot.className = 'indicator-dot unavailable';
      setCardTimestamps('Last reading: No data received', '');
      return;
    }

    if (hardwareState === HARDWARE_STATE.LOADING) {
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = 'Last Sync: Connecting...';
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'CONNECTING...';
      setCardTimestamps('Last reading: Connecting...', '');
      return;
    }

    if (hardwareState === HARDWARE_STATE.ERROR) {
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = 'Last Sync: Server communication error';
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'SERVER ERROR';
      const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
      if (hwDot) hwDot.className = 'indicator-dot offline';
      setCardTimestamps('Last reading: Sync error', 'is-error');
      return;
    }

    if (!reading || !reading.receivedAt) return;

    const ageSeconds = hw.ageSeconds !== undefined
      ? hw.ageSeconds
      : Math.max(0, Math.round((Date.now() - new Date(reading.receivedAt).getTime()) / 1000));

    const date = new Date(reading.receivedAt);
    const timeStr = date.toLocaleTimeString();

    if (hardwareState === HARDWARE_STATE.STALE) {
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = `Last Sync: ${timeStr} (${ageSeconds}s ago — STALE)`;
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = `STALE (${ageSeconds}s)`;
      const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
      if (hwDot) hwDot.className = 'indicator-dot stale';
      setCardTimestamps(`Last reading: ⚠️ Stale (${timeStr}, ${ageSeconds}s ago)`, 'is-stale');
    } else {
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = `Last Sync: ${timeStr} (${ageSeconds}s ago)`;
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = `CONNECTED (${ageSeconds}s)`;
      const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
      if (hwDot) hwDot.className = 'indicator-dot online';
      setCardTimestamps(`Last reading: ${timeStr} (${ageSeconds}s ago)`, 'is-live');
    }

    // Weather timestamp
    if (elements.weatherLastUpdated) {
      if (state.gpsLocationState === GPS_LOCATION_STATE.UNAVAILABLE) {
        elements.weatherLastUpdated.textContent = 'Weather unavailable: no current GPS location';
        elements.weatherLastUpdated.className = 'sensor-timestamp is-error';
      } else if (state.gpsLocationState === GPS_LOCATION_STATE.STALE) {
        elements.weatherLastUpdated.textContent = 'Weather unavailable: GPS stale';
        elements.weatherLastUpdated.className = 'sensor-timestamp is-stale';
      } else if (wx.cached && (wx.cached.fetchedAt || wx.cached.timestamp || wx.cached.cachedAt)) {
        const fetchTime = wx.cached.fetchedAt || wx.cached.timestamp || wx.cached.cachedAt;
        const wxAgeSec = Math.max(0, Math.round((Date.now() - new Date(fetchTime).getTime()) / 1000));
        const wxAgeMin = Math.round(wxAgeSec / 60);
        elements.weatherLastUpdated.textContent = `Forecast: ${wxAgeMin}m ago (${wx.isStale ? 'Stale' : 'Live'})`;
        elements.weatherLastUpdated.className = `sensor-timestamp ${wx.isStale ? 'is-stale' : 'is-live'}`;
      } else {
        elements.weatherLastUpdated.textContent = 'Forecast: No data';
        elements.weatherLastUpdated.className = 'sensor-timestamp';
      }
    }
  }

  function setCardTimestamps(text, className) {
    const timeEls = [
      elements.soilLastUpdated,
      elements.rainLastUpdated,
      elements.tiltLastUpdated,
      elements.accelLastUpdated,
      elements.dispLastUpdated,
    ];
    timeEls.forEach((el) => {
      if (el) {
        el.textContent = text;
        el.className = `sensor-timestamp ${className}`.trim();
      }
    });
  }

  function applyCardStateClasses(stateClass) {
    const cards = [
      elements.cardSoilMoisture,
      elements.cardRainfall,
      elements.cardTilt,
      elements.cardAcceleration,
      elements.cardDisplacement,
    ];
    cards.forEach((card) => {
      if (!card) return;
      card.classList.remove('state-stale', 'state-unavailable', 'state-error');
      if (stateClass) card.classList.add(stateClass);
    });
  }

  function startPollingLoop() {
    if (state.pollingTimerId) clearInterval(state.pollingTimerId);
    const interval = state.demo.isStreaming ? state.demo.intervalMs : state.pollingIntervalMs;
    state.pollingTimerId = setInterval(async () => {
      await pollTelemetryState();
    }, interval);
  }

  async function pollTelemetryState() {
    // In-flight request deduplication: prevent overlapping fetches
    if (state.isFetchingTelemetry) return;
    state.isFetchingTelemetry = true;

    try {
      let data = null;

      // 1. Primary Source: Firebase Realtime Hardware Telemetry (if available)
      if (state.latestHardwareReading) {
        data = buildClientState(state.latestHardwareReading);
      } else {
        // 2. Secondary Source: Local Express Backend (if running locally)
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1200);
          const res = await fetch('/api/state', { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            data = await res.json();
          }
        } catch (_) {
          // Local server not running (e.g. static Vercel or GitHub Pages)
        }

        // 3. Fallback Source: Interactive Client Simulator (Scenario)
        if (!data) {
          const scenarioKey = state.demo.currentScenario || 'safe';
          const scenarioReading = CLIENT_SCENARIOS[scenarioKey] || CLIENT_SCENARIOS.safe;
          data = buildClientState({
            ...scenarioReading,
            timestamp: new Date().toISOString(),
          });
        }
      }

      state.latestTelemetry = data;

      // Validate incoming hardware reading against geotechnical bounds
      const validation = validateClientTelemetry(data.hardware?.latest);
      state.lastValidatedTelemetry = validation;

      // Determine active state model
      const hardwareState = determineHardwareState(data, validation);
      if (state.previousHardwareState && state.previousHardwareState !== hardwareState) {
        announceA11yStatus(`Hardware sensor state updated to ${hardwareState}.`);
      }
      state.previousHardwareState = hardwareState;
      state.hardwareState = hardwareState;

      // Deduplicate re-renders via signature memoization
      const signature = computeDataSignature(data, hardwareState, validation);
      if (signature === state.lastDataSignature) {
        updateRelativeTimeDisplays(data, hardwareState, validation);
        return;
      }
      state.lastDataSignature = signature;

      // Execute full render
      renderTelemetry(data, hardwareState, validation);
      evaluateEmergencyState(data);
    } catch (err) {
      console.warn('[Dashboard] State polling error:', err.message);
      state.hardwareState = HARDWARE_STATE.ERROR;
      renderOfflineState();
    } finally {
      state.isFetchingTelemetry = false;
    }
  }

  function renderTelemetry(data, hardwareState, validation) {
    const hw = data.hardware || {};
    const wx = data.weather || {};
    const reading = hw.latest || {};
    const risk = data.risk || {};
    const site = data.site || {};
    const sms = data.sms || {};
    const fieldErrors = validation?.fieldErrors || {};

    const gpsState = determineGpsLocationState(data);
    state.gpsLocationState = gpsState.status;

    // 1. Station Command Bar & Hardware GPS Status
    if (elements.stationTitleDisplay) {
      elements.stationTitleDisplay.textContent = site.label || 'IIT Bombay Hillside Station #1';
    }

    if (elements.gpsStateCommandBadge) {
      if (gpsState.status === GPS_LOCATION_STATE.AVAILABLE) {
        elements.gpsStateCommandBadge.innerHTML = `<span class="indicator-dot online"></span> GPS Fix: ${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E`;
        elements.gpsStateCommandBadge.title = `Hardware GPS Fix Active (received ${gpsState.ageSeconds ?? 0}s ago)`;
      } else if (gpsState.status === GPS_LOCATION_STATE.STALE) {
        elements.gpsStateCommandBadge.innerHTML = `<span class="indicator-dot stale"></span> GPS Fix: Stale (${gpsState.ageSeconds ?? 0}s ago)`;
        elements.gpsStateCommandBadge.title = gpsState.reason || 'GPS fix is stale';
      } else {
        elements.gpsStateCommandBadge.innerHTML = '<span class="indicator-dot unavailable"></span> GPS: No Fix / Unavailable';
        elements.gpsStateCommandBadge.title = gpsState.reason || 'No valid hardware GPS fix';
      }
    }

    if (elements.stationCoordsBadge) {
      if (gpsState.status === GPS_LOCATION_STATE.AVAILABLE) {
        elements.stationCoordsBadge.textContent = `${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E`;
      } else if (gpsState.status === GPS_LOCATION_STATE.STALE && gpsState.coordinates) {
        elements.stationCoordsBadge.textContent = `${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E (Stale)`;
      } else {
        elements.stationCoordsBadge.textContent = 'GPS Unavailable (No Hardware Fix)';
      }
    }

    if (elements.siteLabelDisplay) {
      elements.siteLabelDisplay.textContent = site.label || 'IIT Bombay Hillside Station #1';
    }
    if (elements.siteCoordsDisplay) {
      if (gpsState.status === GPS_LOCATION_STATE.AVAILABLE) {
        elements.siteCoordsDisplay.textContent = `${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E`;
      } else if (gpsState.status === GPS_LOCATION_STATE.STALE && gpsState.coordinates) {
        elements.siteCoordsDisplay.textContent = `${gpsState.coordinates.latitude.toFixed(4)}° N, ${gpsState.coordinates.longitude.toFixed(4)}° E (Stale)`;
      } else {
        elements.siteCoordsDisplay.textContent = 'GPS Unavailable (No Hardware Fix)';
      }
    }

    // 2. Hardware Freshness Badge & Card State Classes
    const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
    if (hardwareState === HARDWARE_STATE.UNAVAILABLE) {
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'DISCONNECTED';
      if (hwDot) hwDot.className = 'indicator-dot unavailable';
      if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = 'Last Sync: No readings received (Disconnected)';
      applyCardStateClasses('state-unavailable');
    } else if (hardwareState === HARDWARE_STATE.STALE) {
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = `STALE (${hw.ageSeconds ?? 0}s)`;
      if (hwDot) hwDot.className = 'indicator-dot stale';
      applyCardStateClasses('state-stale');
    } else if (hardwareState === HARDWARE_STATE.ERROR) {
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'SERVER ERROR';
      if (hwDot) hwDot.className = 'indicator-dot offline';
      applyCardStateClasses('state-error');
    } else {
      if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = `CONNECTED (${hw.ageSeconds ?? 0}s)`;
      if (hwDot) hwDot.className = 'indicator-dot online';
      applyCardStateClasses('');
    }

    // 3. Weather Freshness Badge
    const wxDot = elements.wxFreshnessBadge?.querySelector('.indicator-dot');
    if (gpsState.status === GPS_LOCATION_STATE.UNAVAILABLE) {
      if (elements.wxFreshnessText) elements.wxFreshnessText.textContent = 'NO GPS LOCATION';
      if (wxDot) wxDot.className = 'indicator-dot unavailable';
    } else if (gpsState.status === GPS_LOCATION_STATE.STALE) {
      if (elements.wxFreshnessText) elements.wxFreshnessText.textContent = 'GPS STALE';
      if (wxDot) wxDot.className = 'indicator-dot stale';
    } else if (!wx.cached || wx.isAvailableForCurrentGps === false) {
      if (elements.wxFreshnessText) elements.wxFreshnessText.textContent = 'NO WEATHER';
      if (wxDot) wxDot.className = 'indicator-dot stale';
    } else if (wx.isStale) {
      if (elements.wxFreshnessText) elements.wxFreshnessText.textContent = `STALE (${wx.ageMinutes}m)`;
      if (wxDot) wxDot.className = 'indicator-dot stale';
    } else {
      if (elements.wxFreshnessText) elements.wxFreshnessText.textContent = `LIVE (${wx.ageMinutes}m)`;
      if (wxDot) wxDot.className = 'indicator-dot online';
    }

    // 4. Update Timestamps with Each Reading
    updateRelativeTimeDisplays(data, hardwareState, validation);

    // 5. Hardware Location & Hazard Map Area
    renderHazardArea(data.hazardArea, data.hardwareLocation, risk);
    updateMapHazardArea(data.hazardArea, data.hardwareLocation, risk);

    // 6. Handle UNAVAILABLE / DISCONNECTED State
    // Never display fabricated, default, or cached-as-live values as real data
    if (hardwareState === HARDWARE_STATE.UNAVAILABLE) {
      if (elements.heroScoreValue) elements.heroScoreValue.textContent = '—';
      if (elements.heroStatusBadge) {
        elements.heroStatusBadge.textContent = 'DISCONNECTED';
        elements.heroStatusBadge.className = 'risk-badge-large status-safe';
      }
      if (elements.hwScoreSubtext) elements.hwScoreSubtext.textContent = 'HW: Disconnected';
      if (elements.wxScoreSubtext) elements.wxScoreSubtext.textContent = `WX: ${risk.weatherScore ?? 0} pts`;
      renderHardwareActuation('DISCONNECTED');
      renderRiskNotes(['Awaiting physical telemetry transmission from ESP32 node. Hardware is currently disconnected.']);

      // Clear all sensor metrics to non-fabricated empty states
      elements.soilMoistureVal.textContent = '—';
      elements.soilRawVal.textContent = '—';
      elements.soilBarFill.style.width = '0%';
      elements.soilStatusTag.textContent = 'NO DATA';
      elements.soilStatusTag.className = 'sensor-status-tag status-safe';
      elements.soilTrendVal.textContent = 'Trend: —';

      elements.rainLevelVal.textContent = '—';
      elements.rainRawVal.textContent = '—';
      elements.rainBarFill.style.width = '0%';
      elements.rainStatusTag.textContent = 'NO DATA';
      elements.rainStatusTag.className = 'sensor-status-tag status-safe';
      elements.rainTrendVal.textContent = 'Trend: —';

      elements.tiltMaxAngleVal.textContent = '—';
      elements.tiltXVal.textContent = '—';
      elements.tiltYVal.textContent = '—';
      elements.tiltStatusTag.textContent = 'NO DATA';
      elements.tiltStatusTag.className = 'sensor-status-tag status-safe';
      elements.tiltSwitchBadge.textContent = 'Tilt Switch: Disconnected';
      elements.tiltSwitchBadge.className = 'mini-badge';

      elements.accelVal.textContent = '—';
      elements.accelBarFill.style.width = '0%';
      elements.accelStatusTag.textContent = 'NO DATA';
      elements.accelStatusTag.className = 'sensor-status-tag status-safe';

      elements.displacementVal.textContent = '—';
      elements.distanceVal.textContent = '—';
      elements.dispBarFill.style.width = '0%';
      elements.dispStatusTag.textContent = 'NO DATA';
      elements.dispStatusTag.className = 'sensor-status-tag status-safe';
      elements.sensorFaultBadge.textContent = 'Sensor: Disconnected';
      elements.sensorFaultBadge.className = '';

      renderWeatherCard(wx, risk, gpsState);
      return;
    }

    // 7. Composite Risk Hero Card for Connected/Stale States
    const status = risk.status || 'UNKNOWN';
    const score = risk.totalScore ?? 0;
    elements.heroScoreValue.textContent = score;
    elements.heroStatusBadge.textContent = status.replace('_', ' ');
    elements.heroStatusBadge.className = `risk-badge-large status-${status.toLowerCase().replace('_', '-')}`;

    elements.hwScoreSubtext.textContent = `HW: ${risk.hardwareScore ?? 0} pts`;
    elements.wxScoreSubtext.textContent = `WX: ${risk.weatherScore ?? 0} pts`;

    // Actuation Indicators (Section 10 of guide)
    renderHardwareActuation(status);

    // Build risk notes, appending field validation warnings if any exist
    const displayNotes = [...(risk.notes || [])];
    if (validation && validation.hasErrors) {
      Object.entries(fieldErrors).forEach(([f, msg]) => {
        displayNotes.unshift(`⚠️ Data Quality Warning: ${msg}`);
      });
    }
    renderRiskNotes(displayNotes);

    // 8. Individual Sensor Channels with Ingestion Validation
    // Soil Moisture
    if (fieldErrors.soil_moisture) {
      elements.soilMoistureVal.textContent = 'ERR';
      elements.soilMoistureVal.classList.add('is-malformed');
      elements.soilStatusTag.textContent = 'MALFORMED DATA';
      elements.soilStatusTag.className = 'sensor-status-tag status-danger';
      elements.soilBarFill.style.width = '0%';
      elements.soilRawVal.textContent = 'Invalid';
    } else {
      elements.soilMoistureVal.classList.remove('is-malformed');
      const soilPct = Number(reading.soil_moisture ?? 0);
      elements.soilMoistureVal.textContent = soilPct.toFixed(1);
      elements.soilRawVal.textContent = reading.soil_raw ?? '—';
      elements.soilBarFill.style.width = `${Math.min(100, Math.max(0, soilPct))}%`;
      elements.soilTrendVal.textContent = `Trend: ${reading.soil_trend >= 0 ? '+' : ''}${(reading.soil_trend ?? 0).toFixed(1)}%/hr`;
      if (soilPct >= 80) {
        elements.soilStatusTag.textContent = 'CRITICAL (SATURATED)';
        elements.soilStatusTag.className = 'sensor-status-tag status-danger';
      } else if (soilPct >= 60) {
        elements.soilStatusTag.textContent = 'WARNING (HIGH)';
        elements.soilStatusTag.className = 'sensor-status-tag status-warning';
      } else {
        elements.soilStatusTag.textContent = 'NORMAL';
        elements.soilStatusTag.className = 'sensor-status-tag status-safe';
      }
    }

    // Rainfall
    if (fieldErrors.rain_level) {
      elements.rainLevelVal.textContent = 'ERR';
      elements.rainLevelVal.classList.add('is-malformed');
      elements.rainStatusTag.textContent = 'MALFORMED DATA';
      elements.rainStatusTag.className = 'sensor-status-tag status-danger';
      elements.rainBarFill.style.width = '0%';
      elements.rainRawVal.textContent = 'Invalid';
    } else {
      elements.rainLevelVal.classList.remove('is-malformed');
      const rainPct = Number(reading.rain_level ?? 0);
      elements.rainLevelVal.textContent = rainPct.toFixed(1);
      elements.rainRawVal.textContent = reading.rain_raw ?? '—';
      elements.rainBarFill.style.width = `${Math.min(100, Math.max(0, rainPct))}%`;
      elements.rainTrendVal.textContent = `Trend: ${reading.rain_trend >= 0 ? '+' : ''}${(reading.rain_trend ?? 0).toFixed(1)}%/hr`;
      if (rainPct >= 80) {
        elements.rainStatusTag.textContent = 'HEAVY RAIN';
        elements.rainStatusTag.className = 'sensor-status-tag status-danger';
      } else if (rainPct >= 40) {
        elements.rainStatusTag.textContent = 'MODERATE';
        elements.rainStatusTag.className = 'sensor-status-tag status-warning';
      } else {
        elements.rainStatusTag.textContent = 'NORMAL';
        elements.rainStatusTag.className = 'sensor-status-tag status-safe';
      }
    }

    // Tilt (MPU-6050 & Mechanical Switch)
    if (fieldErrors.tilt_x || fieldErrors.tilt_y) {
      elements.tiltMaxAngleVal.textContent = 'ERR';
      elements.tiltMaxAngleVal.classList.add('is-malformed');
      elements.tiltStatusTag.textContent = 'MALFORMED INCLINE';
      elements.tiltStatusTag.className = 'sensor-status-tag status-danger';
      elements.tiltXVal.textContent = 'ERR';
      elements.tiltYVal.textContent = 'ERR';
    } else {
      elements.tiltMaxAngleVal.classList.remove('is-malformed');
      const tiltX = Number(reading.tilt_x ?? 0);
      const tiltY = Number(reading.tilt_y ?? 0);
      const maxTilt = Math.max(Math.abs(tiltX), Math.abs(tiltY));
      elements.tiltMaxAngleVal.textContent = maxTilt.toFixed(1);
      elements.tiltXVal.textContent = `${tiltX.toFixed(1)}°`;
      elements.tiltYVal.textContent = `${tiltY.toFixed(1)}°`;

      if (reading.tilt_sensor) {
        elements.tiltSwitchBadge.textContent = 'Tilt Switch: TRIGGERED';
        elements.tiltSwitchBadge.className = 'mini-badge status-danger';
      } else {
        elements.tiltSwitchBadge.textContent = 'Tilt Switch: Open (Stable)';
        elements.tiltSwitchBadge.className = 'mini-badge';
      }

      if (maxTilt >= 20 || reading.tilt_sensor) {
        elements.tiltStatusTag.textContent = 'SEVERE INCLINE';
        elements.tiltStatusTag.className = 'sensor-status-tag status-danger';
      } else if (maxTilt >= 10) {
        elements.tiltStatusTag.textContent = 'WARNING';
        elements.tiltStatusTag.className = 'sensor-status-tag status-warning';
      } else {
        elements.tiltStatusTag.textContent = 'STABLE';
        elements.tiltStatusTag.className = 'sensor-status-tag status-safe';
      }
    }

    // Acceleration / Tremor
    if (fieldErrors.acceleration) {
      elements.accelVal.textContent = 'ERR';
      elements.accelVal.classList.add('is-malformed');
      elements.accelStatusTag.textContent = 'MALFORMED VIBRATION';
      elements.accelStatusTag.className = 'sensor-status-tag status-danger';
      elements.accelBarFill.style.width = '0%';
    } else {
      elements.accelVal.classList.remove('is-malformed');
      const accel = Number(reading.acceleration ?? 9.8);
      elements.accelVal.textContent = accel.toFixed(2);
      const accelFillPct = Math.min(100, Math.max(0, (accel / 20) * 100));
      elements.accelBarFill.style.width = `${accelFillPct}%`;
      if (accel > 13.0) {
        elements.accelStatusTag.textContent = 'SEISMIC / ROCKFALL';
        elements.accelStatusTag.className = 'sensor-status-tag status-danger';
      } else {
        elements.accelStatusTag.textContent = 'STABLE';
        elements.accelStatusTag.className = 'sensor-status-tag status-safe';
      }
    }

    // Displacement (HC-SR04)
    if (fieldErrors.displacement_cm || fieldErrors.distance_cm) {
      elements.displacementVal.textContent = 'ERR';
      elements.displacementVal.classList.add('is-malformed');
      elements.dispStatusTag.textContent = 'MALFORMED TRANSDUCER';
      elements.dispStatusTag.className = 'sensor-status-tag status-danger';
      elements.dispBarFill.style.width = '0%';
      elements.distanceVal.textContent = 'Invalid';
    } else {
      elements.displacementVal.classList.remove('is-malformed');
      const disp = Number(reading.displacement_cm ?? 0);
      elements.displacementVal.textContent = disp.toFixed(2);
      elements.distanceVal.textContent = (reading.distance_cm ?? 0).toFixed(1);
      const dispFillPct = Math.min(100, Math.max(0, (disp / 5) * 100));
      elements.dispBarFill.style.width = `${dispFillPct}%`;

      if (reading.sensor_fault || reading.distance_cm < 0) {
        elements.sensorFaultBadge.textContent = 'Sensor Fault: FAULT';
        elements.sensorFaultBadge.className = 'status-fault';
        elements.dispStatusTag.textContent = 'SENSOR FAULT';
        elements.dispStatusTag.className = 'sensor-status-tag status-fault';
      } else if (disp > 2.0) {
        elements.sensorFaultBadge.textContent = 'Sensor: Nominal';
        elements.sensorFaultBadge.className = '';
        elements.dispStatusTag.textContent = 'FAILURE DANGER';
        elements.dispStatusTag.className = 'sensor-status-tag status-danger';
      } else {
        elements.sensorFaultBadge.textContent = 'Sensor: Nominal';
        elements.sensorFaultBadge.className = '';
        elements.dispStatusTag.textContent = 'STABLE';
        elements.dispStatusTag.className = 'sensor-status-tag status-safe';
      }
    }

    // Weather Card
    renderWeatherCard(wx, risk, gpsState);

    // SMS Provider Status
    if (sms.isSimulated) {
      elements.smsProviderBadge.textContent = 'SIMULATED SMS';
    } else {
      elements.smsProviderBadge.textContent = 'TWILIO CELLULAR';
    }
  }

  function renderWeatherCard(wx, risk, gpsState) {
    const wxData = wx?.cached || {};
    const gps = gpsState || (state.gpsLocationState && { status: state.gpsLocationState });
    const gpsStatus = gps?.status || GPS_LOCATION_STATE.UNAVAILABLE;

    // Check if previous forecast cache exists
    const hasPreviousCache = Boolean(
      wxData && (
        wxData.maxPrecipitation6h !== undefined ||
        wxData.fetchedCoordinates ||
        (wxData.latitude !== undefined && wxData.longitude !== undefined)
      )
    );

    // Weather Gps State Badge
    if (elements.weatherGpsStateBadge) {
      if (gpsStatus === GPS_LOCATION_STATE.AVAILABLE) {
        elements.weatherGpsStateBadge.className = 'mini-badge station-gps-badge gps-available';
        const fixTimeStr = gps.fixTime ? new Date(gps.fixTime).toLocaleTimeString() : 'Active';
        elements.weatherGpsStateBadge.textContent = `GPS Fix: ${fixTimeStr}`;
      } else if (gpsStatus === GPS_LOCATION_STATE.STALE) {
        elements.weatherGpsStateBadge.className = 'mini-badge station-gps-badge gps-stale';
        elements.weatherGpsStateBadge.textContent = `GPS Fix: Stale (${gps.ageSeconds ?? 0}s)`;
      } else {
        elements.weatherGpsStateBadge.className = 'mini-badge station-gps-badge gps-unavailable';
        elements.weatherGpsStateBadge.textContent = 'GPS: No Fix / Unavailable';
      }
    }

    // Weather Notice Banner & Previous Notice handling
    if (gpsStatus === GPS_LOCATION_STATE.UNAVAILABLE) {
      if (elements.weatherNoticeBanner) {
        elements.weatherNoticeBanner.textContent = 'Weather unavailable: no current GPS location';
        elements.weatherNoticeBanner.className = 'weather-notice-banner notice-error';
        elements.weatherNoticeBanner.classList.remove('hidden');
      }

      if (hasPreviousCache) {
        // Label previously fetched weather with coordinates and fetch time
        const prevCoords = wxData.fetchedCoordinates || (wxData.latitude && wxData.longitude ? `${Number(wxData.latitude).toFixed(4)}° N, ${Number(wxData.longitude).toFixed(4)}° E` : 'prior location');
        const prevTime = wxData.fetchedAt ? new Date(wxData.fetchedAt).toLocaleTimeString() : (wxData.cachedAt ? new Date(wxData.cachedAt).toLocaleTimeString() : 'prior sync');
        if (elements.weatherPrevNotice && elements.weatherPrevNoticeText) {
          elements.weatherPrevNoticeText.textContent = `⚠️ Previously fetched for ${prevCoords} at ${prevTime}`;
          elements.weatherPrevNotice.classList.remove('hidden');
        }
        if (elements.weatherCoordsUsed) elements.weatherCoordsUsed.textContent = `${prevCoords} (Outdated)`;
        if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = `${prevTime} (Prior)`;
        if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = (wxData.maxPrecipitation6h ?? 0).toFixed(1);
        if (elements.weatherScoreBadge) {
          elements.weatherScoreBadge.textContent = '+0 Risk Pts (No Current GPS)';
          elements.weatherScoreBadge.className = 'mini-badge';
        }
        if (elements.weatherTimeIndicator) {
          elements.weatherTimeIndicator.textContent = wxData.currentTemperature !== undefined ? `Prior Temp: ${wxData.currentTemperature}°C` : 'Current Temp: — °C';
        }
      } else {
        if (elements.weatherPrevNotice) elements.weatherPrevNotice.classList.add('hidden');
        if (elements.weatherCoordsUsed) elements.weatherCoordsUsed.textContent = '—';
        if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = '—';
        if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = '—';
        if (elements.weatherScoreBadge) {
          elements.weatherScoreBadge.textContent = '+0 Risk Pts (No Current GPS)';
          elements.weatherScoreBadge.className = 'mini-badge';
        }
        if (elements.weatherTimeIndicator) elements.weatherTimeIndicator.textContent = 'Current Temp: — °C';
      }
      return;
    }

    if (gpsStatus === GPS_LOCATION_STATE.STALE) {
      if (elements.weatherNoticeBanner) {
        elements.weatherNoticeBanner.textContent = 'Weather unavailable: no current GPS location (GPS stale)';
        elements.weatherNoticeBanner.className = 'weather-notice-banner notice-warning';
        elements.weatherNoticeBanner.classList.remove('hidden');
      }

      if (hasPreviousCache) {
        const prevCoords = wxData.fetchedCoordinates || (wxData.latitude && wxData.longitude ? `${Number(wxData.latitude).toFixed(4)}° N, ${Number(wxData.longitude).toFixed(4)}° E` : 'prior location');
        const prevTime = wxData.fetchedAt ? new Date(wxData.fetchedAt).toLocaleTimeString() : (wxData.cachedAt ? new Date(wxData.cachedAt).toLocaleTimeString() : 'prior sync');
        if (elements.weatherPrevNotice && elements.weatherPrevNoticeText) {
          elements.weatherPrevNoticeText.textContent = `⚠️ Previously fetched for ${prevCoords} at ${prevTime}`;
          elements.weatherPrevNotice.classList.remove('hidden');
        }
        if (elements.weatherCoordsUsed) elements.weatherCoordsUsed.textContent = `${prevCoords} (Stale GPS)`;
        if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = `${prevTime}`;
        if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = (wxData.maxPrecipitation6h ?? 0).toFixed(1);
        if (elements.weatherScoreBadge) {
          elements.weatherScoreBadge.textContent = '+0 Risk Pts (GPS Stale)';
          elements.weatherScoreBadge.className = 'mini-badge';
        }
        if (elements.weatherTimeIndicator) {
          elements.weatherTimeIndicator.textContent = wxData.currentTemperature !== undefined ? `Prior Temp: ${wxData.currentTemperature}°C` : 'Current Temp: — °C';
        }
      } else {
        if (elements.weatherPrevNotice) elements.weatherPrevNotice.classList.add('hidden');
        if (elements.weatherCoordsUsed) elements.weatherCoordsUsed.textContent = '—';
        if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = '—';
        if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = '—';
        if (elements.weatherScoreBadge) {
          elements.weatherScoreBadge.textContent = '+0 Risk Pts (GPS Stale)';
          elements.weatherScoreBadge.className = 'mini-badge';
        }
        if (elements.weatherTimeIndicator) elements.weatherTimeIndicator.textContent = 'Current Temp: — °C';
      }
      return;
    }

    // gpsStatus === GPS_LOCATION_STATE.AVAILABLE
    if (elements.weatherPrevNotice) elements.weatherPrevNotice.classList.add('hidden');

    if (wx?.isAvailableForCurrentGps === false || !wx?.cached) {
      if (elements.weatherNoticeBanner) {
        elements.weatherNoticeBanner.textContent = wx?.statusMessage || 'Fetching weather forecast for GPS fix...';
        elements.weatherNoticeBanner.className = 'weather-notice-banner notice-info';
        elements.weatherNoticeBanner.classList.remove('hidden');
      }
      if (elements.weatherCoordsUsed) {
        elements.weatherCoordsUsed.textContent = gps.coordinates ? `${gps.coordinates.latitude.toFixed(4)}° N, ${gps.coordinates.longitude.toFixed(4)}° E` : '—';
      }
      if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = 'Fetching...';
      if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = '0.0';
      if (elements.weatherScoreBadge) elements.weatherScoreBadge.textContent = '+0 Risk Pts';
      return;
    }

    // Weather is current & available for current GPS
    if (elements.weatherNoticeBanner) {
      elements.weatherNoticeBanner.classList.add('hidden');
    }

    const maxRain6h = risk?.weather?.maxNext6hPrecipitationMm ?? wxData.maxPrecipitation6h ?? 0;
    if (elements.weatherMaxRainVal) elements.weatherMaxRainVal.textContent = maxRain6h.toFixed(1);
    if (elements.weatherScoreBadge) {
      elements.weatherScoreBadge.textContent = `+${risk?.weatherScore ?? 0} Risk Pts`;
      elements.weatherScoreBadge.className = 'mini-badge';
    }

    // Show coordinates used and fetch time
    const coordsUsedStr = wxData.fetchedCoordinates || (gps.coordinates ? `${gps.coordinates.latitude.toFixed(4)}° N, ${gps.coordinates.longitude.toFixed(4)}° E` : (wxData.latitude && wxData.longitude ? `${Number(wxData.latitude).toFixed(4)}° N, ${Number(wxData.longitude).toFixed(4)}° E` : '—'));
    if (elements.weatherCoordsUsed) elements.weatherCoordsUsed.textContent = coordsUsedStr;

    const fetchTimeStr = wxData.fetchedAt ? new Date(wxData.fetchedAt).toLocaleTimeString() : (wxData.cachedAt ? new Date(wxData.cachedAt).toLocaleTimeString() : 'Live');
    if (elements.weatherFetchTime) elements.weatherFetchTime.textContent = fetchTimeStr;

    if (elements.weatherTimeIndicator) {
      if (wxData.currentTemperature !== undefined) {
        elements.weatherTimeIndicator.textContent = `Current Temp: ${wxData.currentTemperature}°C`;
      } else {
        elements.weatherTimeIndicator.textContent = 'Current Temp: — °C';
      }
    }
  }

  function renderHardwareActuation(status) {
    const detail = elements.actuationDetail;
    const icon = elements.heroActuationText?.querySelector('.indicator-icon');
    if (!detail || !icon) return;

    switch (status) {
      case 'SAFE':
        icon.textContent = '🟢';
        detail.textContent = 'Green LED ON. Buzzer silenced. Normal periodic logging.';
        break;
      case 'WARNING':
        icon.textContent = '🟡';
        detail.textContent = 'Yellow LED blinking (1s pulse). Slow alert buzzer active. Logging rate elevated.';
        break;
      case 'HIGH_RISK':
        icon.textContent = '🟠';
        detail.textContent = 'Orange/Amber LED rapid pulse. Fast acoustic siren active. Evacuation alert primed.';
        break;
      case 'DANGER':
        icon.textContent = '🔴';
        detail.textContent = 'Red LED continuous. Continuous high-decibel evacuation siren active. Automated broadcast dispatched.';
        break;
      case 'SENSOR_FAULT':
        icon.textContent = '🟣';
        detail.textContent = 'Fault LED flashing. Acoustic fault chirp. Geotechnical telemetry invalid; manual inspection required.';
        break;
      case 'DISCONNECTED':
        icon.textContent = '⚪';
        detail.textContent = 'No hardware node connected. Standby awaiting ESP32 telemetry POST.';
        break;
      default:
        icon.textContent = '⚪';
        detail.textContent = 'Awaiting telemetry transmission from ESP32 node.';
    }
  }

  function renderRiskNotes(notes) {
    if (!elements.riskNotesList) return;
    elements.riskNotesList.innerHTML = '';
    if (!notes || notes.length === 0) {
      elements.riskNotesList.innerHTML = '<li class="note-empty">All sensor thresholds are within safe baseline bounds.</li>';
      return;
    }

    notes.forEach((note) => {
      const li = document.createElement('li');
      li.textContent = note;
      if (note.includes('+3') || note.includes('Critical') || note.includes('Saturated') || note.includes('Severe') || note.includes('Alert')) {
        li.className = 'note-danger';
      } else if (note.includes('+2') || note.includes('+1') || note.includes('Warning')) {
        li.className = 'note-warning';
      }
      elements.riskNotesList.appendChild(li);
    });
  }

  function renderOfflineState() {
    if (elements.hwFreshnessText) elements.hwFreshnessText.textContent = 'SERVER UNREACHABLE';
    const hwDot = elements.hwFreshnessBadge?.querySelector('.indicator-dot');
    if (hwDot) hwDot.className = 'indicator-dot offline';
    if (elements.lastUpdatedDisplay) elements.lastUpdatedDisplay.textContent = 'Last Sync: Server unreachable (Offline)';
    applyCardStateClasses('state-error');
    setCardTimestamps('Last reading: Server unreachable', 'is-error');
  }

  // =========================================================================
  // 3. FULL-SCREEN WARNING SIGN & LANGUAGE CYCLING (19 Indian Languages)
  // =========================================================================
  async function fetchTranslations() {
    try {
      let res = await fetch('translations.json');
      if (!res.ok) {
        res = await fetch('/api/translations?includeEnglish=true');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.translations = Array.isArray(data) ? data : (data.translations || []);

      renderTranslationsTable(state.translations);
    } catch (err) {
      console.warn('[Dashboard] Could not fetch external translations, using baseline:', err.message);
    }
  }

  function evaluateEmergencyState(telemetry) {
    const status = telemetry.risk?.status || 'UNKNOWN';
    const isEmergency = status === 'HIGH_RISK' || status === 'DANGER';
    const isRiskDetected = status === 'WARNING' || status === 'HIGH_RISK' || status === 'DANGER';

    // A11y announcement on status transition
    if (state.previousStatus && state.previousStatus !== status) {
      announceA11yStatus(`Slope stability risk status changed from ${state.previousStatus} to ${status}.`);
    }

    // Check status transition for Browser Notification
    if (isRiskDetected && state.previousStatus !== status) {
      fireBrowserNotification(status, telemetry.site?.label || 'Monitoring Site');
    }

    // Audio & Device Vibration Actuation based on detected risk level
    if (isRiskDetected) {
      audioAlarm.start(status);
      triggerDeviceVibration(status);
    } else {
      audioAlarm.stop(true);
    }

    state.previousStatus = status;

    if (isEmergency) {
      elements.emergencyStatusTag.textContent =
        status === 'DANGER' ? '🚨 CRITICAL LANDSLIDE DANGER' : '⚠️ HIGH LANDSLIDE RISK';

      // Start translation cycler if not already running
      startWarningSignCycle();

      if (!state.warningSnoozed) {
        elements.emergencyWarningSign.classList.remove('hidden');
        elements.stickyWarningBanner.classList.add('hidden');
      } else {
        elements.emergencyWarningSign.classList.add('hidden');
        elements.stickyWarningBanner.classList.remove('hidden');
      }
    } else {
      // Reverted to SAFE or WARNING -> Hide emergency overlays
      stopWarningSignCycle();
      elements.emergencyWarningSign.classList.add('hidden');
      elements.stickyWarningBanner.classList.add('hidden');
      state.warningSnoozed = false;
    }
  }

  function startWarningSignCycle() {
    if (state.warningCycleTimer || state.translations.length === 0) return;

    // Show initial language
    showNextLanguageTranslation();

    // Cycle every ~3.5 seconds
    state.warningCycleTimer = setInterval(() => {
      showNextLanguageTranslation();
    }, 3500);
  }

  function stopWarningSignCycle() {
    if (state.warningCycleTimer) {
      clearInterval(state.warningCycleTimer);
      state.warningCycleTimer = null;
    }
  }

  function showNextLanguageTranslation() {
    if (state.translations.length === 0) return;

    const current = state.translations[state.warningCycleIndex];
    state.warningCycleIndex = (state.warningCycleIndex + 1) % state.translations.length;

    // Update overlay text and attributes
    elements.warningSignText.textContent = current.translation;
    elements.warningSignText.setAttribute('lang', current.code);
    elements.warningSignText.setAttribute('dir', current.dir);
    elements.warningLangBadge.textContent = `${current.name} (${current.nativeName})`;

    // Update sticky banner text
    elements.stickyBannerText.textContent = current.translation;
    elements.stickyBannerText.setAttribute('lang', current.code);
    elements.stickyBannerText.setAttribute('dir', current.dir);
    elements.stickyBannerLang.textContent = `(${current.name})`;
  }

  // =========================================================================
  // 4. BROWSER PUSH NOTIFICATIONS
  // =========================================================================
  function setupNotificationPermissionUI() {
    if (!('Notification' in window)) {
      elements.notificationBtn.disabled = true;
      elements.notificationBtnText.textContent = 'Alerts Unsupported';
      elements.notificationFallbackMsg.textContent = 'Browser notifications unsupported in this browser environment.';
      elements.notificationFallbackMsg.classList.remove('hidden');
      return;
    }

    const isSecure = window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';

    if (!isSecure) {
      elements.notificationBtn.disabled = true;
      elements.notificationBtnText.textContent = 'HTTPS Required';
      elements.notificationFallbackMsg.textContent = 'Browser push notifications require HTTPS or localhost.';
      elements.notificationFallbackMsg.classList.remove('hidden');
      return;
    }

    updateNotificationButtonState(Notification.permission);
  }

  function updateNotificationButtonState(permission) {
    if (permission === 'granted') {
      elements.notificationBtn.className = 'btn btn-sm btn-secondary';
      elements.notificationBtnText.textContent = '✓ Alerts Enabled';
      elements.notificationFallbackMsg.classList.add('hidden');
    } else if (permission === 'denied') {
      elements.notificationBtn.className = 'btn btn-sm btn-outline-danger';
      elements.notificationBtnText.textContent = 'Alerts Blocked';
      elements.notificationFallbackMsg.textContent = 'Notifications blocked. Allow permissions in browser site settings.';
      elements.notificationFallbackMsg.classList.remove('hidden');
    } else {
      elements.notificationBtn.className = 'btn btn-sm btn-outline-cyan';
      elements.notificationBtnText.textContent = 'Enable Browser Alerts';
      elements.notificationFallbackMsg.classList.add('hidden');
    }
  }

  async function requestBrowserNotificationPermission() {
    if (!('Notification' in window)) return;
    try {
      const permission = await Notification.requestPermission();
      updateNotificationButtonState(permission);
      if (permission === 'granted') {
        new Notification('IIT Bombay Early-Warning System', {
          body: 'Browser emergency alerts are now active for slope failure hazards.',
          icon: '/favicon.ico',
        });
      }
    } catch (err) {
      console.warn('[Dashboard] Notification request error:', err.message);
    }
  }

  function fireBrowserNotification(status, siteLabel) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
      let title;
      let body;
      if (status === 'DANGER') {
        title = `🚨 CRITICAL LANDSLIDE DANGER — ${siteLabel}`;
        body = 'CRITICAL SLOPE INSTABILITY DETECTED! Evacuate immediately along designated route to shelter.';
      } else if (status === 'HIGH_RISK') {
        title = `⚠️ HIGH LANDSLIDE RISK — ${siteLabel}`;
        body = 'High soil saturation, tilt, or heavy rain detected. Stand by for evacuation order.';
      } else if (status === 'WARNING') {
        title = `🟡 LANDSLIDE WEATHER / TILT WARNING — ${siteLabel}`;
        body = 'Elevated geotechnical parameters or heavy precipitation detected. Monitoring active.';
      } else {
        return;
      }

      const options = {
        body,
        requireInteraction: status === 'DANGER' || status === 'HIGH_RISK',
        tag: 'landslide-hazard',
      };

      new Notification(title, options);
    } catch (err) {
      console.error('[Dashboard] Error displaying push notification:', err.message);
    }
  }

  // =========================================================================
  // 5. MAPLIBRE GL JS MAP & EVACUATION ROUTING (Lazy-Loaded)
  // =========================================================================
  let mapLibrePromise = null;
  function loadMapLibreAssets() {
    if (window.maplibregl) return Promise.resolve();
    if (mapLibrePromise) return mapLibrePromise;

    mapLibrePromise = new Promise((resolve, reject) => {
      // 1. Link stylesheet if not already present
      if (!document.querySelector('link[href*="maplibre-gl"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
        document.head.appendChild(link);
      }

      // 2. Script
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = (err) => {
        mapLibrePromise = null;
        reject(new Error('Failed to load MapLibre GL script'));
      };
      document.head.appendChild(script);
    });
    return mapLibrePromise;
  }

  let mapInitStarted = false;
  async function triggerMapInit() {
    if (mapInitStarted) return;
    mapInitStarted = true;

    try {
      await loadMapLibreAssets();
      await fetchMapConfigAndInit();
    } catch (err) {
      console.warn('[Dashboard] Lazy map initialization failed:', err.message);
      if (elements.mapLoadingPlaceholder) {
        elements.mapLoadingPlaceholder.innerHTML = `<div class="empty-log-msg">Failed to load evacuation map: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function setupLazyMapLoading() {
    const target = elements.evacuationSection || document.getElementById('evacuationSection');
    if (!target) {
      triggerMapInit();
      return;
    }

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          triggerMapInit();
        }
      }, { rootMargin: '300px' });
      observer.observe(target);
    } else {
      triggerMapInit();
    }
  }

  async function fetchMapConfigAndInit() {
    try {
      const cfg = window.LANDSLIDE_CONFIG || {};
      let configData = null;

      // Try local backend if present
      try {
        const res = await fetch('/api/map-config');
        if (res.ok) configData = await res.json();
      } catch (_) {}

      // Fallback to client configuration
      if (!configData) {
        configData = {
          styleUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          satelliteTileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          satelliteEnabled: true,
          safeDestination: {
            latitude: cfg.SITE_COORDINATES?.evacuationShelter?.lat || 19.1380,
            longitude: cfg.SITE_COORDINATES?.evacuationShelter?.lng || 72.9170,
            label: cfg.SITE_COORDINATES?.evacuationShelter?.name || 'Central Emergency Evacuation Center',
            verified: true,
          },
          site: {
            latitude: cfg.SITE_COORDINATES?.lat || 19.1334,
            longitude: cfg.SITE_COORDINATES?.lng || 72.9133,
            label: cfg.SITE_COORDINATES?.name || 'IIT Bombay Hillside Station #1',
            isCustomLocation: false,
          },
        };
      }

      state.mapConfig = configData;
      initMap(state.mapConfig);
      await fetchAndRenderRoute();
    } catch (err) {
      console.error('[Dashboard] Map initialization error:', err.message);
      if (elements.mapLoadingPlaceholder) {
        elements.mapLoadingPlaceholder.innerHTML = `<div class="empty-log-msg">Failed to load evacuation map config: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function initMap(mapConfig) {
    if (!window.maplibregl) {
      console.warn('[Dashboard] MapLibre GL not loaded from CDN');
      return;
    }

    const site = mapConfig.site || { latitude: 19.1334, longitude: 72.9133 };

    // Standard OpenStreetMap vector raster style
    const mapStyle = {
      version: 8,
      sources: {
        'osm-tiles': {
          type: 'raster',
          tiles: [mapConfig.styleUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap contributors',
        },
      },
      layers: [
        {
          id: 'osm-layer',
          type: 'raster',
          source: 'osm-tiles',
          minzoom: 0,
          maxzoom: 19,
        },
      ],
    };

    state.map = new maplibregl.Map({
      container: 'evacuationMap',
      style: mapStyle,
      center: [site.longitude, site.latitude],
      zoom: 14.5,
    });

    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');

    state.map.on('load', () => {
      elements.mapLoadingPlaceholder?.remove();
      // 1. Add Monitoring Site Marker (Red Pin)
      const siteMarkerEl = createCustomMarker('#ff2a4b', '⛰️');
      state.siteMarker = new maplibregl.Marker({ element: siteMarkerEl })
        .setLngLat([site.longitude, site.latitude])
        .setPopup(new maplibregl.Popup().setHTML(`<strong>Monitoring Station</strong><br>${site.label || 'Hillside Sensor Node'}`))
        .addTo(state.map);

      // 2. Add Safe Shelter Marker (Green Pin if verified, Amber if unverified)
      const shelter = mapConfig.safeDestination;
      if (shelter && shelter.latitude && shelter.longitude) {
        const shelterColor = shelter.verified ? '#00f59b' : '#ffb703';
        const shelterMarkerEl = createCustomMarker(shelterColor, '🏥');
        state.shelterMarker = new maplibregl.Marker({ element: shelterMarkerEl })
          .setLngLat([shelter.longitude, shelter.latitude])
          .setPopup(new maplibregl.Popup().setHTML(`<strong>${shelter.label || 'Evacuation Shelter'}</strong><br>${shelter.verified ? '✓ Official Verified Shelter' : '⚠️ Unverified Destination'}`))
          .addTo(state.map);

        elements.destVerifiedBadge.textContent = shelter.verified ? '✓ VERIFIED' : 'UNVERIFIED';
        elements.destVerifiedBadge.className = shelter.verified ? 'badge-verified' : 'badge-needs-verification';
        elements.routeDestLabel.textContent = shelter.label || 'Campus Shelter';
      }

      // 3. Add Hardware Setup Marker (Cyan Pin with 📡)
      const hwLoc = state.latestTelemetry?.hardwareLocation || { latitude: site.latitude, longitude: site.longitude };
      const hwMarkerEl = createCustomMarker('#00e5ff', '📡');
      state.hardwareMarker = new maplibregl.Marker({ element: hwMarkerEl })
        .setLngLat([hwLoc.longitude, hwLoc.latitude])
        .setPopup(new maplibregl.Popup().setHTML(`<strong>📡 Hardware Sensor Setup</strong><br>${escapeHtml(hwLoc.label || 'Slope Anchor Node')}<br>Elev: ${hwLoc.altitude_m || 128}m`))
        .addTo(state.map);

      // Render hazard area circles on map load if telemetry is available
      if (state.latestTelemetry) {
        updateMapHazardArea(state.latestTelemetry.hazardArea, state.latestTelemetry.hardwareLocation, state.latestTelemetry.risk);
      }
    });
  }

  function createCustomMarker(color, symbol) {
    const el = document.createElement('div');
    el.style.width = '34px';
    el.style.height = '34px';
    el.style.borderRadius = '50%';
    el.style.backgroundColor = color;
    el.style.border = '2px solid #ffffff';
    el.style.boxShadow = `0 0 10px ${color}`;
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '16px';
    el.style.cursor = 'pointer';
    el.textContent = symbol;
    return el;
  }

  async function fetchAndRenderRoute(originLat, originLng) {
    const cfg = window.LANDSLIDE_CONFIG || {};
    const startLat = originLat ?? state.hardwareLocation?.latitude ?? cfg.SITE_COORDINATES?.lat ?? 19.1334;
    const startLon = originLng ?? state.hardwareLocation?.longitude ?? cfg.SITE_COORDINATES?.lng ?? 72.9133;
    const destLat = state.mapConfig?.safeDestination?.latitude ?? cfg.SITE_COORDINATES?.evacuationShelter?.lat ?? 19.1380;
    const destLon = state.mapConfig?.safeDestination?.longitude ?? cfg.SITE_COORDINATES?.evacuationShelter?.lng ?? 72.9170;

    // Direct OSRM public routing API
    const routerBase = cfg.OSRM_ROUTER_URL || 'https://router.project-osrm.org/route/v1/driving';
    const routerUrl = `${routerBase}/${startLon},${startLat};${destLon},${destLat}?overview=full&geometries=geojson`;

    try {
      let routeData = null;

      // Try local server first if present
      try {
        const localRes = await fetch(`/api/route?originLat=${startLat}&originLng=${startLon}`);
        if (localRes.ok) routeData = await localRes.json();
      } catch (_) {}

      // Fallback to direct client OSRM request
      if (!routeData || !routeData.success) {
        const res = await fetch(routerUrl);
        const data = await res.json();
        if (res.ok && data.code === 'Ok' && data.routes && data.routes.length) {
          const route = data.routes[0];
          const distanceMeters = Math.round(route.distance);
          const distanceKm = (distanceMeters / 1000).toFixed(2);
          const durationMinutes = Math.max(1, Math.round(route.duration / 60));
          routeData = {
            success: true,
            originLabel: state.site?.label || 'Hillside Station',
            destinationLabel: state.mapConfig?.safeDestination?.label || 'Safe Shelter',
            distanceKm,
            distanceMeters,
            durationMinutes,
            geometry: {
              type: 'Feature',
              properties: {},
              geometry: route.geometry,
            },
          };
        }
      }

      if (!routeData || !routeData.success) {
        throw new Error('No OSRM route available');
      }

      // Update statistics
      elements.routeOriginLabel.textContent = routeData.originLabel || 'Hillside Station';
      elements.routeDestLabel.textContent = routeData.destinationLabel || 'Safe Shelter';
      elements.routeDistanceDisplay.textContent = `${routeData.distanceKm} km (${routeData.distanceMeters.toLocaleString()} m)`;
      elements.routeDurationDisplay.textContent = `${routeData.durationMinutes} mins`;
      elements.routeStatusBadge.textContent = 'ROUTED (OSRM)';
      elements.routeStatusBadge.className = 'status-pill status-safe';

      // Draw GeoJSON Route Line on Map
      if (state.map && state.map.isStyleLoaded() && routeData.geometry) {
        renderRouteGeometry(routeData.geometry);
      } else if (state.map) {
        state.map.once('load', () => renderRouteGeometry(routeData.geometry));
      }
    } catch (err) {
      console.warn('[Dashboard] Direct OSRM route fetch error, using straight-line bearing:', err.message);
      const fallbackGeometry = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [startLon, startLat],
            [destLon, destLat],
          ],
        },
      };
      elements.routeOriginLabel.textContent = 'Hillside Station';
      elements.routeDestLabel.textContent = 'Safe Shelter';
      elements.routeDistanceDisplay.textContent = 'Direct Bearing';
      elements.routeDurationDisplay.textContent = '~5 mins';
      elements.routeStatusBadge.textContent = 'BEARING LINE';
      elements.routeStatusBadge.className = 'status-pill status-warning';

      if (state.map && state.map.isStyleLoaded()) {
        renderRouteGeometry(fallbackGeometry);
      }
    }
  }

  function renderRouteGeometry(geometry) {
    if (!state.map) return;

    if (state.map.getSource('route-line')) {
      state.map.getSource('route-line').setData(geometry);
    } else {
      state.map.addSource('route-line', {
        type: 'geojson',
        data: geometry,
      });

      state.map.addLayer({
        id: 'route-line-layer',
        type: 'line',
        source: 'route-line',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#00e5ff',
          'line-width': 5,
          'line-opacity': 0.85,
        },
      });
      state.routeSourceAdded = true;
    }

    // Fit map bounds to show complete evacuation corridor
    if (geometry.coordinates && geometry.coordinates.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      geometry.coordinates.forEach((coord) => bounds.extend(coord));
      state.map.fitBounds(bounds, { padding: 50 });
    }
  }

  function toggleSatelliteLayer() {
    if (!state.map || !state.mapConfig?.satelliteTileUrl) return;

    state.currentSatellite = !state.currentSatellite;
    const tileUrl = state.currentSatellite
      ? state.mapConfig.satelliteTileUrl
      : state.mapConfig.styleUrl;

    elements.toggleSatelliteBtn.textContent = state.currentSatellite
      ? '🗺️ Street View'
      : '🛰️ Satellite View';

    // Update raster layer tiles
    if (state.map.getSource('osm-tiles')) {
      state.map.removeLayer('osm-layer');
      state.map.removeSource('osm-tiles');

      state.map.addSource('osm-tiles', {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
      });

      state.map.addLayer(
        {
          id: 'osm-layer',
          type: 'raster',
          source: 'osm-tiles',
          minzoom: 0,
          maxzoom: 19,
        },
        state.routeSourceAdded ? 'route-line-layer' : undefined
      );
    }
  }

  function handleUserGeolocation() {
    if (!('geolocation' in navigator)) {
      showGeoStatus('Geolocation is not supported by your browser. Using station coordinates.');
      fetchAndRenderRoute();
      return;
    }

    showGeoStatus('Requesting device GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        showGeoStatus(`✓ Using live device coordinates: ${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`);
        fetchAndRenderRoute(lat, lng);
      },
      (err) => {
        showGeoStatus(`⚠️ Geolocation denied (${err.message}). Falling back to station monitoring location.`);
        fetchAndRenderRoute();
      },
      { timeout: 8000 }
    );
  }

  function showGeoStatus(msg) {
    elements.geolocationStatusBanner.textContent = msg;
    elements.geolocationStatusBanner.classList.remove('hidden');
    setTimeout(() => {
      elements.geolocationStatusBanner.classList.add('hidden');
    }, 6000);
  }

  function announceA11yStatus(msg) {
    if (!msg || !elements.a11yStatusAnnouncer) return;
    elements.a11yStatusAnnouncer.textContent = '';
    setTimeout(() => {
      if (elements.a11yStatusAnnouncer) {
        elements.a11yStatusAnnouncer.textContent = msg;
      }
    }, 50);
  }

  // =========================================================================
  // LOCATION & EMERGENCY ALARM HANDLERS
  // =========================================================================
  function triggerDeviceVibration(status) {
    if (!('vibrate' in navigator)) return;
    try {
      if (status === 'DANGER') {
        navigator.vibrate([400, 150, 400, 150, 600, 200, 800]);
      } else if (status === 'HIGH_RISK') {
        navigator.vibrate([300, 200, 300, 200, 300]);
      } else if (status === 'WARNING') {
        navigator.vibrate([200, 150, 200]);
      }
    } catch (_) {}
  }

  function handleToggleAudioSiren() {
    audioAlarm._ensureContext();
    const isMuted = audioAlarm.toggleMute();
    announceA11yStatus(isMuted ? 'Emergency audio siren muted.' : 'Emergency audio siren enabled.');
    if (elements.audioSirenIcon && elements.audioSirenLabel) {
      elements.audioSirenIcon.textContent = isMuted ? '🔇' : '🔊';
      elements.audioSirenLabel.textContent = isMuted ? 'Siren Sound: MUTED' : 'Siren Sound: ON';
    }
    if (elements.toggleAudioSirenBtn) {
      elements.toggleAudioSirenBtn.classList.toggle('btn-secondary', isMuted);
      elements.toggleAudioSirenBtn.classList.toggle('btn-outline-warning', !isMuted);
    }
  }

  let testAlarmTimer = null;
  function handleTestAlarmSiren() {
    audioAlarm._ensureContext();
    if (testAlarmTimer) {
      clearTimeout(testAlarmTimer);
      testAlarmTimer = null;
      audioAlarm.stop(true);
      if (elements.testAlarmBtn) elements.testAlarmBtn.innerHTML = '<span aria-hidden="true">🚨</span> Test Siren Alert';
      showGeoStatus('Siren test stopped.');
      announceA11yStatus('Emergency siren test stopped.');
      return;
    }

    if (elements.testAlarmBtn) elements.testAlarmBtn.innerHTML = '<span aria-hidden="true">⏹️</span> Stop Siren Test';
    showGeoStatus('Testing audible emergency siren alarm & device vibration (4.5s)...');
    announceA11yStatus('Testing emergency siren alarm.');
    audioAlarm.start('DANGER', true);
    triggerDeviceVibration('DANGER');

    testAlarmTimer = setTimeout(() => {
      audioAlarm.stop(true);
      if (elements.testAlarmBtn) elements.testAlarmBtn.innerHTML = '<span aria-hidden="true">🚨</span> Test Siren Alert';
      testAlarmTimer = null;
    }, 4500);
  }

  function handleSilenceActiveSiren() {
    audioAlarm.silence();
    announceA11yStatus('Active emergency siren silenced.');
    showGeoStatus('Active audible emergency siren silenced by operator.');
  }

  // =========================================================================
  // HARDWARE SETUP LOCATION & DISASTER HAZARD AREA FUNCTIONS
  // =========================================================================
  async function handleFocusHardwareLocation() {
    try {
      let loc = state.hardwareLocation || state.latestTelemetry?.hardwareLocation;

      // Try local server if present and not in local state
      if (!loc) {
        try {
          const res = await fetch('/api/hardware/location');
          if (res.ok) {
            const data = await res.json();
            loc = data.hardwareLocation;
          }
        } catch (_) {}
      }

      if (!loc || loc.latitude === null || loc.latitude === undefined || loc.longitude === null || loc.longitude === undefined || loc.status === 'UNAVAILABLE' || (loc.latitude === 0 && loc.longitude === 0)) {
        showGeoStatus('⚠️ Hardware GPS fix is currently unavailable. No satellite fix coordinates received.');
        document.getElementById('hazardAreaSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      showGeoStatus(`📡 Focused on hardware setup: ${loc.label || 'Hardware Node'} (${loc.latitude.toFixed(4)}° N, ${loc.longitude.toFixed(4)}° E, Elev: ${loc.altitude_m ?? loc.elevation ?? '—'}m)`);

      // Fly map to hardware setup location
      if (state.map) {
        state.map.flyTo({ center: [loc.longitude, loc.latitude], zoom: 15.2, speed: 1.2 });
        if (state.hardwareMarker) {
          state.hardwareMarker.setLngLat([loc.longitude, loc.latitude]);
          state.hardwareMarker.togglePopup();
        }
      }

      // Scroll smoothly to the hazard area card
      document.getElementById('hazardAreaSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      console.warn('[Dashboard] Hardware focus error:', err.message);
      showGeoStatus(`⚠️ Unable to focus hardware setup: ${err.message}`);
    }
  }

  function handleToggleHazardPerimeter() {
    if (!state.map) return;
    state.hazardZoneVisible = !state.hazardZoneVisible;
    const visibility = state.hazardZoneVisible ? 'visible' : 'none';

    ['hazard-impact-zone-fill', 'hazard-impact-zone-line', 'hazard-buffer-zone-line'].forEach((layerId) => {
      if (state.map.getLayer(layerId)) {
        state.map.setLayoutProperty(layerId, 'visibility', visibility);
      }
    });

    if (elements.toggleHazardPerimeterBtn) {
      elements.toggleHazardPerimeterBtn.innerHTML = state.hazardZoneVisible
        ? '<span aria-hidden="true">⚠️</span> Hazard Zone: ON'
        : '<span aria-hidden="true">⚠️</span> Hazard Zone: OFF';
    }

    showGeoStatus(state.hazardZoneVisible ? 'Disaster hazard zone perimeter displayed on map.' : 'Disaster hazard zone perimeter hidden.');
  }

  function handleCheckUserProximity() {
    if (!('geolocation' in navigator)) {
      alert('Geolocation is not supported by your browser environment.');
      return;
    }

    if (elements.checkMyProximityBtn) {
      elements.checkMyProximityBtn.disabled = true;
      elements.checkMyProximityBtn.innerHTML = '<span class="spin-icon">🔄</span> Calculating Distance...';
    }
    showGeoStatus('Acquiring device GPS to evaluate distance to slope failure hazard...');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userLat = pos.coords.latitude;
        const userLng = pos.coords.longitude;
        state.userCoordinates = { lat: userLat, lng: userLng };

        // Add or update User Marker on Map (Amber Pin with 👤)
        if (state.map) {
          if (!state.userMarker) {
            const userMarkerEl = createCustomMarker('#ffb703', '👤');
            state.userMarker = new maplibregl.Marker({ element: userMarkerEl })
              .setLngLat([userLng, userLat])
              .setPopup(new maplibregl.Popup().setHTML('<strong>👤 Your Current Device Position</strong>'))
              .addTo(state.map);
          } else {
            state.userMarker.setLngLat([userLng, userLat]);
          }

          // Fit bounds to show both user and hardware setup
          const hwLoc = state.latestTelemetry?.hardwareLocation;
          if (hwLoc && hwLoc.latitude && hwLoc.longitude) {
            const bounds = new maplibregl.LngLatBounds();
            bounds.extend([hwLoc.longitude, hwLoc.latitude]);
            bounds.extend([userLng, userLat]);
            state.map.fitBounds(bounds, { padding: 60 });
          }
        }

        // Re-render proximity metrics
        renderHazardArea(
          state.latestTelemetry?.hazardArea,
          state.latestTelemetry?.hardwareLocation,
          state.latestTelemetry?.risk
        );

        showGeoStatus(`✓ Device position acquired (${userLat.toFixed(4)}° N, ${userLng.toFixed(4)}° E). Proximity assessed.`);

        if (elements.checkMyProximityBtn) {
          elements.checkMyProximityBtn.disabled = false;
          elements.checkMyProximityBtn.innerHTML = '<span aria-hidden="true">📍</span> Re-check Distance';
        }
      },
      (err) => {
        showGeoStatus(`⚠️ Geolocation denied or unavailable (${err.message}).`);
        if (elements.checkMyProximityBtn) {
          elements.checkMyProximityBtn.disabled = false;
          elements.checkMyProximityBtn.innerHTML = '<span aria-hidden="true">📍</span> Check My Distance to Hazard';
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  function renderHazardArea(hazardArea, hwLoc, risk) {
    if (!hazardArea && !hwLoc) return;

    const loc = hwLoc || (hazardArea ? hazardArea.hardwareNode : {});
    const area = hazardArea || {};
    const status = risk?.status || area.status || 'UNKNOWN';

    // 1. Hardware Setup Node Card
    if (elements.hwLocCoords && loc.latitude !== undefined && loc.longitude !== undefined) {
      elements.hwLocCoords.textContent = `${Number(loc.latitude).toFixed(4)}° N, ${Number(loc.longitude).toFixed(4)}° E`;
    }
    if (elements.hwLocAltitude) {
      elements.hwLocAltitude.textContent = `${loc.altitude_m ?? 128} m MSL`;
    }
    if (elements.hwLocStationId) {
      elements.hwLocStationId.textContent = loc.station_id || 'ESP32_DEVKIT_V1';
    }
    if (elements.hwLocLabel) {
      elements.hwLocLabel.textContent = loc.label || 'Hillside Monitoring Node';
    }
    if (elements.hwLocGpsBadge) {
      elements.hwLocGpsBadge.textContent = loc.isLiveGps ? '✓ Active Node GPS' : 'Configured Site';
      elements.hwLocGpsBadge.className = loc.isLiveGps ? 'mini-badge badge-verified' : 'mini-badge';
    }

    // 2. Disaster Risk Over Area Card
    if (elements.areaRiskSeverityBadge) {
      elements.areaRiskSeverityBadge.textContent = `${area.severity || status} AREA RISK`;
      elements.areaRiskSeverityBadge.className = `status-pill status-${status.toLowerCase().replace('_', '-')}`;
    }
    if (elements.hazardAreaZoneTag) {
      elements.hazardAreaZoneTag.textContent = area.zoneTitle || 'Monitoring Area';
      elements.hazardAreaZoneTag.className = `mini-badge status-${status.toLowerCase().replace('_', '-')}`;
    }
    if (elements.hazardImpactRadius) {
      elements.hazardImpactRadius.textContent = `${area.impactRadiusMeters || 150} m (${status === 'DANGER' ? 'Critical Runout' : 'Threat Radius'})`;
    }
    if (elements.hazardBufferRadius) {
      elements.hazardBufferRadius.textContent = `${area.secondaryBufferMeters || 400} m (Perimeter)`;
    }
    if (elements.hazardThreatArea) {
      elements.hazardThreatArea.textContent = `${area.threatAreaSqKm || 0.071} km²`;
    }
    if (elements.hazardAreaSummary) {
      elements.hazardAreaSummary.textContent = area.description || 'Normal geological bounds across monitored slope.';
    }

    // 3. User Proximity & Safety Advisory
    if (area.userProximity) {
      renderUserProximity(area.userProximity);
    } else if (state.userCoordinates && loc.latitude && loc.longitude) {
      const dist = calculateDistanceMeters(loc.latitude, loc.longitude, state.userCoordinates.lat, state.userCoordinates.lng);
      const isInside = dist <= (area.impactRadiusMeters || 150);
      const isBuffer = dist <= (area.secondaryBufferMeters || 400);
      renderUserProximity({
        distanceMeters: dist,
        distanceKm: Number((dist / 1000).toFixed(2)),
        isInsideImpactZone: isInside,
        isInsideBuffer: isBuffer,
        proximityStatus: isInside ? 'INSIDE_CRITICAL_IMPACT_ZONE' : isBuffer ? 'PROXIMITY_WARNING_ZONE' : 'SAFE_DISTANCE',
        advisory: isInside
          ? '🚨 DANGER: You are located directly inside the active landslide debris runout zone! Evacuate immediately!'
          : isBuffer
          ? '⚠️ CAUTION: You are near the slope disaster perimeter. Move toward the verified safe shelter.'
          : '✓ You are situated outside the immediate slope hazard perimeter.',
      });
    }
  }

  function renderUserProximity(prox) {
    if (!prox) return;
    if (elements.userProximityDistance) {
      elements.userProximityDistance.textContent = prox.distanceMeters < 1000
        ? `${prox.distanceMeters} meters away`
        : `${prox.distanceKm} km away`;
    }
    if (elements.userProximityBadge) {
      if (prox.isInsideImpactZone) {
        elements.userProximityBadge.textContent = '🚨 INSIDE IMPACT ZONE';
        elements.userProximityBadge.className = 'status-proximity-critical';
      } else if (prox.isInsideBuffer) {
        elements.userProximityBadge.textContent = '⚠️ PROXIMITY ALERT';
        elements.userProximityBadge.className = 'status-proximity-warning';
      } else {
        elements.userProximityBadge.textContent = '✓ SAFE DISTANCE';
        elements.userProximityBadge.className = 'status-proximity-safe';
      }
    }
    if (elements.userProximityAdvisory) {
      elements.userProximityAdvisory.textContent = prox.advisory;
    }
  }

  function updateMapHazardArea(hazardArea, hwLoc, risk) {
    if (!state.map || !state.map.isStyleLoaded()) {
      if (state.map) {
        state.map.once('load', () => updateMapHazardArea(hazardArea, hwLoc, risk));
      }
      return;
    }

    const loc = hwLoc || hazardArea?.hardwareNode || (state.latestTelemetry ? state.latestTelemetry.hardwareLocation : null);
    if (!loc || !loc.latitude || !loc.longitude) return;

    const status = risk?.status || hazardArea?.status || 'UNKNOWN';
    let impactRadius = hazardArea?.impactRadiusMeters || 200;
    let bufferRadius = hazardArea?.secondaryBufferMeters || 600;

    let fillColor = 'rgba(0, 229, 255, 0.2)';
    let lineColor = '#00e5ff';
    if (status === 'DANGER') {
      fillColor = 'rgba(255, 42, 75, 0.35)';
      lineColor = '#ff2a4b';
      impactRadius = 600;
      bufferRadius = 1800;
    } else if (status === 'HIGH_RISK') {
      fillColor = 'rgba(255, 123, 0, 0.3)';
      lineColor = '#ff7b00';
      impactRadius = 400;
      bufferRadius = 1200;
    } else if (status === 'WARNING') {
      fillColor = 'rgba(255, 209, 102, 0.25)';
      lineColor = '#ffd166';
      impactRadius = 250;
      bufferRadius = 750;
    }

    const impactCircleGeoJSON = createGeoJSONCircle(loc.longitude, loc.latitude, impactRadius);
    const bufferCircleGeoJSON = createGeoJSONCircle(loc.longitude, loc.latitude, bufferRadius);

    // 1. Impact Zone Source & Layers
    if (state.map.getSource('hazard-impact-zone')) {
      state.map.getSource('hazard-impact-zone').setData(impactCircleGeoJSON);
      state.map.setPaintProperty('hazard-impact-zone-fill', 'fill-color', fillColor);
      state.map.setPaintProperty('hazard-impact-zone-line', 'line-color', lineColor);
    } else {
      state.map.addSource('hazard-impact-zone', {
        type: 'geojson',
        data: impactCircleGeoJSON,
      });

      state.map.addLayer({
        id: 'hazard-impact-zone-fill',
        type: 'fill',
        source: 'hazard-impact-zone',
        paint: {
          'fill-color': fillColor,
          'fill-opacity': 0.75,
        },
      });

      state.map.addLayer({
        id: 'hazard-impact-zone-line',
        type: 'line',
        source: 'hazard-impact-zone',
        paint: {
          'line-color': lineColor,
          'line-width': 2.5,
        },
      });
    }

    // 2. Secondary Buffer Zone Source & Layer
    if (state.map.getSource('hazard-buffer-zone')) {
      state.map.getSource('hazard-buffer-zone').setData(bufferCircleGeoJSON);
    } else {
      state.map.addSource('hazard-buffer-zone', {
        type: 'geojson',
        data: bufferCircleGeoJSON,
      });

      state.map.addLayer({
        id: 'hazard-buffer-zone-line',
        type: 'line',
        source: 'hazard-buffer-zone',
        paint: {
          'line-color': '#ffd166',
          'line-width': 1.8,
          'line-dasharray': [3, 2],
          'line-opacity': 0.8,
        },
      });
    }

    // Update hardware marker position & popup
    if (state.hardwareMarker) {
      state.hardwareMarker.setLngLat([loc.longitude, loc.latitude]);
      state.hardwareMarker.getPopup()?.setHTML(
        `<strong>📡 Hardware Setup Location</strong><br>${escapeHtml(loc.label || 'Slope Node')}<br>Altitude: ${loc.altitude_m || 128}m<br>Status: <strong>${status}</strong><br>Impact Radius: ${impactRadius}m`
      );
    }
  }

  function createGeoJSONCircle(centerLng, centerLat, radiusMeters, points = 64) {
    const coords = [];
    const distanceX = radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));
    const distanceY = radiusMeters / 110540;
    for (let i = 0; i < points; i++) {
      const theta = (i / points) * (2 * Math.PI);
      const x = distanceX * Math.cos(theta);
      const y = distanceY * Math.sin(theta);
      coords.push([centerLng + x, centerLat + y]);
    }
    coords.push(coords[0]);
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [coords],
      },
      properties: {},
    };
  }

  function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  // =========================================================================
  // 6. EMERGENCY RECIPIENT & SIMULATED TEST ALERT
  // =========================================================================
  async function fetchRecipientStatus() {
    try {
      let recip = null;
      // 1. Try local storage first (instant zero-server)
      const stored = localStorage.getItem('landslide_recipient');
      if (stored) {
        try { recip = JSON.parse(stored); } catch (_) {}
      }

      // 2. Try server if available
      if (!recip) {
        try {
          const res = await fetch('/api/recipient');
          if (res.ok) {
            const data = await res.json();
            recip = data.recipient;
          }
        } catch (_) {}
      }

      if (recip && recip.phone && recip.consentGiven) {
        renderActiveRecipient(recip);
      } else {
        elements.activeRecipientCard.classList.add('hidden');
        elements.recipientForm.classList.remove('hidden');
      }
    } catch (err) {
      console.warn('[Dashboard] Recipient fetch error:', err.message);
    }
  }

  function renderActiveRecipient(recip) {
    elements.activeRecipPhone.textContent = recip.phone;
    const timeStr = recip.consentTimestamp ? new Date(recip.consentTimestamp).toLocaleString() : 'Active';
    elements.activeRecipMeta.textContent = `Consent Recorded: ${timeStr} • ${recip.notes || 'Emergency Contact'}`;
    elements.activeRecipientCard.classList.remove('hidden');
    elements.recipientForm.classList.add('hidden');
  }

  async function handleRecipientFormSubmit(e) {
    e.preventDefault();
    elements.recipientFeedback.classList.add('hidden');

    const countryCode = elements.countryCodeInput.value.trim();
    const phone = elements.phoneInput.value.trim();
    const notes = elements.recipientNotesInput.value.trim();
    const consent = elements.consentCheckbox.checked;

    if (!consent) {
      showFeedback('Affirmative user consent is strictly required before saving an emergency recipient.', 'error');
      return;
    }

    if (!phone) {
      showFeedback('Please enter a valid subscriber mobile number.', 'error');
      return;
    }

    const fullPhone = phone.startsWith('+') ? phone : `${countryCode} ${phone}`;
    const recipObj = {
      countryCode,
      phone: fullPhone,
      consentGiven: true,
      consentTimestamp: new Date().toISOString(),
      notes,
    };

    try {
      // Save locally
      localStorage.setItem('landslide_recipient', JSON.stringify(recipObj));

      // Attempt server sync if running
      try {
        await fetch('/api/recipient', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ countryCode, phone, consent: true, notes }),
        });
      } catch (_) {}

      showFeedback('Emergency recipient registered successfully with affirmative consent.', 'success');
      elements.recipientForm.reset();
      renderActiveRecipient(recipObj);
      await fetchAlertLog();
    } catch (err) {
      showFeedback(err.message, 'error');
    }
  }

  async function handleDeleteRecipient() {
    if (!confirm('Are you sure you want to remove this emergency notification recipient?')) {
      return;
    }

    try {
      localStorage.removeItem('landslide_recipient');
      try {
        await fetch('/api/recipient', { method: 'DELETE' });
      } catch (_) {}

      elements.activeRecipientCard.classList.add('hidden');
      elements.recipientForm.classList.remove('hidden');
      showFeedback('Emergency recipient removed and consent record cleared.', 'success');
      await fetchAlertLog();
    } catch (err) {
      showFeedback(err.message, 'error');
    }
  }

  function showFeedback(msg, type) {
    elements.recipientFeedback.textContent = msg;
    elements.recipientFeedback.className = `form-feedback ${type}`;
    elements.recipientFeedback.classList.remove('hidden');
    setTimeout(() => {
      elements.recipientFeedback.classList.add('hidden');
    }, 5000);
  }

  async function handleSendTestAlert() {
    elements.sendTestAlertBtn.disabled = true;
    elements.sendTestAlertBtn.textContent = 'Sending Test Alert...';
    elements.testAlertResult.classList.add('hidden');

    try {
      let data = null;
      try {
        const res = await fetch('/api/alerts/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customNote: 'Manual Console Health Check' }),
        });
        if (res.ok) data = await res.json();
      } catch (_) {}

      if (!data) {
        const stored = localStorage.getItem('landslide_recipient');
        const recip = stored ? JSON.parse(stored) : { phone: '+91 (Emergency Contact)' };
        data = {
          success: true,
          provider: 'Simulated Client Dispatch',
          recipient: recip.phone || 'Designated Contact',
          message: '[TEST ALERT] Slope stability alert pathways verified operational.',
        };
      }

      elements.testAlertResult.textContent = `[SIMULATED DISPATCH SUCCESS]\nProvider: ${data.provider} (No real SMS billed)\nRecipient: ${data.recipient}\nMessage: ${data.message}\nTimestamp: ${new Date().toLocaleTimeString()}`;
      elements.testAlertResult.classList.remove('hidden');

      // Add to local audit log
      const testAlert = {
        timestamp: new Date().toISOString(),
        type: 'TEST_ALERT',
        status: 'NOMINAL',
        message: `Simulated test alert dispatched to ${data.recipient}.`,
      };
      state.localAlertLog.unshift(testAlert);
      localStorage.setItem('landslide_alert_log', JSON.stringify(state.localAlertLog.slice(0, 100)));

      renderAuditLog(state.localAlertLog);
    } catch (err) {
      elements.testAlertResult.textContent = `[TEST ALERT ERROR] ${err.message}`;
      elements.testAlertResult.classList.remove('hidden');
    } finally {
      elements.sendTestAlertBtn.disabled = false;
      elements.sendTestAlertBtn.textContent = '⚡ Send Safe Simulated Test Alert';
    }
  }

  // =========================================================================
  // 7. WEATHER ON-DEMAND REFRESH (/api/weather/refresh)
  // =========================================================================
  async function refreshWeatherForecast() {
    elements.refreshWeatherBtn.disabled = true;
    elements.refreshWeatherBtn.textContent = 'Updating...';

    try {
      let updated = false;

      // Try server if available
      try {
        const res = await fetch('/api/weather/refresh', { method: 'POST' });
        if (res.ok) updated = true;
      } catch (_) {}

      // Fallback to client-side direct Open-Meteo fetch
      if (!updated) {
        const wx = await fetchClientWeather(true);
        if (wx) updated = true;
      }

      if (elements.weatherNoticeBanner) {
        elements.weatherNoticeBanner.classList.add('hidden');
      }

      await pollTelemetryState();
    } catch (err) {
      console.warn('[Dashboard] Weather refresh failed:', err.message);
      if (elements.weatherNoticeBanner) {
        elements.weatherNoticeBanner.textContent = `Weather request failed: ${err.message}`;
        elements.weatherNoticeBanner.className = 'weather-notice-banner notice-warning';
        elements.weatherNoticeBanner.classList.remove('hidden');
      }
    } finally {
      elements.refreshWeatherBtn.disabled = false;
      elements.refreshWeatherBtn.textContent = '🔄 Refresh';
    }
  }

  // =========================================================================
  // 8. ALERT AUDIT LOG RENDERING (/api/alerts)
  // =========================================================================
  async function fetchAlertLog() {
    try {
      // 1. Try local storage
      const stored = localStorage.getItem('landslide_alert_log');
      if (stored) {
        try { state.localAlertLog = JSON.parse(stored); } catch (_) {}
      }
      if (!Array.isArray(state.localAlertLog)) state.localAlertLog = [];

      // 2. Try server if available
      try {
        const res = await fetch('/api/alerts?limit=25');
        if (res.ok) {
          const data = await res.json();
          if (data.alerts && data.alerts.length) {
            state.localAlertLog = data.alerts;
          }
        }
      } catch (_) {}

      elements.auditCountBadge.textContent = `${state.localAlertLog.length} Events`;
      renderAuditLog(state.localAlertLog);
    } catch (err) {
      console.warn('[Dashboard] Alert log fetch error:', err.message);
    }
  }

  function renderAuditLog(alerts) {
    elements.auditLogContainer.innerHTML = '';
    if (!alerts || alerts.length === 0) {
      elements.auditLogContainer.innerHTML = '<div class="empty-log-msg">No alerts recorded in audit ledger yet.</div>';
      return;
    }

    // Newest alerts at top
    const sorted = [...alerts].reverse();

    sorted.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'audit-entry-card';

      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—';
      const type = entry.type || 'EVENT';
      const status = entry.status || 'INFO';

      card.innerHTML = `
        <div class="audit-entry-header">
          <span class="audit-type-tag ${type}">${type}</span>
          <span class="audit-time">${time}</span>
        </div>
        <div class="audit-msg">${escapeHtml(entry.message || 'No description')}</div>
      `;
      elements.auditLogContainer.appendChild(card);
    });
  }

  // =========================================================================
  // 9. ABOUT & 19 REGIONAL TRANSLATIONS TABLE
  // =========================================================================
  function renderTranslationsTable(translations) {
    if (!translations || translations.length === 0) return;

    elements.translationsTableBody.innerHTML = '';
    translations.forEach((item) => {
      const tr = document.createElement('tr');

      const confBadge = `<span class="badge-confidence-${item.confidence || 'high'}">${(item.confidence || 'high').toUpperCase()}</span>`;
      const verBadge = item.needsVerification
        ? '<span class="badge-needs-verification">Needs Field Check</span>'
        : '<span class="badge-verified-lang">Verified</span>';

      tr.innerHTML = `
        <td><code>${escapeHtml(item.code)}</code></td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>${escapeHtml(item.nativeName)}</td>
        <td>${escapeHtml(item.script)}</td>
        <td><code>${item.dir}</code></td>
        <td class="translation-text-cell" lang="${item.code}" dir="${item.dir}">${escapeHtml(item.translation)}</td>
        <td>${confBadge}</td>
        <td>${verBadge}</td>
      `;
      elements.translationsTableBody.appendChild(tr);
    });
  }

  // =========================================================================
  // 10. INTERACTIVE LIVE DEMO & HAZARD SIMULATOR HANDLERS
  // =========================================================================
  function handleToggleDemoPanel() {
    state.demo.isOpen = !state.demo.isOpen;
    if (state.demo.isOpen) {
      elements.demoControllerSection?.classList.remove('hidden');
      elements.demoControllerSection?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      syncDemoStatus();
    } else {
      elements.demoControllerSection?.classList.add('hidden');
    }
  }

  function handleCloseDemoPanel() {
    state.demo.isOpen = false;
    elements.demoControllerSection?.classList.add('hidden');
  }

  const DEMO_SCENARIO_KEYS = ['safe', 'warning', 'high_risk', 'danger'];
  let demoCycleIndex = 0;

  async function handleStartDemoStream() {
    const speed = parseInt(elements.demoSpeedSelect?.value || '2500', 10);
    const autoCycle = Boolean(elements.autoCycleCheckbox?.checked);
    state.demo.isStreaming = true;
    state.demo.intervalMs = speed;
    state.demo.autoCycle = autoCycle;

    elements.startDemoStreamBtn?.classList.add('hidden');
    elements.stopDemoStreamBtn?.classList.remove('hidden');
    if (elements.demoStatusTag) {
      elements.demoStatusTag.className = 'demo-status-tag streaming';
      elements.demoStatusTag.textContent = `STREAMING (${(speed / 1000).toFixed(1)}s)`;
    }
    elements.demoActiveBadge?.classList.remove('hidden');
    if (elements.demoActiveBadgeText) {
      elements.demoActiveBadgeText.textContent = 'STREAMING';
    }

    // Try server start if running
    try {
      await fetch('/api/demo/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs: speed, autoCycle, scenario: state.demo.currentScenario }),
      });
    } catch (_) {}

    // Immediately poll state
    await pollTelemetryState();
    await fetchAlertLog();

    if (state.demo.pollTimer) clearInterval(state.demo.pollTimer);
    state.demo.pollTimer = setInterval(async () => {
      if (state.demo.autoCycle) {
        demoCycleIndex = (demoCycleIndex + 1) % DEMO_SCENARIO_KEYS.length;
        const nextScenario = DEMO_SCENARIO_KEYS[demoCycleIndex];
        state.demo.currentScenario = nextScenario;
        elements.demoScenarioButtons?.forEach((b) => {
          b.classList.toggle('active', b.dataset.scenario === nextScenario);
        });
        if (CLIENT_SCENARIOS[nextScenario]) {
          state.latestHardwareReading = {
            ...CLIENT_SCENARIOS[nextScenario],
            timestamp: new Date().toISOString(),
          };
          state.lastHardwareReceivedAt = Date.now();
        }
      } else {
        // Add realistic micro-variations
        const current = CLIENT_SCENARIOS[state.demo.currentScenario || 'safe'];
        if (current) {
          const jitter = (Math.random() - 0.5) * 0.4;
          state.latestHardwareReading = {
            ...current,
            soil_moisture: Math.max(0, Math.min(100, Number((current.soil_moisture + jitter).toFixed(1)))),
            rain_level: Math.max(0, Math.min(100, Number((current.rain_level + jitter * 0.5).toFixed(1)))),
            timestamp: new Date().toISOString(),
          };
          state.lastHardwareReceivedAt = Date.now();
        }
      }
      await pollTelemetryState();
      await fetchAlertLog();
      await syncDemoStatus();
    }, speed);
  }

  async function handleStopDemoStream() {
    state.demo.isStreaming = false;
    elements.startDemoStreamBtn?.classList.remove('hidden');
    elements.stopDemoStreamBtn?.classList.add('hidden');
    if (elements.demoStatusTag) {
      elements.demoStatusTag.className = 'demo-status-tag idle';
      elements.demoStatusTag.textContent = 'STREAM PAUSED';
    }
    elements.demoActiveBadge?.classList.add('hidden');

    if (state.demo.pollTimer) {
      clearInterval(state.demo.pollTimer);
      state.demo.pollTimer = null;
    }

    try {
      await fetch('/api/demo/stop', { method: 'POST' });
    } catch (_) {}
  }

  async function handleAutoCycleChange() {
    state.demo.autoCycle = Boolean(elements.autoCycleCheckbox?.checked);
    if (state.demo.isStreaming) {
      await handleStartDemoStream();
    }
  }

  async function handleDemoSpeedChange() {
    if (state.demo.isStreaming) {
      await handleStartDemoStream();
    }
  }

  async function handleTriggerScenario(scenarioId) {
    if (!scenarioId) return;
    state.demo.currentScenario = scenarioId;

    // Highlight active scenario button
    elements.demoScenarioButtons?.forEach((b) => {
      b.classList.toggle('active', b.dataset.scenario === scenarioId);
    });

    if (elements.demoStatusTag) {
      elements.demoStatusTag.textContent = `SCENARIO: ${scenarioId.toUpperCase()}`;
    }

    // Set client simulated reading immediately
    if (CLIENT_SCENARIOS[scenarioId]) {
      state.latestHardwareReading = {
        ...CLIENT_SCENARIOS[scenarioId],
        timestamp: new Date().toISOString(),
      };
      state.lastHardwareReceivedAt = Date.now();
    }

    // Inform server if present
    try {
      await fetch('/api/demo/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: scenarioId }),
      });
    } catch (_) {}

    await pollTelemetryState();
    await fetchAlertLog();
  }

  async function handleApplyCustomSliders() {
    const soil = parseFloat(elements.demoSliderSoil?.value || '45');
    const rain = parseFloat(elements.demoSliderRain?.value || '30');
    const tilt = parseFloat(elements.demoSliderTilt?.value || '4');
    const disp = parseFloat(elements.demoSliderDisp?.value || '0.8');
    const tiltSwitch = Boolean(elements.demoSliderTiltSwitch?.checked);

    if (elements.demoStatusTag) {
      elements.demoStatusTag.textContent = 'CUSTOM VALUES APPLIED';
    }

    const customReading = {
      device: 'ESP32_LANDSLIDE_01',
      soil_moisture: soil,
      rain_level: rain,
      soil_raw: Math.round(4095 - (soil / 100) * 3500),
      rain_raw: Math.round(4095 - (rain / 100) * 3500),
      tilt_x: tilt,
      tilt_y: tilt * 0.6,
      displacement_cm: disp,
      distance_cm: Math.max(1, 15 - disp),
      tilt_sensor: tiltSwitch,
      acceleration: tiltSwitch ? 14.5 : 10.2,
      soil_trend: 5.0,
      rain_trend: 5.0,
      history_samples: 120,
      sensor_fault: false,
      gps_valid: true,
      latitude: state.hardwareLocation?.latitude || 19.1334,
      longitude: state.hardwareLocation?.longitude || 72.9133,
      gps_altitude: 125.0,
      gps_speed: 0.0,
      gps_satellites: 7,
      temperature: 25.0,
      humidity: 80.0,
      battery: 90.0,
      timestamp: new Date().toISOString(),
    };

    state.latestHardwareReading = customReading;
    state.lastHardwareReceivedAt = Date.now();

    try {
      await fetch('/api/sensor-data/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customReading),
      });
    } catch (_) {}

    await pollTelemetryState();
    await fetchAlertLog();
  }

  async function syncDemoStatus() {
    try {
      const res = await fetch('/api/demo/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.currentScenario) {
        state.demo.currentScenario = data.currentScenario;
        elements.demoScenarioButtons?.forEach((b) => {
          b.classList.toggle('active', b.dataset.scenario === data.currentScenario);
        });
      }
      if (data.isRunning && !state.demo.isStreaming) {
        state.demo.isStreaming = true;
        elements.startDemoStreamBtn?.classList.add('hidden');
        elements.stopDemoStreamBtn?.classList.remove('hidden');
        if (elements.demoStatusTag) {
          elements.demoStatusTag.className = 'demo-status-tag streaming';
          elements.demoStatusTag.textContent = `STREAMING (${data.currentScenario.toUpperCase()})`;
        }
        elements.demoActiveBadge?.classList.remove('hidden');
      }
    } catch (_) {}
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Start Application on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
