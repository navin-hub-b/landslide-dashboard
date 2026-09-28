/**
 * ESP32 Landslide Early-Warning System - GPS & Sensor Telemetry Node
 * 
 * Target Board: ESP32 DevKit V1
 * Sensors:
 *  - Analog Soil Moisture (Capacitive/Resistive) -> GPIO 34 (AO)
 *  - Analog Raindrop Sensor Plate -> GPIO 35 (AO)
 *  - MPU6050 6-DOF IMU (Accelerometer + Gyro) -> I2C (SDA 21, SCL 22)
 *  - Mechanical Ball Tilt Switch -> GPIO 27 (DO)
 *  - HC-SR04 Ultrasonic Distance Sensor -> TRIG GPIO 5, ECHO GPIO 18 (via 1k/2k voltage divider)
 *  - NEO-6M GPS Module -> TX to GPIO 16 (ESP32 RX), RX to GPIO 17 (ESP32 TX)
 * Actuators:
 *  - Active Buzzer -> GPIO 23
 *  - Status LEDs -> Green (GPIO 25), Yellow (GPIO 26), Red (GPIO 33)
 *
 * Reference: ESP32 Landslide Early-Warning System — GPS Full Guide
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <TinyGPSPlus.h>
#include <math.h>

// =============================================================================
// NETWORK & BACKEND CONFIGURATION
// =============================================================================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// BACKEND DESTINATION:
// Method 1 (Recommended - Zero-Server Cloud Architecture):
// Set to your Firebase Realtime Database URL (ending in /landslide/latest.json):
// e.g. "https://YOUR-PROJECT-ID-default-rtdb.firebaseio.com/landslide/latest.json"
//
// Or Local Node.js Server:
// "http://YOUR_SERVER_IP:5000/api/sensor-data"
const char* DASHBOARD_URL = "https://YOUR-PROJECT-ID-default-rtdb.firebaseio.com/landslide/latest.json";
const char* API_KEY       = ""; // Optional X-API-Key or Firebase Auth Token

// =============================================================================
// PIN DEFINITIONS
// =============================================================================
#define SOIL_PIN    34
#define RAIN_PIN    35
#define MPU_SDA     21
#define MPU_SCL     22
#define TILT_PIN    27
#define TRIG_PIN    5
#define ECHO_PIN    18
#define BUZZER_PIN  23
#define GREEN_LED   25
#define YELLOW_LED  26
#define RED_LED     33
#define GPS_RX      16
#define GPS_TX      17

// =============================================================================
// GLOBAL OBJECTS & SENSOR STATE
// =============================================================================
TinyGPSPlus gps;
HardwareSerial GPS_Serial(2);

Adafruit_MPU6050 mpu;
bool mpuOK = false;

// GPS Telemetry
float latitude       = 0.0;
float longitude      = 0.0;
float gpsAltitude    = 0.0;
float gpsSpeed       = 0.0;
int   gpsSatellites  = 0;
bool  gpsValid       = false;

// Sensor Calibration & Constants
const int SOIL_DRY    = 4095;
const int SOIL_WET    = 1500;
const int RAIN_DRY    = 4095;
const int RAIN_WET    = 1000;
const int TILT_ACTIVE = LOW;

// Sampling & Transmission Timing
const unsigned long SENSOR_INTERVAL    = 10000UL; // 10 seconds
const unsigned long DASHBOARD_INTERVAL = 10000UL; // 10 seconds
const unsigned long WIFI_RETRY_INTERVAL = 15000UL; // 15 seconds

// Rolling 1-Hour Trend Buffer (360 samples at 10s intervals)
#define HISTORY_SIZE 360
float soilHistory[HISTORY_SIZE];
float rainHistory[HISTORY_SIZE];
int historyIndex = 0;
int historyCount = 0;

// Geotechnical & Incline Variables
float soilTrend        = 0.0;
float rainTrend        = 0.0;
float soilPercent      = 0.0;
float rainPercent      = 0.0;
float angleX           = 0.0;
float angleY           = 0.0;
float acceleration     = 0.0;
float distanceCm       = -1.0;
float baselineDistance = 0.0;
float displacementCm   = 0.0;

int  soilRaw     = 0;
int  rainRaw     = 0;
int  riskScore   = 0;
bool tiltSensor  = false;
bool sensorFault = false;

unsigned long lastSensorRead    = 0;
unsigned long lastDashboardSend = 0;
unsigned long lastWiFiAttempt   = 0;

// =============================================================================
// WI-FI CONNECTION MANAGEMENT
// =============================================================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");

  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi connection failed. Will retry later.");
  }
}

// =============================================================================
// GPS NMEA PARSER (NEO-6M via HardwareSerial 2)
// =============================================================================
void readGPS() {
  while (GPS_Serial.available()) {
    gps.encode(GPS_Serial.read());
  }

  if (gps.location.isValid()) {
    gpsValid  = true;
    latitude  = gps.location.lat();
    longitude = gps.location.lng();
  }

  if (gps.altitude.isValid()) {
    gpsAltitude = gps.altitude.meters();
  }

  if (gps.speed.isValid()) {
    gpsSpeed = gps.speed.kmph();
  }

  if (gps.satellites.isValid()) {
    gpsSatellites = gps.satellites.value();
  }
}

// =============================================================================
// SENSOR READING FUNCTIONS
// =============================================================================
float readSoil() {
  soilRaw = analogRead(SOIL_PIN);
  float pct = 100.0 * (soilRaw - SOIL_DRY) / (float)(SOIL_WET - SOIL_DRY);
  return constrain(pct, 0.0, 100.0);
}

float readRain() {
  rainRaw = analogRead(RAIN_PIN);
  float pct = 100.0 * (rainRaw - RAIN_DRY) / (float)(RAIN_WET - RAIN_DRY);
  return constrain(pct, 0.0, 100.0);
}

float readUltrasonic() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long durationUs = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout (~5 meters)
  if (durationUs == 0) {
    return -1.0; // Sensor timeout / fault
  }
  return durationUs * 0.0343 / 2.0;
}

void readMPU() {
  if (!mpuOK) {
    angleX = 0.0;
    angleY = 0.0;
    acceleration = 0.0;
    return;
  }

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  acceleration = sqrt(
    a.acceleration.x * a.acceleration.x +
    a.acceleration.y * a.acceleration.y +
    a.acceleration.z * a.acceleration.z
  );

  angleX = atan2(a.acceleration.y, a.acceleration.z) * 180.0 / PI;
  angleY = atan2(-a.acceleration.x, sqrt(a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z)) * 180.0 / PI;
}

void updateHistory() {
  soilHistory[historyIndex] = soilPercent;
  rainHistory[historyIndex] = rainPercent;
  historyIndex = (historyIndex + 1) % HISTORY_SIZE;
  if (historyCount < HISTORY_SIZE) historyCount++;
}

float trend(float buffer[]) {
  if (historyCount < 2) return 0.0;
  int oldIdx = (historyIndex - historyCount + HISTORY_SIZE) % HISTORY_SIZE;
  int newIdx = (historyIndex - 1 + HISTORY_SIZE) % HISTORY_SIZE;
  return buffer[newIdx] - buffer[oldIdx];
}

// =============================================================================
// RISK FORMULA CALCULATION
// =============================================================================
int calculateRisk() {
  int s = 0;

  // 1. Soil moisture
  if (soilPercent >= 80) s += 3;
  else if (soilPercent >= 60) s += 2;
  else if (soilPercent >= 40) s += 1;

  // 2. Rain level
  if (rainPercent >= 80) s += 3;
  else if (rainPercent >= 60) s += 2;
  else if (rainPercent >= 40) s += 1;

  // 3. Slope tilt
  float maxTilt = max(abs(angleX), abs(angleY));
  if (maxTilt >= 20.0) s += 3;
  else if (maxTilt >= 10.0) s += 2;
  else if (maxTilt >= 5.0)  s += 1;

  // 4. Digital tilt switch trigger
  if (tiltSensor) s += 2;

  // 5. Vibration / acceleration anomaly
  if (acceleration > 13.0) s += 2;
  else if (acceleration > 11.0) s += 1;

  // 6. Ultrasonic ground displacement
  if (baselineDistance > 0) {
    if (displacementCm > 5.0) s += 3;
    else if (displacementCm > 2.0) s += 2;
    else if (displacementCm > 1.0) s += 1;
  }

  // 7. 1-Hour Trends (only after at least 60 samples / 10 minutes)
  if (historyCount >= 60) {
    if (soilTrend > 25.0) s += 2;
    else if (soilTrend > 10.0) s += 1;

    if (rainTrend > 25.0) s += 2;
    else if (rainTrend > 10.0) s += 1;
  }

  return s;
}

String statusText() {
  if (sensorFault) return "SENSOR_FAULT";
  if (riskScore >= 10) return "DANGER";
  if (riskScore >= 7)  return "HIGH_RISK";
  if (riskScore >= 4)  return "WARNING";
  return "SAFE";
}

// =============================================================================
// ACOUSTIC & OPTICAL ACTUATION
// =============================================================================
void warningOutput() {
  String st = statusText();

  digitalWrite(GREEN_LED, LOW);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  if (st == "SAFE") {
    digitalWrite(GREEN_LED, HIGH);
  } else if (st == "WARNING") {
    digitalWrite(YELLOW_LED, HIGH);
    if ((millis() / 1000) % 5 == 0) {
      digitalWrite(BUZZER_PIN, HIGH);
    }
  } else if (st == "HIGH_RISK") {
    digitalWrite(RED_LED, HIGH);
    if ((millis() / 1000) % 2 == 0) {
      digitalWrite(BUZZER_PIN, HIGH);
    }
  } else if (st == "DANGER") {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
  } else {
    digitalWrite(YELLOW_LED, HIGH);
  }
}

// =============================================================================
// PERIODIC SENSOR ACQUISITION
// =============================================================================
void readSensors() {
  soilPercent = readSoil();
  rainPercent = readRain();
  readMPU();

  distanceCm = readUltrasonic();
  if (distanceCm > 0) {
    if (baselineDistance <= 0) baselineDistance = distanceCm;
    displacementCm = abs(distanceCm - baselineDistance);
  }

  tiltSensor = (digitalRead(TILT_PIN) == TILT_ACTIVE);
  sensorFault = (distanceCm < 0 || !mpuOK);

  updateHistory();
  soilTrend = trend(soilHistory);
  rainTrend = trend(rainHistory);

  riskScore = calculateRisk();
  warningOutput();

  Serial.printf(
    "Soil %.1f%% Rain %.1f%% Tilt %.2f/%.2f Dist %.2f Disp %.2f Risk %d %s\n",
    soilPercent, rainPercent, angleX, angleY, distanceCm, displacementCm, riskScore, statusText().c_str()
  );

  if (gpsValid) {
    Serial.printf("GPS Fix: Lat %.6f, Lng %.6f, Alt %.1fm, Sats %d\n", latitude, longitude, gpsAltitude, gpsSatellites);
  } else {
    Serial.println("GPS: Waiting for satellite fix...");
  }
}

// =============================================================================
// TELEMETRY TRANSMISSION (HTTP POST)
// =============================================================================
void sendDashboard() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = DASHBOARD_URL;

  if (url.startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    http.begin(secureClient, url);
  } else {
    WiFiClient client;
    http.begin(client, url);
  }

  http.addHeader("Content-Type", "application/json");
  if (String(API_KEY).length() > 0) {
    http.addHeader("X-API-Key", API_KEY);
  }

  String json = "{";
  json += "\"device\":\"ESP32_LANDSLIDE_01\",";
  json += "\"gps_valid\":" + String(gpsValid ? "true" : "false") + ",";
  json += "\"latitude\":" + String(latitude, 6) + ",";
  json += "\"longitude\":" + String(longitude, 6) + ",";
  json += "\"gps_altitude\":" + String(gpsAltitude, 2) + ",";
  json += "\"gps_speed\":" + String(gpsSpeed, 2) + ",";
  json += "\"gps_satellites\":" + String(gpsSatellites) + ",";
  json += "\"soil_moisture\":" + String(soilPercent, 2) + ",";
  json += "\"rain_level\":" + String(rainPercent, 2) + ",";
  json += "\"soil_raw\":" + String(soilRaw) + ",";
  json += "\"rain_raw\":" + String(rainRaw) + ",";
  json += "\"tilt_x\":" + String(angleX, 2) + ",";
  json += "\"tilt_y\":" + String(angleY, 2) + ",";
  json += "\"acceleration\":" + String(acceleration, 2) + ",";
  json += "\"distance_cm\":" + String(distanceCm, 2) + ",";
  json += "\"displacement_cm\":" + String(displacementCm, 2) + ",";
  json += "\"tilt_sensor\":" + String(tiltSensor ? "true" : "false") + ",";
  json += "\"soil_trend\":" + String(soilTrend, 2) + ",";
  json += "\"rain_trend\":" + String(rainTrend, 2) + ",";
  json += "\"history_samples\":" + String(historyCount) + ",";
  json += "\"risk_score\":" + String(riskScore) + ",";
  json += "\"status\":\"" + statusText() + "\",";
  json += "\"sensor_fault\":" + String(sensorFault ? "true" : "false") + ",";
  json += "\"uptime_ms\":" + String(millis());
  json += "}";

  Serial.println("Transmitting telemetry to dashboard / cloud...");
  int httpCode = 0;
  if (url.indexOf("firebaseio.com") >= 0 || url.endsWith(".json")) {
    httpCode = http.PUT(json);
  } else {
    httpCode = http.POST(json);
  }
  Serial.printf("HTTP Response code: %d\n", httpCode);

  if (httpCode > 0) {
    Serial.println(http.getString());
  }

  http.end();
}

// =============================================================================
// MAIN ARDUINO SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);

  GPS_Serial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  pinMode(TILT_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);

  Wire.begin(MPU_SDA, MPU_SCL);
  if (mpu.begin()) {
    mpuOK = true;
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("MPU6050 sensor initialized successfully");
  } else {
    Serial.println("MPU6050 sensor NOT detected! Check SDA/SCL lines.");
  }

  connectWiFi();
  Serial.println("LANDSLIDE EARLY-WARNING SYSTEM READY");
}

// =============================================================================
// MAIN ARDUINO LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  readGPS();

  if (WiFi.status() != WL_CONNECTED && now - lastWiFiAttempt >= WIFI_RETRY_INTERVAL) {
    lastWiFiAttempt = now;
    connectWiFi();
  }

  if (now - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = now;
    readSensors();
  }

  if (now - lastDashboardSend >= DASHBOARD_INTERVAL) {
    lastDashboardSend = now;
    sendDashboard();
  }

  warningOutput();
}
