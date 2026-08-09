import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const WORKSPACE = resolve(import.meta.dirname, '..');
const PUBLIC_V1 = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1');
const DEFAULT_OUTPUT = join(PUBLIC_V1, 'libraries');
const SOURCE_EXTENSIONS = Object.freeze(new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.S',
]));
const HEADER_EXTENSIONS = Object.freeze(new Set(['.h', '.hh', '.hpp', '.hxx']));

export const BROWSER_ESP32_LIBRARIES = Object.freeze([
  Object.freeze({
    key: 'pubsubclient',
    name: 'PubSubClient',
    version: '2.8',
    commit: '2d228f2f862a95846c65a8518c79f48dfc8f188c',
    repository: 'https://github.com/knolleary/pubsubclient',
    archiveUrl: 'https://codeload.github.com/knolleary/pubsubclient/tar.gz/2d228f2f862a95846c65a8518c79f48dfc8f188c',
    archiveSha256: '1607f393f365ea6da591bbceecde7a1b083c2576b00a136c91fdd826b76be642',
    rootName: 'pubsubclient-2d228f2f862a95846c65a8518c79f48dfc8f188c',
    arduinoIndex: null,
    packId: 'arduino-lib-pubsubclient',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['PubSubClient.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([
      Object.freeze({ path: 'src/PubSubClient.cpp', output: 'src/PubSubClient.cpp', sha256: 'c5ab036263d514791b1955fe44aacca103b2eea4ca07cd539bff25dd88cc4ede' }),
      Object.freeze({ path: 'src/PubSubClient.h', output: 'src/PubSubClient.h', sha256: '376ddb9ecda5816dfeff344f8742253d487adc16272455ebe2dfa4c071cdd348' }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE.txt', output: 'LICENSE.txt', sha256: 'b416abfc7294f9279480389e4825463ac71b2b064b892aa7d95abd5d4b6edc63' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: 'c30de5d0fe2894b38b658a6be980a5f3a3003cb6c44ccb3118551e8dd9326dcf' }),
    ]),
    notice: "PubSubClient 2.8, Copyright (c) 2008-2020 Nicholas O'Leary, MIT License.",
  }),
  Object.freeze({
    key: 'adafruit-busio',
    name: 'Adafruit BusIO',
    version: '1.17.4',
    commit: '3b8364267c3ee6e16bad91bc2101aefbd5b5915f',
    repository: 'https://github.com/adafruit/Adafruit_BusIO',
    archiveUrl: 'https://codeload.github.com/adafruit/Adafruit_BusIO/tar.gz/3b8364267c3ee6e16bad91bc2101aefbd5b5915f',
    archiveSha256: 'e5d8163c527af3c868f6ff5eaf6b92ed6c6baf297b9c39906611c817d553f5eb',
    rootName: 'Adafruit_BusIO-3b8364267c3ee6e16bad91bc2101aefbd5b5915f',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_BusIO-1.17.4.zip',
      sha256: 'c7bab1b6c6eee64b50964c8e149b795719a01f1d9dfcdcef170b35daa696349b',
    }),
    packId: 'arduino-lib-adafruit-busio',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze([
      'Adafruit_BusIO_Register.h',
      'Adafruit_GenericDevice.h',
      'Adafruit_I2CDevice.h',
      'Adafruit_I2CRegister.h',
      'Adafruit_SPIDevice.h',
    ]),
    depends: Object.freeze([
      Object.freeze({ name: 'SPI', version: '3.3.7' }),
      Object.freeze({ name: 'Wire', version: '3.3.7' }),
    ]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: '.',
        output: 'src',
        recursive: false,
        sha256: '25da4d6721b9d81ad12f9386063ab4c9627cfcc56087853a1c3f9b46b239c8de',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE', output: 'LICENSE.txt', sha256: '86e9fafdb50d2a85d8fef369b4635b5a1b89160603e5b1f95484df0804b49508' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '1f1c13c18d84a15f71e8e833aeaf1ada2d505cc915485174167ea661ed085194' }),
    ]),
    notice: 'Adafruit BusIO 1.17.4, Copyright (c) 2017 Adafruit Industries, MIT License.',
  }),
  Object.freeze({
    key: 'adafruit-gfx',
    name: 'Adafruit GFX Library',
    version: '1.12.6',
    commit: 'ac6d7c3869a693d406f77b9bfcd486b0673169f0',
    repository: 'https://github.com/adafruit/Adafruit-GFX-Library',
    archiveUrl: 'https://codeload.github.com/adafruit/Adafruit-GFX-Library/tar.gz/ac6d7c3869a693d406f77b9bfcd486b0673169f0',
    archiveSha256: '16b63fce7e61a0cfc9d764ceade4568dc69659864940852bab0a2db070c3737e',
    rootName: 'Adafruit-GFX-Library-ac6d7c3869a693d406f77b9bfcd486b0673169f0',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_GFX_Library-1.12.6.zip',
      sha256: '7d4dc7a7522716d2c88a3b1b9b13521d33cfeeae9ebffa42c2dba0559696a997',
    }),
    packId: 'arduino-lib-adafruit-gfx',
    artifact: 'sources',
    includeDirs: Object.freeze(['src', 'src/Fonts']),
    publicHeaders: Object.freeze([
      'Adafruit_GFX.h',
      'Adafruit_GrayOLED.h',
      'Adafruit_SPITFT.h',
      'Adafruit_SPITFT_Macros.h',
      'gfxfont.h',
    ]),
    depends: Object.freeze([Object.freeze({ name: 'Adafruit BusIO', version: '1.17.4' })]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: '.',
        output: 'src',
        recursive: false,
        sha256: '12d71fe46bf8e7b3e7c98f17f42cb31b219cf05ae71ab3441eb6d864f134d379',
      }),
      Object.freeze({
        path: 'Fonts',
        output: 'src/Fonts',
        recursive: true,
        sha256: 'bff118c921ebd4529e2c8d980ff8e56baa6d0390f39cf8ea34521cef6940af17',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'license.txt', output: 'LICENSE.txt', sha256: '3e7bede50526352926c2283e640f2823d9f9f2165d1852044c4fb1bbac283106' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: 'e6b702f2d0463216bf4b89d10c1701ae0de2aabbee42f7088054e9e21949cc31' }),
    ]),
    notice: 'Adafruit GFX Library 1.12.6, Copyright (c) 2012 Adafruit Industries, BSD License.',
  }),
  Object.freeze({
    key: 'adafruit-ssd1306',
    name: 'Adafruit SSD1306',
    version: '2.5.17',
    commit: 'd94f699451d72286357cba7259055ffff2c2940b',
    repository: 'https://github.com/adafruit/Adafruit_SSD1306',
    archiveUrl: 'https://codeload.github.com/adafruit/Adafruit_SSD1306/tar.gz/d94f699451d72286357cba7259055ffff2c2940b',
    archiveSha256: '12b46d49f2a10acafefd2f0d31620af7efbb9def61d6d56a6477bbac7fcdc615',
    rootName: 'Adafruit_SSD1306-d94f699451d72286357cba7259055ffff2c2940b',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_SSD1306-2.5.17.zip',
      sha256: '9b8a9c29a16576d66bce16ed9f6a731632fecbb477171f38a6bc033fda15dd06',
    }),
    packId: 'arduino-lib-adafruit-ssd1306',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['Adafruit_SSD1306.h']),
    depends: Object.freeze([Object.freeze({ name: 'Adafruit GFX Library', version: '1.12.6' })]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: '.',
        output: 'src',
        recursive: false,
        sha256: '53200765b48ca7b3539ce86023ee7954bf3df0142c169a4c7d30bfb01b729a75',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'license.txt', output: 'LICENSE.txt', sha256: '4b6bb6d827e9da638841bf575c6068b83aaaf0d9508e892d3ea27e2525b070e8' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: 'bfb5d85959c14de682a285496e3c905054a0b126b0ca2d7c1870307890e6bc9d' }),
    ]),
    notice: 'Adafruit SSD1306 2.5.17, Copyright (c) 2012 Adafruit Industries, BSD License.',
  }),
  Object.freeze({
    key: 'adafruit-sensor',
    name: 'Adafruit Unified Sensor',
    version: '1.1.15',
    commit: '0a9127a1e886ff1adb4c1b6f5958b24108d55aa6',
    repository: 'https://github.com/adafruit/Adafruit_Sensor',
    archiveUrl: 'https://codeload.github.com/adafruit/Adafruit_Sensor/tar.gz/0a9127a1e886ff1adb4c1b6f5958b24108d55aa6',
    archiveSha256: '5d3397934cd15fe002cd2289c2fcf347856a56b8d6c9ff41f20e1b8f33abe1f9',
    rootName: 'Adafruit_Sensor-0a9127a1e886ff1adb4c1b6f5958b24108d55aa6',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_Unified_Sensor-1.1.15.zip',
      sha256: 'd64cdec0b817535f568fc3b8b8d44e7e097749f5ab8040aea573f412a3cbaec6',
    }),
    packId: 'arduino-lib-adafruit-sensor',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['Adafruit_Sensor.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: '.',
        output: 'src',
        recursive: false,
        sha256: '93d9d248be2098d2c921239549d69cb1fdd7a3046caf251f2b70dafa88d8b501',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE.txt', output: 'LICENSE.txt', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '9898dcd235542e85f504cc0d1c5bff9e99f17602607dae944075fdcab6831d37' }),
    ]),
    notice: 'Adafruit Unified Sensor 1.1.15, Adafruit Industries, Apache License 2.0.',
  }),
  Object.freeze({
    key: 'dht',
    name: 'DHT sensor library',
    version: '1.4.7',
    commit: 'f7d625462e6033f373e51f8c67f88fc429535b47',
    repository: 'https://github.com/adafruit/DHT-sensor-library',
    archiveUrl: 'https://codeload.github.com/adafruit/DHT-sensor-library/tar.gz/f7d625462e6033f373e51f8c67f88fc429535b47',
    archiveSha256: '834b424a6e40471c3a5ba4ec437f10861f8921abf2009aea0fddb1fc2f20c1e5',
    rootName: 'DHT-sensor-library-f7d625462e6033f373e51f8c67f88fc429535b47',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/DHT_sensor_library-1.4.7.zip',
      sha256: '5c5d3881b49840c7be98cc0848a48930bbac364fadc7edb7965fe98f9bb1463f',
    }),
    packId: 'arduino-lib-dht',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['DHT.h', 'DHT_U.h']),
    depends: Object.freeze([Object.freeze({ name: 'Adafruit Unified Sensor', version: '1.1.15' })]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: '.',
        output: 'src',
        recursive: false,
        sha256: '766941ff411fece9021af0a3b65ba3c9eb4a4b8672eb5a4caee7417092b3b49e',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'license.txt', output: 'LICENSE.txt', sha256: '8598f9a7e17727381839097b65b763e8e574b980b8157754209e9a089176c927' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: 'a224463cf9b12c1b0615b70ea881d7d07ee1d989815414875bce1bb12cd464af' }),
    ]),
    notice: 'DHT sensor library 1.4.7, Copyright (c) 2020 Adafruit Industries, MIT License.',
  }),
  Object.freeze({
    key: 'esp32servo',
    name: 'ESP32Servo',
    version: '3.2.1',
    commit: 'f7282217605d8bd9a4f3070cf9901d10d13ede1d',
    repository: 'https://github.com/madhephaestus/ESP32Servo',
    archiveUrl: 'https://codeload.github.com/madhephaestus/ESP32Servo/tar.gz/f7282217605d8bd9a4f3070cf9901d10d13ede1d',
    archiveSha256: 'ad9b83c3b8742c54c2c409f9132730be86a742b3815419de419e6b73d793b3df',
    rootName: 'ESP32Servo-f7282217605d8bd9a4f3070cf9901d10d13ede1d',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/madhephaestus/ESP32Servo-3.2.1.zip',
      sha256: '2fdebd81b1fb17cc52737ed1412ef23cd475ddec44e3a298f12d88cc881d9fa6',
    }),
    packId: 'arduino-lib-esp32servo',
    artifact: 'sources',
    architectures: Object.freeze(['esp32']),
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['ESP32PWM.h', 'ESP32Servo.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: 'src',
        output: 'src',
        recursive: true,
        sha256: 'b6c5b7426af527dcb3f5da22ec5adf9bc06b1cb86984dffd3166224513d101f6',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '4aab11d6e25a01f654318fbe0923db8c45b32c77eedf81bcd717263979b3b4f4' }),
    ]),
    licenseHeader: Object.freeze({ path: 'src/ESP32Servo.cpp', output: 'LICENSE-NOTICE.txt' }),
    notice: 'ESP32Servo 3.2.1, Copyright (c) 2017 John K. Bennett, LGPL-2.1-or-later.',
  }),
  Object.freeze({
    key: 'fastled',
    name: 'FastLED',
    version: '3.9.4',
    commit: '20beab7f48146ecdc134714369978e03f7b071a2',
    repository: 'https://github.com/FastLED/FastLED',
    archiveUrl: 'https://codeload.github.com/FastLED/FastLED/tar.gz/20beab7f48146ecdc134714369978e03f7b071a2',
    archiveSha256: '0b18a67445f1dc9be9abb87d7cc76504ed73c5eac213ac69a4a61efff22d5dff',
    rootName: 'FastLED-20beab7f48146ecdc134714369978e03f7b071a2',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/FastLED/FastLED-3.9.4.zip',
      sha256: 'd47807e7a157ada0bc909b8f34147335dff95189fdd772bb81a3089eb15c2134',
    }),
    packId: 'arduino-lib-fastled',
    artifact: 'sources',
    architectures: Object.freeze(['esp32']),
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['FastLED.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([
      Object.freeze({ path: 'src/platforms/esp/esp_version.h', output: 'src/platforms/esp/esp_version.h', sha256: '64159437e53a01154199017ff4182f422f575a1ee276f3394c42715827281f01' }),
      Object.freeze({ path: 'src/platforms/fastspi_ardunio_core.h', output: 'src/platforms/fastspi_ardunio_core.h', sha256: '780b93df206f9d7baecf226e1f4d9d2f803efe722c11c2a144c4055e2573a3d7' }),
      Object.freeze({ path: 'src/platforms/fs_sdcard_arduino.hpp', output: 'src/platforms/fs_sdcard_arduino.hpp', sha256: 'aaa1a6d339e83cc8a1e2a33f6bbd175486634dd59b99a4ecf2383e70497a896f' }),
      Object.freeze({ path: 'src/platforms/ui_defs.h', output: 'src/platforms/ui_defs.h', sha256: 'd00c7b8d8439ea5fa3f46f360e04741b9a99be6a6f59d7d76680c65e087045f6' }),
    ]),
    sourceTrees: Object.freeze([
      Object.freeze({ path: 'src', output: 'src', recursive: false, sha256: 'a0861e939a1e6017ec4d721958f9b16d266320a27ac2b998d3447d60de3a39b1' }),
      Object.freeze({ path: 'src/fl', output: 'src/fl', recursive: true, sha256: '25ea11b003bce7df3e47affa969ffd8f65e2cbf752cc57f69c23245e880bba14' }),
      Object.freeze({ path: 'src/fx', output: 'src/fx', recursive: true, sha256: '58e8b362b3c6e2458853a9dc66fe8071e6262f164cfcd3982f8c487de8f50a09' }),
      Object.freeze({ path: 'src/lib8tion', output: 'src/lib8tion', recursive: true, sha256: '42005b4ac3eae2b1a8c0db079497c74582c07c69fec2697139bc5a7aea82bcdf' }),
      Object.freeze({ path: 'src/platforms/esp/32', output: 'src/platforms/esp/32', recursive: true, sha256: '233bb99a1ac67be67bf12948a40fdd4d010b7b451c330ff3b281a5f97c0c546e' }),
      Object.freeze({ path: 'src/third_party', output: 'src/third_party', recursive: true, sha256: 'e4c900b3fa04c87d24e9b7397c418a32644df4d026fe9821fb397b6120fe7e58' }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE', output: 'LICENSE.txt', sha256: '4358d4c37f1305b43a3117a6a12780f666bf285538de0b28991613c0ccacecd8' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '6c5660bfa9a8bbd69689a86950cdf95a46f0ceffa0715d1b13aef09f37b917aa' }),
    ]),
    notice: 'FastLED 3.9.4, Copyright (c) Daniel Garcia and contributors, MIT License.',
  }),
  Object.freeze({
    key: 'esp32-spi',
    name: 'SPI',
    version: '3.3.7',
    commit: 'c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    repository: 'https://github.com/espressif/arduino-esp32',
    archiveUrl: 'https://codeload.github.com/espressif/arduino-esp32/tar.gz/c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    archiveSha256: '94cbb880cda24ad082dda10e3a2babd96377d580870e471d55cc6958cbe4831f',
    rootName: 'arduino-esp32-c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    arduinoIndex: null,
    packId: 'arduino-lib-esp32-spi',
    artifact: 'sources',
    architectures: Object.freeze(['esp32']),
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['SPI.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: 'libraries/SPI/src',
        output: 'src',
        recursive: true,
        sha256: 'b7ed8edb81fb8483ef9fac60cae945c2bb3c3dc36c0340ad395d478992bd2ea1',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE.md', output: 'LICENSE.txt', sha256: '62e54861b30e953735dc187f036917c588665dbe3c5dd88449e34317608bbf5e' }),
      Object.freeze({ path: 'libraries/SPI/library.properties', output: 'library.properties', sha256: '7b8c4522149c3a3eb753035f36bd7fd89cdbfe739b6392776c6d115c4e08ecf6' }),
    ]),
    notice: 'Arduino-ESP32 SPI 3.3.7, Hristo Gochkov and contributors, LGPL-2.1-or-later.',
  }),
  Object.freeze({
    key: 'esp32-wire',
    name: 'Wire',
    version: '3.3.7',
    commit: 'c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    repository: 'https://github.com/espressif/arduino-esp32',
    archiveUrl: 'https://codeload.github.com/espressif/arduino-esp32/tar.gz/c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    archiveSha256: '94cbb880cda24ad082dda10e3a2babd96377d580870e471d55cc6958cbe4831f',
    rootName: 'arduino-esp32-c94a9a59dfc294e99a0637cb39a855b8d3e472b5',
    arduinoIndex: null,
    packId: 'arduino-lib-esp32-wire',
    artifact: 'sources',
    architectures: Object.freeze(['esp32']),
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['Wire.h']),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([]),
    sourceTrees: Object.freeze([
      Object.freeze({
        path: 'libraries/Wire/src',
        output: 'src',
        recursive: true,
        sha256: '10884b4f473852e00a18b0b8d317dab03eee687dcfc6c15dda3bdf12b29e116d',
      }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE.md', output: 'LICENSE.txt', sha256: '62e54861b30e953735dc187f036917c588665dbe3c5dd88449e34317608bbf5e' }),
      Object.freeze({ path: 'libraries/Wire/library.properties', output: 'library.properties', sha256: '6b487275342aa11ee5acc9553f38c8ed502b0820fd706ec1ab8e148c08ec3c34' }),
    ]),
    notice: 'Arduino-ESP32 Wire 3.3.7, Nicholas Zambetti, Hristo Gochkov, and contributors, LGPL-2.1-or-later.',
  }),
  Object.freeze({
    key: 'onewire',
    name: 'OneWire',
    version: '2.3.8',
    commit: '72249e22ef9092b0750e303d266199965a89e500',
    repository: 'https://github.com/PaulStoffregen/OneWire',
    archiveUrl: 'https://codeload.github.com/PaulStoffregen/OneWire/tar.gz/72249e22ef9092b0750e303d266199965a89e500',
    archiveSha256: 'd0bba3294c4e94b97583ea375e58b62d0a7a428b4772e72395bbe6a4ef2fae83',
    rootName: 'OneWire-72249e22ef9092b0750e303d266199965a89e500',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/PaulStoffregen/OneWire-2.3.8.zip',
      sha256: 'dd76d1480a2f4c94348e8c8307ea74206d2936d9c80c73be67783fd200f2be17',
    }),
    packId: 'arduino-lib-onewire',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze([
      'OneWire.h',
      'util/OneWire_direct_gpio.h',
      'util/OneWire_direct_regtype.h',
    ]),
    depends: Object.freeze([]),
    sourceFiles: Object.freeze([
      Object.freeze({ path: 'OneWire.cpp', output: 'src/OneWire.cpp', sha256: 'a252b02f7f7e8a49f8c96c81add003175ce72e7b9c927d9d98514937d2656013' }),
      Object.freeze({ path: 'OneWire.h', output: 'src/OneWire.h', sha256: '806961558963b32d380c223d8c27f3d046818b3c9dc6d1ae0bd1870ced949233' }),
      Object.freeze({ path: 'util/OneWire_direct_gpio.h', output: 'src/util/OneWire_direct_gpio.h', sha256: '6c7ab6a1a979f651abef5d00d94ed686117d410714593788d579c457d56302fe' }),
      Object.freeze({ path: 'util/OneWire_direct_regtype.h', output: 'src/util/OneWire_direct_regtype.h', sha256: 'ad353ca653c8c280a3a894e768088dd15fc13cf7ce76920bfc88c6ac2049c851' }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '5027fc42bda4d6f9fd47e724fa09c3265b2d9606512b541623c6eeecfc5209f8' }),
    ]),
    licenseHeader: Object.freeze({ path: 'OneWire.cpp', output: 'LICENSE-NOTICE.txt' }),
    notice: 'OneWire 2.3.8, Jim Studt, Paul Stoffregen, Dallas Semiconductor, and contributors; license notices retained from OneWire.cpp.',
  }),
  Object.freeze({
    key: 'dallas-temperature',
    name: 'DallasTemperature',
    version: '4.0.6',
    commit: '3f570bbe2d0ad3cae55663cfaec1fedbc5b4fa50',
    repository: 'https://github.com/milesburton/Arduino-Temperature-Control-Library',
    archiveUrl: 'https://codeload.github.com/milesburton/Arduino-Temperature-Control-Library/tar.gz/3f570bbe2d0ad3cae55663cfaec1fedbc5b4fa50',
    archiveSha256: 'bd0d9166a9e92f0392f948cd0acca91a4aa728b4a27f86d28b54aeb53fcdd032',
    rootName: 'Arduino-Temperature-Control-Library-3f570bbe2d0ad3cae55663cfaec1fedbc5b4fa50',
    arduinoIndex: Object.freeze({
      url: 'https://downloads.arduino.cc/libraries/github.com/milesburton/DallasTemperature-4.0.6.zip',
      sha256: 'fb90dffd2bbd10b8eb5943968e8300ada5e4af17793b0f80c10359702d9de4e4',
    }),
    packId: 'arduino-lib-dallas-temperature',
    artifact: 'sources',
    includeDirs: Object.freeze(['src']),
    publicHeaders: Object.freeze(['DallasTemperature.h']),
    depends: Object.freeze([Object.freeze({ name: 'OneWire', version: '2.3.8' })]),
    sourceFiles: Object.freeze([
      Object.freeze({ path: 'DallasTemperature.cpp', output: 'src/DallasTemperature.cpp', sha256: 'a1a02460c65649b238b1cef32291052eef8214dc1c2c8b54b83b2a1456b3bf10' }),
      Object.freeze({ path: 'DallasTemperature.h', output: 'src/DallasTemperature.h', sha256: '4c0d12e1fe33653655f207847668833d378f34de3dfcc9c300a4fdaf8e3ac197' }),
    ]),
    metadataFiles: Object.freeze([
      Object.freeze({ path: 'LICENSE', output: 'LICENSE.txt', sha256: 'd1656adecdddcf223dfbb2d3056491226836acb671d9f1b09870008036633951' }),
      Object.freeze({ path: 'library.properties', output: 'library.properties', sha256: '48fb912f9282bc90c8e9d4bc31ccb0dc56261a81d94645a15bd8760e1fc24e02' }),
    ]),
    notice: 'DallasTemperature 4.0.6, Copyright (c) 2024 Miles Burton, MIT License.',
  }),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseBrowserEsp32LibraryBuildArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, roots: {} };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--output') options.output = resolve(value);
    else if (argument === '--source-root' || argument === '--pubsubclient-root') options.roots.pubsubclient = resolve(value);
    else if (argument === '--adafruit-busio-root') options.roots['adafruit-busio'] = resolve(value);
    else if (argument === '--adafruit-gfx-root') options.roots['adafruit-gfx'] = resolve(value);
    else if (argument === '--adafruit-ssd1306-root') options.roots['adafruit-ssd1306'] = resolve(value);
    else if (argument === '--adafruit-sensor-root') options.roots['adafruit-sensor'] = resolve(value);
    else if (argument === '--dht-root') options.roots.dht = resolve(value);
    else if (argument === '--esp32servo-root') options.roots.esp32servo = resolve(value);
    else if (argument === '--fastled-root') options.roots.fastled = resolve(value);
    else if (argument === '--esp32-core-root') {
      options.roots['esp32-spi'] = resolve(value);
      options.roots['esp32-wire'] = resolve(value);
    }
    else if (argument === '--onewire-root') options.roots.onewire = resolve(value);
    else if (argument === '--dallas-temperature-root') options.roots['dallas-temperature'] = resolve(value);
    else throw new Error(`unknown argument: ${argument}`);
  }
  const outputRelative = relative(PUBLIC_V1, options.output);
  if (!outputRelative || outputRelative.startsWith('..') || resolve(PUBLIC_V1, outputRelative) !== options.output) {
    throw new Error('library output must stay below packages/web/public/esp32/v1');
  }
  return options;
}

