import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredIds = ['big-fish', 'grok', 'claude', 'gemini', 'qwen', 'zai', 'kimi'];
const allowedIds = new Set([...requiredIds, 'gpt']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function startDreamSkinCompanions(config) {
  const win = globalThis;
  const doc = win.document;
  let instance = null;
  let timer = null;
  let destroyed = false;

  function isSkinActive() {
    return Boolean(doc.querySelector(config.skinRootSelector));
  }

  function sync() {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    if (destroyed) return;
    if (!isSkinActive()) {
      instance?.destroy();
      instance = null;
      return;
    }
    if (!instance) instance = win.CodexCompanions.install(config.companions);
  }

  const observer = new win.MutationObserver((records) => {
    if (records.some((record) => record.type === 'attributes' && record.attributeName === 'data-dream-skin')) {
      sync();
      return;
    }
    if (destroyed || timer !== null) return;
    timer = win.setTimeout(sync, 100);
  });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-dream-skin'] });
  const controller = {
    inspect: () => ({ destroyed, skinActive: isSkinActive(), active: Boolean(instance), companions: instance?.inspect() || null }),
    refresh: sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      if (timer !== null) win.clearTimeout(timer);
      instance?.destroy();
      instance = null;
      if (win.__codexDreamSkinCompanions === controller) delete win.__codexDreamSkinCompanions;
    },
  };
  win.__codexDreamSkinCompanions = controller;
  sync();
  return controller;
}

export async function buildCompanionConfig({ projectRoot = projectDirectory, characterIds, layout = {} } = {}) {
  const manifestText = await readFile(path.join(projectRoot, 'assets', 'companions.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const sourceCharacters = Array.isArray(manifest) ? manifest : manifest.characters;
  if (!Array.isArray(sourceCharacters) || sourceCharacters.length < 1 || sourceCharacters.length > allowedIds.size ||
      new Set(sourceCharacters.map((character) => character.id)).size !== sourceCharacters.length ||
      sourceCharacters.some((character) => !allowedIds.has(character.id))) {
    throw new Error('Companion manifest must contain one to eight companions with unique known IDs.');
  }
  if (characterIds !== undefined && (!Array.isArray(characterIds) || !characterIds.length ||
      new Set(characterIds).size !== characterIds.length ||
      characterIds.some((id) => !sourceCharacters.some((character) => character.id === id)))) {
    throw new Error('Select one or more unique character IDs present in the manifest.');
  }
  const selectedCharacters = characterIds ? characterIds.map((id) => sourceCharacters.find((character) => character.id === id)) : sourceCharacters;
  const spritesDirectory = path.resolve(projectRoot, 'assets', 'sprites');
  const imagePaths = new Map();
  function registerImage(source, id) {
    const imagePath = path.resolve(projectRoot, source);
    if (path.dirname(imagePath) !== spritesDirectory || path.extname(imagePath).toLowerCase() !== '.png') {
      throw new Error(`Companion image must be a local PNG in assets/sprites: ${id}`);
    }
    if (!imagePaths.has(imagePath)) imagePaths.set(imagePath, `sprite${imagePaths.size}`);
    return imagePaths.get(imagePath);
  }
  const characters = selectedCharacters.map((character) => {
    const { src, animations, ...details } = character;
    if (!animations) return { ...details, src: registerImage(src || `assets/sprites/${character.id}.png`, character.id) };
    const stages = {};
    for (const phase of ['idle', 'enter', 'settle', 'loop', 'exit']) {
      if (phase === 'settle' && !animations.settle) continue;
      const stage = animations[phase];
      if (!stage?.src) throw new Error(`Missing ${phase} sprite for ${character.id}`);
      if (!Number.isInteger(stage.columns) || stage.columns < 1 || !Number.isInteger(stage.rows) || stage.rows < 1 ||
          !Array.isArray(stage.frames) || !stage.frames.length ||
          stage.frames.some((index) => !Number.isInteger(index) || index < 0 || index >= stage.columns * stage.rows) ||
          (stage.fps !== undefined && (!Number.isFinite(stage.fps) || stage.fps <= 0)) ||
          (stage.scale !== undefined && (!Number.isFinite(stage.scale) || stage.scale <= 0)) ||
          (stage.completeOnLeave !== undefined && typeof stage.completeOnLeave !== 'boolean') ||
          (stage.exitFrame !== undefined && (phase !== 'loop' || stage.completeOnLeave !== true ||
            !Number.isInteger(stage.exitFrame) || !stage.frames.includes(stage.exitFrame))) ||
          (stage.scalesY !== undefined && stage.frames.some((index) => !Number.isFinite(stage.scalesY?.[index]) || stage.scalesY[index] <= 0)) ||
          (stage.faceOffset !== undefined && (!Array.isArray(stage.faceOffset) || stage.faceOffset.length !== 2 ||
            stage.faceOffset.some((value) => !Number.isFinite(value)))) ||
          (stage.offsets !== undefined && stage.frames.some((index) => !Array.isArray(stage.offsets?.[index]) ||
            stage.offsets[index].length !== 2 || stage.offsets[index].some((value) => !Number.isFinite(value))))) {
        throw new Error(`Invalid ${phase} animation for ${character.id}`);
      }
      stages[phase] = { ...stage, src: registerImage(stage.src, character.id) };
    }
    return { ...details, animations: stages };
  });
  const images = Object.fromEntries(await Promise.all([...imagePaths].map(async ([imagePath, key]) => {
    const bytes = await readFile(imagePath);
    if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`Invalid PNG signature: ${path.basename(imagePath)}`);
    return [key, `data:image/png;base64,${bytes.toString('base64')}`];
  })));
  const integration = manifest.integration || {};
  const config = {
    skinRootSelector: integration.skinRootSelector || 'html[data-dream-skin="active"]',
    companions: {
      characters,
      images,
      composerSelector: '[data-ds-part="composer"]',
      reserveComposerSpace: integration.reserveComposerSpace !== false,
      characterWidth: layout.characterWidth ?? integration.characterWidth ?? 56,
      gap: layout.gap ?? integration.gap ?? -8,
      rightInset: layout.rightInset ?? integration.rightInset ?? 8,
      overlap: layout.overlap ?? integration.overlap ?? 3,
    },
  };
  return config;
}

export async function buildPayload({ projectRoot = projectDirectory, characterIds } = {}) {
  let settings = {};
  try { settings = JSON.parse(await readFile(path.join(projectRoot, 'companion-settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const [runtime, config] = await Promise.all([
    readFile(path.join(projectRoot, 'src', 'companions.js'), 'utf8'),
    buildCompanionConfig({ projectRoot, characterIds: characterIds ?? settings.characters, layout: settings.layout }),
  ]);
  const payload = `;(() => {\n` +
    `globalThis.__codexDreamSkinCompanions?.destroy();\n` + runtime + '\n' +
    `return (${startDreamSkinCompanions.toString()})(${JSON.stringify(config)});\n})();`;
  new Function(payload);
  return payload;
}
