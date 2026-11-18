import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

export function blockStateName(name, properties = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name)) {
    throw Error(`无效的方块名称 ${name}。`);
  }
  const pairs = Object.keys(properties).sort().map(key => {
    const value = properties[key];
    if (!/^[a-z0-9_-]+$/.test(key) || !/^[a-z0-9_.-]+$/.test(String(value))) {
      throw Error(`无效的方块属性 ${name}[${key}=${value}]。`);
    }
    return `${key}=${value}`;
  });
  return pairs.length ? `${name}[${pairs.join(',')}]` : name;
}

export function reportStates(report) {
  const states = [];
  for (const [name, block] of Object.entries(report)) {
    if (!Array.isArray(block?.states)) throw Error('需要官方 reports/blocks.json 中的 states 列表。');
    for (const state of block.states) {
      if (!Number.isSafeInteger(state.id) || state.id < 0 || state.id >= 0x7fffffff || states[state.id] !== undefined) {
        throw Error(`${name} 包含重复或无效的状态编号 ${state.id}。`);
      }
      states[state.id] = blockStateName(name, state.properties);
    }
  }
  if (!states.includes('minecraft:air')) throw Error('方块状态表缺少 minecraft:air。');
  return states;
}

export async function readStateRegistry(minecraftVersion, file) {
  if (!file && minecraftVersion !== '1.21.10') throw Error('该游戏版本需要通过 --registry 提供录制环境对应的方块状态表。');
  const bytes = await readFile(file ?? new URL('./mc-export-1.21.10.json.gz', import.meta.url));
  const json = JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8'));
  // A registry captured from a modded server can supply this same ID-indexed
  // array. Its raw IDs must be from the exact mod set used to record the scene.
  if (Array.isArray(json.states)) {
    if (json.minecraftVersion !== minecraftVersion) throw Error('方块状态表的 Minecraft 版本与 --minecraft 不一致。');
    if (!json.states.includes('minecraft:air')) throw Error('状态表缺少 minecraft:air。');
    return json.states;
  }
  return reportStates(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, minecraftVersion, output] = process.argv.slice(2);
  if (!source || !minecraftVersion || !output) {
    console.error('用法：node scripts/mc-export-registry.mjs <reports/blocks.json> <游戏版本> <输出.json.gz>');
    process.exitCode = 1;
  } else {
    const states = reportStates(JSON.parse(await readFile(source, 'utf8')));
    const bytes = gzipSync(JSON.stringify({ minecraftVersion, states }), { level: 9 });
    await writeFile(output, bytes, { flag: 'wx' });
    console.log(`已保存 ${states.filter(Boolean).length} 个方块状态。`);
  }
}
