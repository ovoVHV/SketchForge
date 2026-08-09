import { describe, expect, it } from 'vitest';

import {
  platformPublicHeaders,
  removeAmbiguousPlatformHeaders,
} from '../../../scripts/build-ck-platform-library-packs.js';

const file = (path: string) => ({ path, bytes: Buffer.alloc(0) });

describe('CK Platform Library Pack Builder', () => {
  it('uses an explicit Arduino includes list when one is declared', () => {
    expect(platformPublicHeaders(
      'NetworkClientSecure',
      'NetworkClientSecure',
      'NetworkClientSecure.h, WiFiClientSecure.h',
      [file('src/NetworkClientSecure.h'), file('src/WiFiClientSecure.h')],
    )).toEqual(['NetworkClientSecure.h', 'WiFiClientSecure.h']);
  });

  it('exports every root header when library.properties omits includes', () => {
    expect(platformPublicHeaders(
      'NetworkClientSecure',
      'NetworkClientSecure',
      undefined,
      [
        file('src/NetworkClientSecure.h'),
        file('src/WiFiClientSecure.h'),
        file('src/ssl_client.h'),
        file('src/private/config.h'),
        file('src/NetworkClientSecure.cpp'),
      ],
    )).toEqual(['NetworkClientSecure.h', 'WiFiClientSecure.h', 'ssl_client.h']);
  });

  it('removes cross-library header aliases while retaining unique public headers', () => {
    const rows = [
      { name: 'SD', versions: [{ publicHeaders: ['SD.h', 'sd_defines.h'] }] },
      { name: 'SD_MMC', versions: [{ publicHeaders: ['SD_MMC.h', 'sd_defines.h'] }] },
    ];
    removeAmbiguousPlatformHeaders(rows);
    expect(rows).toEqual([
      { name: 'SD', versions: [{ publicHeaders: ['SD.h'] }] },
      { name: 'SD_MMC', versions: [{ publicHeaders: ['SD_MMC.h'] }] },
    ]);
  });
});
