import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default persistence location
const DEFAULT_DATA_DIR = path.resolve(__dirname, 'data');
const DEFAULT_STORE_FILE = path.join(DEFAULT_DATA_DIR, 'store.json');

// Audit log minimum retention guarantee
const MIN_AUDIT_LOG_RETENTION = 500;
const MAX_AUDIT_LOG_ENTRIES = 1000;

export class SensorStore {
  /**
   * @param {Object} options Configuration options
   * @param {string} [options.filePath] Custom path to store.json
   * @param {number} [options.maxHistory] Maximum readings in ring buffer (default 360)
   * @param {boolean} [options.autoPersist] Whether to persist to disk on mutations
   */
  constructor(options = {}) {
    if (typeof options === 'number') {
      // Backwards compatibility with new SensorStore(5) -> pure in-memory test store
      options = { maxHistory: options, autoPersist: false };
    }

    this.filePath = options.filePath || (options.isDefaultStore ? DEFAULT_STORE_FILE : null);
    this.maxHistory = options.maxHistory || config.MAX_HISTORY || 360;
    this.autoPersist = options.autoPersist ?? Boolean(this.filePath);

    // Core data structures
    this.latestReading = null;
    this.history = [];
    this.latestWeather = null;
    this.alertLog = [];
    this.alertDedup = {
      lastLevel: null,
      lastStatus: 'SAFE',
      lastAlertSentAt: null,
      lastBroadcastAt: null,
      cooldowns: {},
    };
    this.recipientPhoneConsent = {
      phone: null,
      consentGiven: false,
      consentTimestamp: null,
      verified: false,
      notes: '',
      updatedAt: null,
    };
    this.recipients = [];
    this.siteLocation = null;
    this.hardwareLocation = null;

    // Ensure data directory exists and initialize state if file-backed
    if (this.filePath) {
      this._initStore();
    }
  }

  // Backwards compatibility alias for this.latest
  get latest() {
    return this.latestReading;
  }

  set latest(val) {
    this.latestReading = val;
  }

