import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIco, DEFAULT_VARIANT, ICON_SIZES, VARIANTS } from '../scripts/make-icon.js';

const icoPath = fileURLToPath(new URL('../assets/teamclaude.ico', import.meta.url));
const dashboardSource = readFileSync(fileURLToPath(new URL('../src/dashboard.js', import.meta.url)), 'utf8');

function readIcoDirectory(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'reserved');
  assert.equal(buf.readUInt16LE(2), 1, 'type must be icon');
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16;
    const size = buf[e] || 256;
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    return { size, bits: buf.readUInt16LE(e + 6), data: buf.subarray(offset, offset + length) };
  });
}

test('committed .ico holds every size: DIBs below 256, PNG at 256', () => {
  const entries = readIcoDirectory(readFileSync(icoPath));
  assert.deepEqual(entries.map(e => e.size), ICON_SIZES);
  for (const { size, bits, data } of entries) {
    assert.equal(bits, 32, `${size}px bit depth`);
    if (size === 256) {
      assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } else {
      assert.equal(data.readUInt32LE(0), 40, `${size}px BITMAPINFOHEADER`);
      assert.equal(data.readInt32LE(4), size);
      assert.equal(data.readInt32LE(8), size * 2);
    }
  }
});

test('committed .ico matches what scripts/make-icon.js generates', () => {
  assert.ok(readFileSync(icoPath).equals(buildIco()),
    'assets/teamclaude.ico is stale: run node scripts/make-icon.js');
});

test('dashboard favicon uses the icon colour and stroke', () => {
  const spec = VARIANTS[DEFAULT_VARIANT];
  const hex = '#' + spec.bg.map(c => c.toString(16).padStart(2, '0')).join('');
  assert.ok(dashboardSource.includes(`fill="${hex}"`), `favicon fill ${hex}`);
  assert.ok(dashboardSource.includes(`stroke-width="${spec.stroke}"`), `favicon stroke ${spec.stroke}`);
  for (const l of spec.lines) {
    assert.ok(dashboardSource.includes(`M${l.x1} ${l.y1}`), `favicon arm from ${l.x1},${l.y1}`);
  }
});
