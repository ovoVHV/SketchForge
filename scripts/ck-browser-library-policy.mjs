/**
 * Declarative browser-library compatibility policy.
 *
 * This data describes support guidance only. It must never mutate compiler
 * arguments or provide a library-specific source rewrite.
 */
const POLICIES = Object.freeze([
  Object.freeze({
    library: 'ArduinoBLE',
    versions: Object.freeze(['2.1.0']),
    targets: Object.freeze(['s2']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'ArduinoBLE 2.1.0 requires the ESP Bluetooth controller headers that ESP32-S2 does not provide',
  }),
  Object.freeze({
    library: 'CapacitiveSensor',
    versions: Object.freeze(['0.5.1']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'CapacitiveSensor 0.5.1 requires the AVR-style IO_REG_TYPE API that Arduino-ESP32 does not provide',
  }),
  Object.freeze({
    library: 'DallasTemperature',
    versions: Object.freeze(['4.0.6']),
    targets: Object.freeze(['c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'DallasTemperature 4.0.6 depends on OneWire 2.3.8, whose direct GPIO implementation is incompatible with the ESP32-C6 register types',
  }),
  Object.freeze({
    library: 'ESP32Encoder',
    versions: Object.freeze(['5.0.0']),
    targets: Object.freeze(['c3']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'ESP32Encoder 5.0.0 references SOC_PCNT_UNITS_PER_GROUP on ESP32-C3 even though that SoC profile does not provide it',
  }),
  Object.freeze({
    library: 'Firmata',
    versions: Object.freeze(['2.5.9']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'Firmata 2.5.9 has no ESP32 hardware abstraction in Boards.h',
  }),
  Object.freeze({
    library: 'ESPAsync_WiFiManager',
    versions: Object.freeze(['1.15.1']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'ESPAsync_WiFiManager 1.15.1 calls WiFi.getAutoConnect() and WiFi.setAutoConnect(), which Arduino-ESP32 3.3.x does not provide',
  }),
  Object.freeze({
    library: 'FastLED',
    versions: Object.freeze(['3.10.5']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'FastLED 3.10.5 unity-build compile units exceed the CK Browser WASM Action execution budget; use FastLED 3.9.4 in the browser or the native executor',
  }),
  Object.freeze({
    library: 'lvgl',
    versions: Object.freeze(['9.5.0']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'LVGL 9.5.0 is outside the current basic-library acceptance scope and is deferred as a large 539-unit pack; this policy is a scope exclusion, not a compatibility verdict',
  }),
  Object.freeze({
    library: 'LedControl',
    versions: Object.freeze(['1.0.6']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'LedControl 1.0.6 requires AVR-only headers and register APIs',
  }),
  Object.freeze({
    library: 'NeoGPS',
    versions: Object.freeze(['4.2.9']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'NeoGPS 4.2.9 is not compatible with the browser Clang frontend because NeoGPS::time_t conflicts with the global time_t typedef',
  }),
  Object.freeze({
    library: 'OneWire',
    versions: Object.freeze(['2.3.8']),
    targets: Object.freeze(['c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'OneWire 2.3.8 performs integer operations on the structured ESP32-C6 GPIO registers',
  }),
  Object.freeze({
    library: 'PulsePosition',
    versions: Object.freeze(['1.0.0']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'PulsePosition 1.0.0 requires Teensy FTM timer APIs that Arduino-ESP32 does not provide',
  }),
  Object.freeze({
    library: 'SD',
    versions: Object.freeze(['1.3.0']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'The generic SD 1.3.0 release has no ESP32 pin map; use the Arduino-ESP32 platform SD library instead',
  }),
  Object.freeze({
    library: 'ServoESP32',
    versions: Object.freeze(['1.1.1']),
    targets: Object.freeze(['esp32', 's2', 's3', 'c3', 'c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'ServoESP32 1.1.1 depends on LEDC symbols removed before Arduino-ESP32 3.3.x',
  }),
  Object.freeze({
    library: 'TFT_eSPI',
    targets: Object.freeze(['c3']),
    status: 'not-recommended',
    minPlatformVersion: '3.3.0',
    reason: 'TFT_eSPI is not recommended for ESP32-C3 with Arduino-ESP32 3.3.x or newer',
  }),
  Object.freeze({
    library: 'TFT_eSPI',
    versions: Object.freeze(['2.5.43']),
    targets: Object.freeze(['c6']),
    status: 'unsupported',
    minPlatformVersion: '3.3.0',
    reason: 'TFT_eSPI 2.5.43 does not provide an ESP32-C6 processor implementation',
  }),
]);

/**
 * Return the first applicable guidance rule, or null when the library can be
 * tested normally. Unknown platform versions fail open so a new pack is not
 * silently classified without an explicit policy review.
 */
export function evaluateBrowserLibraryPolicy({ library, libraryVersion, target, platformVersion } = {}) {
  if (typeof library !== 'string' || typeof target !== 'string' || typeof platformVersion !== 'string') return null;
  const foldedLibrary = library.toLowerCase();
  const foldedTarget = target.toLowerCase();
  for (const policy of POLICIES) {
    if (policy.library.toLowerCase() !== foldedLibrary || !policy.targets.includes(foldedTarget)) continue;
    if (policy.versions && (!policy.versions.includes(libraryVersion))) continue;
    const comparison = compareVersions(platformVersion, policy.minPlatformVersion);
    if (!Number.isFinite(comparison) || comparison < 0) continue;
    return Object.freeze({
      status: policy.status,
      reason: policy.reason,
      minPlatformVersion: policy.minPlatformVersion,
    });
  }
  return null;
}

/** Compare numeric dotted release versions. Invalid versions are unknown. */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return Number.NaN;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return match.slice(1, 4).map((part) => Number(part ?? 0));
}
