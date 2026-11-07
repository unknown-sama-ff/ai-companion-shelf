import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/companions.js';

function rectangle(left = 0, top = 0, width = 600, height = 100) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function stickyOuterRoot(contentTop, padding = '') {
  const root = new Element();
  if (padding) root.style.setProperty('padding-top', padding, 'important');
  root.getBoundingClientRect = () => rectangle(80, contentTop - (Number.parseFloat(root.style.getPropertyValue('padding-top')) || 0), 640, 130);
  return root;
}

class Element {
  constructor(rect = rectangle()) {
    this.rect = rect;
    const values = new Map();
    const priorities = new Map();
    this.style = {
      getPropertyValue: (name) => values.get(name) || '',
      getPropertyPriority: (name) => priorities.get(name) || '',
      setProperty: (name, value, priority = '') => { values.set(name, value); priorities.set(name, priority); },
      removeProperty: (name) => { values.delete(name); priorities.delete(name); },
    };
    this.dataset = {};
    this.children = [];
    this.isConnected = true;
  }
  getBoundingClientRect() { return this.rect; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  append(child) { this.children.push(child); }
  remove() { this.isConnected = false; }
  matches() { return false; }
  closest() { return this.outerRoot || null; }
  attachShadow() {
    this.shelf = new Element();
    return { querySelector: () => this.shelf };
  }
}

function browser(composers) {
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  let nextId = 0;
  const page = { composers, modals: [], popups: [] };
  const document = Object.assign(new Element(), {
    documentElement: new Element(),
    body: new Element(),
    hidden: false,
    createElement: () => new Element(),
    querySelectorAll(selector) {
      if (selector.includes('dialog[open]')) return page.modals;
      if (selector.includes('[role="menu"]')) return page.popups;
      return page.composers;
    },
  });
  const environment = Object.assign(new Element(), {
    document,
    innerHeight: 800,
    performance: { now: () => 0 },
    getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', paddingTop: element.style.getPropertyValue('padding-top') || '0px', ...element.computed }),
    matchMedia: () => Object.assign(new Element(), { matches: false }),
    Image: class {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  function flushFrames() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  }
  function mutate() {
    observers.forEach((callback) => callback([{ type: 'attributes', attributeName: 'style' }]));
  }
  function flushMutation() {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
    flushFrames();
  }
  return { page, environment, frames, timers, mutate, flushFrames, flushMutation };
}

function install(harness, options = {}) {
  const instance = globalThis.createCodexCompanionsRuntime(harness.environment).install({
    characters: [{ id: 'sample', name: 'Sample', src: 'sample.png', cellRatio: 1 }],
    composerSelector: '.composer',
    characterWidth: 100, gap: 0, rightInset: 0,
    ...options,
  });
  harness.flushFrames();
  return instance;
}

test('chooses the visible SPA composer and reselects when visibility changes', () => {
  const hidden = new Element(rectangle(10, 500, 0, 0));
  const visible = new Element(rectangle(200, 500));
  const harness = browser([hidden, visible]);
  const instance = install(harness);
  assert.equal(instance.host.shelf.style.left, '700px');
  hidden.rect = rectangle(30, 500);
  visible.computed = { visibility: 'hidden' };
  harness.mutate();
  harness.mutate();
  assert.equal(harness.timers.size, 1);
  harness.flushMutation();
  assert.equal(instance.host.shelf.style.left, '530px');
  assert.equal(harness.frames.size, 0);
  instance.destroy();
});

test('preserves the explicit getComposer override', () => {
  const first = new Element(rectangle(10, 500));
  const chosen = new Element(rectangle(250, 500));
  const harness = browser([first]);
  const instance = install(harness, { getComposer: () => chosen });
  assert.equal(instance.host.shelf.style.left, '750px');
  instance.destroy();
});

test('hides for modal dialogs and overlapping popup controls, then restores', () => {
  const harness = browser([new Element(rectangle(200, 500))]);
  const instance = install(harness);
  const shelf = instance.host.shelf;
  assert.equal(shelf.style.visibility, 'visible');
  harness.page.modals = [new Element(rectangle(0, 0, 100, 100))];
  harness.mutate(); harness.flushMutation();
  assert.equal(shelf.style.visibility, 'hidden');
  harness.page.modals = [];
  harness.page.popups = [new Element(rectangle(710, 410, 100, 100))];
  harness.mutate(); harness.flushMutation();
  assert.equal(shelf.style.visibility, 'hidden');
  harness.page.popups[0].rect = rectangle(0, 0, 100, 100);
  harness.mutate(); harness.flushMutation();
  assert.equal(shelf.style.visibility, 'visible');
  harness.page.modals = [new Element(rectangle(0, 0, 100, 100))];
  harness.page.modals[0].computed = { opacity: '0' };
  harness.mutate(); harness.flushMutation();
  assert.equal(shelf.style.visibility, 'visible');
  instance.destroy();
});

test('scales tall characters into the space above the composer without lowering the row', () => {
  const composer = new Element(rectangle(100, 50));
  const harness = browser([composer]);
  const instance = install(harness, {
    characters: [{ id: 'tall', src: 'tall.png', cellRatio: 2 }],
    characterWidth: 100,
    overlap: 3,
  });
  const shelf = instance.host.shelf;
  const top = Number.parseFloat(shelf.style.top);
  const height = Number.parseFloat(shelf.style.height);
  assert.ok(top >= 8);
  assert.equal(top + height, composer.rect.top + 3);
  assert.ok(height < 200);
  composer.rect = rectangle(100, 3);
  harness.mutate(); harness.flushMutation();
  assert.equal(shelf.style.visibility, 'hidden');
  instance.destroy();
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 0);
});

test('reserves outer-root space while anchoring to the inner composer and restores original padding', () => {
  const composer = new Element(rectangle(100, 500));
  const root = stickyOuterRoot(492, '12px');
  composer.outerRoot = root;
  const harness = browser([composer]);
  const instance = install(harness, { reserveComposerSpace: true });
  assert.equal(root.style.getPropertyValue('padding-top'), '118px');
  assert.equal(instance.host.shelf.style.top, '392px');
  harness.flushFrames();
  assert.equal(harness.frames.size, 0);
  harness.mutate(); harness.flushMutation();
  assert.equal(root.style.getPropertyValue('padding-top'), '118px');
  assert.equal(harness.frames.size, 0);
  instance.destroy();
  assert.equal(root.style.getPropertyValue('padding-top'), '12px');
  assert.equal(root.style.getPropertyPriority('padding-top'), 'important');
});

test('restores a replaced outer root and preserves padding changed by another owner at cleanup', () => {
  const first = new Element(rectangle(100, 500));
  const firstRoot = stickyOuterRoot(500);
  first.outerRoot = firstRoot;
  const harness = browser([first]);
  const instance = install(harness, { reserveComposerSpace: true });
  harness.flushFrames();
  const replacement = new Element(rectangle(200, 500));
  const nextRoot = stickyOuterRoot(500);
  replacement.outerRoot = nextRoot;
  first.isConnected = false;
  harness.page.composers = [replacement];
  harness.mutate(); harness.flushMutation();
  harness.flushFrames();
  assert.equal(firstRoot.style.getPropertyValue('padding-top'), '');
  assert.equal(nextRoot.style.getPropertyValue('padding-top'), '106px');
  nextRoot.style.setProperty('padding-top', '27px');
  instance.destroy();
  assert.equal(nextRoot.style.getPropertyValue('padding-top'), '27px');
  assert.equal(nextRoot.style.getPropertyPriority('padding-top'), '');
});

test('reserved row sits above the native toolbar at outer content top', () => {
  const composer = new Element(rectangle(100, 692.67));
  const root = stickyOuterRoot(660.67, '83px');
  composer.outerRoot = root;
  const harness = browser([composer]);
  const instance = install(harness, { reserveComposerSpace: true });
  harness.flushFrames();
  const shelf = instance.host.shelf;
  const bottom = Number.parseFloat(shelf.style.top) + Number.parseFloat(shelf.style.height);
  assert.equal(bottom, 660.67);
  assert.equal(shelf.style.left, '600px');
  assert.equal(shelf.style.width, '100px');
  assert.ok(bottom < composer.rect.top);
  instance.destroy();
});

test('eight compact sprites pack at top right inside nonoverlapping logical slots', () => {
  const harness = browser([new Element(rectangle(100, 500))]);
  const instance = install(harness, {
    characterWidth: 56, gap: -8, rightInset: 8,
    characters: Array.from({ length: 8 }, (_, index) => ({ id: `character-${index}`, src: 'sample.png' })),
  });
  const shelf = instance.host.shelf;
  assert.equal(shelf.style.left, '304px');
  assert.equal(shelf.style.width, '384px');
  for (const button of shelf.children) {
    assert.equal(button.style.width, '48px');
    assert.equal(button.children[0].style.width, '56px');
  }
  assert.equal(Number.parseFloat(shelf.style.left) + 384 + 4, 700 - 8);
  instance.destroy();
});

test('frame offsets align both blend layers and scale with sprite width', () => {
  const harness = browser([new Element(rectangle(100, 500))]);
  const stage = (frames, offsets) => ({ src: 'sample.png', columns: 2, rows: 1, frames, fps: 10, offsets });
  const instance = install(harness, {
    characterWidth: 50,
    characters: [{ id: 'aligned', animations: {
      idle: stage([0], { 0: [0, 0] }),
      enter: stage([1], { 1: [-0.04, 0.02] }),
      loop: stage([1], { 1: [-0.04, 0.02] }),
      exit: stage([0], { 0: [0, 0] }),
    } }],
  });
  const button = instance.host.shelf.children[0];
  instance.setActive('aligned', true);
  assert.equal(button.children[0].style.left, 'calc(50% + 0px)');
  assert.equal(button.children[0].style.bottom, '0px');
  assert.equal(button.children[1].style.left, 'calc(50% + -2px)');
  assert.equal(button.children[1].style.bottom, '1px');
  assert.equal(button.style.width, '50px');
  instance.destroy();
});

test('calibrated pose scales keep the seated anchor fixed', () => {
  const harness = browser([new Element(rectangle(100, 500))]);
  const stage = { src: 'sample.png', columns: 1, rows: 1, frames: [0], scale: .8, offsets: { 0: [-.04, .02] } };
  const instance = install(harness, {
    characterWidth: 50,
    characters: [{ id: 'calibrated', anchor: [.6, .1], animations: { idle: stage, enter: stage, loop: stage, exit: stage } }],
  });
  const sprite = instance.host.shelf.children[0].children[0];
  const left = Number(sprite.style.left.match(/calc\(50% \+ (.*)px\)/)[1]);
  const bottom = Number.parseFloat(sprite.style.bottom);
  assert.equal(sprite.style.width, '40px');
  assert.ok(Math.abs(left + (.64 - .5) * 40 - (.6 - .5) * 50) < 1e-8);
  assert.ok(Math.abs(bottom + .08 * 40 - .1 * 50) < 1e-8);
  instance.destroy();
});

test('calibrated border seating uses the composer edge without reserving a strip', () => {
  const composer = new Element(rectangle(100, 500));
  const root = stickyOuterRoot(492, '12px');
  composer.outerRoot = root;
  const harness = browser([composer]);
  const instance = install(harness, { reserveComposerSpace: false, overlap: 3 });
  const shelf = instance.host.shelf;
  assert.equal(Number.parseFloat(shelf.style.top) + Number.parseFloat(shelf.style.height), 503);
  assert.equal(root.style.getPropertyValue('padding-top'), '12px');
  instance.destroy();
});

test('frame height calibration preserves the same foot anchor independently of width', () => {
  const harness = browser([new Element(rectangle(100, 500))]);
  const stage = { src: 'sample.png', columns: 1, rows: 1, frames: [0], scale: .8,
    scalesY: { 0: 1.1 }, offsets: { 0: [-.04, .02] } };
  const instance = install(harness, {
    characterWidth: 50,
    characters: [{ id: 'height-calibrated', anchor: [.6, .1], animations: { idle: stage, enter: stage, loop: stage, exit: stage } }],
  });
  const sprite = instance.host.shelf.children[0].children[0];
  const bottom = Number.parseFloat(sprite.style.bottom);
  assert.equal(sprite.style.width, '40px');
  assert.ok(Math.abs(Number.parseFloat(sprite.style.height) - 55) < 1e-8);
  assert.ok(Math.abs(bottom + .08 * 55 - .1 * 50) < 1e-8);
  instance.destroy();
});
