import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { buildPayload } from '../integration/skin-extension.mjs';
import { connectCdp, evaluate, readCdpJson } from '../integration/cdp-client.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'assets', 'companions.json'), 'utf8'));
const expectedCharacterCount = (Array.isArray(manifest) ? manifest : manifest.characters).length;
const options = new Set(process.argv.slice(2));
if ([...options].some((option) => !['--remove', '--verify-only'].includes(option))) {
  throw new Error('Supported options are --remove and --verify-only.');
}
const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const resolved = await execFileAsync(powershell, [
  '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File',
  path.join(projectRoot, 'scripts', 'resolve-dream-skin-session.ps1'),
], { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
const identity = JSON.parse(resolved.stdout.trim());
const version = await readCdpJson(identity.port, '/json/version');
if (new URL(version.webSocketDebuggerUrl).pathname !== `/devtools/browser/${identity.browserId}`) {
  throw new Error('The Dream Skin browser identity changed before attachment.');
}
const targets = await readCdpJson(identity.port, '/json/list');
const payload = options.has('--remove') || options.has('--verify-only') ? null : await buildPayload();
const reports = [];
for (const target of targets.filter((target) => target.type === 'page' && target.url?.startsWith('app://') && target.webSocketDebuggerUrl)) {
  const session = await connectCdp(target.webSocketDebuggerUrl, identity.port);
  try {
    const eligible = await evaluate(session, `Boolean(document.documentElement.getAttribute('data-dream-skin') === 'active' && document.querySelector('[data-ds-part="composer"], [data-codex-composer-root]'))`);
    if (!eligible) continue;
    if (options.has('--remove')) {
      await evaluate(session, 'globalThis.__codexDreamSkinCompanions?.destroy(); true');
      reports.push({ targetId: target.id, removed: true });
      continue;
    }
    if (payload) await evaluate(session, `${payload}\ntrue`);
    let status;
    for (let attempt = 0; attempt < 25; attempt++) {
      status = await evaluate(session, 'globalThis.__codexDreamSkinCompanions?.inspect() || null');
      const characters = status?.companions?.characters || [];
      if (status?.active && status.companions.connected && characters.length === expectedCharacterCount &&
          characters.every((character) => character.loaded || character.failed)) break;
      await delay(200);
    }
    const characters = status?.companions?.characters || [];
    if (!status?.active || !status.companions.connected || characters.length !== expectedCharacterCount ||
        characters.some((character) => !character.loaded || character.failed)) {
      throw new Error(`Companion activation could not be verified: ${JSON.stringify(status)}`);
    }
    reports.push({ targetId: target.id, ...status });
  } finally {
    session.close();
  }
}
if (!reports.length) throw new Error('No active Dream Skin chat composer was found.');
console.log(JSON.stringify({ packageVersion: identity.packageVersion, reports }, null, 2));
