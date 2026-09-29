// dist/cjs sits under a package whose default module type is ESM-agnostic;
// this marker makes Node treat those files as CommonJS explicitly.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{"type":"commonjs"}\n');
