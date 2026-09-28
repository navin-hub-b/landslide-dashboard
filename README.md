# ⛰️ ESP32 Landslide Early-Warning Dashboard & API Server

A real-time telemetry ingestion server, risk calculation engine, and mobile-first geotechnical dashboard for the **ESP32 Landslide Early-Warning System**. Built with Node.js/Express (ESM), MapLibre GL JS, Open-Meteo, OSRM, and Node's built-in test runner (`node:test`).

---

## 1. System Architecture

```
[Hillside Geotechnical Sensors]
  ├── Soil Moisture (Analog AO -> GPIO 34)
  ├── Rain Sensor Module (Analog AO -> GPIO 35)
  ├── MPU6050 (6-DoF I2C IMU -> SDA: GPIO 21, SCL: GPIO 22)
  ├── SW-520D Tilt Sensor (Digital DO -> GPIO 27, Active LOW)
  └── HC-SR04 Ultrasonic (TRIG: GPIO 5, ECHO: GPIO 18 via 1kΩ:2kΩ Divider)
        │
        ▼
   [ESP32 DevKit V1] ─── Computes Onboard Risk (0–10+) & Local Alerts (LEDs + Buzzer)
        │
        ▼ Wi-Fi HTTP POST (JSON Every 10s)
[Node.js / Express API Server] (Port 5000)
  ├── Ingestion & Freshness Validation (server/modules/hardware.js)
  ├── Meteorological Intelligence (server/modules/weather.js via Open-Meteo)
  ├── Dual Risk Scoring Engine (server/modules/risk.js: Hardware + Forecast)
  ├── JSON File-Backed Store & Audit Log (server/store.js: 360-sample ring buffer, >=500 alerts)
  ├── Emergency SMS & Dedup Engine (server/modules/notifications.js: Console / Twilio)
  ├── Turn-by-Turn Evacuation Routing (server/modules/routing.js via OSRM)
  └── Multilingual Warning Engine (server/modules/translations.js: 19 Indian Languages)
        │
        ▼
[Mobile-First Responsive Dashboard] (public/)
  ├── Real-time Geotechnical Telemetry & Freshness Badges
  ├── Multi-Hazard Risk Breakdown & Explanations
  ├── MapLibre GL Map with Evacuation Corridor & Satellite Imagery Toggle
  ├── Full-Screen Cycling Warning Banner (Auto-switches on HIGH_RISK / DANGER)
  └── Browser Push Notifications & Recipient Consent Management
```

---

## 2. ESP32 Pin Connections & Hardware Guide

Refer to `firmware/ESP32_Landslide_Early_Warning_Full_Implementation_Guide.pdf` for complete electrical and assembly details.

All sensor grounds and ESP32 GND pins must share a **common electrical ground**.

| Sensor / Component | ESP32 Pin | Connection Type | Voltage / Operational Notes |
| :--- | :--- | :--- | :--- |
| **Soil Moisture AO** | **GPIO 34** | Analog Input (ADC1) | Powered from 3.3V pin; ADC1 is safe with Wi-Fi active. |
| **Soil VCC / GND** | **3.3V / GND** | Power & Ground | 3.3V supply. |
| **Rain Sensor AO** | **GPIO 35** | Analog Input (ADC1) | Powered from 3.3V pin; calibrated 0–100% wetness. |
| **Rain VCC / GND** | **3.3V / GND** | Power & Ground | 3.3V supply. |
| **MPU6050 SDA** | **GPIO 21** | I2C Data | 3.3V logic; default I2C clock 100 kHz. |
| **MPU6050 SCL** | **GPIO 22** | I2C Clock | 3.3V logic. |
| **MPU6050 VCC / GND** | **3.3V / GND** | Power & Ground | 3.3V supply. |
| **Tilt Switch DO** | **GPIO 27** | Digital Input (`INPUT_PULLUP`) | 3.3V logic; Active LOW (`TILT_ACTIVE = LOW`). |
| **Tilt VCC / GND** | **3.3V / GND** | Power & Ground | 3.3V supply. |
| **HC-SR04 TRIG** | **GPIO 5** | Digital Output | 10 µs trigger pulse. |
| **HC-SR04 ECHO** | **GPIO 18** | Digital Input via Divider | **MANDATORY**: 1kΩ / 2kΩ voltage divider (5V → 3.33V). |
| **HC-SR04 VCC / GND**| **5V (VIN) / GND** | Power & Ground | 5V supply required for ultrasonic transducer sensitivity. |
| **Active Buzzer (+ / -)** | **GPIO 23 / GND** | Digital Output | Active buzzer (use 2N2222 transistor for loads > 20 mA). |
| **Green LED** | **GPIO 25** | Digital Output via Resistor | Normal / SAFE status; 220–330 Ω series resistor. |
| **Yellow LED** | **GPIO 26** | Digital Output via Resistor | WARNING / FAULT status; 220–330 Ω series resistor. |
| **Red LED** | **GPIO 33** | Digital Output via Resistor | HIGH_RISK / DANGER status; 220–330 Ω series resistor. |

