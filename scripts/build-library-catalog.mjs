#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const indexPath = process.argv[2] ?? 'var/work/library_index_full.json';
const outputPath = process.argv[3] ?? 'packages/core/src/library/catalog-data.ts';

const commonNames = [
  'Adafruit BusIO', 'Adafruit GFX Library', 'Adafruit SSD1306', 'Adafruit Unified Sensor',
  'Adafruit BMP085 Library', 'Adafruit NeoPixel', 'Adafruit NeoMatrix', 'Adafruit BME280 Library',
  'Adafruit BNO055', 'Adafruit MPU6050', 'Adafruit ADXL345', 'Adafruit INA219',
  'Adafruit MAX31855 library', 'Adafruit MCP23017 Arduino Library', 'Adafruit ADS1X15',
  'Adafruit DotStar', 'Adafruit Fingerprint Sensor Library', 'Adafruit GPS Library',
  'Adafruit ImageReader Library', 'Adafruit ILI9341', 'Adafruit LSM303DLHC',
  'Adafruit Motor Shield V2 Library', 'Adafruit PWM Servo Driver Library', 'Adafruit TCS34725',
  'Adafruit TinyUSB Library', 'Ethernet', 'EthernetENC', 'PubSubClient', 'ArduinoJson', 'Async TCP',
  'ESP Async WebServer', 'WiFiManager', 'OneWire', 'DallasTemperature', 'DHT sensor library', 'FastLED', 'IRremote',
  'Servo', 'Stepper', 'LiquidCrystal', 'SD', 'SdFat', 'Bounce2', 'AceButton', 'TaskScheduler',
  'ArduinoOTA', 'ArduinoMDNS', 'NTPClient', 'Time', 'TimeAlarms', 'RTClib', 'TinyGPSPlus',
  'Keypad', 'MFRC522', 'RF24', 'RadioHead', 'WebSockets', 'ArduinoHttpClient', 'ESP32Servo',
  'ESP32 BLE Arduino', 'ESP32Encoder', 'ESP32 AnalogWrite', 'SimpleTimer', 'CircularBuffer',
  'LinkedList', 'U8g2', 'TFT_eSPI', 'lvgl', 'GxEPD2', 'IRremoteESP8266', 'ESPAsync_WiFiManager',
  'ESP AsyncDNSServer',
  'ESPAsyncTCP', 'ESP8266Audio', 'MKRWAN', 'ArduinoECCX08', 'ArduinoBLE', 'Arduino_LSM6DS3',
  'Arduino_LSM9DS1', 'WiFi', 'Firmata',
  'Adafruit PCD8544 Nokia 5110 LCD library', 'Adafruit PN532', 'Adafruit SGP30 Sensor',
  'Adafruit SH110X', 'Adafruit ST7735 and ST7789 Library', 'Adafruit TouchScreen',
  'CapacitiveSensor', 'CmdMessenger', 'CRC32', 'LedControl', 'MIDI Library', 'NeoGPS',
  'PCF8574', 'PCA9685', 'PulsePosition', 'RF24Network', 'ServoESP32', 'TinyGPS', 'USBHost',
];

// Some transitive dependencies are not distributed through Arduino's index.
// Keep those sources immutable and integrity-pinned so generated catalogs stay
// reproducible without embedding dependency source into another Library Pack.
const supplementalRecords = [
  {
    name: 'ESP AsyncDNSServer',
    version: '1.0.0',
    architectures: ['esp32'],
    dependencies: [],
    providesIncludes: ['ESPAsyncDNSServer.h'],
    sentence: 'Async DNS Server Library for ESP',
    category: 'Other',
    repository: 'https://github.com/devyte/ESPAsyncDNSServer.git',
    url: 'https://codeload.github.com/devyte/ESPAsyncDNSServer/zip/119dd3ce1b639a5314aac219cf5a00d29946ea47',
    size: 7128,
    checksum: 'SHA-256:96167f45065ca5f25689b408da8573550325b1ab81d506385e3c1f358466b247',
  },
];

const source = JSON.parse(await readFile(indexPath, 'utf8'));
const records = Array.isArray(source?.libraries) ? source.libraries : [];
const byName = new Map();
const key = (name) => String(name).trim().toLocaleLowerCase('en-US');
const compareVersion = (a, b) => {
  const tokenize = (value) => String(value).split(/[.+-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
  const left = tokenize(a); const right = tokenize(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0; const y = right[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number' && x !== y) return x - y;
    if (String(x) !== String(y)) return String(x).localeCompare(String(y));
  }
  return 0;
};

for (const record of [...records, ...supplementalRecords]) {
  if (!record?.name || !record.version || !record.url || !/^SHA-256:[a-f0-9]{64}$/i.test(record.checksum ?? '')) continue;
  const current = byName.get(key(record.name));
  if (!current || compareVersion(current.version, record.version) < 0) byName.set(key(record.name), record);
}

// Include transitive catalog dependencies when they are present in the official
// index. Platform-provided Wire/SPI/etc. are deliberately left to the Platform
// Pack and therefore are not fabricated as third-party archives.
const selected = new Set(commonNames.map(key));
const queue = [...selected];
while (queue.length) {
  const name = queue.shift();
  const record = byName.get(name);
  for (const dependency of record?.dependencies ?? []) {
    const dependencyKey = key(dependency.name);
    if (byName.has(dependencyKey) && !selected.has(dependencyKey)) {
      selected.add(dependencyKey);
      queue.push(dependencyKey);
    }
  }
}

const output = [...selected]
  .map((name) => byName.get(name))
  .filter(Boolean)
  .sort((a, b) => key(a.name).localeCompare(key(b.name)))
  .map((record) => ({
    name: record.name,
    version: record.version,
    architectures: record.architectures?.length ? record.architectures : ['*'],
    dependencies: (record.dependencies ?? [])
      .filter((dependency) => selected.has(key(dependency.name)))
      .map((dependency) => ({ name: dependency.name, ...(dependency.version ? { version: dependency.version } : {}) })),
    providesIncludes: record.providesIncludes ?? [],
    sentence: record.sentence,
    category: record.category,
    license: record.license,
    repository: record.repository,
    url: record.url,
    size: record.size,
    checksum: record.checksum,
  }));

const content = `/* Generated from Arduino's official library_index.json and CK-pinned supplemental records. Do not hand-edit. */\nimport type { ArduinoLibraryIndexRecord } from './catalog.js';\n\nexport const CK_ARDUINO_COMMON_LIBRARY_INDEX: readonly ArduinoLibraryIndexRecord[] = ${JSON.stringify(output, null, 2)} as const;\n`;
await writeFile(outputPath, content, 'utf8');
console.log(`wrote ${output.length} catalog records to ${outputPath}`);
