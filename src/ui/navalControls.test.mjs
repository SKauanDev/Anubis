import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { expandApplicationHtml } from '../../build/application-html.js';
import { formatCompactCount } from './navalControls.js';

const html = expandApplicationHtml(
  readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
);
const controls = readFileSync(
  new URL('./navalControls.js', import.meta.url),
  'utf8',
);
const shell = readFileSync(
  new URL('./applicationShell.js', import.meta.url),
  'utf8',
);
const chrome = readFileSync(
  new URL('./panelChrome.js', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('./styles/layers.css', import.meta.url),
  'utf8',
);

test('Área Naval is an independent right-rail panel with maritime controls', () => {
  assert.match(html, /id="naval-panel"[^>]*data-panel-id="naval-panel"/);
  assert.match(html, /class="panel-title">ÁREA NAVAL<\/span>/);
  for (const id of [
    'naval-vessels-toggle',
    'naval-nearby-btn',
    'naval-cables-toggle',
    'naval-bases-toggle',
    'naval-cctv-btn',
    'naval-nearby-list',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /#right-context-rail > #naval-panel/);
  assert.match(chrome, /'naval-panel'/);
});

test('Área Naval reuses live AIS and established world-focus ownership', () => {
  assert.match(controls, /const VESSELS_LAYER_ID = 'ais-live-vessels'/);
  assert.match(
    controls,
    /const CABLES_LAYER_ID = 'telegeography-submarine-cables'/,
  );
  assert.match(controls, /const BASES_LAYER_ID = 'military-installations'/);
  assert.match(controls, /getNearby\?\.\(this\._viewCenter\(\), Infinity, 8\)/);
  assert.match(controls, /this\.vessels\?\.selectById\?\.\(mmsi\)/);
  assert.match(controls, /requestWorldFocus\(\{/);
  assert.match(shell, /new NavalControls\(\{/);
  assert.match(shell, /this\._cctvNearestBtn\?\.click\(\)/);
});

test('Area Naval compacts large vessel totals without breaking its header', () => {
  assert.equal(formatCompactCount(999), '999');
  assert.equal(formatCompactCount(1_000), '1k');
  assert.equal(formatCompactCount(1_250), '1,3k');
  assert.equal(formatCompactCount(12_000), '12k');
  assert.equal(formatCompactCount(1_200_000), '1,2M');
});