### ⚠️ Mandatory HC-SR04 Voltage Divider Circuit
The HC-SR04 ultrasonic sensor requires a 5V power supply to transmit ultrasound pulses effectively. However, its ECHO line outputs a 5V TTL pulse that **exceeds the 3.3V maximum tolerance of ESP32 GPIOs**. Connect the ECHO pin through this resistor divider:

```
HC-SR04 ECHO (5V) ───[ 1 kΩ ]───┬─── GPIO 18 (ESP32)
                                │
                             [ 2 kΩ ]
                                │
                               GND
V_GPIO = 5V × (2000 / (1000 + 2000)) = 3.33V (Safe for ESP32)
```

---

## 3. ESP32 Connection & Ingestion API

The ESP32 firmware posts telemetry every 10 seconds to:
```http
POST /api/sensor-data HTTP/1.1
Host: <SERVER_IP>:5000
Content-Type: application/json
X-API-Key: <HARDWARE_API_KEY>   (Optional in prototype when unconfigured)
```

### Exact JSON Payload Specification
```json
{
  "device": "ESP32_DEVKIT_V1",
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

### Ingestion Validation & Staleness Tracking:
- `soil_moisture` / `rain_level`: Calibrated percentage (`0.00` to `100.00`).
- `tilt_x` / `tilt_y`: Pitch and roll angles (`-90.00°` to `+90.00°`).
- `acceleration`: Resultant vector magnitude ($\sqrt{a_x^2 + a_y^2 + a_z^2}$) in $m/s^2$ (`0.00` to `50.00`).
- `distance_cm`: Distance from ultrasonic sensor (`-1.00` for timeout/fault, or `2.00` to `500.00` cm).
- `displacement_cm`: Absolute delta from established baseline $|distance - baselineDistance|$ (`0.00` to `500.00` cm).
- `sensor_fault`: Explicit boolean flag.
- **Hardware Staleness**: The server tracks the elapsed time since the last valid POST. If no reading is received within `HARDWARE_STALE_SECONDS` (default: 60s), the station is marked `STALE` and the risk engine raises an offline warning.

---

## 4. Meteorological Forecast Integration (Open-Meteo)

The server automatically correlates in-situ geotechnical telemetry with regional weather forecasts:
- **Upstream Provider**: [Open-Meteo API](https://open-meteo.com) (free, non-commercial and commercial open-access, zero API key required).
- **Default Site Coordinates**: Latitude `19.1334`, Longitude `72.9133` (IIT Bombay Hillside Station #1, Powai).
- **Background Polling**: Automated polling worker fetches hourly precipitation forecasts every `WEATHER_CHECK_INTERVAL_MINUTES` (default: 15 minutes).
- **Cache & Staleness**: Forecast data is cached in `server/data/store.json`. If cache age exceeds `WEATHER_CACHE_MINUTES` (15m), it is marked `STALE`.
- **Strict Degradation Handling**: If the Open-Meteo network request fails or times out, the server logs an explicit error object, sets weather risk contribution to `0`, and flags `usable: false`. It **never fabricates forecast data** or masks meteorological outages.
- **Manual Trigger**: `POST /api/weather/refresh` allows on-demand cache revalidation.

---

## 5. Risk Assessment Formula & Provisional Thresholds

The system evaluates cumulative risk by combining the firmware's on-site geotechnical scoring (Section 6 of guide) with the server's forward-looking weather forecast.

### Part A: Firmware Geotechnical Score (0–17+ Points)
Evaluated every 10 seconds:

| Indicator | Condition / Threshold | Points | Rationale |
| :--- | :--- | :---: | :--- |
| **Soil Moisture (`soilPct`)** | $\ge 80\%$ | **+3** | Critical soil saturation; loss of shear strength |
| | $\ge 60\%$ and $< 80\%$ | **+2** | Heavy saturation |
| | $\ge 40\%$ and $< 60\%$ | **+1** | Moderate wetness |
| **Rain Level (`rainPct`)** | $\ge 80\%$ | **+3** | Torrential rainfall detected on sensor surface |
| | $\ge 60\%$ and $< 80\%$ | **+2** | Heavy rainfall |
| | $\ge 40\%$ and $< 60\%$ | **+1** | Moderate rainfall |
| **Tilt Angle (`max(\|angleX\|, \|angleY\|)`)** | $\ge 20^\circ$ | **+3** | Severe slope movement / sensor tilt |
| | $\ge 10^\circ$ and $< 20^\circ$ | **+2** | Significant slope creep |
| | $\ge 5^\circ$ and $< 10^\circ$ | **+1** | Minor angular deviation |
| **Mechanical Tilt Switch** | `LOW` (Triggered) | **+2** | Independent mechanical verification of displacement |
| **Resultant Acceleration** | $> 13.0\ m/s^2$ | **+2** | Dynamic shock, vibration, or slope slip |
| | $> 11.0\ m/s^2$ and $\le 13.0\ m/s^2$| **+1** | Moderate ground vibration |
| **Ultrasonic Displacement** | $> 5.0\text{ cm}$ | **+3** | Major ground mass displacement |
| *(if baseline established)* | $> 2.0\text{ cm}$ and $\le 5.0\text{ cm}$ | **+2** | Moderate ground movement |
| | $> 1.0\text{ cm}$ and $\le 2.0\text{ cm}$ | **+1** | Subtle surface displacement |
| **1-Hour Trend Analysis** | Soil trend $> 25\%$ | **+2** | Rapid saturation rate |
| *(requires history_samples $\ge 60$)* | Soil trend $> 10\%$ and $\le 25\%$ | **+1** | Steady saturation rate |
| | Rain trend $> 25\%$ | **+2** | Intensifying rain storm |
| | Rain trend $> 10\%$ and $\le 25\%$ | **+1** | Steady precipitation buildup |

### Part B: Weather Forecast Addition (0–3 Points)
The server inspects the maximum hourly rainfall predicted over the next 6 hours:
- $\ge 10.0\text{ mm/h}$ (`WEATHER_HEAVY_RAIN_MM`): **+3 Points**
- $\ge 2.5\text{ mm/h}$ (`WEATHER_MODERATE_RAIN_MM`): **+1 Point**
- Stale, missing, or error weather data: **+0 Points** (`usable: false`, clearly noted).

### Part C: Status Mapping & Precedence
```
if (sensorFault || distanceCm < 0) ──► SENSOR_FAULT
else if (totalScore >= 10)         ──► DANGER
else if (totalScore >= 7)          ──► HIGH_RISK
else if (totalScore >= 4)          ──► WARNING
else                               ──► SAFE
```
*Note: If no reading has yet been received by the server, status returns `UNKNOWN` (never falsely assumes `SAFE`).*

| Score | Status | Hardware Indication | Buzzer Behavior | Action Recommended |
| :---: | :--- | :--- | :--- | :--- |
| **0 – 3** | `SAFE` | Green LED ON | OFF | Normal monitoring |
| **4 – 6** | `WARNING` | Yellow LED ON | Beep every 5s | Heightened awareness, inspect slope |
| **7 – 9** | `HIGH_RISK` | Red LED ON | Beep every 2s | Evacuation standby; prep vulnerable groups |
| **10+** | `DANGER` | Red LED ON | Continuous alarm | **Immediate evacuation to shelter** |
| **—** | `SENSOR_FAULT`| Yellow LED ON | Beep every 5s | Inspect wiring, ultrasonic, or MPU6050 |

---

## 6. Emergency SMS Notifications & Recipient Consent

### 1. Opt-In Recipient Consent Invariant
In accordance with ethical alerting and anti-spam protocols:
- Phone numbers can **only** be saved with explicit affirmative consent (`consent: true`).
- `POST /api/recipient`: Rejects requests without `consent: true`.
- If no consenting recipient is registered, automatic SMS dispatch is cleanly skipped with an audit log record (`SMS skipped: no consenting recipient registered`). The system never falsely reports SMS delivery.

### 2. Deduplication & Escalation
- Cooldown timer (`ALERT_COOLDOWN_MINUTES`, default: 15 minutes) prevents repetitive SMS spam during prolonged warning conditions.
- **Escalation Bypass**: If risk escalates (e.g., `WARNING` $\to$ `DANGER`), cooldown is bypassed and emergency SMS dispatches immediately.
- **System Recovery**: When conditions return to `SAFE`, a recovery event is recorded in the audit log. Recovery events **never send SMS** and **never purge previous alert history**.
- **Audit History**: All dispatch attempts, simulated messages, and recoveries are stored in `server/data/store.json` (retaining $\ge 500$ entries).

### 3. Safe Test Alerts
- Triggered via `POST /api/alerts/test` or the dashboard UI button.
- **Safety Guard**: Always uses the simulated console provider and prefixes messages with `[TEST — not a real emergency]`.
- Will **refuse** execution with HTTP `400 Bad Request` unless a consenting phone number is provided or registered.
- Setting `ALLOW_REAL_TEST_SMS=true` in `.env` is strictly required to permit real cellular test dispatches via Twilio.

---

## 7. Evacuation Map, Satellite Imagery & Routing

The dashboard includes an interactive geospatial console powered by MapLibre GL JS:
- **Baseline Basemap**: OpenStreetMap raster tiles (`MAP_STYLE_URL`).
- **Satellite Layer**: High-resolution ESRI World Imagery raster tiles (`SATELLITE_TILE_URL`), toggleable via dashboard control.
- **Evacuation Corridor**: Open Source Routing Machine (`OSRM_BASE_URL`) computes an emergency navigation route connecting `SITE_LATITUDE/LONGITUDE` to the designated shelter `SAFE_DEST_LATITUDE/LONGITUDE`.
- **Strict Non-Fabrication**: If OSRM is offline or coordinates cannot be resolved, the routing module returns an explicit error object (`Routing service unavailable: route could not be computed`). It never fabricates fictional escape paths.
- **Shelter Verification Status (`SAFE_DEST_VERIFIED`)**:
  - `SAFE_DEST_VERIFIED=true`: Displayed with a green verified badge.
  - `SAFE_DEST_VERIFIED=false`: Displayed with a yellow provisional warning badge indicating the assembly location has not been officially inspected by civil defense authorities.

---

## 8. Multilingual Warning Signage & Verification Caveats

During `HIGH_RISK` or `DANGER` states, a high-contrast emergency warning sign appears, cycling through **19 regional Indian languages** every ~3.5 seconds with native typography and appropriate text directions (`dir="ltr"` or `dir="rtl"`). All other dashboard UI text remains in English.

### Accessibility & Reduced Motion
- Conforms to WCAG 2.1 Level AA.
- Detects the OS user preference `@media (prefers-reduced-motion: reduce)`: automatically halts the flashing/pulsing CSS animation, rendering a steady, high-contrast warning banner while preserving language cycling.

### Regional Language Matrix:
| Code | Language | Native Script | Direction | Verification Status |
| :--- | :--- | :--- | :---: | :--- |
| `hi` | Hindi | भूस्खलन खतरा — तुरंत सुरक्षित स्थान पर जाएं | LTR | High Confidence |
| `bn` | Bengali | ভূমিধস বিপদ — অবিলম্বে এলাকা ত্যাগ করুন | LTR | High Confidence |
| `mr` | Marathi | भूस्खलन धोका — तातडीने सुरक्षित ठिकाणी जा | LTR | High Confidence |
| `te` | Telugu | కొండచరియల ప్రమాదం — వెంటనే ఖాళీ చేయండి | LTR | High Confidence |
| `ta` | Tamil | நிலச்சரிவு ஆபத்து — உடனே வெளியேறவும் | LTR | High Confidence |
| `gu` | Gujarati | ભૂસ્ખલન જોખમ — તાત્કાલિક બહાર નીકળો | LTR | High Confidence |
| `ur` | Urdu | لینڈ سلائیڈنگ کا خطرہ — فوراً محفوظ مقام پر منتقل ہوں | **RTL** | High Confidence |
| `kn` | Kannada | ಭೂಕುಸಿತದ ಅಪಾಯ — ತಕ್ಷಣವೇ ಸ್ಥಳಾಂತರಿಸಿ | LTR | High Confidence |
| `or` | Odia | ଭୂସ୍ଖଳନ ବିପଦ — ତୁରନ୍ତ ସ୍ଥାନ ଖାଲି କରନ୍ତୁ | LTR | High Confidence |
| `ml` | Malayalam | ഉരുൾപൊട്ടൽ ഭീഷണി — ഉടൻ ഒഴിഞ്ഞുപോകുക | LTR | High Confidence |
| `as` | Assamese | ভূমিস্খলনৰ বিপদ — তৎকালীনভাৱে স্থান ত্যাগ কৰক | LTR | High Confidence |
| `ne` | Nepali | पहिरोको जोखिम — तुरुन्त सुरक्षित स्थानमा जानुहोस् | LTR | High Confidence |
| `mni`| Manipuri (Meitei) | ꯂꯩꯈꯥꯌꯕꯒꯤ ꯈꯨꯗꯣꯡꯊꯤꯕ — ꯍꯧꯖꯤꯛꯃꯛ ꯌꯥꯝꯅ ꯊꯨꯅ ꯂꯥꯞꯊꯣꯛꯎ | LTR | ⚠️ `needsVerification: true` |
| `lus`| Mizo | Leimin hlauhawm — Tunah tlanchhuak nghal rawh | LTR | ⚠️ `needsVerification: true` |
| `kha`| Khasi | Ka jinghap khyndew kaba ma — Phet noh mardor | LTR | ⚠️ `needsVerification: true` |
| `grt`| Garo | A·a be·ani kengnigipa — Da·on katrikbo | LTR | ⚠️ `needsVerification: true` |
| `brx`| Bodo | हास्रुग्नाय खौरां — दाखनोनो जायगा गार | LTR | ⚠️ `needsVerification: true` |
| `trp`| Kokborok | Hachuk baijakma khituk — Tabukno safe jaigat thangdi | LTR | ⚠️ `needsVerification: true` |
| `nag`| Nagamese | Mati bhanga denger ase — Etya he polabi | LTR | ⚠️ `needsVerification: true` |

> [!WARNING]
> **Translation Verification Caveat**:
> The 7 indigenous and dialectical languages marked `needsVerification: true` (Manipuri, Mizo, Khasi, Garo, Bodo, Kokborok, Nagamese) must be validated with local community leaders and native speakers before deploying physical emergency sirens or visual displays in those jurisdictions.

---

## 8. Dynamic Monitoring Location & Multi-Modal Emergency Alerting

The dashboard supports monitoring both your **live current location** and specific landslide hazard zones across India, coupled with multi-modal alerting when risk is detected:

### 1. Live Current Location & Hazard Presets
- **🎯 Use My Current Location**: Queries browser GPS (`navigator.geolocation`) and updates the monitoring station via `POST /api/site/location`. The server immediately fetches localized Open-Meteo precipitation forecasts, re-evaluates geotechnical risk, and recalculates the evacuation corridor to the nearest shelter.
- **📍 Indian Hazard Zone Presets**: Quickly monitor major slope instability zones:
  - *Wayanad, Kerala (Meppadi Slope)*: 11.5367° N, 76.1384° E
  - *Shimla, Himachal Pradesh (Ridge Station)*: 31.1048° N, 77.1734° E
  - *Joshimath, Uttarakhand (Chamoli Slope)*: 30.5564° N, 79.5647° E
  - *Darjeeling, West Bengal (Himalayan Ridge)*: 27.0410° N, 88.2663° E
  - *Munnar, Idukki, Kerala*: 10.0889° N, 77.0595° E
  - *Western Ghats (Lonavala / Khandala)*: 18.7557° N, 73.4091° E
  - *IIT Bombay Hillside Station #1 (Powai)*: 19.1334° N, 72.9133° E
- **Custom Coordinates**: Input any arbitrary latitude/longitude to track real-time rain and evacuation topology.

### 2. Multi-Modal Alerting When Risk is Detected
When composite landslide hazard reaches **`WARNING`**, **`HIGH_RISK`**, or **`DANGER`**, the dashboard dispatches multi-channel alerts:
1. **🔊 Audible Web Audio Siren / Alarm**: Synthesizes real acoustic tones via browser `AudioContext` matching Section 10 actuation modes:
   - `WARNING`: Periodic caution double-beeps (587 Hz) every 3.5s.
   - `HIGH_RISK`: Rapid alternating two-tone alarm (660 Hz / 880 Hz) at 450 ms intervals.
   - `DANGER`: Continuous high-pitch modulated warble siren (980 Hz ± 320 Hz LFO at 0.75 Hz).
   - Includes **"Test Siren Alert"**, **"Siren Sound: ON / MUTED"**, and **"Silence Siren"** controls.
2. **📳 Tactile Mobile Vibration**: Calls `navigator.vibrate()` with distinct rhythmic hazard pulses on compatible mobile devices.
3. **🔔 Native Browser Push Notifications**: Triggers system notifications with risk levels and evacuation advice upon risk escalation.
4. **🚨 19-Language Visual Warning Sign**: Full-screen flashing high-visibility banner cycling emergency instructions in 19 Indian languages during `HIGH_RISK` and `DANGER`.
5. **📱 Cellular / Console SMS Dispatch**: Automatically logs or sends SMS to registered affirmative-consent recipients.

### 3. Hardware Setup Location Access & Area Disaster Risk Detection
The dashboard decouples the **physical IoT sensor hardware node location on the slope** from the **user's viewing location**, allowing civil defense teams, local operators, and residents to detect and visualize the disaster hazard footprint over the entire terrain:

1. **Hardware Deployment Node Telemetry (`📡`)**:
   - The hardware setup transmits its real-time GNSS coordinates directly in `POST /api/sensor-data` (`latitude`, `longitude`, `altitude_m`, `station_id`, `station_label`).
   - Dedicated endpoints:
     - `GET /api/hardware/location`: Returns current deployment coordinates, altitude, station ID, and active hazard footprint.
     - `POST /api/hardware/location`: Allows operators to register or adjust the sensor node's geographic position.
   - UI Display: Station ID, elevation, latitude/longitude, and GPS live status badge.

2. **Disaster Risk Footprint Over the Slope Area**:
   - The server dynamically calculates the physical ground hazard radius and affected area ($\text{km}^2$) centered on the hardware node based on active risk:
     - **`DANGER`**: **600 m** critical debris flow / runout radius ($1.13\text{ km}^2$), **1,800 m** evacuation buffer ($10.18\text{ km}^2$).
     - **`HIGH_RISK`**: **400 m** shear & inundation radius ($0.50\text{ km}^2$), **1,200 m** evacuation buffer ($4.52\text{ km}^2$).
     - **`WARNING`**: **250 m** pre-failure moisture saturation radius ($0.20\text{ km}^2$), **750 m** buffer ($1.77\text{ km}^2$).
     - **`SAFE`**: **150 m** baseline monitoring radius ($0.07\text{ km}^2$), **400 m** buffer.
   - Renders 64-vertex dynamic GeoJSON circles directly on the MapLibre GL map (red fill for primary runout zone, amber outline for evacuation perimeter).
   - Includes map toolbar controls to toggle perimeter visibility and pan straight to the hardware installation.

3. **User Proximity & Threat Assessment**:
   - When the user enables device location or enters coordinates, the system computes the exact geodesic distance (Haversine formula) from the user to the hardware setup slope node.
   - Real-time proximity safety classification:
     - `INSIDE_CRITICAL_IMPACT_ZONE`: User is directly within the primary debris flow / rockfall runout envelope. Immediate evacuation siren and visual alert.
     - `PROXIMITY_WARNING_ZONE`: User is within the secondary evacuation buffer perimeter. Pre-evacuation readiness advised.
     - `SAFE_DISTANCE`: User is situated at a safe distance outside the active hazard corridor.

### 4. Interactive Live Demo Mode & Geotechnical Hazard Simulator
To test and demonstrate all system capabilities without needing physical ESP32 hardware deployed on a slope, the dashboard includes a full-featured **Live Demo & Simulation Engine**:

1. **Dashboard UI Controller (`🎮 Live Demo Mode`)**:
   - Prominent command-bar button opens the **Live Demo Controller Panel**.
   - **Live Stream Toggle**: `▶️ Start Live Demo Stream` / `⏸️ Pause Demo Stream` streams realistic synthetic sensor readings directly into the server at configurable frequencies (1x / 1.5x / 2.5x).
   - **Auto-Cycle Mode**: Progressively cycles through all four geotechnical hazard phases (`SAFE` $\to$ `WARNING` $\to$ `HIGH_RISK` $\to$ `DANGER` $\to$ `SAFE`) every 15 seconds, animating gauges, trend indicators, map circles, acoustic sirens, and warning signage.
   - **One-Click Instant Hazard Scenarios**:
     - 🟢 **1. Baseline Safe**: Moisture 24%, Rain 6%, 0.8° tilt, 0.2 cm displacement $\to$ Risk Score 0 (`SAFE`).
     - 🟡 **2. Monsoon Saturation**: Moisture 62%, Rain 52%, 5.5° tilt, 0.8 cm displacement $\to$ Risk Score 5 (`WARNING`), caution double-beep active.
     - 🟠 **3. Slope Creep & Shear**: Moisture 72%, Rain 70%, 12.0° tilt, 2.5 cm displacement $\to$ Risk Score 8 (`HIGH_RISK`), urgent alternating siren active.
     - 🔴 **4. Landslide Failure**: Moisture 90%, Rain 94%, 23.5° tilt, mechanical tilt tripped, 7.1 cm displacement, acceleration 15.8 m/s² $\to$ Risk Score 16+ (`DANGER`), continuous warble siren, full-screen 19-language emergency signage, and 600m map hazard circle.
     - ⚠️ **5. Transducer Fault**: Ultrasonic timeout (-1.0 cm) $\to$ `SENSOR_FAULT`.
   - **Manual Sensor Tweaker**: Interactive range sliders allow fine-tuning Soil Moisture (0–100%), Rain (0–100%), Incline Tilt (0–35°), Displacement (0–10 cm), and Mechanical Tilt Switch to observe the multi-hazard risk engine respond in real time.

2. **REST API Demo Endpoints**:
   - `GET /api/demo/status`: Returns current simulator state, active scenario, interval, and available presets.
   - `POST /api/demo/start`: Starts background telemetry generator (`{ intervalMs: 3000, autoCycle: true, scenario: "safe" }`).
   - `POST /api/demo/stop`: Pauses automated simulation.
   - `POST /api/demo/scenario`: Injects a specific preset scenario (`{ "scenario": "danger" }`).
   - `POST /api/sensor-data/simulate`: Injects arbitrary customized synthetic telemetry with complete risk scoring and notification evaluation.

---

## 9. Installation, Configuration & Running

### 1. Prerequisites
- **Node.js**: v20.0.0 or higher (v20.18+ recommended)
- **npm**: v10.0.0 or higher

### 2. Installation
Clone the repository and install dependencies:
```bash
cd landslide-dashboard
npm install
```

### 3. Environment Setup
Copy the template to `.env`:
```bash
cp .env.example .env
```
Key configuration parameters:
- `PORT`: Server port (default: `5000`).
- `SMS_PROVIDER`: Set to `console` (default, simulated logs) or `twilio` (cellular).
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_PHONE`: Required only if `SMS_PROVIDER=twilio`.
- `SAFE_DEST_VERIFIED`: Set to `true` only when the emergency shelter has been officially certified.

