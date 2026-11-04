import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/stashscope.mjs', import.meta.url));
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
});

test('installed-style CLI demo inspects real synthetic worktrees', () => {
  const child = run(['demo', '--json'], {
    env: { ...process.env, GIT_DIR: '/nonexistent-stashscope-demo-git', GIT_WORK_TREE: '/nonexistent-stashscope-demo-tree' },
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.synthetic, true);
  assert.match(report.stash.oid, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.equal(report.worktrees.length, 3);
  const byBranch = (name) => report.worktrees.find((item) => item.branch === name || item.branch === `refs/heads/${name}`);
  const status = (branch, name) => byBranch(branch).findings.find((item) => item.path === name).status;
  assert.equal(status('main', 'config.txt'), 'base-match');
  assert.equal(status('main', 'draft.txt'), 'path-clear');
  assert.equal(status('diverged', 'config.txt'), 'diverged');
  assert.equal(status('dirty', 'config.txt'), 'local-changes');
  assert.equal(status('dirty', 'draft.txt'), 'path-occupied');
  for (const worktree of report.worktrees) assert.match(worktree.path, /^<demo>\//);
  assert.ok(!child.stdout.includes('stashscope-demo-'));
});

test('CLI rejects unsupported options and missing flag values', () => {
  for (const args of [['unknown'], ['inspect', '--oops'], ['inspect', '--repo'], ['inspect', '--stash'], ['demo', '--stash', '0']]) {
    const child = run(args);
    assert.equal(child.status, 2, `${JSON.stringify(args)}: ${child.stdout} ${child.stderr}`);
    assert.ok(child.stderr.trim());
  }
});

test('stash listing preserves stable IDs and escapes terminal control characters', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stashscope-cli-'));
  const hooks = path.join(directory, 'hooks');
  const template = path.join(directory, 'template');
  const repo = path.join(directory, 'repo');
  mkdirSync(hooks);
  mkdirSync(template);
  mkdirSync(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(directory, 'absent-config');
  const git = (args) => execFileSync('git', [
    '-c', `core.hooksPath=${hooks}`, '-c', 'core.autocrlf=false',
    '-c', 'user.name=Synthetic CLI Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '-b', 'main', `--template=${template}`]);
    writeFileSync(path.join(repo, 'file.txt'), 'base\n');
    git(['add', '--', 'file.txt']);
    git(['commit', '-m', 'Synthetic test base']);
    writeFileSync(path.join(repo, 'file.txt'), 'first\n');
    git(['stash', 'push', '-m', 'SYNTHETIC \u001b[31m unsafe terminal sequence']);
    const first = git(['rev-parse', 'refs/stash']).trim();
    writeFileSync(path.join(repo, 'file.txt'), 'second\n');
    git(['stash', 'push', '-m', 'SYNTHETIC newer stash']);
    const json = run(['list', '--repo', repo, '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    const value = JSON.parse(json.stdout);
    const stashes = Array.isArray(value) ? value : value.stashes;
    assert.equal(stashes.length, 2);
    assert.equal(stashes[1].oid, first);
    const text = run(['list', '--repo', repo], { env });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(!text.stdout.includes('\u001b'));
    assert.ok(text.stdout.includes(first.slice(0, 8)));
    const inspect = run(['inspect', '--repo', repo, '--stash', first, '--json'], { env });
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).stash.oid, first);
    assert.equal(git(['rev-parse', 'refs/stash']).trim(), stashes[0].oid);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('stashscope-cli-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
