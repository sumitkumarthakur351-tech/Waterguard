/**
 * ==============================================================================
 * PROJECT: WaterGuard — Smart Water Quality Monitoring System
 * HARDWARE: ESP32-WROOM-32 (38-Pin Development Board)
 * CLOUD: Google Firebase Realtime Database
 * 
 * SENSOR PINOUT (ADC1 pins chosen to work reliably alongside active Wi-Fi):
 * - pH Sensor Analog Out      -> GPIO 34 (ADC1_CH6)
 * - TDS Sensor Analog Out     -> GPIO 35 (ADC1_CH7)
 * - Turbidity Sensor (Analog) -> GPIO 32 (ADC1_CH4) [Switch module to 'A' mode]
 * - DS18B20 Waterproof Temp   -> GPIO 4 (Digital OneWire with 4.7k resistor)
 * 
 * LIBRARIES REQUIRED (Install via Arduino IDE Library Manager):
 * 1. "OneWire" by Paul Stoffregen
 * 2. "DallasTemperature" by Miles Burton
 * ==============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ==========================================
// 1. WI-FI & FIREBASE CREDENTIALS
// ==========================================
const char* WIFI_SSID     = "WaterGuard";      // Enter your Wi-Fi SSID
const char* WIFI_PASSWORD = "10203040";  // Enter your Wi-Fi Password

// Your WaterGuard Firebase Realtime Database REST URL:
const char* FIREBASE_URL  = "https://waterguard-67705-default-rtdb.asia-southeast1.firebasedatabase.app/.json";

// ==========================================
// 2. PIN DEFINITIONS
// ==========================================
#define PIN_PH         34   // Analog Input (ADC1)
#define PIN_TDS        35   // Analog Input (ADC1)
#define PIN_TURBIDITY  32   // Analog Input (ADC1)
#define PIN_TEMP_BUS   4    // Digital OneWire Data pin

// OneWire & DallasTemperature setup
OneWire oneWire(PIN_TEMP_BUS);
DallasTemperature tempSensor(&oneWire);

// ==========================================
// 3. CALIBRATION CONSTANTS
// ==========================================
// pH Calibration:
// - V_NEUTRAL: Voltage when probe is in neutral drinking water (~1.30V on your board)
// - PH_SLOPE: Sensitivity multiplier
float V_NEUTRAL = 1.30;  // Calibrated to 1.30V for packaged drinking water
float PH_SLOPE  = 3.50;  // Standard calibration slope for pH-4502C

// TDS Calibration Factor:
// 1.0 = Default. If your packaged water label says 150 ppm and it reads 210, set to (150.0/210.0 = 0.71)
float TDS_FACTOR = 1.00;

// Number of analog samples to average for noise reduction
const int NUM_SAMPLES = 20;

// Telemetry interval (transmit every 3 seconds)
const unsigned long SEND_INTERVAL = 3000;
unsigned long lastSendTime = 0;

// ==========================================
// HELPER: Average Analog Reading (Noise Filter)
// ==========================================
float getAverageVoltage(int pin) {
  long sum = 0;
  for (int i = 0; i < NUM_SAMPLES; i++) {
    sum += analogRead(pin);
    delay(5);
  }
  float avgRaw = (float)sum / NUM_SAMPLES;
  // ESP32 ADC has 12-bit resolution (0 - 4095) with ~3.3V reference
  return avgRaw * (3.3 / 4095.0);
}

// ==========================================
// SENSOR READING FUNCTIONS
// ==========================================

// 1. Read DS18B20 Water Temperature (°C)
float getWaterTemperature() {
  tempSensor.requestTemperatures();
  float tempC = tempSensor.getTempCByIndex(0);
  // Fallback to 25.0°C if sensor is disconnected (DEVICE_DISCONNECTED_C = -127.0)
  if (tempC < -50.0 || tempC > 100.0) {
    return 25.0; 
  }
  return tempC;
}

// 2. Read pH Level (0.00 - 14.00)
float getPHLevel(float voltage) {
  float ph = 7.20 + (voltage - V_NEUTRAL) * PH_SLOPE;

  // Calibration correction
  ph = ph + 1.10;

  return constrain(ph, 0.0, 14.0);
}

// 3. Read TDS Level (ppm) with Temperature Compensation
int getTDSLevel(float voltage, float tempC) {
  // Temperature compensation coefficient (standard 2% per °C at 25°C reference)
  float compensationCoefficient = 1.0 + 0.02 * (tempC - 25.0);
  float compensationVoltage = voltage / compensationCoefficient;

  // Third-order polynomial formula for gravity TDS analog sensor
  float tdsValue = (133.42 * pow(compensationVoltage, 3) 
                    - 255.86 * pow(compensationVoltage, 2) 
                    + 857.39 * compensationVoltage) * 0.5;
  tdsValue = tdsValue * TDS_FACTOR;
  if (tdsValue < 0) tdsValue = 0;
  return (int)tdsValue;
}

// 4. Read Turbidity (NTU) — Continuous Smooth Curve for ESP32
float getTurbidityLevel(float voltage) {
  // Calibrated smooth transfer function for 3.3V ESP32 ADC:
  // - Clean clear water (voltage ~ 3.0V to 3.3V) -> 0.5 to 2.5 NTU
  // - Slightly hazy water (voltage ~ 2.5V to 2.9V) -> 5.0 to 20.0 NTU
  // - Murky / dirty water (voltage ~ 1.8V to 2.4V) -> 25.0 to 60.0 NTU
  // - Heavy mud / blocked light (voltage < 1.5V) -> 70.0 to 100.0 NTU
  float ntu = 0.0;
  if (voltage >= 3.0) {
    // Very clear water: 0.5 - 2.0 NTU
    ntu = (3.3 - voltage) * 5.0;
    if (ntu < 0.5) ntu = 0.5;
  } else if (voltage >= 2.0) {
    // Transition from clear to moderately cloudy: 2.0 - 40.0 NTU
    ntu = 2.0 + (3.0 - voltage) * 38.0;
  } else {
    // High turbidity to dense mud: 40.0 - 100.0 NTU
    ntu = 40.0 + (2.0 - voltage) * 60.0;
  }
  return constrain(ntu, 0.5, 100.0);
}

// ==========================================
// FIREBASE TRANSMISSION
// ==========================================
void sendTelemetryToFirebase(float ph, int tds, float turbidity, float temp) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ Wi-Fi disconnected! Reconnecting...");
    WiFi.reconnect();
    return;
  }

  HTTPClient http;
  http.begin(FIREBASE_URL);
  http.addHeader("Content-Type", "application/json");

  // Construct JSON payload matching the WaterGuard dashboard model
  String jsonPayload = "{";
  jsonPayload += "\"ph\":" + String(ph, 2) + ",";
  jsonPayload += "\"tds\":" + String(tds) + ",";
  jsonPayload += "\"turbidity\":" + String(turbidity, 1) + ",";
  jsonPayload += "\"temperature\":" + String(temp, 1) + ",";
  jsonPayload += "\"device\":\"ESP32-WaterGuard-Node01\",";
  jsonPayload += "\"lastUpdated\":\"ESP32 Live\"";
  jsonPayload += "}";

  // HTTP PATCH updates the fields in Realtime Database in-place
  int httpResponseCode = http.PATCH(jsonPayload);

  if (httpResponseCode == 200) {
    Serial.print("✅ Firebase Sync OK [200]: ");
    Serial.println(jsonPayload);
  } else {
    Serial.print("⚠️ Firebase Sync Error: HTTP code ");
    Serial.println(httpResponseCode);
  }

  http.end();
}

// ==========================================
// ARDUINO SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=============================================");
  Serial.println("  💧 WaterGuard — Smart Water Monitoring");
  Serial.println("  Node MCU / ESP32 Hardware Core Starting...");
  Serial.println("=============================================");

  // Initialize DS18B20 temperature sensor
  tempSensor.begin();

  // Set ADC attenuation to 11dB (allows reading up to full 3.3V range)
  analogSetAttenuation(ADC_11db);

  // Connect to Wi-Fi
  Serial.print("Connecting to Wi-Fi SSID: ");
  Serial.println(WIFI_SSID);
  
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Wi-Fi Connected!");
    Serial.print("📡 ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("📶 Signal Strength (RSSI): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n❌ Wi-Fi Connection Failed!");
    Serial.println("⚠️ Please check:");
    Serial.println("1. Is your Hotspot set to 2.4 GHz band? (ESP32 does NOT support 5 GHz)");
    Serial.println("2. On iPhone, is 'Maximize Compatibility' turned ON?");
    Serial.println("3. Check SSID spelling and password case-sensitivity.");
  }
  Serial.println("=============================================\n");
}

// ==========================================
// ARDUINO MAIN LOOP
// ==========================================
void loop() {
  unsigned long currentMillis = millis();

  // Send packet every SEND_INTERVAL (3 seconds) non-blocking
  if (currentMillis - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = currentMillis;

    // 1. Read Analog Voltages (with multi-sample filtering)
    float phVolt   = getAverageVoltage(PIN_PH);
    float tdsVolt  = getAverageVoltage(PIN_TDS);
    float turbVolt = getAverageVoltage(PIN_TURBIDITY);

    // 2. Read Temperature
    float waterTemp = getWaterTemperature();

    // 3. Compute Water Quality Metrics
    float phVal     = getPHLevel(phVolt);
    int tdsVal      = getTDSLevel(tdsVolt, waterTemp);
    float turbVal   = getTurbidityLevel(turbVolt);

    // 4. Output to Serial Monitor for Debugging
    Serial.println("---------------------------------------------");
    Serial.printf("pH: %.2f (Volt: %.2fV) | TDS: %d ppm (Volt: %.2fV)\n", phVal, phVolt, tdsVal, tdsVolt);
    Serial.printf("Turbidity: %.1f NTU (Volt: %.2fV) | Temp: %.1f °C\n", turbVal, turbVolt, waterTemp);

    // 5. Transmit Live Telemetry to Firebase
    sendTelemetryToFirebase(phVal, tdsVal, turbVal, waterTemp);
  }
}
