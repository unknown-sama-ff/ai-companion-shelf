import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildPayload } from '../integration/skin-extension.mjs';

const ids = ['big-fish', 'grok', 'claude', 'gemini', 'qwen', 'zai', 'kimi', 'gpt'];
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWhoAAAAASUVORK5CYII=', 'base64');

async function fixture(t, runtime) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'companion-payload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'src'));
  await mkdir(path.join(directory, 'assets', 'sprites'), { recursive: true });
  const source = runtime || await readFile(new URL('../src/companions.js', import.meta.url), 'utf8');
  await writeFile(path.join(directory, 'src', 'companions.js'), source);
  const sequence = (start, count) => Array.from({ length: count }, (_, index) => start + index);
  const characters = ids.map((id) => {
    const src = `assets/sprites/${id}.png`;
    const cycle = `assets/sprites/${id}-cycle.png`;
    const stage = (source, columns, rows, frames) => ({ src: source, columns, rows, frames, fps: 18 });
    return { id, animations: id === 'gpt' ? {
      idle: stage(src, 6, 4, [0]), enter: stage(src, 6, 4, sequence(0, 6)),
      loop: stage(src, 6, 4, sequence(6, 12)), exit: stage(src, 6, 4, sequence(18, 6)),
    } : {
      idle: stage(src, 4, 2, [0]), enter: stage(src, 4, 2, sequence(0, 8)),
      loop: stage(cycle, 6, 3, sequence(0, 12)), exit: stage(cycle, 6, 3, sequence(12, 6)),
    } };
  });
  await writeFile(path.join(directory, 'assets', 'companions.json'), JSON.stringify({ characters }));
  const files = ids.flatMap((id) => id === 'gpt' ? [`${id}.png`] : [`${id}.png`, `${id}-cycle.png`]);
  await Promise.all(files.map((file) => writeFile(path.join(directory, 'assets', 'sprites', file), pixel)));
  return directory;
}

test('payload deduplicates repeated stage sources into fifteen unique sheets for eight companions', async (t) => {
  const projectRoot = await fixture(t);
  const payload = await buildPayload({ projectRoot });
  assert.equal((payload.match(/data:image\/png;base64,/g) || []).length, 15);
  assert.ok(payload.includes('html[data-dream-skin=\\"active\\"]'));
  assert.ok(!payload.includes('"src":"assets/sprites/'));
  assert.ok(payload.includes('"composerSelector":"[data-ds-part=\\"composer\\"]"'));
  assert.ok(payload.includes('"reserveComposerSpace":true'));
  assert.ok(payload.includes('"characterWidth":56,"gap":-8,"rightInset":8'));
  assert.doesNotThrow(() => new Function(payload));
});

test('each build reads changed project assets and rejects missing companions', async (t) => {
  const projectRoot = await fixture(t);
  const first = await buildPayload({ projectRoot });
  await writeFile(path.join(projectRoot, 'assets', 'sprites', 'kimi.png'), Buffer.concat([pixel, Buffer.from('updated')]));
  assert.notEqual(await buildPayload({ projectRoot }), first);
  const legacy = ids.slice(0, 7).map((id) => ({ id, src: `assets/sprites/${id}.png`, columns: 4, rows: 2, frames: 8 }));
  await writeFile(path.join(projectRoot, 'assets', 'companions.json'), JSON.stringify({ characters: legacy }));
  assert.equal(((await buildPayload({ projectRoot })).match(/data:image\/png;base64,/g) || []).length, 7);
  await writeFile(path.join(projectRoot, 'assets', 'companions.json'), JSON.stringify({ characters: [...legacy, { ...legacy[0], id: 'unknown' }] }));
  await assert.rejects(buildPayload({ projectRoot }), /unique known IDs/);
  await writeFile(path.join(projectRoot, 'assets', 'companions.json'), JSON.stringify({ characters: [] }));
  await assert.rejects(buildPayload({ projectRoot }), /unique known IDs/);
});

test('an optional settling image is included in the native payload', async (t) => {
  const projectRoot = await fixture(t);
  const manifestPath = path.join(projectRoot, 'assets', 'companions.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.characters.find((character) => character.id === 'zai').animations.settle = {
    src: 'assets/sprites/zai-settle.png', columns: 1, rows: 1, frames: [0], fps: 5,
  };
  await writeFile(path.join(projectRoot, 'assets', 'sprites', 'zai-settle.png'), pixel);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const payload = await buildPayload({ projectRoot });
  assert.equal((payload.match(/data:image\/png;base64,/g) || []).length, 16);
  assert.ok(payload.includes('"settle":'));
});

test('native active marker mounts, pause destroys, reapply remounts, and reinjection cleans up', async (t) => {
  const runtime = `globalThis.CodexCompanions = {install(config) { calls.push(['install', config.characters.length]); return {destroy() {calls.push(['destroy']);}, inspect() {return {connected:true};}}; }};`;
  const projectRoot = await fixture(t, runtime);
  const payload = await buildPayload({ projectRoot });
  let active = false;
  const callbacks = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    calls: [],
    document: { querySelector: () => active ? {} : null },
    MutationObserver: class {
      constructor(callback) { callbacks.push(callback); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(payload, context);
  assert.equal(context.calls.length, 0);
  active = true;
  callbacks.at(-1)([{ type: 'attributes', attributeName: 'data-dream-skin' }]);
  assert.equal(context.__codexDreamSkinCompanions.inspect().active, true);
  active = false;
  callbacks.at(-1)([{ type: 'attributes', attributeName: 'data-dream-skin' }]);
  assert.equal(context.calls.at(-1)[0], 'destroy');
  assert.equal(context.__codexDreamSkinCompanions.inspect().active, false);
  active = true;
  callbacks.at(-1)([{ type: 'attributes', attributeName: 'data-dream-skin' }]);
  assert.equal(context.calls.filter((call) => call[0] === 'install').length, 2);
  vm.runInContext(payload, context);
  assert.equal(context.calls.filter((call) => call[0] === 'destroy').length, 2);
  assert.equal(context.calls.filter((call) => call[0] === 'install').length, 3);
  callbacks.at(-1)([{ type: 'childList' }]);
  callbacks.at(-1)([{ type: 'childList' }]);
  assert.equal(timers.size, 1);
  context.__codexDreamSkinCompanions.destroy();
  assert.equal(timers.size, 0);
});
