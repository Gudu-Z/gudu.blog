import { gunzipSync } from 'node:zlib';

// Java edition NBT has a named root tag and big-endian numbers. Only four-int
// entity and game-profile UUID arrays are needed to associate recorded players.
export function readRecordingNbt(bytes) {
  const limit = 256 * 1024 * 1024;
  const buffer = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: limit }) : bytes;
  if (buffer.length > limit) throw Error('单个 NBT 文件解压后超过 256 MiB。');
  let offset = 0;
  function take(length) {
    const start = offset;
    if (length < 0 || length > buffer.length - start) throw Error('NBT 文件不完整或长度无效。');
    offset += length;
    return start;
  }
  function string() {
    const size = buffer.readUInt16BE(take(2));
    const start = take(size);
    // Most keys are ASCII. Java modified UTF-8 encodes NUL and surrogate
    // halves differently from UTF-8, notably in user-defined area names.
    const slice = buffer.subarray(start, start + size);
    if (!slice.includes(0xc0) && !slice.includes(0xed)) return slice.toString('utf8');
    let value = '';
    for (let i = 0; i < slice.length;) {
      const c = slice[i++];
      if (c < 128) value += String.fromCharCode(c);
      else if ((c & 0xe0) === 0xc0 && i < slice.length) value += String.fromCharCode((c & 31) << 6 | slice[i++] & 63);
      else if ((c & 0xf0) === 0xe0 && i + 1 < slice.length) value += String.fromCharCode((c & 15) << 12 | (slice[i++] & 63) << 6 | slice[i++] & 63);
      else throw Error('NBT 文件包含无效的 Java UTF 字符串。');
    }
    return value;
  }
  function value(type, depth, key) {
    if (depth > 512) throw Error('NBT 嵌套深度超过限制。');
    switch (type) {
      case 1: return buffer.readInt8(take(1));
      case 2: return buffer.readInt16BE(take(2));
      case 3: return buffer.readInt32BE(take(4));
      case 4: {
        const long = buffer.readBigInt64BE(take(8));
        return Number.isSafeInteger(Number(long)) ? Number(long) : long;
      }
      case 5: return buffer.readFloatBE(take(4));
      case 6: return buffer.readDoubleBE(take(8));
      case 7: case 11: case 12: {
        const count = buffer.readInt32BE(take(4));
        const width = type === 7 ? 1 : type === 11 ? 4 : 8;
        if (type === 11 && count === 4 && (key === 'UUID' || key === 'id')) {
          return Array.from({ length: 4 }, () => buffer.readInt32BE(take(4)));
        }
        take(count * width);
        return undefined;
      }
      case 8: return string();
      case 9: {
        const element = buffer[take(1)];
        const length = buffer.readInt32BE(take(4));
        if (length < 0 || length > buffer.length - offset) throw Error('NBT 列表长度无效。');
        const result = [];
        for (let i = 0; i < length; i++) result.push(value(element, depth + 1));
        return result;
      }
      case 10: {
        const object = Object.create(null);
        for (let tag = buffer[take(1)]; tag !== 0; tag = buffer[take(1)]) {
          const key = string();
          object[key] = value(tag, depth + 1, key);
        }
        return object;
      }
      default: throw Error(`不支持的 NBT 标签 ${type}。`);
    }
  }
  if (buffer[take(1)] !== 10) throw Error('需要 Java 版 NBT 根复合标签。');
  string();
  const root = value(10, 0);
  if (offset !== buffer.length) throw Error('NBT 根标签之后存在额外数据。');
  return root;
}
