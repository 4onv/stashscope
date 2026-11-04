import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const npm = process.env.npm_execpath;
if (!npm || !path.isAbsolute(npm)) throw new Error('Run this check with npm run test:package.');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'stashscope-package-'));
const options = { encoding: 'utf8', timeout: 120000, windowsHide: true };
try {
  const data = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], { ...options, cwd: root }));
  const packed = Array.isArray(data) ? data[0] : data['@4onv/stashscope'];
  assert.equal(packed.name, '@4onv/stashscope');
  assert.equal(packed.filename, path.basename(packed.filename));
  const prefix = path.join(directory, 'install');
  await mkdir(prefix);
  execFileSync(process.execPath, [npm, 'install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(directory, packed.filename)], { ...options, cwd: directory });
  const raw = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', 'node_modules\\.bin\\stashscope.cmd demo --json'], { ...options, cwd: prefix })
    : execFileSync(path.join(prefix, 'node_modules/.bin/stashscope'), ['demo', '--json'], { ...options, cwd: prefix });
  const demo = JSON.parse(raw);
  assert.equal(demo.synthetic, true);
  assert.equal(demo.worktrees.length, 3);
  const statuses = new Set(demo.worktrees.flatMap(w => w.findings.map(f => f.status)));
  for (const status of ['base-match', 'diverged', 'local-changes', 'path-occupied']) assert.ok(statuses.has(status), `Missing ${status}`);
  const api = await import(pathToFileURL(path.join(prefix, 'node_modules/@4onv/stashscope/src/index.mjs')));
  assert.equal(typeof api.inspectRepository, 'function');
  console.log('Release archive installed offline; installed CLI exercised real synthetic Git recovery cases.');
} finally {
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('stashscope-package-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
