// Start the local blog (npm run dev), then: node scripts/check-mc-entity-models.mjs
// Optional: CHROME_PATH=/path/to/chrome MC_PREVIEW_URL=http://localhost:4173/.
// Uses Node 22's WebSocket and a temporary Chrome profile, with no browser test dependency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const definitions = JSON.parse(await readFile(new URL('./mc-special-models-1.21.10.json',import.meta.url)));
const origin = new URL(process.env.MC_PREVIEW_URL || 'http://127.0.0.1:4173/').origin;
const page = new URL('/robots.txt',origin).href;
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'
].find(existsSync);
assert(chrome,'Set CHROME_PATH to a Chromium-compatible browser executable.');
assert((await fetch(page)).ok,'Start the blog with npm run dev before running this check.');
const parent = resolve(tmpdir()), profile = await mkdtemp(join(parent,'mc-entity-registry-'));
const processHandle = spawn(chrome,['--headless=new','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader',
  '--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--disable-background-networking','--user-data-dir='+profile,'about:blank'],
  { windowsHide:true, stdio:['ignore','ignore','pipe'] });
const closed = once(processHandle,'close');
let ws;
try {
  let log = '';
  processHandle.stderr.on('data',chunk => { log = (log + chunk).slice(-12000); });
  let addr;
  for (let i=0; i<150 && !addr; i++) {
    addr = log.match(/DevTools listening on ws:\/\/([^/]+)/)?.[1];
    if (!addr) await sleep(100);
  }
  assert(addr,'Chrome did not open a DevTools port: ' + log);
  const tabs = await (await fetch('http://'+addr+'/json/list')).json();
  ws = new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await once(ws,'open');
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message',({data}) => {
    const msg = JSON.parse(data);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  });
  function call(method,params={}) {
    return new Promise(resolveResponse => {
      const id=++seq; pending.set(id,resolveResponse); ws.send(JSON.stringify({id,method,params}));
    });
  }
  await call('Page.navigate',{url:page});
  for (let i=0; i<100; i++) {
    if ((await call('Runtime.evaluate',{expression:'location.origin'})).result?.result?.value === origin) break;
    await sleep(50);
  }
  const expression = '('+audit.toString()+')('+JSON.stringify(definitions.entityIds)+','+JSON.stringify(definitions.paintings)+')';
  const reply = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:90000});
  assert.ifError(reply.error && Error(reply.error.message));
  assert.ifError(reply.result.exceptionDetails && Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text));
  const result = reply.result.result.value;
  assert.deepEqual(result.errors,[]);
  assert.equal(result.total,153);
  assert.equal(result.visible,151);
  assert.equal(result.textured,150);
  console.log('实体模型检查通过：官方 1.21.10 注册表 ' + result.total + ' 种，151 种可见，150 种带材质贴图，51 种画作已核对。');
} finally {
  ws?.close();
  processHandle.kill();
  await closed;
  if (dirname(resolve(profile)) === parent && basename(profile).startsWith('mc-entity-registry-')) {
    await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
}

async function audit(entityIds,paintings) {
  const {AssetProvider,buildEntityMesh,Renderer,Box3} = await import('/js/vendor/mc-engine.mjs');
  const assets = new AssetProvider();
  await assets.ready();
  const item = { id:'minecraft:diamond',count:1 };
  const fixtures = { item:{Item:item}, item_display:{item}, block_display:{block_state:{Name:'minecraft:stone'}},
    text_display:{text:'测试'}, ominous_item_spawner:{item}, painting:{variant:'minecraft:burning_skull'} };
  const host = document.createElement('div');
  host.style.cssText = 'width:240px;height:240px;position:fixed;inset:0';
  document.body.append(host);
  const world = new Renderer(host,{orbitOnly:true,alpha:true});
  world.setActive(false);
  let visible = 0, textured = 0;
  const errors = [];
  const build = (id,nbt) => buildEntityMesh({id:'minecraft:'+id,pos:[0,0,0],rotation:[0,0],nbt},assets);
  try {
    for (const id of entityIds) {
      try {
        const root = await build(id,fixtures[id] ?? {});
        let geometry = false, texture = false;
        root?.traverseVisible(node => {
          if (!(node.isMesh || node.isSprite) || !node.geometry?.attributes.position.count) return;
          geometry = true;
          texture ||= [node.material].flat().some(mat=>mat?.map?.image?.width > 0);
        });
        if (['interaction','marker'].includes(id)) {
          if (geometry) throw Error('expected a logical entity without a body');
          continue;
        }
        if (!geometry || (!texture && id !== 'lightning_bolt')) throw Error('missing textured geometry');
        visible++; if (texture) textured++;
        world.scene.add(root);
        world.camera.position.set(5,4,6); world.camera.lookAt(0,.6,0);
        world.renderer.render(world.scene,world.camera);
        root.removeFromParent();
      } catch (error) {errors.push([id,error.message]);}
    }
    for (const [name,[key,w,h]] of Object.entries(paintings)) {
      const texture = await assets.getTexture('painting/'+key.replace('minecraft:',''));
      const art = await build('painting',{variant:'minecraft:'+name});
      const bounds = new Box3().setFromObject(art);
      if (!texture || bounds.max.x-bounds.min.x !== w || bounds.max.y-bounds.min.y !== h) errors.push([name,'artwork or size missing']);
    }
    const display = await build('block_display',{ block_state:{Name:'minecraft:stone'},
      transformation:{translation:[2,3,-5],scale:[2,1,1],left_rotation:[0,0,0,1],right_rotation:[0,0,0,1]} });
    const box = new Box3().setFromObject(display);
    if (JSON.stringify([box.min.toArray(),box.max.toArray()]) !== '[[2,3,-5],[4,4,-4]]') errors.push(['block_display','incorrect transformed block']);
    const hash = 'a'.repeat(64);
    const payload = btoa(JSON.stringify({textures:{SKIN:{url:'https://textures.minecraft.net/texture/'+hash}}}));
    const profile = {properties:[{name:'textures',value:payload}]};
    const badSkin = await buildEntityMesh({id:'minecraft:mannequin',pos:[0,0,0],rotation:[0,0],nbt:{profile}},
      {getTexture:assets.getTexture.bind(assets),getRecordedSkin:async () => { throw Error('invalid PNG'); }}, {skins:{[hash]:'invalid'}});
    if (!badSkin.getObjectByName('head')?.children.some(mesh=>mesh.material?.map?.image)) errors.push(['mannequin','corrupt skin hid avatar']);
  } finally {world.dispose();assets.clearCaches();host.remove();}
  return {total:entityIds.length,visible,textured,errors};
}
