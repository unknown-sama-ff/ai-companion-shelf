import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, evaluate, readCdpJson } from '../integration/cdp-client.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(await readFile(path.join(process.env.LOCALAPPDATA, 'CodexDreamSkin', 'state.json'), 'utf8'));
const version = await readCdpJson(state.port, '/json/version');
if (new URL(version.webSocketDebuggerUrl).pathname !== `/devtools/browser/${state.browserId}`) {
  throw new Error('The Dream Skin browser identity changed.');
}

async function capturePreview() {
  const instance = globalThis.__codexCompanionsInstance;
  const source = instance.host.shadowRoot.querySelector('.scene');
  const ids = ['grok', 'claude', 'gemini', 'qwen', 'kimi', 'zai'];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (const id of ids) instance.setActive(id, false);
  if (instance.inspect().characters.some((character) => character.phase !== 'idle')) await delay(2800);

  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height + 42;
  const context = canvas.getContext('2d');
  const surface = source.getBoundingClientRect();
  const scale = source.width / surface.width;
  const labels = [...instance.host.shadowRoot.querySelectorAll('.character')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { text: button.dataset.character, x: (rect.left + rect.width / 2 - surface.left) * scale };
  });
  let frame = null;
  const paint = () => {
    context.fillStyle = '#fcf9ff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#cfc2df';
    context.beginPath();
    context.moveTo(0, source.height - 3 * scale);
    context.lineTo(canvas.width, source.height - 3 * scale);
    context.stroke();
    context.drawImage(source, 0, 0);
    context.font = '13px system-ui';
    context.textAlign = 'center';
    context.fillStyle = '#5d4c6c';
    for (const label of labels) context.fillText(label.text, label.x, source.height + 28);
    frame = requestAnimationFrame(paint);
  };
  const stream = canvas.captureStream(30);
  const chunks = [];
  let recorder = null;
  try {
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1800000 });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => reject(event.error);
    });
    paint();
    recorder.start(1000);
    await delay(300);
    for (const id of ids) instance.setActive(id, true);
    await delay(5500);
    for (const id of ids) instance.setActive(id, false);
    await delay(2800);
    recorder.stop();
    await finished;
    if (document.hidden) throw new Error('The window became hidden during recording.');
    const blob = new Blob(chunks, { type: 'video/webm' });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } finally {
    cancelAnimationFrame(frame);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    for (const id of ids) instance.setActive(id, false);
  }
}

let captured = false;
try {
for (const target of (await readCdpJson(state.port, '/json/list')).filter((target) =>
  target.type === 'page' && target.url?.startsWith('app://') && target.webSocketDebuggerUrl)) {
  const session = await connectCdp(target.webSocketDebuggerUrl, state.port);
  try {
    if (!await evaluate(session, 'Boolean(!document.hidden && globalThis.__codexCompanionsInstance?.inspect().connected)')) continue;
    const bytes = await evaluate(session, `(${capturePreview.toString()})()`);
    await writeFile(path.join(projectRoot, 'work', 'repaired-companions-preview.webm'), Buffer.from(bytes, 'base64'));
    captured = true;
    console.log('Saved the companion gesture preview.');
    break;
  } finally {
    session.close();
  }
}
if (!captured) throw new Error('No visible companion window was found.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
