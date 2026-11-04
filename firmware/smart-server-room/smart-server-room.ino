
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>

// =========================
// WIFI DAN SERVER FLASK
// =========================
const char* WIFI_SSID = "";
const char* WIFI_PASSWORD = "";
const char* SERVER_URL = "http://192.168.0.104:5000/api/data";

// =========================
// PIN ESP32 WROOM
// =========================
const int PIR_PIN = 14;
const int LED_PIN = 32;
const int DHT_PIN = 25;
const int RELAY_FAN = 27;
const int MQ2_PIN = 34;

// =========================
// DHT22
// =========================
#define DHTTYPE DHT22
DHT dht(DHT_PIN, DHTTYPE);

// =========================
// KIPAS
// =========================
const float FAN_ON_TEMP = 31.0;
const int RELAY_ON = HIGH;
const int RELAY_OFF = LOW;
bool fanIsOn = false;

// =========================
// SENSOR MQ-2
// =========================
const int SMOKE_THRESHOLD = 2000;

// Jumlah sampel untuk meratakan nilai ADC
const int MQ2_SAMPLES = 10;

// =========================
// TIMER SENSOR
// =========================
unsigned long lastRead = 0;
const unsigned long INTERVAL = 5000;

// =========================
// WIFI
// =========================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Menghubungkan ke WiFi");

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi berhasil terhubung");
    Serial.print("IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi gagal terhubung");
  }
}

// =========================
// PEMBACAAN MQ-2
// =========================
int readMQ2() {
  long total = 0;

  for (int i = 0; i < MQ2_SAMPLES; i++) {
    total += analogRead(MQ2_PIN);
    delay(10);
  }

  return total / MQ2_SAMPLES;
}

// =========================
// KIRIM DATA KE FLASK
// =========================
void sendData(
  float temperature,
  float humidity,
  int fanStatus,
  int motionStatus,
  int smokeValue,
  int smokeStatus
) {

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi terputus, data tidak terkirim");
    return;
  }

  WiFiClient client;
  HTTPClient http;

  http.setTimeout(5000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("Gagal memulai koneksi HTTP");
    return;
  }

  http.addHeader("Content-Type", "application/json");

  String json = "{";
  json += "\"suhu\":" + String(temperature, 1) + ",";
  json += "\"kelembapan\":" + String(humidity, 1) + ",";
  json += "\"kipas\":" + String(fanStatus) + ",";
  json += "\"gerakan\":" + String(motionStatus) + ",";
  json += "\"nilai_asap\":" + String(smokeValue) + ",";
  json += "\"asap\":" + String(smokeStatus);
  json += "}";

  int httpCode = http.POST(json);

  Serial.print("HTTP status: ");
  Serial.println(httpCode);

  if (httpCode > 0) {
    Serial.print("Respons server: ");
    Serial.println(http.getString());
  } else {
    Serial.print("Gagal mengirim: ");
    Serial.println(http.errorToString(httpCode));
  }

  http.end();
}

// =========================
// SETUP
// =========================
void setup() {
  Serial.begin(115200);

  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(RELAY_FAN, OUTPUT);
  pinMode(MQ2_PIN, INPUT);

  digitalWrite(LED_PIN, LOW);
  digitalWrite(RELAY_FAN, RELAY_OFF);

  analogReadResolution(12);

  // Rentang ADC ESP32
  // Membantu pembacaan analog pada GPIO34
  analogSetPinAttenuation(MQ2_PIN, ADC_11db);

  dht.begin();
  connectWiFi();

  Serial.println();
  Serial.println("==============================");
  Serial.println("MONITORING RUANG SERVER");
  Serial.println("PIR + LED + DHT22 + KIPAS + MQ-2");
  Serial.println("==============================");

  Serial.println("DEBUG MQ-2 AKTIF");
  Serial.print("Threshold MQ-2: ");
  Serial.println(SMOKE_THRESHOLD);
  Serial.println("Tunggu sensor MQ-2 stabil sebelum evaluasi.");
}

// =========================
// LOOP
// =========================
void loop() {

  // LED mengikuti status PIR
  int motion = digitalRead(PIR_PIN);
  digitalWrite(LED_PIN, motion == HIGH ? HIGH : LOW);

  unsigned long currentMillis = millis();

  if (currentMillis - lastRead >= INTERVAL) {
    lastRead = currentMillis;

    // =====================
    // BACA SENSOR
    // =====================
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();

    int smokeValue = readMQ2();

    Serial.println();
    Serial.println("==============================");
    Serial.println("HASIL PEMBACAAN SENSOR");
    Serial.println("==============================");

    // =====================
    // PIR
    // =====================
    Serial.print("Gerakan: ");
    Serial.println(
      motion == HIGH ? "TERDETEKSI" : "TIDAK ADA"
    );

    // =====================
    // MQ-2 DEBUG
    // =====================
    Serial.println("--- DEBUG MQ-2 ---");

    Serial.print("Nilai analog MQ-2 : ");
    Serial.println(smokeValue);

    Serial.print("Threshold         : ");
    Serial.println(SMOKE_THRESHOLD);

    Serial.print("Selisih threshold : ");
    Serial.println(smokeValue - SMOKE_THRESHOLD);

    int smokeStatus =
      (smokeValue >= SMOKE_THRESHOLD) ? 1 : 0;

    Serial.print("Status asap       : ");

    if (smokeStatus == 1) {
      Serial.println("TERDETEKSI");
    } else {
      Serial.println("TIDAK TERDETEKSI");
    }

    Serial.println("------------------");

    // =====================
    // DHT22
    // =====================
    if (isnan(humidity) || isnan(temperature)) {
      Serial.println("Gagal membaca DHT22");
      Serial.println("Pengiriman data dilewati");
      return;
    }

    Serial.print("Suhu: ");
    Serial.print(temperature);
    Serial.println(" C");

    Serial.print("Kelembapan: ");
    Serial.print(humidity);
    Serial.println(" %");

    // =====================
    // KIPAS OTOMATIS
    // =====================
    fanIsOn = (temperature >= FAN_ON_TEMP);

    digitalWrite(
      RELAY_FAN,
      fanIsOn ? RELAY_ON : RELAY_OFF
    );

    Serial.print("Kipas: ");
    Serial.println(fanIsOn ? "ON" : "OFF");

    // =====================
    // KIRIM KE FLASK
    // =====================
    sendData(
      temperature,
      humidity,
      fanIsOn ? 1 : 0,
      motion,
      smokeValue,
      smokeStatus
    );
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
  }
}
