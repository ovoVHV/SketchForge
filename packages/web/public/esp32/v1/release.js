/**
 * Same-origin release pins for the experimental ESP32 browser route.
 *
 * This is executable bootstrap metadata and must stay on the application
 * origin. A CDN may eventually serve verified toolchain data, but it must not
 * be able to enable a browser compiler by changing its own manifest.
 */
export const ESP32_BROWSER_RELEASE = Object.freeze({
  schema: 1,
  capabilities: Object.freeze({
    path: 'capabilities.json',
    // Updated together with capabilities.json.
    sha256: '133b2aec88320ba81216fce8049d24879673d6d029e1c47863d2c152339d0799',
  }),
  libraries: Object.freeze({
    path: 'libraries-catalog/registry.json',
    // Updated only after the catalog publisher verifies every referenced Pack.
    sha256: '6394e23ac6e4d9b099316b1aeb3003f60b872525bb84ee35d01b9aa000afcea6',
  }),
  platforms: Object.freeze({
    path: 'platform-manifests/registry.json',
    sha256: 'c8a93295a54ccf9f46f57866eebfe8e96666fa91bced291cf0428fbbaddf0a06',
  }),
  runtimes: Object.freeze({
    'esp32-riscv': Object.freeze({
      enabled: true,
      toolchainId: 'riscv32-esp-elf-wasm',
      revision: 'da8ae2555f96b021faa75986c30ff5fd4be6ce022c48c13a303729751cd6d2c4',
      descriptors: Object.freeze({
        'esp32:esp32:esp32c3': Object.freeze({
          path: './esp32/v2/runtime/runtime.json',
          sha256: '69b23b203f764097331432e87c060a70f0dfec8d7cae1ae484c61d7ee5ba111b',
        }),
        'esp32:esp32:esp32c6': Object.freeze({
          path: './esp32/v2/runtime-c6/runtime.json',
          sha256: 'fbfeb424ce14716d1bb408139571fad6a34ec325ff2fdc92be070bda39fe1b5a',
        }),
      }),
    }),
    'esp32-xtensa': Object.freeze({
      enabled: true,
      toolchainId: 'xtensa-esp-elf-wasm',
      revision: '88ab93457f1c89e2edab1c79aa13aa7dd0afd097b13481741b6a9f8ad2d73142',
      descriptors: Object.freeze({
        'esp32:esp32:esp32': Object.freeze({
          path: './esp32/v5/xtensa/esp32.json',
          sha256: '1d7d72737b32f9d50df9ffdfd12bb7847138f7662ecfea52aae9189a032e7ecd',
        }),
        'esp32:esp32:esp32s2': Object.freeze({
          path: './esp32/v5/xtensa/esp32s2.json',
          sha256: '6cb2aff008d61cd1cf833de3fef89c94b4ae72ce314c2c5072ce4bf01e0d599c',
        }),
        'esp32:esp32:esp32s3': Object.freeze({
          path: './esp32/v5/xtensa/esp32s3.json',
          sha256: '8e722199fd9265ba09c8ccae909cba980c4c4595fa563817c8d640ddcc717c1a',
        }),
      }),
    }),
  }),
});

export function esp32BrowserCapabilitiesUrl() {
  return new URL(ESP32_BROWSER_RELEASE.capabilities.path, import.meta.url);
}
