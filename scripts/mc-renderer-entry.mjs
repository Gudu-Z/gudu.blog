// Browser entry for the blog's locally bundled Minecraft rendering core.
import { AssetProvider as ViewerAssets, textureFromBlob } from '@lwv/assets.js';

export { Renderer } from '@lwv/renderer.js';
export { BlockModelResolver } from '@lwv/blocks.js';
export { parseLitematica } from '@lwv/litematica.js';
export { extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from '@lwv/schematicDetails.js';

const archive = new URL('../../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url);
let catalogRequest;

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
  ready() {
    return loadCatalog();
  }

  async _getJSON(path) {
    const { json } = await loadCatalog();
    return Object.hasOwn(json, path) ? json[path] : null;
  }

  async _getTexture(key) {
    const { json, png } = await loadCatalog();
    if (!Object.hasOwn(png, key)) return null;
    const text = atob(png[key]);
    const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
    const metadata = json['textures/' + key + '.png.mcmeta'];
    const animation = metadata ? metadata.animation || false : null;
    return textureFromBlob(new Blob([bytes], { type: 'image/png' }), animation);
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
