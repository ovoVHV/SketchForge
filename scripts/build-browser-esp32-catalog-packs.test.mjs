import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCatalogSourcePackFromFiles,
  resetCatalogInferredDependencies,
  resolveInferredHeaderOwner,
  sourceIncludes,
} from './build-browser-esp32-catalog-packs.mjs';

const record = Object.freeze({
  name: 'Flat Library',
  version: '1.0.0',
  architectures: ['*'],
  publicHeaders: ['Flat.h'],
  source: { url: 'https://example.invalid/flat.zip', sha256: '0'.repeat(64) },
});

function source(path, content = '') {
  return { path, bytes: Buffer.from(content, 'utf8') };
}

test('dependency reset preserves catalog edges to platform Pack versions', () => {
  const catalogRecord = (name, version) => ({
    name,
    version,
    architectures: ['*'],
    dependencies: [],
    publicHeaders: [`${name}.h`],
    source: { url: `https://example.invalid/${name}.zip`, sha256: '0'.repeat(64) },
  });
  const registry = {
    schema: 2,
    libraries: [
      {
        name: 'Catalog Source',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          depends: [
            { name: 'Catalog Dependency', version: '2.0.0' },
            { name: 'SD', version: '3.3.7' },
            { name: 'SPI', version: '3.3.7' },
          ],
        }],
      },
      { name: 'Catalog Dependency', defaultVersion: '2.0.0', versions: [{ version: '2.0.0', depends: [] }] },
      { name: 'SD', defaultVersion: '3.3.7', versions: [{ version: '1.3.0', depends: [] }, { version: '3.3.7', depends: [] }] },
      { name: 'SPI', defaultVersion: '3.3.7', versions: [{ version: '3.3.7', depends: [] }] },
    ],
  };

  const reset = resetCatalogInferredDependencies(registry, [
    catalogRecord('Catalog Source', '1.0.0'),
    catalogRecord('Catalog Dependency', '2.0.0'),
    catalogRecord('SD', '1.3.0'),
  ]);

  assert.deepEqual(reset.libraries[0].versions[0].depends, [
    { name: 'SD', version: '3.3.7' },
    { name: 'SPI', version: '3.3.7' },
  ]);
  assert.deepEqual(registry.libraries[0].versions[0].depends, [
    { name: 'Catalog Dependency', version: '2.0.0' },
    { name: 'SD', version: '3.3.7' },
    { name: 'SPI', version: '3.3.7' },
  ]);
});

test('flat catalog packs compile root units and retain only reachable nested sources', () => {
  const pack = createCatalogSourcePackFromFiles(record, [
    source('Flat.cpp', '#include "utility/needed.h"\n'),
    source('Flat.h', '#pragma once\n'),
    source('utility/needed.h', '#include "needed.tpp"\n'),
    source('utility/needed.tpp', '#pragma once\n'),
    source('utility/host.cpp', '#include <host-only/runtime.h>\n'),
    source('examples_linux/demo.cpp', '#include <host-only/runtime.h>\n'),
    source('pyFlat/python.cpp', '#include <boost/python.hpp>\n'),
  ]);

  assert.deepEqual(pack.files.map(({ path }) => path), [
    'src/Flat.cpp',
    'src/Flat.h',
    'src/utility/needed.h',
    'src/utility/needed.tpp',
  ]);
  assert.deepEqual(pack.publicHeaders, ['Flat.h']);
});

test('source packs exclude suffixed example trees below src', () => {
  const pack = createCatalogSourcePackFromFiles(record, [
    source('src/Flat.cpp', '#include "Flat.h"\n'),
    source('src/Flat.h', '#pragma once\n'),
    source('src/examples_pico/demo.cpp', '#include <host-only/runtime.h>\n'),
    source('src/tests_extra/demo.cpp', '#include <host-only/runtime.h>\n'),
  ]);

  assert.deepEqual(pack.files.map(({ path }) => path), ['src/Flat.cpp', 'src/Flat.h']);
});

test('dependency scanning follows default macro aliases without library-specific rules', () => {
  const includes = sourceIncludes(`
#define NETWORK_PLAIN (1)
#define NETWORK_SECURE (4)
#if !defined(NETWORK_TYPE)
#if defined(ESP8266)
#define NETWORK_TYPE NETWORK_PLAIN
#elif defined(ESP32)
#define NETWORK_TYPE NETWORK_SECURE
#endif
#endif
#if (NETWORK_TYPE == NETWORK_SECURE)
#include <WiFiClientSecure.h>
#endif
`);
  assert.deepEqual(includes, [{ header: 'WiFiClientSecure.h', conditional: false }]);
});

test('dependency scanning treats ESP32 SoC capabilities as platform defaults', () => {
  const includes = sourceIncludes(`
#if SOC_WIFI_SUPPORTED
#include <WiFi.h>
#endif
#if SOC_BLE_SUPPORTED && CONFIG_BT_ENABLED
#include <BLEDevice.h>
#endif
`);
  assert.deepEqual(includes, [
    { header: 'WiFi.h', conditional: false },
    { header: 'BLEDevice.h', conditional: false },
  ]);
});

test('dependency scanning evaluates compound Arduino and ESP-IDF version guards', () => {
  const includes = sourceIncludes(`
#if defined(ARDUINO) && !defined(LIBRETINY)
#if (ESP_IDF_VERSION_MAJOR >= 5)
#include <NetworkInterface.h>
#else
#include <LegacyNetworkInterface.h>
#endif
#endif
#if !defined(ESP32)
#include <WrongPlatform.h>
#endif
`);
  assert.deepEqual(includes, [
    { header: 'NetworkInterface.h', conditional: false },
    { header: 'LegacyNetworkInterface.h', conditional: true },
    { header: 'WrongPlatform.h', conditional: true },
  ]);
});

test('dependency scanning accepts platform-version macro overrides', () => {
  const includes = sourceIncludes(`
#if ESP_IDF_VERSION_MAJOR >= 5
#include <ModernInterface.h>
#else
#include <LegacyInterface.h>
#endif
`, { ESP_IDF_VERSION_MAJOR: 4 });
  assert.deepEqual(includes, [
    { header: 'ModernInterface.h', conditional: true },
    { header: 'LegacyInterface.h', conditional: false },
  ]);
});

test('dependency header matching follows case-sensitive compiler path semantics', () => {
  const fastLed = { name: 'FastLED' };
  const mdns = { name: 'ArduinoMDNS' };
  const secure = { name: 'NetworkClientSecure' };
  const owners = new Map([
    ['types.h', { library: fastLed }],
    ['MDNS.h', mdns],
    ['WiFiClientSecure.h', { library: secure }],
  ]);
  assert.equal(resolveInferredHeaderOwner(owners, 'sys/types.h'), undefined);
  assert.equal(resolveInferredHeaderOwner(owners, 'mdns.h'), undefined);
  assert.equal(resolveInferredHeaderOwner(owners, 'WiFiClientSecure.h'), secure);
});