  /**
   * Initializes store by loading from disk or creating empty template
   * @private
   */
  _initStore() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        this._loadFromDisk();
      } else if (this.autoPersist) {
        this._saveToDisk();
      }
    } catch (err) {
      console.warn(`[Store] Warning during initialization: ${err.message}`);
    }
  }

  /**
   * Loads state from store.json
   * @private
   */
  _loadFromDisk() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw || !raw.trim()) return;

      const data = JSON.parse(raw);

      this.latestReading = data.latestReading ?? null;
      this.history = Array.isArray(data.history)
        ? data.history.slice(-this.maxHistory)
        : [];
      this.latestWeather = data.latestWeather ?? null;
      this.alertLog = Array.isArray(data.alertLog) ? data.alertLog : [];
      this.alertDedup = {
        lastLevel: null,
        lastStatus: 'SAFE',
        lastAlertSentAt: null,
        lastBroadcastAt: null,
        cooldowns: {},
        ...(data.alertDedup || {}),
      };
      this.recipientPhoneConsent = {
        phone: null,
        consentGiven: false,
        consentTimestamp: null,
        verified: false,
        notes: '',
        updatedAt: null,
        ...(data.recipientPhoneConsent || {}),
      };
      this.recipients = Array.isArray(data.recipients) ? data.recipients : [];
      this.siteLocation = data.siteLocation ?? null;
      this.hardwareLocation = data.hardwareLocation ?? null;
    } catch (err) {
      console.error(
        `[Store] Failed to parse ${this.filePath}, preserving empty defaults:`,
        err.message
      );
    }
  }

  /**
   * Safely writes state to disk using an atomic temporary file write
   * @private
   */
  _saveToDisk() {
    if (!this.autoPersist) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload = {
        latestReading: this.latestReading,
        history: this.history,
        latestWeather: this.latestWeather,
        alertLog: this.alertLog,
        alertDedup: this.alertDedup,
        recipientPhoneConsent: this.recipientPhoneConsent,
        recipients: this.recipients,
        siteLocation: this.siteLocation,
        hardwareLocation: this.hardwareLocation,
        lastSavedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Store] Error writing to ${this.filePath}:`, err.message);
    }
  }

  // -------------------------------------------------------------
  // Sensor Readings & Ring Buffer (360 samples)
  // -------------------------------------------------------------

  /**
   * Appends reading to ring buffer and updates latestReading
   * @param {Object} data Sensor metrics
   * @returns {Object} Stored reading with timestamp
   */
  addReading(data) {
    const reading = {
      ...data,
      receivedAt: data.receivedAt || new Date().toISOString(),
    };

    this.latestReading = reading;
    this.history.push(reading);

    // Maintain ring buffer cap (last 360 readings)
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    this._saveToDisk();
    return reading;
  }

  getLatest() {
    return this.latestReading;
  }

  getLatestReading() {
    return this.latestReading;
  }

  getHistory(limit = null) {
    if (limit && Number.isInteger(limit) && limit > 0) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  // -------------------------------------------------------------
  // Weather Cache
  // -------------------------------------------------------------

  getLatestWeather() {
    return this.latestWeather;
  }

  setLatestWeather(weatherData) {
    this.latestWeather = {
      ...weatherData,
      cachedAt: new Date().toISOString(),
    };
    this._saveToDisk();
    return this.latestWeather;
  }

  // -------------------------------------------------------------
  // Alert Audit Log (Never truncated below 500 entries)
  // -------------------------------------------------------------

  /**
   * Adds an entry to the permanent alert audit log.
   * Audit log is NEVER truncated below 500 entries and NEVER cleared on recovery.
   *
   * @param {Object} entry Alert log metadata
   * @returns {Object} Stored log entry
   */
  addAlertLog(entry) {
    const record = {
      id: entry.id || crypto.randomUUID(),
      timestamp: entry.timestamp || new Date().toISOString(),
      type: entry.type || 'STATUS_CHANGE', // e.g. 'ESCALATION', 'RECOVERY', 'SMS_BROADCAST', 'MANUAL_TEST'
      status: entry.status || 'UNKNOWN',
      riskScore: entry.riskScore ?? entry.risk_score ?? null,
      message: entry.message || '',
      recipients: entry.recipients || [],
      details: entry.details || {},
    };

    this.alertLog.push(record);

    // If log exceeds max configured capacity, prune oldest entries
    // but GUARANTEE that at least MIN_AUDIT_LOG_RETENTION (500) entries are kept.
    if (this.alertLog.length > MAX_AUDIT_LOG_ENTRIES) {
      const excess = this.alertLog.length - MAX_AUDIT_LOG_ENTRIES;
      const targetLength = Math.max(MIN_AUDIT_LOG_RETENTION, MAX_AUDIT_LOG_ENTRIES);
      if (this.alertLog.length > targetLength) {
        this.alertLog.splice(0, this.alertLog.length - targetLength);
      }
    }

    this._saveToDisk();
    return record;
  }

  getAlertLog(limit = null) {
    if (limit && Number.isInteger(limit) && limit > 0) {
      return this.alertLog.slice(-limit);
    }
    return [...this.alertLog];
  }

  // -------------------------------------------------------------
  // Alert Deduplication & Cooldown Tracking
  // -------------------------------------------------------------

  getAlertDedup() {
    return { ...this.alertDedup };
  }

  updateAlertDedup(updates = {}) {
    this.alertDedup = {
      ...this.alertDedup,
      ...updates,
      cooldowns: {
        ...(this.alertDedup.cooldowns || {}),
        ...(updates.cooldowns || {}),
      },
    };
    this._saveToDisk();
    return this.alertDedup;
  }

  /**
   * Checks whether an alert of a given status/level is permitted by cooldown
   * @param {string} level Status level (e.g. 'WARNING', 'HIGH_RISK', 'DANGER')
   * @param {number} cooldownMinutes Cooldown duration
   * @returns {boolean} True if cooldown has elapsed
   */
  canSendAlert(level, cooldownMinutes = config.ALERT_COOLDOWN_MINUTES) {
    const lastSent = this.alertDedup.cooldowns?.[level];
    if (!lastSent) return true;

    const elapsedMs = Date.now() - new Date(lastSent).getTime();
    const cooldownMs = cooldownMinutes * 60 * 1000;
    return elapsedMs >= cooldownMs;
  }

  recordAlertSent(level, details = {}) {
    const now = new Date().toISOString();
    this.alertDedup = {
      ...this.alertDedup,
      lastLevel: level,
      lastStatus: level,
      lastAlertSentAt: now,
      cooldowns: {
        ...(this.alertDedup.cooldowns || {}),
        [level]: now,
      },
    };
    this._saveToDisk();
  }

  // -------------------------------------------------------------
  // Recipient Phone & Consent Management
  // -------------------------------------------------------------

  getRecipientConsent() {
    return { ...this.recipientPhoneConsent };
  }

  setRecipientConsent({ phone, consentGiven, verified = false, notes = '' }) {
    const now = new Date().toISOString();
    this.recipientPhoneConsent = {
      phone: phone || null,
      consentGiven: Boolean(consentGiven),
      consentTimestamp: consentGiven ? now : null,
      verified: Boolean(verified),
      notes: notes || '',
      updatedAt: now,
    };

    // Update in recipients list if phone is present
    if (phone) {
      const idx = this.recipients.findIndex((r) => r.phone === phone);
      const record = {
        phone,
        consentGiven: Boolean(consentGiven),
        consentTimestamp: consentGiven ? now : null,
        verified: Boolean(verified),
        notes: notes || '',
        updatedAt: now,
      };

      if (idx >= 0) {
        this.recipients[idx] = { ...this.recipients[idx], ...record };
      } else {
        this.recipients.push(record);
      }
    }

    this._saveToDisk();
    return this.recipientPhoneConsent;
  }

  getRecipients() {
    return [...this.recipients];
  }

  addRecipient({ phone, name = '', consentGiven = true, verified = false }) {
    if (!phone) throw new Error('Phone number is required');
    const now = new Date().toISOString();
    const idx = this.recipients.findIndex((r) => r.phone === phone);

    const record = {
      phone,
      name,
      consentGiven: Boolean(consentGiven),
      consentTimestamp: consentGiven ? now : null,
      verified: Boolean(verified),
      updatedAt: now,
    };

    if (idx >= 0) {
      this.recipients[idx] = { ...this.recipients[idx], ...record };
    } else {
      this.recipients.push(record);
    }

    // Set as active recipientPhoneConsent if none set yet
    if (!this.recipientPhoneConsent.phone) {
      this.recipientPhoneConsent = { ...record, notes: '' };
    }

    this._saveToDisk();
    return record;
  }

  removeRecipient(phone) {
    if (phone) {
      this.recipients = this.recipients.filter((r) => r.phone !== phone);
      if (this.recipientPhoneConsent.phone === phone) {
        this.clearRecipientConsent();
      } else {
        this._saveToDisk();
      }
    } else {
      this.clearRecipientConsent();
    }
    return { success: true };
  }

  clearRecipientConsent() {
    this.recipientPhoneConsent = {
      phone: null,
      consentGiven: false,
      consentTimestamp: null,
      verified: false,
      notes: '',
      updatedAt: new Date().toISOString(),
    };
    this.recipients = [];
    this._saveToDisk();
    return this.recipientPhoneConsent;
  }

  // -------------------------------------------------------------
  // General Stats, Clear & Test Reset
  // -------------------------------------------------------------

  getStats() {
    return {
      totalReadings: this.history.length,
      maxHistory: this.maxHistory,
      hasLatest: this.latestReading !== null,
      lastUpdated: this.latestReading ? this.latestReading.receivedAt : null,
      hasWeather: this.latestWeather !== null,
      totalAlertsLogged: this.alertLog.length,
      totalRecipients: this.recipients.length,
      storeFile: this.filePath,
    };
  }

  clear() {
    this.latestReading = null;
    this.history = [];
    this._saveToDisk();
  }

  /**
   * Retrieves active monitoring site geolocation and safe shelter.
   */
  getSiteLocation() {
    return (
      this.siteLocation || {
        latitude: config.site?.latitude ?? config.SITE_LATITUDE ?? 19.1334,
        longitude: config.site?.longitude ?? config.SITE_LONGITUDE ?? 72.9133,
        label: config.site?.label ?? config.SITE_LABEL ?? 'IIT Bombay Hillside Station #1',
        safeDestination: config.map?.safeDestination || {
          latitude: config.SAFE_DEST_LATITUDE ?? 19.136,
          longitude: config.SAFE_DEST_LONGITUDE ?? 72.916,
          label: config.SAFE_DEST_LABEL ?? 'Campus Evacuation Center / Safe Shelter',
          verified: config.SAFE_DEST_VERIFIED ?? true,
        },
        isCustomLocation: false,
      }
    );
  }

  /**
   * Sets or overrides active monitoring site geolocation.
   *
   * @param {Object} location
   * @param {number} location.latitude
   * @param {number} location.longitude
   * @param {string} [location.label]
   * @param {Object} [location.safeDestination]
   * @returns {Object} Updated siteLocation
   */
  setSiteLocation(location = {}) {
    const lat = Number(location.latitude);
    const lng = Number(location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('Valid numeric latitude and longitude required');
    }

    const safeDest = location.safeDestination || {
      latitude: Number((lat + 0.012).toFixed(4)),
      longitude: Number((lng + 0.012).toFixed(4)),
      label: location.safeDestLabel || 'Designated Safe Evacuation Zone / Shelter',
      verified: location.safeDestVerified ?? true,
    };

    this.siteLocation = {
      latitude: lat,
      longitude: lng,
      label: location.label || `Custom Station (${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E)`,
      safeDestination: safeDest,
      updatedAt: new Date().toISOString(),
      isCustomLocation: true,
    };

    if (this.autoPersist) {
      this._saveToDisk();
    }
    return this.siteLocation;
  }

  /**
   * Retrieves the physical hardware setup location (deployed slope sensor node).
  /**
   * Returns the hardware setup location.
   * Reads exclusively from hardware-reported GPS data without hard-coded fallback coordinates.
   *
   * @returns {Object} Hardware setup location metadata
   */
  getHardwareLocation() {
    if (this.hardwareLocation && this.hardwareLocation.latitude !== null && this.hardwareLocation.longitude !== null) {
      return this.hardwareLocation;
    }

    return {
      latitude: null,
      longitude: null,
      altitude_m: null,
      station_id: null,
      label: 'Awaiting Hardware GPS Location',
      isLiveGps: false,
      isHardwareReported: false,
      status: 'UNAVAILABLE',
      updatedAt: null,
      fixTime: null,
    };
  }

  /**
   * Updates the physical hardware setup location (from firmware GPS payload only).
   *
   * @param {Object} location
   * @param {number|null} location.latitude
   * @param {number|null} location.longitude
   * @param {number} [location.altitude_m]
   * @param {string} [location.station_id]
   * @param {string} [location.label]
   * @param {boolean} [location.isLiveGps]
   * @param {number} [location.gps_satellites]
   * @param {number} [location.gps_speed]
   * @param {string} [location.fixTime]
   * @returns {Object} Updated hardwareLocation
   */
  setHardwareLocation(location = {}) {
    const rawLat = location.latitude;
    const rawLng = location.longitude;
    const lat = rawLat !== undefined && rawLat !== null ? Number(rawLat) : null;
    const lng = rawLng !== undefined && rawLng !== null ? Number(rawLng) : null;
    const isLive = Boolean(location.isLiveGps);
    const hasValidCoords = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    const hasFix = isLive && hasValidCoords;

    const now = new Date().toISOString();
    this.hardwareLocation = {
      latitude: hasValidCoords ? lat : null,
      longitude: hasValidCoords ? lng : null,
      altitude_m: location.altitude_m !== undefined && location.altitude_m !== null ? Number(location.altitude_m) : null,
      station_id: location.station_id || 'ESP32_LANDSLIDE_01',
      label: hasFix ? (location.label || `Hardware Node (${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E)`) : 'Hardware Node (No GPS Fix)',
      isLiveGps: hasFix,
      isHardwareReported: true,
      gps_satellites: location.gps_satellites !== undefined ? location.gps_satellites : null,
      gps_speed: location.gps_speed !== undefined ? location.gps_speed : null,
      updatedAt: now,
      fixTime: hasFix ? (location.fixTime || now) : null,
      status: hasFix ? 'AVAILABLE' : 'UNAVAILABLE',
    };

    if (this.autoPersist) {
      this._saveToDisk();
    }
    return this.hardwareLocation;
  }

  clearHardwareLocation() {
    this.hardwareLocation = null;
    if (this.autoPersist) {
      this._saveToDisk();
    }
  }

  /**
   * Resets the entire store for automated tests.
   * Wipes memory and cleans persisted store.json.
   *
   * @param {Object} [initialData] Optional seed data for test setup
   */
  _resetForTests(initialData = {}) {
    this.latestReading = initialData.latestReading ?? null;
    this.history = initialData.history ? [...initialData.history] : [];
    this.latestWeather = initialData.latestWeather ?? null;
    this.alertLog = initialData.alertLog ? [...initialData.alertLog] : [];
    this.alertDedup = {
      lastLevel: null,
      lastStatus: 'SAFE',
      lastAlertSentAt: null,
      lastBroadcastAt: null,
      cooldowns: {},
      ...(initialData.alertDedup || {}),
    };
    this.recipientPhoneConsent = {
      phone: null,
      consentGiven: false,
      consentTimestamp: null,
      verified: false,
      notes: '',
      updatedAt: null,
      ...(initialData.recipientPhoneConsent || {}),
    };
    this.recipients = initialData.recipients
      ? [...initialData.recipients]
      : [];
    this.siteLocation = initialData.siteLocation ?? null;
    this.hardwareLocation = initialData.hardwareLocation ?? null;

    this._saveToDisk();
  }
}

// Global singleton instance backed by server/data/store.json
export const store = new SensorStore({ isDefaultStore: true });
export default store;
