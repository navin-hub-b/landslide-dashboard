# Data Flow Architecture & End-to-End Traces

This reference document outlines the two primary telemetry ingestion and processing pipelines for the IIT Bombay Geotechnical Landslide Early-Warning System:

- **Path A: Hardware Geotechnical Telemetry**
- **Path B: GPS Deployment Geolocation & Hazard Envelopes**

---

## Path A: Hardware Geotechnical Telemetry Flow

Traces geotechnical sensor readings from physical transducers on the hillside through firmware, network transport, server-side validation, store persistence, risk evaluation, to real-time dashboard rendering.

### Hop 1: Physical Transducers to ESP32 DevKit V1
- **Firmware Implementation:** `firmware/esp32_landslide_node/esp32_landslide_node.ino` (and PDF implementation guide)
- **Physical Pins & Calibrations:**
  - Capacitive/resistive soil moisture sensor (`GPIO 34 / AO`): produces `soil_raw` (0–4095) and calibrated percentage `soil_moisture` (0.0%–100.0%).
  - Analog rain detector plate (`GPIO 35 / AO`): produces `rain_raw` (0–4095) and calibrated percentage `rain_level` (0.0%–100.0%).
  - MPU6050 6-DOF IMU (`I2C: SDA GPIO 21, SCL GPIO 22`): produces `tilt_x` (-180.0° to +180.0°), `tilt_y` (-180.0° to +180.0°), and acceleration magnitude `acceleration` (0.0 to 100.0 m/s²).
  - HC-SR04 ultrasonic distance transducer (`TRIG GPIO 5, ECHO GPIO 18` via 1kΩ/2kΩ voltage divider): produces `distance_cm` (0.0 to 500.0 cm or -1 for timeout fault) and delta `displacement_cm` relative to baseline.
  - Mechanical ball tilt switch (`GPIO 27 / DO`): produces boolean `tilt_sensor` (`true`/`false`).
  - Rolling trend analysis: `soilHistory[360]` and `rainHistory[360]` sampled every 10s calculate `soil_trend` and `rain_trend`.
  - Firmware risk scoring: `calculateRisk()` determines `risk_score` (0–100) and `status` (`"SAFE"`, `"WARNING"`, `"HIGH_RISK"`, `"DANGER"`, `"SENSOR_FAULT"`).

### Hop 2: ESP32 to Backend Gateway (HTTP POST)
- **Transport:** HTTP POST over Wi-Fi (`HTTPClient.h` / `WiFiClient.h`)
- **Target URL:** `http://<SERVER_IP>:5000/api/sensor-data`
- **Headers:** `Content-Type: application/json`, optional `X-API-Key: <HARDWARE_API_KEY>`
- **JSON Telemetry Fields:**
  ```json
  {
    "device": "ESP32_LANDSLIDE_01",
    "soil_moisture": 72.50,
    "rain_level": 64.20,
    "soil_raw": 2100,
    "rain_raw": 1800,
    "tilt_x": 4.25,
    "tilt_y": 2.10,
    "acceleration": 9.81,
    "distance_cm": 48.20,
    "displacement_cm": 1.40,
    "tilt_sensor": false,
    "soil_trend": 12.20,
    "rain_trend": 18.50,
    "history_samples": 120,
    "risk_score": 5,
    "status": "WARNING",
    "sensor_fault": false,
    "uptime_ms": 1234567
  }
  ```

### Hop 3: Server Routing & Ingestion Validation
- **Route Handler:** `server/routes/api.js` -> `router.post('/sensor-data')`
- **API Key Check:** `server/modules/hardware.js` -> `checkApiKey(headerValue)`
- **Validation:** `server/modules/hardware.js` -> `validateReading(body)`
  - Validates numeric ranges, integer constraints, and status enum.
- **Timestamping:** `server/modules/hardware.js` -> `ingestReading(data)` adds `receivedAt: <ISO 8601>`.

### Hop 4: Data Store & Risk Processing
- **File:** `server/store.js` -> `store.setLatestReading(reading)` & `store.addHistoryReading(reading)`
- **Persistence:** Synchronized to `server/data/store.json` (360-sample ring buffer).
- **Risk Assessment:** `server/modules/risk.js` -> `evaluateRisk({ reading, readingIsStale, weather })` combines hardware telemetry with Open-Meteo precipitation forecast.
- **Emergency Notifications:** `server/modules/notifications.js` -> `evaluateAndNotify(riskAssessment)` triggers deduplicated SMS dispatches and logs to the audit ledger.

### Hop 5: Client Polling Transport
- **Polling Loop:** `public/app.js` -> `pollState()` executes `GET /api/state` every ~10s.
- **Aggregated Response:**
  ```json
  {
    "success": true,
    "hardware": {
      "latest": { ...reading fields... },
      "isStale": false,
      "ageSeconds": 3,
      "status": "LIVE"
    },
    "risk": { "score": 5, "status": "WARNING", "breakdown": { ... } },
    "weather": { ... },
    "hazardArea": { ... }
  }
  ```

