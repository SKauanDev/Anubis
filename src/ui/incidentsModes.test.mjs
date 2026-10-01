import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createIncidentSource } from '../incidents/source.js';

test('Incidents panel exposes and wires the four monitoring modes', () => {
  const markup = readFileSync(
    new URL('./templates/context.html', import.meta.url),
    'utf8',
  );
  const shell = readFileSync(
    new URL('./applicationShell.js', import.meta.url),
    'utf8',
  );
  for (const mode of ['events', 'environment', 'ocean', 'alerts'])
    assert.match(markup, new RegExp(`data-incidents-mode="${mode}"`));
  assert.match(shell, /_incidentsModeTabs: this\._incidentsModeTabs/);
  assert.match(shell, /_incidentsListTitle: this\._incidentsListTitle/);
});

test('Incident source requests the selected mode without trusting response shape', async () => {
  let requested = '';
  const source = createIncidentSource({
    fetchImpl: async (url) => {
      requested = url;
      return new Response(
        JSON.stringify({ incidents: [], providers: {}, stale: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  await source.getSnapshot({ mode: 'ocean' });
  assert.equal(requested, '/api/incidents?mode=ocean');
});
