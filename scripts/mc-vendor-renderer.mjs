// Rebuild the checked-in browser assets with an installed LitematicWebViewer checkout.
//   node scripts/mc-vendor-renderer.mjs <viewer-checkout>
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.length !== 3) throw new Error('用法：node scripts/mc-vendor-renderer.mjs <已安装依赖和原版资源的查看器目录>');
const checkout = resolve(process.argv[2]);
const requireUpstream = createRequire(join(checkout, 'package.json'));
const { rolldown } = await import(pathToFileURL(requireUpstream.resolve('rolldown')));
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(checkout, 'src');
const vanilla = join(checkout, 'public', 'assets', 'minecraft');
const revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const entry = join(root, 'scripts', 'mc-renderer-entry.mjs');

const bundle = await rolldown({
  input: entry,
  cwd: checkout,
  platform: 'browser',
  plugins: [{
    name: 'minecraft-rendering-core',
    resolveId(specifier) {
      if (specifier === 'jszip') return requireUpstream.resolve('jszip/dist/jszip.min.js');
      if (specifier === 'three') return join(dirname(requireUpstream.resolve('three')), 'three.module.js');
      if (specifier.startsWith('@lwv/')) return join(source, specifier.slice(5));
    },
    transform(code, id) {
      if (resolve(id) === join(source, 'entities.js')) {
        // A dropped item or projectile can have a physics box without an implemented mesh.
        // Keep the upstream registration, vehicle transforms and passenger traversal.
        const buildBody = 'await buildSingleEntityMesh(entity, assets, data)';
        if (code.split(buildBody).length !== 2) throw new Error('请核对查看器的 buildEntityMesh 实体入口。');
        return "import { getEntityHitbox } from './entityHitboxes.js'\n" +
          code.replace(buildBody, buildBody + ' ?? hitboxAnchor(entity)') +
          `\nfunction hitboxAnchor(entity) {
  if (!getEntityHitbox(entity)) return null
  const anchor = new THREE.Group()
  anchor.position.fromArray(entity.pos)
  return anchor
}\n`;
      }
      // Reuse the same nearest-filtered PNG decoder and animation logic for our local archive.
      if (resolve(id) === join(source, 'entityHitboxes.js')) return code + '\nexport { makeOverlay };\n';
      if (resolve(id) === join(source, 'assets.js')) return code + '\nexport { parseResourceJSON, textureFromBlob };\n';
    },
  }],
  onwarn(warning, log) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
    log(warning);
  },
});

let result;
try {
  result = await bundle.generate({
    format: 'esm', entryFileNames: 'mc-engine.mjs', codeSplitting: false, minify: false,
    comments: true,
    banner: '/*! Blog Minecraft renderer, based on Gudu-Z/LitematicWebViewer ' + revision
      + '. Rebuild with scripts/mc-vendor-renderer.mjs. Notices: assets/mc-renderer/NOTICES.txt */',
  });
} finally {
  await bundle.close();
}
const [engine] = result.output;
if (result.output.length !== 1 || engine.type !== 'chunk' || engine.imports.length || engine.dynamicImports.some(name => name !== engine.fileName)) {
  throw new Error('渲染器未构建成独立浏览器模块：' + JSON.stringify(result.output.map(({fileName, type, imports, dynamicImports}) => ({fileName, type, imports, dynamicImports}))));
}

// Flatten thousands of tiny resources into a single same-origin static request.
// JSON stays readable and PNGs retain the exact bytes supplied by the upstream asset pack.
const catalog = { version: 1, json: Object.create(null), png: Object.create(null) };
const paths = readdirSync(vanilla, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => relative(vanilla, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();
for (const path of paths) {
  const bytes = readFileSync(join(vanilla, path));
  if (path.startsWith('textures/') && path.endsWith('.png')) catalog.png[path.slice(9, -4)] = bytes.toString('base64');
  else if (path.endsWith('.json') || path.endsWith('.mcmeta')) catalog.json[path] = JSON.parse(bytes.toString('utf8'));
  else throw new Error('未知资源类型：' + path);
}
if (!catalog.json['blockstates/stone.json'] || !catalog.json['models/block/stone.json'] || !catalog.png['block/stone']
    || !catalog.png['entity/player/wide/steve']) throw new Error('缺少原版资源，请先在查看器仓库运行 npm run setup。');

const notices = [
  'Minecraft article renderer',
  'Rendering core: Gudu-Z/LitematicWebViewer — https://github.com/Gudu-Z/LitematicWebViewer',
  'Upstream revision: ' + revision,
  'Blog adaptation: the renderer consumes local article data, models and textures.',
  'Vanilla Minecraft assets from the upstream public/assets/minecraft directory are by Mojang Studios / Microsoft.',
  'zlib portions of pako: https://zlib.net/zlib_license.html — Jean-loup Gailly and Mark Adler.',
];
notices.push('Default resource pack: XK Redstone Display 26.3.0, by Xe_Kr (XeKr). https://modrinth.com/resourcepack/xk-redstone-display — Original ZIP includes README.txt and licence terms (CC BY-NC-ND 4.0).');
for (const name of ['three', 'pako', 'jszip']) {
  const location = join(checkout, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
  notices.push('', pkg.name + ' ' + pkg.version + ' (' + pkg.license + ')', readFileSync(join(location, name === 'jszip' ? 'LICENSE.markdown' : 'LICENSE'), 'utf8').trim());
}

for (const [path, contents] of [
  ['js/vendor/mc-engine.mjs', engine.code.replace(/^[\t ]+$/gm, '')],
  ['assets/minecraft/vanilla-resources/vanilla.json', JSON.stringify(catalog, (_key, value) => Object.is(value, -0) ? JSON.rawJSON('-0') : value)],
  ['assets/mc-renderer/NOTICES.txt', notices.join('\n') + '\n'],
]) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  console.log(path, Buffer.byteLength(contents), 'bytes');
}

