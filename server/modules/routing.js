/**
 * Evacuation Routing & Geographic Navigation Module
 *
 * Integrates with the Open Source Routing Machine (OSRM) engine
 * to calculate turn-by-turn emergency evacuation routes from the landslide monitoring
 * station to designated safe assembly areas and emergency shelters.
 *
 * Strict Policy: Never fabricates or synthesizes coordinates or routes.
 * If origin/destination or routing service is unavailable, returns explicit error objects.
 */

import { config } from '../config.js';

/**
 * Validates whether latitude and longitude are valid numeric geographic coordinates.
 */
function isValidCoord(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return false;
  }
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  return nLat >= -90 && nLat <= 90 && nLng >= -180 && nLng <= 180;
}

/**
 * Fetches real evacuation route from OSRM.
 *
 * @param {Object} params
 * @param {number} params.originLat Origin latitude
 * @param {number} params.originLng Origin longitude
 * @param {number} params.destLat Destination latitude
 * @param {number} params.destLng Destination longitude
 * @param {string} [params.profile='driving'] Routing profile ('driving', 'walking')
 * @returns {Promise<Object>} Route response or explicit error object
 */
export async function getEvacuationRoute({
  originLat,
  originLng,
  destLat,
  destLng,
  profile = 'driving',
} = {}) {
  // 1. Strict validation: origin and destination coordinates are required
  if (!isValidCoord(originLat, originLng)) {
    return {
      success: false,
      error: 'Valid origin coordinates (latitude: -90..90, longitude: -180..180) are required',
      status: 'INVALID_ORIGIN',
    };
  }

  if (!isValidCoord(destLat, destLng)) {
    return {
      success: false,
      error: 'Valid destination coordinates (latitude: -90..90, longitude: -180..180) are required',
      status: 'INVALID_DESTINATION',
    };
  }

  const oLat = Number(originLat);
  const oLng = Number(originLng);
  const dLat = Number(destLat);
  const dLng = Number(destLng);

  // 2. Build OSRM route URL (format: /route/v1/{profile}/{lng1},{lat1};{lng2},{lat2})
  const osrmBase = (
    config.map?.osrmBaseUrl ||
    config.OSRM_BASE_URL ||
    'https://router.project-osrm.org'
  ).replace(/\/+$/, '');

  const url = `${osrmBase}/route/v1/${profile}/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson&steps=true`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LandslideEarlyWarningDashboard/1.0',
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        success: false,
        error: `OSRM routing service responded with HTTP status ${res.status}`,
        status: 'UPSTREAM_ERROR',
        httpStatus: res.status,
      };
    }

    const data = await res.json();

    if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
      return {
        success: false,
        error: data.message || 'No navigable evacuation route found between origin and destination',
        status: data.code || 'NO_ROUTE_FOUND',
      };
    }

    const primaryRoute = data.routes[0];

    return {
      success: true,
      distanceMeters: primaryRoute.distance,
      durationSeconds: primaryRoute.duration,
      distanceKm: Number((primaryRoute.distance / 1000).toFixed(2)),
      durationMinutes: Number((primaryRoute.duration / 60).toFixed(1)),
      geometry: primaryRoute.geometry, // GeoJSON LineString: { type: 'LineString', coordinates: [[lng, lat], ...] }
      waypoints: data.waypoints || [],
      legs: primaryRoute.legs || [],
      origin: { latitude: oLat, longitude: oLng },
      destination: { latitude: dLat, longitude: dLng },
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    return {
      success: false,
      error: isTimeout
        ? 'OSRM routing request timed out after 8 seconds'
        : `OSRM routing network failure: ${err.message}`,
      status: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      details: err.message,
    };
  }
}

export default {
  getEvacuationRoute,
};
