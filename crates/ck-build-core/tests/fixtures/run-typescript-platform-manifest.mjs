import fs from 'node:fs';
import { canonicalJson } from '../../../../packages/core/dist/build-ir/canonical.js';
import { resolvePlatformManifest } from '../../../../packages/core/dist/platform-pack/builder.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(canonicalJson(resolvePlatformManifest(input)));
