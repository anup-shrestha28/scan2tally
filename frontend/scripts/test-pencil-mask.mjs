/**
 * Tests for the pencil-mask geometry.
 *
 * Run with: node scripts/test-pencil-mask.mjs   (or `npm test`)
 *
 * The canvas drawing itself is browser-only; what is testable — and what would
 * quietly hide the wrong part of a financial document if it drifted — is the
 * arithmetic: which stored boxes are trusted at all, and which pixels a
 * trusted box covers.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/lib/pencilMask.ts'), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { sanitizePencilRegions, regionToPixels } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

let failures = 0;
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
}
function equal(name, expected, actual) {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  check(name, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ------------------------------------------------- what is trusted at all
equal('a clean box passes', [[100, 200, 140, 380]], sanitizePencilRegions([[100, 200, 140, 380]]));
equal('reversed corners are reordered', [[100, 200, 140, 380]], sanitizePencilRegions([[140, 380, 100, 200]]));
equal('out-of-range values are clamped', [[0, 200, 1000, 380]], sanitizePencilRegions([[-50, 200, 1400, 380]]));
equal('a sliver is dropped', [], sanitizePencilRegions([[100, 200, 100, 380]]));
equal('malformed entries are dropped', [], sanitizePencilRegions([[1, 2, 3], 'junk', null, { y: 1 }]));
equal('a non-list is nothing', [], sanitizePencilRegions('not a list'));
equal('null is nothing', [], sanitizePencilRegions(null));
equal('numeric strings still land', [[100, 200, 140, 380]], sanitizePencilRegions([[99.6, '200', 140.2, 380]]));
equal('an avalanche of boxes is discarded wholesale', [],
  sanitizePencilRegions(Array.from({ length: 41 }, () => [0, 0, 10, 10])));

// ------------------------------------------------- which pixels get covered
{
  // The stored box arrives already fitted to the writing by the backend, so
  // the cover must land on exactly it. Padding here is what hid ink before.
  const patch = regionToPixels([100, 200, 140, 380], 1000, 1000);
  equal('the cover is exactly the stored box, unpadded',
    { x: 200, y: 100, w: 180, h: 40 }, patch);
}
{
  // The same box on the real photo size, 1200x1600: normalized coordinates
  // must scale by each axis independently.
  const patch = regionToPixels([100, 200, 140, 380], 1200, 1600);
  check('x scales by width', Math.abs(patch.x - 0.2 * 1200) < 0.001, `x=${patch.x}`);
  check('y scales by height', Math.abs(patch.y - 0.1 * 1600) < 0.001, `y=${patch.y}`);
}
{
  // A box hugging the edge must not pad outside the image.
  const patch = regionToPixels([0, 0, 50, 50], 1000, 1000);
  equal('edge boxes clamp at zero', [0, 0], [patch.x, patch.y]);
  const corner = regionToPixels([960, 960, 1000, 1000], 1000, 1000);
  check('edge boxes clamp at the far side',
    corner.x + corner.w <= 1000 && corner.y + corner.h <= 1000,
    JSON.stringify(corner));
}

// ===================================================================
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(failures === 0
  ? `\nall ${results.length} pencil-mask checks passed`
  : `\n${failures} of ${results.length} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
