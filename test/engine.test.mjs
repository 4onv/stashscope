import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, rmdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRepository, listStashes } from '../src/inspect.mjs';
import { parseIndex, parseTree, parseWorktrees, gitEnvironment } from '../src/git.mjs';

function command(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
async function fixture(t, format = 'sha1') {
  const directory = await mkdtemp(path.join(tmpdir(), 'stashscope-engine-'));
  const main = path.join(directory, 'main');
  await mkdir(main);
  command(main, 'init', '-b', 'main', `--object-format=${format}`);
  command(main, 'config', 'user.name', 'Synthetic test');
  command(main, 'config', 'user.email', 'synthetic@example.invalid');
  command(main, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(main, 'file.txt'), 'base\n');
  command(main, 'add', '.'); command(main, 'commit', '-m', 'Synthetic base');
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('stashscope-engine-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return { directory, main };
}
const finding = (report, name, branch = 'main') => report.worktrees.find(item => item.branch === branch).findings.find(item => item.path === name);

test('parsers preserve NUL-delimited whitespace paths and hidden/conflict index flags', () => {
  const oid = 'a'.repeat(40);
  const tree = parseTree(`100644 blob ${oid}\tspace é\nline.txt\0`);
  assert.equal(tree.get('space é\nline.txt').oid, oid);
  assert.equal(parseIndex(`h 100644 ${oid} 0\tx\0`).get('x').hidden, true);
  assert.equal(parseIndex(`H 100644 ${oid} 2\tx\0H 100644 ${oid} 3\tx\0`).get('x').unmerged, true);
  assert.equal(parseWorktrees(`worktree /a b\0HEAD ${oid}\0branch refs/heads/main\0\0`)[0].path, '/a b');
  assert.throws(() => parseTree('bogus'), /Unsupported/);
});

test('stash inventory pins SHA and rejects arbitrary revisions and ordinary commits', async t => {
  const { main } = await fixture(t);
  assert.deepEqual(await listStashes({ cwd: main }), []);
  await writeFile(path.join(main, 'file.txt'), 'change\n');
  command(main, 'stash', 'push', '-m', 'SYNTHETIC inventory');
  const stashes = await listStashes({ cwd: main });
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].selector, 'stash@{0}');
  assert.match(stashes[0].oid, /^[a-f0-9]{40}$/);
  assert.match(stashes[0].subject, /SYNTHETIC inventory/);
  assert.equal((await inspectRepository({ cwd: main, stash: stashes[0].oid })).stash.oid, stashes[0].oid);
  await assert.rejects(inspectRepository({ cwd: main, stash: '--help' }), /Stash must/);
  await assert.rejects(inspectRepository({ cwd: main, stash: '999' }), /does not resolve/);
  await assert.rejects(inspectRepository({ cwd: main, stash: command(main, 'rev-parse', 'HEAD') }), /not a supported/);
});