### Hop 6: Frontend DOM Rendering & Actuation
- **Renderer:** `public/app.js` -> `renderDashboard(data)` updates `public/index.html`:
  - `#soilMoistureValue` & `#soilTrend` <- `latest.soil_moisture`, `latest.soil_trend`
  - `#rainLevelValue` & `#rainTrend` <- `latest.rain_level`, `latest.rain_trend`
  - `#tiltX`, `#tiltY`, `#maxTiltAngle` <- `latest.tilt_x`, `latest.tilt_y`
  - `#accelValue` <- `latest.acceleration`
  - `#displacementValue` <- `latest.displacement_cm`
  - `#tiltSwitchBadge` <- `latest.tilt_sensor`
  - `#hardwareFreshnessBadge` <- `hardware.isStale`, `hardware.ageSeconds`
  - `#riskScoreValue` & `#riskStatusBadge` <- `risk.score`, `risk.status`
  - Web Audio API alarm and full-screen 19-language emergency signage activate if status is `HIGH_RISK` or `DANGER`.

---

## Path B: GPS Deployment Coordinates & Hazard Envelopes

Traces geographic coordinates from the satellite receiver on the slope node to the interactive geospatial map and threat radius calculations.

### Hop 1: GPS Constellation to NEO-6M Receiver
- **Hardware Module:** u-blox NEO-6M GPS Receiver with external ceramic patch antenna.
- **Physical Wiring:**
  - `NEO-6M TX` -> `ESP32 GPIO 16 (GPS_RX)`
  - `NEO-6M RX` -> `ESP32 GPIO 17 (GPS_TX)`
  - `NEO-6M VCC / GND` -> `3.3V / GND` (or 5V for regulated breakout boards)
- **Serial Interface:** ESP32 `HardwareSerial GPS_Serial(2)` configured at 9600 baud, 8N1.

### Hop 2: NMEA Stream Decoding on ESP32
- **Firmware Parser:** `TinyGPSPlus gps;` in `firmware/esp32_landslide_node/esp32_landslide_node.ino`
- **Processing Routine:** `readGPS()` feeds raw NMEA sentences (`$GPRMC`, `$GPGGA`) into `gps.encode()`.
- **Extracted Fields:**
  - `latitude`: `gps.location.lat()` (WGS-84 decimal degrees, e.g. `11.016800`)
  - `longitude`: `gps.location.lng()` (WGS-84 decimal degrees, e.g. `76.955800`)
  - `gps_valid`: boolean indicator (`gps.location.isValid()`)
  - `gps_altitude`: `gps.altitude.meters()` (e.g. `421.5` meters)
  - `gps_speed`: `gps.speed.kmph()` (e.g. `0.0` km/h)
  - `gps_satellites`: `gps.satellites.value()` (e.g. `8`)

### Hop 3: Transmission to Ingestion Endpoint
- Emitted in `sendDashboard()` inside `POST /api/sensor-data`:
  ```json
  {
    "device": "ESP32_LANDSLIDE_01",
    "gps_valid": true,
    "latitude": 11.016800,
    "longitude": 76.955800,
    "gps_altitude": 421.5,
    "gps_speed": 0.0,
    "gps_satellites": 8,
    ...geotechnical sensor fields...
  }
  ```

### Hop 4: Server Ingestion & Dynamic Geolocation Binding
- **Validation:** `server/modules/hardware.js` -> `validateReading(body)` validates:
  - `gps_valid`: boolean
  - `latitude`: numeric range [-90, +90]
  - `longitude`: numeric range [-180, +180]
  - `gps_altitude` / `altitude_m`: numeric range [-500, +9000]
  - `gps_speed`: numeric >= 0
  - `gps_satellites`: non-negative integer
- **Location Store Update:** `server/routes/api.js`:
  ```javascript
  if (validation.data.latitude !== undefined && validation.data.longitude !== undefined) {
    store.setHardwareLocation({
      latitude: validation.data.latitude,
      longitude: validation.data.longitude,
      altitude_m: validation.data.altitude_m,
      station_id: validation.data.station_id || validation.data.device,
      label: validation.data.station_label,
      isLiveGps: validation.data.gps_valid !== undefined ? Boolean(validation.data.gps_valid) : true,
      gps_satellites: validation.data.gps_satellites,
      gps_speed: validation.data.gps_speed,
    });
  }
  ```
- **Hazard Footprint Calculation:** `computeHazardAreaRisk(status, hardwareLoc, userLat, userLng)` dynamically sets the hazard center at `hardwareLoc.latitude` and `hardwareLoc.longitude`, scaling:
  - `DANGER`: 600m Critical Impact Zone / 1800m Buffer Zone
  - `HIGH_RISK`: 400m Critical Impact Zone / 1200m Buffer Zone
  - `WARNING`: 250m Critical Impact Zone / 750m Buffer Zone
  - `SAFE`: 150m Baseline Monitoring Radius

### Hop 5: Geospatial Map Display on Dashboard
- **State Endpoint:** `GET /api/state` supplies `hardwareLocation` and `hazardArea`.
- **Frontend Map Engine:** `public/app.js` using MapLibre GL JS:
  - Places node marker `📡` at `(hardwareLocation.longitude, hardwareLocation.latitude)`.
  - Generates 64-vertex GeoJSON circular polygon overlays for Critical Debris Impact Zone (red `#ef4444`) and Secondary Buffer Zone (amber `#f59e0b`).
  - Displays altitude, satellite count, and GPS fix state in the map overlay and station command bar.
  - Evaluates user distance via Haversine formula relative to the live hardware coordinates.
