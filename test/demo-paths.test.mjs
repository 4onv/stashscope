import test from 'node:test';
import assert from 'node:assert/strict';
import { portableDemoReport } from '../src/demo.mjs';

const reportFor = paths => ({
  stash: { subject: 'SYNTHETIC: preserve report text' },
  worktrees: paths.map(path => ({ path, available: true, findings: [], warnings: [] })),
});

test('demo maps macOS canonical temporary paths without leaving a /private prefix', async () => {
  const temporary = '/var/folders/example/stashscope-demo-fixture';
  const known = { main: `${temporary}/main`, dirty: `${temporary}/dirty` };
  const report = reportFor([`/private${temporary}/dirty`, `/private${temporary}/main`]);
  // Model realpath resolving the symlink used for macOS temporary directories.
  const resolvePath = async value => value.startsWith('/var/') ? `/private${value}` : value;
  const result = await portableDemoReport(report, known, { resolvePath, platform: 'darwin' });
  assert.deepEqual(result.worktrees.map(tree => tree.path), ['<demo>/dirty', '<demo>/main']);
  assert.equal(result.stash.subject, report.stash.subject);
  assert.equal(report.worktrees[0].path, `/private${temporary}/dirty`);
});

test('demo maps Windows short-path aliases, separators and canonical casing', async () => {
  const temporary = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\stashscope-demo-fixture';
  const canonical = 'C:/Users/runneradmin/AppData/Local/Temp/stashscope-demo-fixture';
  const known = { main: `${temporary}\\main`, dirty: `${temporary}\\dirty` };
  const report = reportFor([`${canonical}/main`, `${canonical}/dirty`]);
  const resolvePath = async value => value.includes('RUNNER~1')
    ? value.replace('RUNNER~1', 'RunnerAdmin') : value;
  const result = await portableDemoReport(report, known, { resolvePath, platform: 'win32' });
  assert.deepEqual(result.worktrees.map(tree => tree.path), ['<demo>/main', '<demo>/dirty']);
  assert.ok(!JSON.stringify(result).includes('stashscope-demo-fixture'));
});

test('demo refuses unrelated, duplicate, incomplete or unavailable worktrees', async () => {
  const known = { main: '/tmp/stashscope-demo-known/main' };
  const options = { resolvePath: async value => value, platform: 'linux' };
  await assert.rejects(portableDemoReport(reportFor(['/tmp/stashscope-demo-other/main']), known, options), /unexpected worktree path/);
  await assert.rejects(portableDemoReport(reportFor([]), known, options), /unexpected worktree inventory/);
  const unavailable = reportFor([known.main]);
  unavailable.worktrees[0].available = false;
  await assert.rejects(portableDemoReport(unavailable, known, options), /could not be inspected/);
  await assert.rejects(portableDemoReport(reportFor([known.main, known.main]), { ...known, dirty: '/tmp/stashscope-demo-known/dirty' }, options), /unexpected worktree path/);
});