async function acquireSource(definition, sourceRoot) {
  if (sourceRoot) return { root: sourceRoot, cleanup() {} };
  const temporary = mkdtempSync(join(tmpdir(), `arduinofast-${definition.key}-`));
  try {
    const response = await fetch(definition.archiveUrl);
    if (!response.ok) throw new Error(`${definition.name} archive returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== definition.archiveSha256) {
      throw new Error(`${definition.name} archive checksum mismatch`);
    }
    const archive = join(temporary, 'source.tar.gz');
    writeFileSync(archive, bytes);
    await tar.x({ cwd: temporary, file: archive, strict: true });
    return {
      root: join(temporary, definition.rootName),
      cleanup() { rmSync(temporary, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readLockedFile(root, definition, lock) {
  const path = join(root, ...lock.path.split('/'));
  if (!existsSync(path)) throw new Error(`locked ${definition.name} file is missing: ${lock.path}`);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== lock.sha256) throw new Error(`locked ${definition.name} file changed: ${lock.path}`);
  return bytes;
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateTreePath(value, { allowDot = false } = {}) {
  if (allowDot && value === '.') return;
  if (
    typeof value !== 'string'
    || !value.length
    || value.includes('\\')
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || !/^[A-Za-z0-9._/-]+$/.test(value)
  ) throw new Error(`invalid browser library source tree path: ${String(value)}`);
}

export function readLockedSourceTreeFiles(root, definition) {
  const files = [];
  const sourceRoot = resolve(root);
  for (const tree of definition.sourceTrees ?? []) {
    validateTreePath(tree.path, { allowDot: true });
    validateTreePath(tree.output);
    if (typeof tree.recursive !== 'boolean' || !/^[a-f0-9]{64}$/.test(tree.sha256)) {
      throw new Error(`invalid ${definition.name} source tree lock: ${tree.path}`);
    }
    const treeRoot = resolve(sourceRoot, ...tree.path.split('/'));
    const treeRelative = relative(sourceRoot, treeRoot);
    if (treeRelative.startsWith('..') || resolve(sourceRoot, treeRelative) !== treeRoot) {
      throw new Error(`${definition.name} source tree escapes its root: ${tree.path}`);
    }
    let rootStat;
    try { rootStat = lstatSync(treeRoot); } catch {
      throw new Error(`locked ${definition.name} source tree is missing: ${tree.path}`);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`locked ${definition.name} source tree is not a regular directory: ${tree.path}`);
    }

    const selected = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
        asciiCompare(left.name, right.name)
      ))) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`locked ${definition.name} source tree contains a symbolic link: ${tree.path}`);
        }
        if (entry.isDirectory()) {
          if (tree.recursive) walk(path);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(`locked ${definition.name} source tree contains an unsupported entry: ${tree.path}`);
        }
        if (SOURCE_EXTENSIONS.has(extname(entry.name))) selected.push(path);
      }
    };
    walk(treeRoot);
    if (!selected.length) throw new Error(`locked ${definition.name} source tree is empty: ${tree.path}`);

    const digest = createHash('sha256');
    for (const path of selected) {
      const sourcePath = relative(treeRoot, path).split(sep).join('/');
      const bytes = readFileSync(path);
      digest.update(sourcePath).update('\0').update(bytes).update('\0');
      files.push(Object.freeze({
        path: relative(sourceRoot, path).split(sep).join('/'),
        output: `${tree.output}/${sourcePath}`,
        sha256: sha256(bytes),
        bytes,
      }));
    }
    if (digest.digest('hex') !== tree.sha256) {
      throw new Error(`locked ${definition.name} source tree changed: ${tree.path}`);
    }
  }
  return Object.freeze(files);
}

function readLockedLibrarySourceFiles(root, definition) {
  const files = [
    ...definition.sourceFiles.map((lock) => Object.freeze({
      path: lock.path,
      output: lock.output,
      sha256: lock.sha256,
      bytes: readLockedFile(root, definition, lock),
    })),
    ...readLockedSourceTreeFiles(root, definition),
  ].sort((left, right) => asciiCompare(left.output, right.output));
  const outputs = new Set();
  for (const file of files) {
    const folded = file.output.toLowerCase();
    if (outputs.has(folded)) throw new Error(`locked ${definition.name} source output is duplicated: ${file.output}`);
    outputs.add(folded);
  }
  if (!files.length) throw new Error(`locked ${definition.name} source set is empty`);
  return Object.freeze(files);
}

export function validateBrowserEsp32LibraryPublicHeaders(definition, lockedSourceFiles) {
  if (!Array.isArray(definition.includeDirs) || !definition.includeDirs.length || definition.includeDirs.length > 16) {
    throw new Error(`invalid ${definition.name} include directories`);
  }
  for (const includeDir of definition.includeDirs) validateTreePath(includeDir, { allowDot: true });
  if (!Array.isArray(definition.publicHeaders) || !definition.publicHeaders.length || definition.publicHeaders.length > 512) {
    throw new Error(`invalid ${definition.name} public headers`);
  }

  const publishedFiles = new Set(lockedSourceFiles.map(({ output }) => output));
  const publicHeaders = [];
  let previous = '';
  for (const header of definition.publicHeaders) {
    validateTreePath(header);
    if (!HEADER_EXTENSIONS.has(extname(header))) {
      throw new Error(`invalid ${definition.name} public header: ${header}`);
    }
    const folded = header.toLowerCase();
    if (folded <= previous) {
      throw new Error(`${definition.name} public headers must be sorted and unique`);
    }
    const isPublished = definition.includeDirs.some((includeDir) => (
      publishedFiles.has(includeDir === '.' ? header : `${includeDir}/${header}`)
    ));
    if (!isPublished) throw new Error(`${definition.name} public header is not in an include directory: ${header}`);
    publicHeaders.push(header);
    previous = folded;
  }
  return Object.freeze(publicHeaders);
}

function addPackArtifact(directory, id, kind, bytes) {
  if (!bytes.byteLength) throw new Error(`empty browser library artifact: ${id}`);
  const digest = sha256(bytes);
  const chunkPath = `chunks/${id}-${digest.slice(0, 16)}.bin`;
  mkdirSync(join(directory, 'chunks'), { recursive: true });
  writeFileSync(join(directory, ...chunkPath.split('/')), bytes);
  return Object.freeze({
    id,
    kind,
    size: bytes.byteLength,
    sha256: digest,
    chunks: Object.freeze([Object.freeze({ path: chunkPath, size: bytes.byteLength, sha256: digest })]),
  });
}

function extractLicenseHeader(bytes, label) {
  const text = bytes.toString('utf8');
  const end = text.indexOf('*/');
  if (!text.startsWith('/*') || end < 0) throw new Error(`${label} license header is missing`);
  return `${text.slice(0, end + 2)}\n`;
}

function buildLibrary(definition, root, output) {
  const lockedSourceFiles = readLockedLibrarySourceFiles(root, definition);
  const publicHeaders = validateBrowserEsp32LibraryPublicHeaders(definition, lockedSourceFiles);
  const architectures = definition.architectures ?? Object.freeze(['*']);
  for (const lock of definition.metadataFiles) readLockedFile(root, definition, lock);
  const packageDirectory = join(output, definition.key, definition.version);
  mkdirSync(packageDirectory, { recursive: true });

  const files = lockedSourceFiles
    .map((file) => ({
      path: file.output,
      content: file.bytes.toString('utf8'),
    }))
    .sort((left, right) => asciiCompare(left.path, right.path));
  const payload = {
    schema: 1,
    name: definition.name,
    version: definition.version,
    architectures,
    includeDirs: definition.includeDirs,
    files,
  };
  const artifact = addPackArtifact(
    packageDirectory,
    definition.artifact,
    'library-source-json',
    Buffer.from(JSON.stringify(payload), 'utf8'),
  );
  const revisionInput = JSON.stringify({
    schema: 1,
    id: definition.packId,
    version: definition.version,
    artifacts: [artifact],
  });
  const manifest = {
    schema: 1,
    id: definition.packId,
    version: definition.version,
    revision: sha256(Buffer.from(revisionInput, 'utf8')),
    artifacts: [artifact],
  };
  writeFileSync(join(packageDirectory, 'toolchain.json'), stableJson(manifest), 'utf8');

  for (const lock of definition.metadataFiles) {
    copyFileSync(join(root, ...lock.path.split('/')), join(packageDirectory, lock.output ?? basename(lock.path)));
  }
  if (definition.licenseHeader) {
    const sourceLock = lockedSourceFiles.find(({ path }) => path === definition.licenseHeader.path);
    if (!sourceLock) throw new Error(`${definition.name} license source is not locked`);
    writeFileSync(
      join(packageDirectory, definition.licenseHeader.output),
      extractLicenseHeader(sourceLock.bytes, definition.name),
      'utf8',
    );
  }
  writeFileSync(join(packageDirectory, 'source-lock.json'), stableJson({
    schema: 1,
    upstream: definition.repository,
    commit: definition.commit,
    archive: { url: definition.archiveUrl, sha256: definition.archiveSha256 },
    ...(definition.arduinoIndex ? { arduinoIndex: definition.arduinoIndex } : {}),
    ...(definition.sourceTrees?.length ? { sourceTrees: definition.sourceTrees } : {}),
    files: [
      ...lockedSourceFiles.map(({ path, output: publishedPath, sha256: digest }) => ({ path, publishedPath, sha256: digest })),
      ...definition.metadataFiles.map(({ path, output: publishedPath, sha256: digest }) => ({ path, publishedPath, sha256: digest })),
    ],
  }), 'utf8');
  return {
    name: definition.name,
    defaultVersion: definition.version,
    versions: [{
      version: definition.version,
      architectures,
      publicHeaders,
      depends: definition.depends,
      pack: {
        id: definition.packId,
        revision: manifest.revision,
        manifest: `${definition.key}/${definition.version}/toolchain.json`,
        artifact: definition.artifact,
      },
    }],
  };
}

export async function buildBrowserEsp32Libraries({ output = DEFAULT_OUTPUT, roots = {} } = {}) {
  const sharedAcquisitions = new Map();
  const acquired = await Promise.all(BROWSER_ESP32_LIBRARIES.map((definition) => {
    const sourceRoot = roots[definition.key];
    if (sourceRoot) return acquireSource(definition, sourceRoot);
    const key = `${definition.archiveUrl}\0${definition.archiveSha256}\0${definition.rootName}`;
    if (!sharedAcquisitions.has(key)) sharedAcquisitions.set(key, acquireSource(definition));
    return sharedAcquisitions.get(key);
  }));
  const staging = mkdtempSync(join(dirname(output), '.libraries-build-'));
  try {
    const libraries = BROWSER_ESP32_LIBRARIES
      .map((definition, index) => buildLibrary(definition, acquired[index].root, staging))
      .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
    const registryBytes = Buffer.from(stableJson({ schema: 2, libraries }), 'utf8');
    writeFileSync(join(staging, 'registry.json'), registryBytes);
    writeFileSync(join(staging, 'THIRD_PARTY_NOTICES.md'), [
      '# Browser Library Registry Notices',
      '',
      ...BROWSER_ESP32_LIBRARIES.flatMap((definition) => [
        `- ${definition.notice}`,
        '  The pinned upstream license material and source lock are stored with its immutable pack.',
      ]),
      '',
    ].join('\n'), 'utf8');

    rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
    return Object.freeze({
      output,
      registryPath: join(output, 'registry.json'),
      registrySha256: sha256(registryBytes),
      libraries: Object.freeze(libraries),
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    for (const source of new Set(acquired)) source.cleanup();
  }
}

async function main() {
  const result = await buildBrowserEsp32Libraries(parseBrowserEsp32LibraryBuildArgs(process.argv.slice(2)));
  console.log(`registry=${result.registryPath}`);
  console.log(`registry sha256=${result.registrySha256}`);
  console.log(`libraries=${result.libraries.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
