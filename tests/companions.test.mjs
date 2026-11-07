import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/companions.js';

function harness(options = {}) {
  let time = 0;
  let nextId = 0;
  const frames = new Map();
  const updates = [];
  const stages = {
    idle: { src: 'a', frames: [0], fps: 10 },
    enter: { src: 'a', frames: [0, 1, 2], fps: 10 },
    loop: { src: 'b', frames: [3, 4, 5], fps: 10 },
    exit: { src: 'b', frames: [6, 7, 8], fps: 10 },
  };
  const timeline = globalThis.CodexCompanions.createTimeline({
    stages, transitionDuration: 0, now: () => time,
    requestFrame: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: (id) => frames.delete(id),
    onUpdate: (sample) => updates.push(sample),
    ...options,
  });
  function advance(milliseconds) {
    time += milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  }
  return { timeline, advance, updates, frames };
}

test('enter leads to a continuous adjacent-frame blended loop and forward exit', () => {
  const { timeline, advance, frames } = harness();
  timeline.setIntent(true);
  advance(200);
  assert.equal(timeline.inspect().phase, 'loop');
  advance(50);
  assert.equal(timeline.inspect().from.frame, 3);
  assert.equal(timeline.inspect().to.frame, 4);
  assert.equal(timeline.inspect().blend, 0.5);
  advance(600);
  assert.equal(timeline.inspect().phase, 'loop');
  assert.equal(frames.size, 1);
  timeline.setIntent(false);
  advance(50);
  assert.equal(timeline.inspect().phase, 'exit');
  advance(100);
  assert.equal(timeline.inspect().frame, 7);
  advance(100);
  assert.equal(timeline.inspect().phase, 'idle');
  assert.equal(frames.size, 0);
});

test('leaving during enter finishes enter, and re-entering during exit finishes exit first', () => {
  const { timeline, advance, updates } = harness();
  timeline.setIntent(true);
  advance(100);
  timeline.setIntent(false);
  assert.equal(timeline.inspect().phase, 'enter');
  assert.equal(timeline.inspect().frame, 1);
  advance(100);
  assert.equal(timeline.inspect().phase, 'exit');
  assert.equal(timeline.inspect().frame, 6);
  timeline.setIntent(true);
  advance(100);
  assert.equal(timeline.inspect().phase, 'exit');
  assert.equal(timeline.inspect().frame, 7);
  advance(100);
  assert.equal(timeline.inspect().phase, 'enter');
  assert.equal(timeline.inspect().frame, 0);
  assert.deepEqual(updates.filter((sample) => sample.phase === 'exit').map((sample) => sample.frame), [6, 6, 7]);
});

test('stage boundaries crossfade forward between different sprite sheets', () => {
  const { timeline, advance } = harness({ transitionDuration: 70 });
  timeline.setIntent(true);
  advance(200);
  advance(35);
  assert.equal(timeline.inspect().from.phase, 'enter');
  assert.equal(timeline.inspect().from.frame, 2);
  assert.equal(timeline.inspect().to.phase, 'loop');
  assert.equal(timeline.inspect().blend, 0.5);
  advance(35);
  assert.equal(timeline.inspect().loopProgress, 0);
});

test('sleep tilt blends with visible poses at the entry and waking joins', () => {
  const { timeline, advance } = harness({ transitionDuration: 220, sleepSway: true });
  timeline.setIntent(true);
  advance(200);
  assert.equal(timeline.inspect().sleepStrength, 0);
  advance(110);
  assert.equal(timeline.inspect().sleepStrength, .5);
  advance(110);
  assert.equal(timeline.inspect().sleepStrength, 1);
  timeline.setIntent(false);
  advance(100);
  assert.equal(timeline.inspect().phase, 'exit');
  assert.equal(timeline.inspect().sleepStrength, 1);
  advance(220);
  assert.equal(timeline.inspect().sleepStrength, 1);
  advance(200);
  assert.equal(timeline.inspect().sleepStrength, 0);
});

test('a settling sprite is held between entry and sleep, including an early leave', () => {
  const stages = {
    idle: { src: 'a', frames: [0], fps: 10 },
    enter: { src: 'a', frames: [0, 1, 2], fps: 10 },
    settle: { src: 'bridge', frames: [0], fps: 5 },
    loop: { src: 'b', frames: [3, 4, 5], fps: 10 },
    exit: { src: 'b', frames: [6, 7, 8], fps: 10 },
  };
  const active = harness({ stages, transitionDuration: 70, sleepSway: true });
  active.timeline.setIntent(true);
  active.advance(200);
  assert.equal(active.timeline.inspect().phase, 'settle');
  assert.equal(active.timeline.inspect().sleepStrength, 0);
  active.advance(35);
  assert.equal(active.timeline.inspect().sleepStrength, .075);
  active.advance(35);
  active.advance(199);
  assert.equal(active.timeline.inspect().phase, 'settle');
  active.advance(1);
  assert.equal(active.timeline.inspect().phase, 'loop');
  assert.equal(active.timeline.inspect().sleepStrength, .15);
  active.advance(70);
  assert.equal(active.timeline.inspect().sleepStrength, 1);

  const leaving = harness({ stages, sleepSway: true });
  leaving.timeline.setIntent(true);
  leaving.advance(200);
  leaving.timeline.setIntent(false);
  leaving.advance(200);
  assert.equal(leaving.timeline.inspect().phase, 'exit');
  assert.equal(leaving.timeline.inspect().sleepStrength, .15);
  leaving.advance(200);
  assert.equal(leaving.timeline.inspect().phase, 'idle');
});

