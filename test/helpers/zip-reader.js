import assert from 'node:assert/strict';

/**
 * 纯 JS、不依赖任何外部命令（unzip/python3 等）的最小 ZIP 读取器，只用于
 * 测试断言 src/report/zip.js 写出来的 zip 内容正确——不能依赖 unzip/
 * python3，因为这个项目最终要在用户的 Windows 机器上跑 npm test，不能
 * 假设那台机器装了这些工具。只支持 STORE（不压缩），和 zip.js 的写法配套。
 */
export function readZipEntries(buf) {
  const eocdSig = buf.readUInt32LE(buf.length - 22);
  assert.equal(eocdSig, 0x06054b50, 'EOCD 签名不匹配（本读取器假设没有 zip comment）');
  const entryCount = buf.readUInt16LE(buf.length - 22 + 10);
  const centralDirOffset = buf.readUInt32LE(buf.length - 22 + 16);

  const entries = [];
  let ptr = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, `第 ${i} 条中央目录记录签名不匹配`);
    const crc = buf.readUInt32LE(ptr + 16);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localHeaderOffset), 0x04034b50, `${name} 的本地文件头签名不匹配`);
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize); // STORE：compressed == uncompressed

    assert.equal(data.length, uncompressedSize, `${name} 数据长度和头部记录的大小不一致`);
    entries.push({ name, data, crc });

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
