// Limits the ChatGPT Actions importer enforces, checked here so a schema change
// fails at `npm test` rather than as red text in the GPT editor after a deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import openapi from '../src/openapi.js';

// Found the hard way: the editor rejected searchLibrary (477) and getDocument
// (551) with "description has length N exceeding limit of 300". Operation
// descriptions are the only place this bites — parameter and response
// descriptions are not capped.
const MAX_OPERATION_DESCRIPTION = 300;

function operations() {
  const out = [];
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(methods)) out.push({ path, method, op });
  }
  return out;
}

test('every operation description fits the importer limit', () => {
  for (const { path, op } of operations()) {
    const n = (op.description || '').length;
    assert.ok(n <= MAX_OPERATION_DESCRIPTION,
      `${path} ${op.operationId}: description is ${n} chars, limit is ${MAX_OPERATION_DESCRIPTION}`);
  }
});

test('every operation has an operationId and a summary', () => {
  for (const { path, method, op } of operations()) {
    assert.ok(op.operationId, `${method.toUpperCase()} ${path} has no operationId`);
    assert.ok(op.summary, `${path} ${op.operationId} has no summary`);
  }
});

test('operationIds are unique — the GPT calls them by name', () => {
  const ids = operations().map(({ op }) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, `duplicate operationId in ${ids.join(', ')}`);
});

test('the library operations are present and are GETs', () => {
  const byId = Object.fromEntries(operations().map(({ method, op }) => [op.operationId, method]));
  assert.equal(byId.searchLibrary, 'get');
  assert.equal(byId.getDocument, 'get');
});

test('every $ref resolves to a defined schema', () => {
  const defined = new Set(Object.keys(openapi.components.schemas));
  const refs = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else walk(v);
      }
    }
  })(openapi.paths);
  for (const ref of refs) {
    const name = ref.replace('#/components/schemas/', '');
    assert.ok(defined.has(name), `${ref} is referenced but not defined`);
  }
});
