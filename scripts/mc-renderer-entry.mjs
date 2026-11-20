// Browser entry for the blog's locally bundled Minecraft rendering core.
import { AssetProvider as ViewerAssets, parseResourceJSON, textureFromBlob } from '@lwv/assets.js';

import { readResourcePack } from '@lwv/resourcePacks.js';

export { Group, MeshLambertMaterial, DoubleSide } from 'three';
export { getEntityHitbox, makeOverlay as createEntityHitboxLines } from '@lwv/entityHitboxes.js';
export { createEntityRig } from '@lwv/entityModel.js';
export { Renderer } from '@lwv/renderer.js';
export { BlockModelResolver } from '@lwv/blocks.js';
export { parseLitematica } from '@lwv/litematica.js';
export { extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from '@lwv/schematicDetails.js';

const archive = new URL('../../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url);
const packURL = new URL('../../assets/minecraft/resource-packs/xk-redstone-display-26.3.0.zip', import.meta.url);
let catalogRequest, packRequest;

function loadDefaultPack() {
  if (!packRequest) {
    packRequest = fetch(packURL).then(async response => {
      if (!response.ok) throw new Error('无法读取 XK 红石材质包（HTTP ' + response.status + '）。');
      return readResourcePack(await response.arrayBuffer());
    }).catch(error => {
      packRequest = undefined;
      console.warn('XK 红石材质包加载失败，本次预览使用原版材质。', error);
      return null;
    });
  }
  return packRequest;
}

function loadCatalog() {
  if (!catalogRequest) {
    catalogRequest = fetch(archive).then(async response => {
      if (!response.ok) throw new Error('无法读取原版模型和贴图（HTTP ' + response.status + '）。');
      const catalog = await response.json();
      if (catalog.version !== 1 || !catalog.json?.['blockstates/stone.json'] || !catalog.png?.['block/stone']) {
        throw new Error('原版模型和贴图文件格式无效。');
      }
      return catalog;
    }).catch(error => {
      catalogRequest = undefined;
      throw error;
    });
  }
  return catalogRequest;
}

// Share immutable source assets between figures. Each viewer owns its decoded GPU textures.
export class AssetProvider extends ViewerAssets {
  // Keep one resource stack per open figure, including a fallback after a failed request.
  // A later figure can retry without changing a model that is already using vanilla textures.
  #pack = loadDefaultPack();

  async ready() {
    const [catalog] = await Promise.all([loadCatalog(), this.#pack]);
    return catalog;
  }

  async _getJSON(path) {
    const pack = await this.#pack;
    const entry = pack?.file('assets/minecraft/' + path);
    if (entry) return parseResourceJSON(await entry.async('string'), path);
    const { json } = await loadCatalog();
    return Object.hasOwn(json, path) ? json[path] : null;
  }

  async _getTexture(key) {
    const pack = await this.#pack;
    const path = 'assets/minecraft/textures/' + key + '.png';
    const entry = pack?.file(path);
    if (entry) {
      const metadata = pack.file(path + '.mcmeta');
      const animation = metadata ? (JSON.parse((await metadata.async('string')).trimStart()).animation || false) : null;
      const bytes = await entry.async('uint8array');
      return textureFromBlob(new Blob([bytes], { type: 'image/png' }), animation);
    }
    const { json, png } = await loadCatalog();
    if (!Object.hasOwn(png, key)) return null;
    const text = atob(png[key]);
    const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
    const metadata = json['textures/' + key + '.png.mcmeta'];
    const animation = metadata ? metadata.animation || false : null;
    return textureFromBlob(new Blob([bytes], { type: 'image/png' }), animation);
  }


  // Recorded player textures are embedded by the exporter. Decode each skin once,
  // normalize the old 64×32 format and apply vanilla's opaque base-layer rules.
  async getRecordedSkin(hash, png) {
    return this._cachedTexture('recorded-player/' + hash, async () => {
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      const texture = await textureFromBlob(new Blob([bytes], { type: 'image/png' }), false);
      try {
        const source = texture.image;
        if (source.width !== 64 || (source.height !== 64 && source.height !== 32)) {
          texture.dispose();
          return null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const image = ctx.getImageData(0, 0, 64, 64);
        const rgba = image.data, legacy = source.height === 32;
        if (legacy) {
          // The old atlas stores one arm and leg. Reflect their six faces into
          // the independent left-arm/leg regions of the modern atlas.
          const faces = [
            [4,16,20,48,4], [8,16,24,48,4], [0,20,24,52,12], [4,20,20,52,12], [8,20,16,52,12], [12,20,28,52,12],
            [44,16,36,48,4], [48,16,40,48,4], [40,20,40,52,12], [44,20,36,52,12], [48,20,32,52,12], [52,20,44,52,12],
          ];
          for (const [sx, sy, dx, dy, height] of faces) {
            for (let y = 0; y < height; y++) for (let x = 0; x < 4; x++) {
              const from = ((sy + y) * 64 + sx + 3 - x) * 4;
              rgba.set(rgba.subarray(from, from + 4), ((dy + y) * 64 + dx + x) * 4);
            }
          }
        }
        function alpha(x0, y0, x1, y1, value, onlyWhenOpaque = false) {
          if (onlyWhenOpaque) {
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
              if (rgba[(y * 64 + x) * 4 + 3] < 128) return;
            }
          }
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba[(y * 64 + x) * 4 + 3] = value;
        }
        alpha(0, 0, 32, 16, 255);
        if (legacy) alpha(32, 0, 64, 32, 0, true);
        alpha(0, 16, 64, 32, 255);
        alpha(16, 48, 48, 64, 255);
        ctx.putImageData(image, 0, 0);
        texture.image = canvas;
        texture.needsUpdate = true;
        return texture;
      } catch (error) {
        texture.dispose();
        throw error;
      }
    });
  }

  async getExternalTexture(source) {
    if (typeof source === 'string' && source.trim() && URL.canParse(source, document.baseURI)) {
      const url = new URL(source, document.baseURI);
      if (url.origin === location.origin && (url.protocol === 'https:' || url.protocol === 'http:')) {
        const texture = await this._cachedTexture(url.href, async () => {
          const response = await fetch(url, { mode: 'same-origin' });
          if (!response.ok) return null;
          return textureFromBlob(await response.blob(), false);
        });
        if (texture) return texture;
      }
    }
    return this.getTexture('entity/player/wide/steve');
  }
}
