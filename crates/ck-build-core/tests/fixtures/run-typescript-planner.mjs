import fs from 'node:fs';
import { planBuildIR } from '../../../../packages/core/dist/build-ir/planner.js';
import { canonicalJson } from '../../../../packages/core/dist/build-ir/canonical.js';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(canonicalJson(planBuildIR(input)));
