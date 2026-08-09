import { resolve } from 'node:path';
import { mergeFeaturedFirmwareManifestFiles } from './prebuild-featured-firmware.js';

const [output, ...inputs] = process.argv.slice(2);

if (!output || inputs.length === 0) {
  console.error('usage: merge-featured-firmware-manifests <output.json> <manifest.json> [...]');
  process.exitCode = 2;
} else {
  try {
    const manifest = await mergeFeaturedFirmwareManifestFiles(resolve(output), inputs.map((input) => resolve(input)));
    console.log(`Merged ${inputs.length} featured firmware manifests (${manifest.entries.length} identities) into ${resolve(output)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
