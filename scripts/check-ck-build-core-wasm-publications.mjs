#!/usr/bin/env node

import { readPlannerPublicationIdentity } from './verify-ck-native-library-matrix.mjs';

const identity = await readPlannerPublicationIdentity();
if (identity.publications.length !== 3) {
  throw new Error(`expected three CK Build Core WASM publications, found ${identity.publications.length}`);
}

console.log(
  `CK Build Core WASM publications match (3 copies, artifactSetSha256=${identity.artifactSetSha256})`,
);
