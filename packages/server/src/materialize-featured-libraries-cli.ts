import { resolve } from 'node:path';
import { materializeFeaturedLibraries } from './materialize-featured-libraries.js';

try {
  const registryPath = resolve(process.env.AF_FEATURED_LIBRARY_REGISTRY ?? 'packages/web/public/esp32/v1/libraries/registry.json');
  const outputDir = resolve(process.env.AF_FEATURED_LIBRARY_DIR ?? 'var/featured-libraries');
  const result = materializeFeaturedLibraries({ registryPath, outputDir });
  console.log(`Materialized ${result.libraries.length} verified featured libraries into ${outputDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
