/**
 * Open-Meteo Weather Service & Caching Module
 *
 * Fetches hourly precipitation and current meteorological metrics for the
 * landslide sensor station from Open-Meteo (free API, no key required).
 * Strictly returns explicit error objects on failure — never fabricates mock data.
 */

import { config } from '../config.js';
import { store } from '../store.js';
import { evaluateGpsLocationState } from './hardware.js';

let weatherPollingIntervalId = null;

/**
 * Computes Haversine distance in meters between two lat/lng coordinates.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters
 */
export function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  if (
    lat1 === undefined || lat1 === null ||
    lon1 === undefined || lon1 === null ||
    lat2 === undefined || lat2 === null ||
    lon2 === undefined || lon2 === null
  ) {
    return Infinity;
  }
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Checks if coordinates moved by more than thresholdMeters (default 500m).
 * Refetches weather only when coordinates change meaningfully.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} [thresholdMeters=500]
 * @returns {boolean} True if coordinates changed meaningfully
 */
export function hasMeaningfulCoordinateChange(lat1, lon1, lat2, lon2, thresholdMeters = 500) {
  const dist = calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2);
  return dist > thresholdMeters;
}

/**
 * Fetches live weather data from Open-Meteo API using hardware GPS coordinates ONLY.
 * Never uses browser geolocation or hard-coded fallback coordinates.
 * If GPS is unavailable, stale, or (0,0), returns an explicit error object.
 *
 * @param {Object} [coords] Optional explicit coordinates (e.g. from tests or hardware update)
 * @param {number} [coords.latitude]
 * @param {number} [coords.longitude]
 * @returns {Promise<{ success: boolean, data?: Object, error?: string, status?: string }>}
 */
