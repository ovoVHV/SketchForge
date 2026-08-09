import { describe, expect, it } from 'vitest';
import {
  CK_LIBRARY_CATALOG_SCHEMA,
  LibraryCatalog,
  createArduinoCommonLibraryCatalog,
} from '../src/library/catalog.js';

describe('CK library catalog', () => {
  it('ships a verified Arduino-index catalog without fabricated checksums', () => {
    const catalog = createArduinoCommonLibraryCatalog();
    expect(catalog.schema).toBe(CK_LIBRARY_CATALOG_SCHEMA);
    expect(catalog.entries.length).toBeGreaterThanOrEqual(90);
    const adafruit = catalog.get('Adafruit SSD1306');
    expect(adafruit).toMatchObject({ name: 'Adafruit SSD1306', version: '2.5.17' });
    expect(adafruit?.source).toMatchObject({
      kind: 'archive',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      url: expect.stringContaining('Adafruit_SSD1306-2.5.17.zip'),
    });
  });

  it('queries by id and architecture and expands recursive dependencies', () => {
    const catalog = createArduinoCommonLibraryCatalog();
    const dht = catalog.get('DHT sensor library');
    expect(dht?.id).toBe('dht-sensor-library-1-4-7');
    expect(catalog.get(dht!.id)?.name).toBe('DHT sensor library');
    expect(catalog.list({ architecture: 'esp32', text: 'display' }).length).toBeGreaterThan(0);

    const resolved = catalog.resolve([{ name: 'Adafruit SSD1306' }], 'esp32');
    expect(resolved.errors).toEqual([]);
    expect(resolved.libraries.map((entry) => entry.name)).toEqual([
      'Adafruit BusIO',
      'Adafruit GFX Library',
      'Adafruit SSD1306',
    ]);
  });

  it('rejects unsupported architectures and version conflicts', () => {
    const catalog = createArduinoCommonLibraryCatalog();
    expect(catalog.resolve([{ name: 'ESP32Servo' }], 'avr').errors.join(' ')).toMatch(/does not support avr/);
    expect(catalog.resolve([
      { name: 'Adafruit SSD1306', version: '2.5.17' },
      { name: 'Adafruit SSD1306', version: '0.0.1' },
    ]).errors.join(' ')).toMatch(/version conflict|version not found/);
  });

  it('validates arbitrary catalog records and only exposes archive sources as installable', () => {
    const catalog = new LibraryCatalog([{
      id: 'local-demo',
      name: 'Local Demo',
      defaultVersion: '1.0.0',
      versions: [{
        id: 'local-demo-1-0-0',
        name: 'Local Demo',
        version: '1.0.0',
        architectures: ['*'],
        dependencies: [],
        publicHeaders: ['Demo.h'],
        source: { kind: 'pack', packId: 'ck-demo', revision: 'a'.repeat(64) },
      }],
    }]);
    expect(catalog.installable()).toHaveLength(1);
    expect(catalog.toJSON().schema).toBe(CK_LIBRARY_CATALOG_SCHEMA);
  });

  it('rejects two Pack revisions for the same library name and version', () => {
    const version = {
      id: 'local-demo-1-0-0-a',
      name: 'Local Demo',
      version: '1.0.0',
      architectures: ['*'],
      dependencies: [],
      publicHeaders: ['Demo.h'],
      source: { kind: 'pack' as const, packId: 'ck-demo-a', revision: 'a'.repeat(64) },
    };

    expect(() => new LibraryCatalog([{
      id: 'local-demo',
      name: 'Local Demo',
      defaultVersion: '1.0.0',
      versions: [
        version,
        {
          ...version,
          id: 'local-demo-1-0-0-b',
          source: { kind: 'pack', packId: 'ck-demo-b', revision: 'b'.repeat(64) },
        },
      ],
    }])).toThrow(/ambiguous library source revision.*Local Demo@1\.0\.0/i);
  });
});
