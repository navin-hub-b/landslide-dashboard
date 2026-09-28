import dotenv from 'dotenv';
dotenv.config();

/**
 * Safely parses a number with a fallback default.
 */
function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Safely parses a boolean with a fallback default.
 */
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return defaultValue;
}

export const config = {
  // Server & Networking
  PORT: parseNumber(process.env.PORT, 5000),
  port: parseNumber(process.env.PORT, 5000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  NODE_ENV: process.env.NODE_ENV || 'development',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Hardware API & Ingestion
  HARDWARE_API_KEY: process.env.HARDWARE_API_KEY || process.env.API_KEY || '',
  hardwareApiKey: process.env.HARDWARE_API_KEY || process.env.API_KEY || '',
  apiKey: process.env.HARDWARE_API_KEY || process.env.API_KEY || '',
  HARDWARE_STALE_SECONDS: parseNumber(process.env.HARDWARE_STALE_SECONDS, 60),
  hardwareStaleSeconds: parseNumber(process.env.HARDWARE_STALE_SECONDS, 60),
  MAX_HISTORY: parseNumber(process.env.MAX_HISTORY, 360),
  maxHistory: parseNumber(process.env.MAX_HISTORY, 360),
  hardware: {
    apiKey: process.env.HARDWARE_API_KEY || process.env.API_KEY || '',
    staleSeconds: parseNumber(process.env.HARDWARE_STALE_SECONDS, 60),
    maxHistory: parseNumber(process.env.MAX_HISTORY, 360),
  },

  // Monitoring Site Geolocation & Label
  // Default coordinates: IIT Bombay Hillside / Powai Lake region
  SITE_LATITUDE: parseNumber(process.env.SITE_LATITUDE, 19.1334),
  siteLatitude: parseNumber(process.env.SITE_LATITUDE, 19.1334),
  SITE_LONGITUDE: parseNumber(process.env.SITE_LONGITUDE, 72.9133),
  siteLongitude: parseNumber(process.env.SITE_LONGITUDE, 72.9133),
  SITE_LABEL: process.env.SITE_LABEL || 'IIT Bombay Hillside Station #1',
  siteLabel: process.env.SITE_LABEL || 'IIT Bombay Hillside Station #1',
  site: {
    latitude: parseNumber(process.env.SITE_LATITUDE, 19.1334),
    longitude: parseNumber(process.env.SITE_LONGITUDE, 72.9133),
    label: process.env.SITE_LABEL || 'IIT Bombay Hillside Station #1',
  },

  // Physical Hardware Setup Deployment Location
  HARDWARE_LATITUDE: parseNumber(process.env.HARDWARE_LATITUDE, 19.1334),
  HARDWARE_LONGITUDE: parseNumber(process.env.HARDWARE_LONGITUDE, 72.9133),
  HARDWARE_ALTITUDE_M: parseNumber(process.env.HARDWARE_ALTITUDE_M, 128),
  HARDWARE_STATION_ID: process.env.HARDWARE_STATION_ID || 'ESP32_DEVKIT_V1',
  HARDWARE_LABEL: process.env.HARDWARE_LABEL || 'IIT Bombay Hillside Station #1 (Slope Anchor)',
  hardwareLocation: {
    latitude: parseNumber(process.env.HARDWARE_LATITUDE, 19.1334),
    longitude: parseNumber(process.env.HARDWARE_LONGITUDE, 72.9133),
    altitude_m: parseNumber(process.env.HARDWARE_ALTITUDE_M, 128),
    station_id: process.env.HARDWARE_STATION_ID || 'ESP32_DEVKIT_V1',
    label: process.env.HARDWARE_LABEL || 'IIT Bombay Hillside Station #1 (Slope Anchor)',
  },

  // Weather Settings
  WEATHER_API_URL:
    process.env.WEATHER_API_URL ||
    process.env.OPENMETEO_BASE_URL ||
    'https://api.open-meteo.com/v1/forecast',
  weatherApiUrl:
    process.env.WEATHER_API_URL ||
    process.env.OPENMETEO_BASE_URL ||
    'https://api.open-meteo.com/v1/forecast',
  WEATHER_CACHE_MINUTES: parseNumber(process.env.WEATHER_CACHE_MINUTES, 15),
  weatherCacheMinutes: parseNumber(process.env.WEATHER_CACHE_MINUTES, 15),
  WEATHER_CHECK_INTERVAL_MINUTES: parseNumber(
    process.env.WEATHER_CHECK_INTERVAL_MINUTES,
    15
  ),
  weatherCheckIntervalMinutes: parseNumber(
    process.env.WEATHER_CHECK_INTERVAL_MINUTES,
    15
  ),
  weather: {
    apiUrl:
      process.env.WEATHER_API_URL ||
      process.env.OPENMETEO_BASE_URL ||
      'https://api.open-meteo.com/v1/forecast',
    cacheMinutes: parseNumber(process.env.WEATHER_CACHE_MINUTES, 15),
    staleMinutes: parseNumber(process.env.WEATHER_CACHE_MINUTES, 15),
    pollMinutes: parseNumber(process.env.WEATHER_CHECK_INTERVAL_MINUTES, 15),
    checkIntervalMinutes: parseNumber(
      process.env.WEATHER_CHECK_INTERVAL_MINUTES,
      15
    ),
  },

  // Risk Calculation Thresholds (matching Sections 6 & 10 of guide)
  RISK_THRESHOLD_WARNING: parseNumber(process.env.RISK_THRESHOLD_WARNING, 4),
  riskThresholdWarning: parseNumber(process.env.RISK_THRESHOLD_WARNING, 4),
  RISK_THRESHOLD_HIGH: parseNumber(process.env.RISK_THRESHOLD_HIGH, 7),
  riskThresholdHigh: parseNumber(process.env.RISK_THRESHOLD_HIGH, 7),
  RISK_THRESHOLD_DANGER: parseNumber(process.env.RISK_THRESHOLD_DANGER, 10),
  riskThresholdDanger: parseNumber(process.env.RISK_THRESHOLD_DANGER, 10),
  WEATHER_HEAVY_RAIN_MM: parseNumber(process.env.WEATHER_HEAVY_RAIN_MM, 10.0),
  WEATHER_MODERATE_RAIN_MM: parseNumber(
    process.env.WEATHER_MODERATE_RAIN_MM,
    2.5
  ),
  risk: {
    thresholdWarning: parseNumber(process.env.RISK_THRESHOLD_WARNING, 4),
    thresholdHigh: parseNumber(process.env.RISK_THRESHOLD_HIGH, 7),
    thresholdDanger: parseNumber(process.env.RISK_THRESHOLD_DANGER, 10),
    weatherHeavyRainMm: parseNumber(process.env.WEATHER_HEAVY_RAIN_MM, 10.0),
    weatherModerateRainMm: parseNumber(
      process.env.WEATHER_MODERATE_RAIN_MM,
      2.5
    ),
  },

  // Alert Deduplication & Cooldown
  ALERT_COOLDOWN_MINUTES: parseNumber(process.env.ALERT_COOLDOWN_MINUTES, 15),
  alertCooldownMinutes: parseNumber(process.env.ALERT_COOLDOWN_MINUTES, 15),
  alerts: {
    cooldownMinutes: parseNumber(process.env.ALERT_COOLDOWN_MINUTES, 15),
  },

  // SMS Provider Configuration
  SMS_PROVIDER: (process.env.SMS_PROVIDER || 'console').toLowerCase().trim(),
  smsProvider: (process.env.SMS_PROVIDER || 'console').toLowerCase().trim(),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_PHONE: process.env.TWILIO_FROM_PHONE || '',
  twilioFromPhone: process.env.TWILIO_FROM_PHONE || '',
  ALLOW_REAL_TEST_SMS: parseBoolean(process.env.ALLOW_REAL_TEST_SMS, false),
  allowRealTestSms: parseBoolean(process.env.ALLOW_REAL_TEST_SMS, false),
  sms: {
    provider: (process.env.SMS_PROVIDER || 'console').toLowerCase().trim(),
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFromPhone: process.env.TWILIO_FROM_PHONE || '',
    allowRealTestSms: parseBoolean(process.env.ALLOW_REAL_TEST_SMS, false),
  },

  // Map & Evacuation Routing Settings
  MAP_STYLE_URL:
    process.env.MAP_STYLE_URL ||
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  mapStyleUrl:
    process.env.MAP_STYLE_URL ||
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  OSRM_BASE_URL:
    process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  osrmBaseUrl:
    process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  SATELLITE_TILE_URL:
    process.env.SATELLITE_TILE_URL ||
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  satelliteTileUrl:
    process.env.SATELLITE_TILE_URL ||
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',

  // Safe Destination / Evacuation Shelter
  SAFE_DEST_LATITUDE: parseNumber(process.env.SAFE_DEST_LATITUDE, 19.1360),
  safeDestLatitude: parseNumber(process.env.SAFE_DEST_LATITUDE, 19.1360),
  SAFE_DEST_LONGITUDE: parseNumber(process.env.SAFE_DEST_LONGITUDE, 72.9160),
  safeDestLongitude: parseNumber(process.env.SAFE_DEST_LONGITUDE, 72.9160),
  SAFE_DEST_LABEL:
    process.env.SAFE_DEST_LABEL || 'Campus Evacuation Center / Safe Shelter',
  safeDestLabel:
    process.env.SAFE_DEST_LABEL || 'Campus Evacuation Center / Safe Shelter',
  SAFE_DEST_VERIFIED: parseBoolean(process.env.SAFE_DEST_VERIFIED, true),
  safeDestVerified: parseBoolean(process.env.SAFE_DEST_VERIFIED, true),

  map: {
    styleUrl:
      process.env.MAP_STYLE_URL ||
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    osrmBaseUrl:
      process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
    satelliteTileUrl:
      process.env.SATELLITE_TILE_URL ||
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    safeDestination: {
      latitude: parseNumber(process.env.SAFE_DEST_LATITUDE, 19.1360),
      longitude: parseNumber(process.env.SAFE_DEST_LONGITUDE, 72.9160),
      label:
        process.env.SAFE_DEST_LABEL ||
        'Campus Evacuation Center / Safe Shelter',
      verified: parseBoolean(process.env.SAFE_DEST_VERIFIED, true),
    },
  },
};

/**
 * Checks whether an SMS provider is configured and operable.
 * - 'twilio': Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_PHONE.
 * - 'console' / 'mock': Considered configured for development and testing.
 * - 'none' / empty: Not configured.
 *
 * @returns {boolean} True if SMS provider is configured and ready.
 */
export function smsIsConfigured() {
  const provider = (config.SMS_PROVIDER || '').toLowerCase().trim();
  if (provider === 'twilio') {
    return Boolean(
      config.TWILIO_ACCOUNT_SID &&
      config.TWILIO_ACCOUNT_SID.trim().length > 0 &&
      config.TWILIO_AUTH_TOKEN &&
      config.TWILIO_AUTH_TOKEN.trim().length > 0 &&
      config.TWILIO_FROM_PHONE &&
      config.TWILIO_FROM_PHONE.trim().length > 0
    );
  }
  if (provider === 'console' || provider === 'mock') {
    return true;
  }
  return false;
}

/**
 * Returns true if real cellular SMS transmission (Twilio) is active and configured.
 */
export function isRealSmsConfigured() {
  return config.SMS_PROVIDER === 'twilio' && smsIsConfigured();
}

export default config;
