// Dated, human-observed checks; never heartbeats. These timestamps must not move
// on build/deploy. Sources describe exactly what was seen, not broader uptime.
const gptSetup = {
  tested_on: '2026-10-11', outcome: 'passed', method: 'Private teaching activation and bounded native checks',
  detail: 'The private merged teaching instructions and course-scoped Action schema 1.3.0 were published and reloaded. Bounded isolated native checks covered understanding, save and fresh retrieval; separate production authenticated reads passed. This dated check is not a heartbeat or proof of future answer accuracy.',
  source: '../docs/teaching-rollout.md',
};
export const CONNECTION_EVIDENCE = Object.freeze({
  'gpt-BUSN5000': gptSetup,
  'gpt-MGMT4280': {
    tested_on: '2026-10-11', tested_at: '2026-10-11T21:38:09.561Z', outcome: 'passed', method: 'Private teaching hardening and bounded native Action checks',
    detail: 'The hardened private teaching instructions matched after reload; existing Action schema 1.2.2 and authentication were preserved. Fourteen isolated native cases covered method evidence, save, exact retry and fresh retrieval. This dated test is not a heartbeat, current Knowledge inventory or proof of future answer accuracy.',
    source: '../docs/teaching-mgmt4280.md',
  },
  'gpt-MGMT5560': gptSetup, 'gpt-MGMT5850': gptSetup,
  'gpt-LAND2510': gptSetup, 'gpt-BUSN3040': gptSetup,
  codex: {
    tested_on: '2026-10-12', tested_at: '2026-10-12T04:45:59.194Z', outcome: 'passed', method: 'Registered MCP status and continuation reads',
    detail: 'The actual Codex connection returned scoped MGMT4280 status with both feeds complete; its exact continuation token returned the requested remaining section. Urgent items and warnings were complete, while the response disclosed its oversize and trimmed sections. No coursework or learning write was performed. This is a dated connection check, not a heartbeat.',
    source: 'docs/map-connection-evidence.md',
  },
  knowledge: {
    tested_on: '2026-10-11', outcome: 'passed', method: 'Scoped BUSN3040 publication and source retrieval',
    detail: 'The BUSN3040 opening/setup announcement bundle was privately published and reloaded, with exact Bridge text readback and three native source/retrieval checks. This verifies that selected bundle only; it is not a current six-course inventory or evidence that later queued bundles have published.',
    source: '../docs/busn3040-materials.md',
  },
  chrome: {
    tested_on: '2026-09-05', tested_at: '2026-09-05T19:42:57Z', outcome: 'passed', method: 'Manual eLC portal access check',
    detail: 'After the user signed in, this Mac’s Chrome showed the authenticated eLC homepage. The earlier check had redirected to sessionExpired=1. This confirms portal login only, not the collector API, content/grade job completion, or other Chrome portals.',
    source: 'docs/map-connection-evidence.md',
  },
  assistant: {
    tested_on: '2026-10-12', outcome: 'failed', method: 'Native dashboard inference check',
    detail: 'An actual dashboard assistant request reported insufficient Anthropic account credit. Provider funding is required before another inference check can pass. A configured credential does not establish a functional inference connection; this is a dated failure, not a continuous heartbeat.',
    source: 'docs/map-connection-evidence.md',
  },
});
