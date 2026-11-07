import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCompanionConfig } from '../integration/skin-extension.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(root, 'assets/companions.json'), 'utf8'));
const runtime = await readFile(path.join(root, 'src/companions.js'), 'utf8');
const api = await readFile(path.join(root, 'src/shelf.js'), 'utf8');
const template = await readFile(path.join(root, 'standalone.html'), 'utf8');
const wallpaper = await readFile(path.join(root, 'themes/white-dragon-lavender/wallpaper.png'));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const ids = manifest.characters.map(c => c.id);
const previewOnly = process.argv.includes('--preview-only');
const common = ['README.md', 'LICENSE-CODE', 'ASSETS.md', 'docs/EMBEDDING.md', 'docs/DREAM-SKIN.md', 'docs/default-preview.png'];
const sourceFiles = ['src/companions.js', 'src/shelf.js', 'integration/skin-extension.mjs', 'integration/cdp-client.mjs',
  'scripts/install-dream-skin-extension.ps1', 'scripts/apply-companions.mjs', 'scripts/resolve-dream-skin-session.ps1',
  'companion-settings.json', 'assets/companions.json', 'themes/white-dragon-lavender/theme.json',
  'themes/white-dragon-lavender/theme.css', 'themes/white-dragon-lavender/wallpaper.png'];

async function copy(relative, directory) {
  const target = path.join(directory, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, relative), target);
}

async function build(directory, characterIds, full) {
  await mkdir(directory, { recursive: true });
  const { companions } = await buildCompanionConfig({ characterIds });
  const data = { ...companions, version,
    theme: { name: '白龙娘 · 浅紫', image: `data:image/png;base64,${wallpaper.toString('base64')}` } };
  const bundle = `${runtime}\n;globalThis.CompanionShelfData=${JSON.stringify(data)};\n${api}\n`;
  new Function(bundle);
  await writeFile(path.join(directory, 'companion-shelf.js'), bundle);
  await writeFile(path.join(directory, 'index.html'), template.replace('<!-- COMPANION_SCRIPTS -->', '<script src="companion-shelf.js"></script>'));
  if (previewOnly) return;
  for (const file of common) await copy(file, directory);
  if (full) {
    const sprites = [...new Set(manifest.characters.flatMap(c => Object.values(c.animations).map(s => s.src)))];
    for (const file of [...sourceFiles, ...sprites]) await copy(file, directory);
  } else {
    const character = manifest.characters.find(c => c.id === characterIds[0]);
    const sprites = [...new Set(Object.values(character.animations).map(s => s.src))];
    await mkdir(path.join(directory, 'assets'), { recursive: true });
    await writeFile(path.join(directory, 'assets/companions.json'), JSON.stringify({ characters: [character] }, null, 2) + '\n');
    for (const file of ['src/companions.js', 'src/shelf.js', ...sprites]) await copy(file, directory);
  }
}

await build(path.join(out, 'full'), ids, true);
if (!previewOnly) {
  for (const id of ids) await build(path.join(out, 'characters', id), [id], false);
  await writeFile(path.join(out, 'release-manifest.json'), JSON.stringify({ version, characters: ids }, null, 2) + '\n');
}
console.log(`Built default wallpaper + ${ids.length} companions${previewOnly ? '' : ' and eight individual packages'}.`);