### 4. Running the Server
```bash
# Start in production mode
npm start

# Start in development mode (auto-reload on code change)
npm run dev
```
Open your browser to: **`http://localhost:5000`**

### 5. Running the Test Suite
The project uses Node.js's built-in test runner (`node:test`) and strict assertions (`node:assert/strict`). No Jest or external test libraries are used.
```bash
npm test
```

### 6. Syntax Verification (`node --check`)
Verify all server and public JavaScript files:
```bash
node --check server/index.js
node --check server/config.js
node --check server/store.js
node --check server/modules/hardware.js
node --check server/modules/weather.js
node --check server/modules/risk.js
node --check server/modules/phone.js
node --check server/modules/notifications.js
node --check server/modules/routing.js
node --check server/modules/translations.js
node --check server/routes/api.js
node --check public/app.js
```

---

## 10. Explicit Limitations & Disclaimers

> [!CAUTION]
> ### 1. Prototype & Educational Status
> This software and hardware reference design is a **research and proof-of-concept prototype**. It has not undergone ISO 13849 safety validation or industrial functional safety certification (SIL rating). It must NOT be used as the sole life-safety or evacuation system in hazardous inhabited zones.

> [!WARNING]
> ### 2. No Guaranteed Lead Time
> Any reference to a "1-hour early-warning lead time" is a **design objective** derived from gradual soil saturation and sensor trend accumulation (`history_samples >= 60`). **It is not an operational guarantee**. Abrupt slope failures, seismic co-seismic landslides, or flash debris flows can occur within seconds with zero prior ground displacement.

> [!IMPORTANT]
> ### 3. Unvalidated Geotechnical Thresholds
> The numerical scoring thresholds (e.g., soil moisture $\ge 80\%$, tilt $\ge 10^\circ$, displacement $> 2\text{ cm}$) are **provisional approximations** specified in the reference guide. Operational deployment requires calibration by licensed geotechnical engineers against local soil mechanics parameters (plastic limit, liquid limit, hydraulic conductivity, factor of safety $F_s$, and slope angle $\beta$).

> [!NOTE]
> ### 4. Unverified Evacuation Corridors
> Automated walking routes generated via OSRM are algorithmic estimates based on OpenStreetMap road and trail networks. In a real landslide scenario, designated paths may be blocked by mud, debris, or washed-out culverts. Routes must never be treated as official without physical ground-truthing and explicit certification (`SAFE_DEST_VERIFIED=true`) by emergency authorities.
