import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildCompanionConfig } from '../integration/skin-extension.mjs';
const source = await readFile(new URL('../src/shelf.js', import.meta.url), 'utf8');

test('portable mount selects one character and follows a replaceable target without Dream Skin', async () => {
  const first = {}, second = {};
  let current = first, installed;
  const context = vm.createContext({ URL, structuredClone,
    document: { querySelector: () => current },
    CompanionShelfData: { characters: [{ id: 'grok' }, { id: 'kimi' }], images: {} },
    CodexCompanions: { install(config) { installed = config; return { destroy() {} }; } },
  });
  vm.runInContext(source, context);
  await context.CompanionShelf.mount({ target: '#anchor', characters: ['kimi'] });
  assert.deepEqual(Array.from(installed.characters, c => c.id), ['kimi']);
  assert.equal(installed.getComposer(), first);
  current = second;
  assert.equal(installed.getComposer(), second);
  assert.equal(installed.reserveComposerSpace, false);
  assert.throws(() => context.CompanionShelf.selectCharacters(context.CompanionShelfData, ['unknown']), /Unknown/);
  assert.throws(() => context.CompanionShelf.selectCharacters(context.CompanionShelfData, ['kimi', 'kimi']), /unique/);
});

test('single-character builds exclude unrelated sprites and preserve chosen order', async () => {
  const one = await buildCompanionConfig({ characterIds: ['kimi'] });
  assert.deepEqual(one.companions.characters.map(c => c.id), ['kimi']);
  assert.equal(Object.keys(one.companions.images).length, 1);
  const pair = await buildCompanionConfig({ characterIds: ['gpt', 'big-fish'] });
  assert.deepEqual(pair.companions.characters.map(c => c.id), ['gpt', 'big-fish']);
  await assert.rejects(buildCompanionConfig({ characterIds: [] }), /Select/);
});
