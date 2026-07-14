import test from 'node:test';
import assert from 'node:assert/strict';
import { createZipBuffer } from '../../src/report/zip.js';
import { readZipEntries } from '../helpers/zip-reader.js';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (c ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('createZipBuffer：写出的 zip 能被独立实现的读取器正确解析，内容（含中文/CRC）一字不差', () => {
  const entries = [
    { name: 'new-urls.csv', data: 'detected_at,url\r\n2026-07-15,https://poki.com/g/a\r\n' },
    { name: 'report.md', data: '# 报告\n\n本轮缺失：1，恢复：0，中文与 emoji 🎮 都要能正确往返。\n' },
    { name: 'changes.json', data: JSON.stringify({ missing: [], restored: [] }) },
  ];
  const buf = createZipBuffer(entries, { now: new Date('2026-07-15T09:00:00') });

  const read = readZipEntries(buf);
  assert.equal(read.length, entries.length);
  assert.deepEqual(read.map((r) => r.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) {
    const original = Buffer.from(entries[i].data, 'utf-8');
    assert.equal(read[i].data.toString('utf-8'), entries[i].data, `${entries[i].name} 内容必须一字不差`);
    assert.equal(read[i].crc, crc32(original), `${entries[i].name} 的 CRC-32 必须匹配`);
  }
});

test('createZipBuffer：空文件列表也能生成合法的空 zip', () => {
  const buf = createZipBuffer([]);
  const read = readZipEntries(buf);
  assert.equal(read.length, 0);
});
