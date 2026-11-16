#!/usr/bin/env node
// Regenerates src/openapi.js from gpt-action-schema.yaml with the live server URL,
// so the document the Worker serves can never drift from the one in the repo.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const WORKER_URL = process.env.WORKER_URL || 'https://ijuh2yp6rf.example-subdomain.workers.dev';
const yaml = readFileSync(new URL('../gpt-action-schema.yaml', import.meta.url), 'utf8')
  .replace('https://WORKER-URL.workers.dev', WORKER_URL);

// Use Python's YAML parser rather than adding a JS dependency for one build step.
const json = execFileSync('python3', ['-c', 'import sys,yaml,json;json.dump(yaml.safe_load(sys.stdin),sys.stdout,indent=2)'], { input: yaml }).toString();

writeFileSync(new URL('../src/openapi.js', import.meta.url),
  `// GENERATED — do not edit by hand.\n// Rebuild with: node scripts/build-openapi.mjs\n// Source of truth: gpt-action-schema.yaml\n\nexport default ${json};\n`);
console.log(`src/openapi.js rebuilt for ${WORKER_URL}`);
