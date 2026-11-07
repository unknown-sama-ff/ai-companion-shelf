import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp, evaluate, readCdpJson } from '../integration/cdp-client.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'assets', 'companions.json'), 'utf8'));
const phaseWait = (phase) => Math.ceil(Math.max(...manifest.characters.map(({ animations }) =>
  Math.max(1, animations[phase].frames.length - 1) / animations[phase].fps * 1000 +
  (phase === 'enter' && animations.settle ? Math.max(1, animations.settle.frames.length - 1) / animations.settle.fps * 1000 + 220 : 0)))) + 500;
const enterWait = phaseWait('enter');
const exitWait = phaseWait('exit');
const loopFinishWait = Math.max(...manifest.characters.map(({ animations }) =>
  (animations.loop.completeOnLeave ? animations.loop.frames.length : 1) / animations.loop.fps * 1000));
const workDirectory = path.join(projectRoot, 'work');
await mkdir(workDirectory, { recursive: true });
const statePath = path.join(process.env.LOCALAPPDATA, 'CodexDreamSkin', 'state.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const version = await readCdpJson(state.port, '/json/version');
if (new URL(version.webSocketDebuggerUrl).pathname !== `/devtools/browser/${state.browserId}`) {
  throw new Error('The verified Dream Skin browser identity changed.');
}
const targets = await readCdpJson(state.port, '/json/list');
let result = null;
for (const target of targets.filter((target) => target.type === 'page' && target.url?.startsWith('app://') && target.webSocketDebuggerUrl)) {
  const session = await connectCdp(target.webSocketDebuggerUrl, state.port);
  try {
    if (!await evaluate(session, 'Boolean(!document.hidden && globalThis.__codexDreamSkinCompanions?.inspect().active)')) continue;
    const readStatus = () => evaluate(session, 'globalThis.__codexDreamSkinCompanions.inspect()');
    const readSleepingFeet = () => evaluate(session, `(() => {
      const shadow = document.querySelector('#codex-companions-host').shadowRoot;
      const source = shadow.querySelector('.scene:not([hidden])');
      if (!source) return null;
      const slot = shadow.querySelector('[data-character="zai"]').getBoundingClientRect();
      const surface = source.getBoundingClientRect();
      const width = globalThis.__codexDreamSkinCompanions.inspect().companions.characters.find(character => character.id === 'zai').spriteWidth;
      const pixelScale = source.width / surface.width;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * .4 * pixelScale);
      canvas.height = Math.ceil(width * pixelScale / 4);
      const context = canvas.getContext('2d');
      const left = (slot.left + slot.width / 2 - width * .2 - surface.left) * pixelScale;
      context.drawImage(source, left, source.height - canvas.height, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0, horizontal = 0, bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] < 96) continue;
        count++; horizontal += x; bottom = Math.max(bottom, y);
      }
      return count ? { center: horizontal / count, bottom } : null;
    })()`);
    const dispatch = (type) => evaluate(session, `(() => {
      const buttons = document.querySelector('#codex-companions-host').shadowRoot.querySelectorAll('.character');
      for (const button of buttons) button.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { pointerType: 'mouse' }));
      return buttons.length;
    })()`);
    const capture = async (name) => {
      const clip = await evaluate(session, `(() => {
        const shelf = document.querySelector('#codex-companions-host').shadowRoot.querySelector('.shelf');
        const rect = shelf.getBoundingClientRect();
        const composer = [...document.querySelectorAll('[data-ds-part="composer"]')].find(node => node.getBoundingClientRect().width > 0);
        const input = composer.getBoundingClientRect();
        const top = Math.max(0, rect.y - 28);
        return { x: Math.max(0, input.x), y: top, width: input.width, height: Math.min(innerHeight - top, rect.height + 108), scale: 1 };
      })()`);
      const screenshot = await session.request('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
      await writeFile(path.join(workDirectory, name), Buffer.from(screenshot.data, 'base64'));
    };
    await dispatch('pointerleave');
    await delay(enterWait + exitWait);
    const idle = await readStatus();
    if (idle.companions.characters.length !== 8 || idle.companions.characters.some((character) => character.phase !== 'idle' || character.running)) throw new Error('The eight companions are not idle.');
    await capture('companions-idle.png');
    await dispatch('pointerenter');
    await delay(enterWait);
    const looping = await readStatus();
    if (looping.companions.characters.some((character) => character.phase !== 'loop' || !character.running)) throw new Error('A hovered character is not looping.');
    const feetBefore = await readSleepingFeet();
    await capture('companions-actions.png');
    await delay(337);
    const advanced = await readStatus();
    const feetAfter = await readSleepingFeet();
    const stableSleepingFeet = Boolean(feetBefore && feetAfter && Math.abs(feetBefore.center - feetAfter.center) <= 2 && Math.abs(feetBefore.bottom - feetAfter.bottom) <= 2);
    if (!stableSleepingFeet) throw new Error('The sleeping pose changes below the head and creates ghosting.');
    if (advanced.companions.characters.some((character, index) => !character.procedural && character.frame === looping.companions.characters[index].frame)) throw new Error('A loop did not advance its atlas frame.');
    await dispatch('pointerleave');
    const seenExit = new Map();
    const deadline = Date.now() + loopFinishWait + exitWait + 250;
    let returned = false;
    while (Date.now() < deadline) {
      const status = await readStatus();
      for (const character of status.companions.characters) {
        if (character.phase !== 'exit') continue;
        const frames = manifest.characters.find((item) => item.id === character.id).animations.exit.frames;
        const index = frames.indexOf(character.frame);
        if (index < 0 || index < (seenExit.get(character.id) ?? 0)) throw new Error('A closing action moved backward.');
        seenExit.set(character.id, index);
      }
      if (status.companions.characters.every((character) => character.phase === 'idle' && !character.running)) {
        returned = true;
        break;
      }
      await delay(50);
    }
    if (!returned || seenExit.size !== manifest.characters.length) throw new Error('A character did not complete its forward closing action.');
    const inputAccessible = await evaluate(session, `(() => {
      const composer = [...document.querySelectorAll('[data-ds-part="composer"]')].find(element => element.getBoundingClientRect().width > 0);
      const rect = composer.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(35, rect.height / 2));
      return Boolean(hit && composer.contains(hit));
    })()`);
    if (!inputAccessible) throw new Error('The companion shelf covers the native input surface.');
    const packing = await evaluate(session, `(() => {
      const host = document.querySelector('#codex-companions-host');
      const buttons = [...host.shadowRoot.querySelectorAll('.character')];
      const input = [...document.querySelectorAll('[data-ds-part="composer"]')].find(node => node.getBoundingClientRect().width > 0).getBoundingClientRect();
      const slots = buttons.map(button => button.getBoundingClientRect());
      const width = globalThis.__codexDreamSkinCompanions.inspect().companions.characters.at(-1).spriteWidth;
      const right = slots.at(-1).left + slots.at(-1).width / 2 + width / 2;
      return { characterWidth: width, rightInset: input.right - right, canvasCount: host.shadowRoot.querySelectorAll('canvas').length,
        nonoverlappingHitboxes: slots.every((slot, index) => index === 0 || slot.left >= slots[index - 1].right - 0.1) };
    })()`);
    if (packing.characterWidth > 56.1 || Math.abs(packing.rightInset - 8) > 0.5 || !packing.nonoverlappingHitboxes || packing.canvasCount !== 1) throw new Error(`Unexpected compact packing: ${JSON.stringify(packing)}`);
    result = { targetId: target.id, loaded: idle.companions.characters.length, continuousLoops: true, independentForwardExit: true,
      motionInterpolation: advanced.companions.characters.every((character) => character.interpolation === 'motion'), stableSleepingFeet, inputAccessible, packing };
    break;
  } finally {
    await evaluate(session, `(() => {
      const buttons = document.querySelector('#codex-companions-host')?.shadowRoot.querySelectorAll('.character') || [];
      for (const button of buttons) button.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
      return true;
    })()`).catch(() => {});
    session.close();
  }
}
if (!result) throw new Error('No visible active companion shelf was found.');
await writeFile(path.join(workDirectory, 'live-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