export async function fetchWeather(coords = {}) {
  let latitude = coords.latitude !== undefined && coords.latitude !== null ? Number(coords.latitude) : null;
  let longitude = coords.longitude !== undefined && coords.longitude !== null ? Number(coords.longitude) : null;

  // If coordinates not provided, read exclusively from hardware GPS telemetry
  if (latitude === null || longitude === null) {
    const hwLoc = store.getHardwareLocation();
    const reading = store.getLatestReading();
    const gpsState = evaluateGpsLocationState(hwLoc, reading);

    if (gpsState.status === 'AVAILABLE' && gpsState.coordinates) {
      latitude = gpsState.coordinates.latitude;
      longitude = gpsState.coordinates.longitude;
    } else {
      return {
        success: false,
        error: 'Weather unavailable: no current GPS location',
        status: 'NO_GPS_LOCATION',
        gpsStatus: gpsState.status,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Strictly reject out-of-range, non-finite, and (0,0) null-island coordinates
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return {
      success: false,
      error: 'Weather unavailable: no current GPS location',
      status: 'NO_GPS_LOCATION',
      timestamp: new Date().toISOString(),
    };
  }

  const baseUrl =
    config.weather?.apiUrl ||
    config.WEATHER_API_URL ||
    'https://api.open-meteo.com/v1/forecast';

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,precipitation,rain',
    hourly: 'precipitation,rain',
    forecast_days: '2',
    timezone: 'auto',
  });

  const requestUrl = `${baseUrl}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const res = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LandslideDashboard/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      const isRateLimit = res.status === 429;
      return {
        success: false,
        error: isRateLimit
          ? 'Open-Meteo API rate limit exceeded. Please retry later.'
          : `Upstream weather API returned HTTP ${res.status}: ${errorText || res.statusText}`,
        statusCode: res.status,
        status: isRateLimit ? 'RATE_LIMIT' : 'UPSTREAM_ERROR',
        timestamp: new Date().toISOString(),
      };
    }

    const json = await res.json();

    if (!json || typeof json !== 'object' || json.error) {
      return {
        success: false,
        error: json?.reason || 'Invalid response from weather API',
        status: 'INVALID_RESPONSE',
        timestamp: new Date().toISOString(),
      };
    }

    // Calculate next 24 hours precipitation sum
    const hourly24 = json.hourly?.precipitation?.slice(0, 24) || [];
    const next24hPrecipitationMm = hourly24.reduce(
      (sum, val) => sum + (Number(val) || 0),
      0
    );

    const weatherData = {
      source: 'open-meteo',
      latitude: json.latitude,
      longitude: json.longitude,
      requestedLatitude: latitude,
      requestedLongitude: longitude,
      fetchedCoordinates: {
        latitude: Number(latitude.toFixed(4)),
        longitude: Number(longitude.toFixed(4)),
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
    };

    // Cache to store
    store.setLatestWeather(weatherData);

    return {
      success: true,
      data: weatherData,
      status: 'OK',
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err.name === 'AbortError';
    return {
      success: false,
      error: isAbort
        ? 'Weather API request timed out after 10 seconds'
        : `Network or fetch error: ${err.message}`,
      status: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Returns the cached weather with freshness metrics.
 * Flags as stale once older than config.weather.staleMinutes.
 *
 * @returns {{ weather: Object|null, isStale: boolean, ageMinutes: number|null, staleThresholdMinutes: number, status: string }}
 */
export function getWeatherWithFreshness() {
  const weather = store.getLatestWeather();
  const staleThreshold =
    config.weather?.staleMinutes ??
    config.WEATHER_CACHE_MINUTES ??
    15;

  if (!weather || !weather.cachedAt) {
    return {
      weather: null,
      isStale: true,
      ageMinutes: null,
      staleThresholdMinutes: staleThreshold,
      status: 'NO_DATA',
    };
  }

  const cachedTime = new Date(weather.cachedAt).getTime();
  const elapsedMs = Date.now() - cachedTime;
  const ageMinutes = Math.max(0, Math.floor(elapsedMs / (60 * 1000)));
  const isStale = ageMinutes >= staleThreshold;

  return {
    weather,
    isStale,
    ageMinutes,
    staleThresholdMinutes: staleThreshold,
    status: isStale ? 'STALE' : 'FRESH',
    lastCachedAt: weather.cachedAt,
  };
}

/**
 * Starts background polling worker to periodically fetch and update weather data.
 * Re-fetches only when hardware GPS is AVAILABLE and either:
 * - Coordinates have changed meaningfully (> 500m)
 * - Cache has expired (age >= pollMinutes)
 *
 * @returns {NodeJS.Timeout} The active interval timer
 */
export function startWeatherPolling() {
  const pollMinutes =
    config.weather?.pollMinutes ??
    config.WEATHER_CHECK_INTERVAL_MINUTES ??
    15;

  const intervalMs = Math.max(1, pollMinutes) * 60 * 1000;

  const checkAndFetch = async () => {
    try {
      const hwLoc = store.getHardwareLocation();
      const reading = store.getLatestReading();
      const gpsState = evaluateGpsLocationState(hwLoc, reading);

      // Do NOT fetch weather if GPS is UNAVAILABLE or STALE
      if (gpsState.status !== 'AVAILABLE' || !gpsState.coordinates) {
        return;
      }

      const cached = store.getLatestWeather();
      if (cached) {
        const cachedLat = cached.requestedLatitude ?? cached.latitude;
        const cachedLng = cached.requestedLongitude ?? cached.longitude;
        const hasMoved = hasMeaningfulCoordinateChange(
          gpsState.coordinates.latitude,
          gpsState.coordinates.longitude,
          cachedLat,
          cachedLng,
          500
        );

        const ageMinutes = cached.cachedAt
          ? Math.floor((Date.now() - new Date(cached.cachedAt).getTime()) / 60000)
          : Infinity;
        const isExpired = ageMinutes >= pollMinutes;

        // Skip fetch if coordinates have not changed meaningfully (>500m) and cache has not expired
        if (!hasMoved && !isExpired) {
          return;
        }
      }

      await fetchWeather({
        latitude: gpsState.coordinates.latitude,
        longitude: gpsState.coordinates.longitude,
      });
    } catch (err) {
      console.warn(`[Weather] Background fetch notice: ${err.message}`);
    }
  };

  // Perform initial check (non-blocking)
  checkAndFetch();

  if (weatherPollingIntervalId) {
    clearInterval(weatherPollingIntervalId);
  }

  weatherPollingIntervalId = setInterval(checkAndFetch, intervalMs);

  // Unref so the interval doesn't block clean Node process exits
  if (weatherPollingIntervalId.unref) {
    weatherPollingIntervalId.unref();
  }

  return weatherPollingIntervalId;
}

/**
 * Stops background weather polling interval (useful for tests and shutdown)
 */
export function stopWeatherPolling() {
  if (weatherPollingIntervalId) {
    clearInterval(weatherPollingIntervalId);
    weatherPollingIntervalId = null;
  }
}
