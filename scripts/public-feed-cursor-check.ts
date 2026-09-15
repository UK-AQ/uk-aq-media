import assert from 'node:assert/strict';
import { decodeArticleCursor } from '../apps/media-public/src/index';

function encoded(sortAt: string, id: number): string {
  return btoa(JSON.stringify([sortAt, id]));
}

assert.deepEqual(decodeArticleCursor(encoded('2026-09-09', 41)), ['2026-09-09', 41]);
assert.deepEqual(decodeArticleCursor(encoded('2026-09-09T12:34:56.789Z', 42)),
  ['2026-09-09T12:34:56.789Z', 42]);
assert.equal(decodeArticleCursor(null), null);
for (const invalid of [
  encoded('2026-09-09T12:34:56Z', 42),
  encoded('not-a-date', 42),
  encoded('2026-09-09', 0),
]) assert.throws(() => decodeArticleCursor(invalid), /invalid_before_cursor/);

console.log('Public feed cursor checks passed');