test('leaving mid-tween completes the visible frame before starting the closing action', () => {
  const { timeline, advance } = harness();
  timeline.setIntent(true);
  advance(250);
  const before = timeline.inspect();
  timeline.setIntent(false);
  const after = timeline.inspect();
  assert.equal(after.phase, 'loop');
  assert.deepEqual(after.from, before.from);
  assert.deepEqual(after.to, before.to);
  assert.equal(after.blend, before.blend);
  advance(49);
  assert.equal(timeline.inspect().phase, 'loop');
  advance(1);
  assert.equal(timeline.inspect().phase, 'exit');
});

test('a complete gesture returns to its shared pose before closing', () => {
  const stages = {
    idle: { src: 'sheet', frames: [0], fps: 10 },
    enter: { src: 'sheet', frames: [0, 1, 2], fps: 10 },
    loop: { src: 'sheet', frames: [2, 3, 4], fps: 10, completeOnLeave: true },
    exit: { src: 'sheet', frames: [2, 5, 0], fps: 10 },
  };
  const { timeline, advance, frames } = harness({ stages, transitionDuration: 220 });
  timeline.setIntent(true);
  advance(200);
  assert.deepEqual(timeline.inspect().from, { phase: 'loop', frame: 2 });
  advance(50);
  timeline.setIntent(false);
  advance(100);
  assert.equal(timeline.inspect().phase, 'loop');
  advance(150);
  assert.deepEqual(timeline.inspect().from, { phase: 'exit', frame: 2 });
  advance(200);
  assert.deepEqual(timeline.inspect().from, { phase: 'idle', frame: 0 });
  assert.equal(frames.size, 0);
});

test('a selected loop pose closes without wrapping back through the starting pose', () => {
  const stages = {
    idle: { src: 'sheet', frames: [0], fps: 10 },
    enter: { src: 'sheet', frames: [0, 1, 2], fps: 10 },
    loop: { src: 'sheet', frames: [2, 3, 4, 3], fps: 10, completeOnLeave: true, exitFrame: 4 },
    exit: { src: 'sheet', frames: [4, 5, 0], fps: 10 },
  };
  const { timeline, advance } = harness({ stages, transitionDuration: 220 });
  timeline.setIntent(true);
  advance(250);
  timeline.setIntent(false);
  advance(150);
  assert.equal(timeline.inspect().phase, 'exit');
  assert.deepEqual(timeline.inspect().from, { phase: 'exit', frame: 4 });
  assert.equal(timeline.inspect().blend, 0);
});

test('leaving after the selected exit pose finishes the visible tween and waits for the next matching pose', () => {
  const stages = {
    idle: { src: 'sheet', frames: [0], fps: 10 },
    enter: { src: 'sheet', frames: [0, 1, 2], fps: 10 },
    loop: { src: 'sheet', frames: [2, 3, 4, 3], fps: 10, completeOnLeave: true, exitFrame: 4 },
    exit: { src: 'sheet', frames: [4, 5, 0], fps: 10 },
  };
  const { timeline, advance } = harness({ stages, transitionDuration: 220 });
  timeline.setIntent(true);
  advance(450);
  const before = timeline.inspect();
  timeline.setIntent(false);
  assert.deepEqual(timeline.inspect().from, before.from);
  assert.equal(timeline.inspect().blend, before.blend);
  advance(150);
  assert.equal(timeline.inspect().phase, 'loop');
  assert.equal(timeline.inspect().from.frame, 2);
  advance(200);
  assert.deepEqual(timeline.inspect().from, { phase: 'exit', frame: 4 });
});

test('an early leave reaches the selected closing pose without jumping from the entry pose', () => {
  const stages = {
    idle: { src: 'sheet', frames: [0], fps: 10 },
    enter: { src: 'sheet', frames: [0, 1, 2], fps: 10 },
    loop: { src: 'sheet', frames: [2, 3, 4, 3], fps: 10, completeOnLeave: true, exitFrame: 4 },
    exit: { src: 'sheet', frames: [4, 5, 0], fps: 10 },
  };
  const { timeline, advance } = harness({ stages, transitionDuration: 220 });
  timeline.setIntent(true);
  advance(100);
  timeline.setIntent(false);
  advance(100);
  assert.equal(timeline.inspect().phase, 'loop');
  assert.equal(timeline.inspect().from.frame, 2);
  advance(200);
  assert.deepEqual(timeline.inspect().from, { phase: 'exit', frame: 4 });
  advance(200);
  assert.equal(timeline.inspect().phase, 'idle');
});

test('pause, reduced motion and destruction cancel animation work safely', () => {
  const { timeline, advance, frames, updates } = harness();
  timeline.setIntent(true);
  advance(100);
  timeline.setPaused(true);
  advance(5000);
  assert.equal(timeline.inspect().frame, 1);
  assert.equal(frames.size, 0);
  timeline.setPaused(false);
  advance(100);
  timeline.setReducedMotion(true);
  assert.equal(timeline.inspect().phase, 'loop');
  assert.equal(frames.size, 0);
  timeline.setIntent(false);
  assert.equal(timeline.inspect().phase, 'idle');
  timeline.destroy();
  const count = updates.length;
  timeline.setIntent(true);
  assert.equal(updates.length, count);
  assert.equal(timeline.inspect().destroyed, true);
});

test('runtime factory remains self-contained for injection', () => {
  const factory = Function(`return (${globalThis.createCodexCompanionsRuntime.toString()})`)();
  const runtime = factory({});
  assert.equal(typeof runtime.createTimeline, 'function');
  assert.throws(() => runtime.install(), /browser document/);
});
