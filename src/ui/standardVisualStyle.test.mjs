import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_VISUAL_STYLE } from './visualPresets.js';

test('ordinary globe uses Normal at every hour', () => {
  assert.equal(DEFAULT_VISUAL_STYLE, 'normal');
  const settings = readFileSync(
    new URL('./visualSettings.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(settings, /automaticVisualStyleAt|StyleBoundary/);
  assert.match(
    settings,
    /useStandardStyle\(\)[\s\S]*setStyle\(DEFAULT_VISUAL_STYLE/,
  );
});

test('startup normalizes legacy restored visual styles once', () => {
  const shell = readFileSync(
    new URL('./applicationShell.js', import.meta.url),
    'utf8',
  );
  assert.match(
    shell,
    /initialRestorePromise\.then\([\s\S]*useStandardStyle\(\)/,
  );
  assert.doesNotMatch(shell, /startAutomaticStyle/);
});
