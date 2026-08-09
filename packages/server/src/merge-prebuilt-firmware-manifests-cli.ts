import { resolve } from 'node:path';
import { mergePrebuiltFirmwareManifestFiles } from './prebuild-firmware-assets.js';

async function main(): Promise<void> {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) {
    throw new TypeError('usage: merge-prebuilt-firmware-manifests OUTPUT INPUT...');
  }
  const merged = await mergePrebuiltFirmwareManifestFiles(resolve(output), inputs.map((input) => resolve(input)));
  console.log(`Merged ${inputs.length} shards and ${merged.entries.length} static firmware identities into ${resolve(output)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