test('inspection leaves stash refs, index bytes, files and tracked staged state unchanged', async t => {
  const { main, directory } = await fixture(t);
  await writeFile(path.join(main, 'file.txt'), 'stashed\n');
  command(main, 'stash', 'push');
  const dirty = path.join(directory, 'dirty');
  command(main, 'worktree', 'add', '-b', 'dirty', dirty);
  await writeFile(path.join(dirty, 'file.txt'), 'staged\n'); command(dirty, 'add', 'file.txt');
  await writeFile(path.join(dirty, 'file.txt'), 'unstaged\n');
  const indexPath = command(dirty, 'rev-parse', '--git-path', 'index');
  const indexBefore = await readFile(indexPath);
  const refsBefore = command(main, 'show-ref');
  const report = await inspectRepository({ cwd: main });
  assert.equal(finding(report, 'file.txt').status, 'base-match');
  assert.equal(finding(report, 'file.txt', 'dirty').status, 'local-changes');
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.equal(command(main, 'show-ref'), refsBefore);
  assert.equal(await readFile(path.join(dirty, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(finding(report, 'file.txt', 'dirty').indexEntry.oid, command(dirty, 'rev-parse', ':file.txt'));
});

test('saved staged cancellation is retained and requires review', async t => {
  const { main } = await fixture(t);
  await writeFile(path.join(main, 'file.txt'), 'staged only\n'); command(main, 'add', 'file.txt');
  await writeFile(path.join(main, 'file.txt'), 'base\n');
  command(main, 'stash', 'push', '-m', 'SYNTHETIC index cancellation');
  const report = await inspectRepository({ cwd: main });
  assert.equal(report.stash.paths.length, 1);
  assert.equal(report.stash.paths[0].base.oid, report.stash.paths[0].stashed.oid);
  assert.notEqual(report.stash.paths[0].base.oid, report.stash.paths[0].index.oid);
  assert.equal(finding(report, 'file.txt').status, 'unknown');
  assert.match(finding(report, 'file.txt').reason, /staged changes/);
});

test('untracked stash files detect ignored collisions and obstructing parent files', async t => {
  const { main } = await fixture(t);
  await mkdir(path.join(main, 'nested'));
  await writeFile(path.join(main, 'nested', 'draft.txt'), 'draft\n');
  await writeFile(path.join(main, 'new é file.txt'), 'untracked\n');
  command(main, 'stash', 'push', '-u');
  await writeFile(path.join(main, '.gitignore'), 'new*\n');
  await writeFile(path.join(main, 'new é file.txt'), 'ignored collision\n');
  await writeFile(path.join(main, 'nested'), 'parent obstruction\n');
  const report = await inspectRepository({ cwd: main });
  assert.equal(finding(report, 'new é file.txt').status, 'path-occupied');
  assert.equal(finding(report, 'nested/draft.txt').status, 'path-occupied');
  assert.equal(report.stash.paths.find(item => item.path === 'new é file.txt').kind, 'untracked');
});

test('deletions, committed divergence, and already-present content are distinguished', async t => {
  const { main, directory } = await fixture(t);
  await writeFile(path.join(main, 'delete.txt'), 'remove me\n'); command(main, 'add', '.'); command(main, 'commit', '-m', 'second base');
  await rm(path.join(main, 'delete.txt'));
  await writeFile(path.join(main, 'file.txt'), 'stashed\n'); command(main, 'stash', 'push');
  const applied = path.join(directory, 'already'); command(main, 'worktree', 'add', '-b', 'already', applied);
  await rm(path.join(applied, 'delete.txt')); await writeFile(path.join(applied, 'file.txt'), 'stashed\n'); command(applied, 'add', '-A'); command(applied, 'commit', '-m', 'already present');
  const diverged = path.join(directory, 'diverged'); command(main, 'worktree', 'add', '-b', 'diverged', diverged);
  await writeFile(path.join(diverged, 'file.txt'), 'other\n'); command(diverged, 'add', '.'); command(diverged, 'commit', '-m', 'diverged');
  const report = await inspectRepository({ cwd: main });
  assert.equal(finding(report, 'delete.txt').status, 'base-match');
  assert.equal(finding(report, 'delete.txt', 'already').status, 'already-present');
  assert.equal(finding(report, 'file.txt', 'already').status, 'already-present');
  assert.equal(finding(report, 'file.txt', 'diverged').status, 'diverged');
});

test('transforming attributes and hidden index flags are unknown without invoking filters', async t => {
  const { main } = await fixture(t);
  await writeFile(path.join(main, 'file.txt'), 'stashed\n'); command(main, 'stash', 'push');
  await writeFile(path.join(main, '.gitattributes'), 'file.txt filter=never-run\n');
  command(main, 'config', 'filter.never-run.clean', 'stashscope-filter-must-never-execute');
  command(main, 'config', 'filter.never-run.required', 'true');
  let report = await inspectRepository({ cwd: main });
  assert.equal(report.worktrees[0].available, true);
  assert.equal(finding(report, 'file.txt').status, 'unknown');
  await rm(path.join(main, '.gitattributes'));
  command(main, 'update-index', '--assume-unchanged', 'file.txt');
  report = await inspectRepository({ cwd: main });
  assert.equal(finding(report, 'file.txt').status, 'unknown');
  assert.match(finding(report, 'file.txt').reason, /assume-unchanged/);
});

test('sha256 repositories hash raw worktree content using the repository format', async t => {
  const { main } = await fixture(t, 'sha256');
  await writeFile(path.join(main, 'file.txt'), 'stashed\n'); command(main, 'stash', 'push');
  const report = await inspectRepository({ cwd: main });
  assert.equal(report.stash.oid.length, 64);
  assert.equal(finding(report, 'file.txt').status, 'base-match');
});

test('core.filemode defaults to true and accepts Git boolean synonyms', { skip: process.platform === 'win32' }, async t => {
  const { main } = await fixture(t);
  await writeFile(path.join(main, 'file.txt'), 'stashed\n'); command(main, 'stash', 'push');
  await chmod(path.join(main, 'file.txt'), 0o755);
  command(main, 'config', '--unset', 'core.filemode');
  assert.equal(finding(await inspectRepository({ cwd: main }), 'file.txt').status, 'local-changes');
  command(main, 'config', 'core.filemode', 'yes');
  assert.equal(finding(await inspectRepository({ cwd: main }), 'file.txt').status, 'local-changes');
});

test('tracked ancestor and descendant collisions remain occupied when their working files are missing', async t => {
  const { main, directory } = await fixture(t);
  await writeFile(path.join(main, 'route'), 'stashed file\n');
  await mkdir(path.join(main, 'folder'));
  await writeFile(path.join(main, 'folder', 'child'), 'stashed child\n');
  command(main, 'stash', 'push', '-u');
  const target = path.join(directory, 'target'); command(main, 'worktree', 'add', '-b', 'target', target);
  await mkdir(path.join(target, 'route'));
  await writeFile(path.join(target, 'route', 'child'), 'tracked descendant\n');
  await writeFile(path.join(target, 'folder'), 'tracked ancestor\n');
  command(target, 'add', '.'); command(target, 'commit', '-m', 'collision topology');
  await rm(path.join(target, 'route', 'child')); await rmdir(path.join(target, 'route'));
  await rm(path.join(target, 'folder'));
  const report = await inspectRepository({ cwd: main });
  assert.equal(finding(report, 'route', 'target').status, 'path-occupied');
  assert.equal(finding(report, 'folder/child', 'target').status, 'path-occupied');
});

test('case aliases in tracked trees remain occupied even when the local file is missing', async t => {
  const { main, directory } = await fixture(t);
  await writeFile(path.join(main, 'Draft.txt'), 'stashed file\n'); command(main, 'stash', 'push', '-u');
  const target = path.join(directory, 'target'); command(main, 'worktree', 'add', '-b', 'target', target);
  await writeFile(path.join(target, 'draft.txt'), 'tracked case alias\n'); command(target, 'add', '.'); command(target, 'commit', '-m', 'case alias');
  await rm(path.join(target, 'draft.txt'));
  command(main, 'config', 'core.ignorecase', 'true');
  assert.equal(finding(await inspectRepository({ cwd: main }), 'Draft.txt', 'target').status, 'path-occupied');
});
