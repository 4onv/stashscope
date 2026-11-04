import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRepository } from './inspect.mjs';

// Internal report adapter, exported for platform-alias regression tests. Resolve
// paths before matching: Git can spell macOS /var as /private/var, and Windows
// temporary directories can arrive through short names or different casing.
export async function portableDemoReport(report, knownWorktrees, { resolvePath = realpath, platform = process.platform } = {}) {
  const key = value => platform === 'win32'
    ? path.win32.normalize(value).toLowerCase()
    : path.posix.normalize(value);
  const known = new Map(await Promise.all(Object.entries(knownWorktrees).map(async ([name, directory]) =>
    [key(await resolvePath(directory)), `<demo>/${name}`])));
  if (report.worktrees.length !== known.size) throw new Error('The generated demo returned an unexpected worktree inventory.');
  const seen = new Set();
  const worktrees = [];
  for (const worktree of report.worktrees) {
    if (!worktree.available) throw new Error('A generated demo worktree could not be inspected.');
    const resolved = key(await resolvePath(worktree.path));
    const portablePath = known.get(resolved);
    if (!portablePath || seen.has(resolved)) throw new Error('The generated demo returned an unexpected worktree path.');
    seen.add(resolved);
    worktrees.push({ ...worktree, path: portablePath });
  }
  return { ...report, worktrees };
}

// This is generated demonstration data. Every Git mutation stays inside this
// newly created temporary repository; the caller's repository is never used.
export async function runDemo() {
  const directory = await mkdtemp(path.join(tmpdir(), 'stashscope-demo-'));
  const main = path.join(directory, 'main');
  const diverged = path.join(directory, 'diverged');
  const dirty = path.join(directory, 'dirty');
  const hooks = path.join(directory, 'empty-hooks');
  const template = path.join(directory, 'empty-template');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(directory, 'absent-global-config');
  env.GIT_TERMINAL_PROMPT = '0';
  const git = (cwd, args) => execFileSync('git', [
    '-c', `core.hooksPath=${hooks}`,
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'user.name=StashScope Synthetic Demo',
    '-c', 'user.email=demo@example.invalid',
    ...args,
  ], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.all([mkdir(main), mkdir(hooks), mkdir(template)]);
    git(main, ['init', '-b', 'main', `--template=${template}`]);
    git(main, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(main, 'README.md'), '# Synthetic StashScope demonstration\n');
    await writeFile(path.join(main, 'config.txt'), 'port=3000\nmode=development\n');
    git(main, ['add', '--', 'README.md', 'config.txt']);
    git(main, ['commit', '-m', 'Synthetic base']);
    await writeFile(path.join(main, 'config.txt'), 'port=4000\nmode=development\n');
    await writeFile(path.join(main, 'draft.txt'), 'Synthetic untracked work saved in the stash.\n');
    git(main, ['stash', 'push', '--include-untracked', '-m', 'SYNTHETIC: change port and add a draft']);
    git(main, ['worktree', 'add', '-b', 'diverged', diverged]);
    git(main, ['worktree', 'add', '-b', 'dirty', dirty]);
    await writeFile(path.join(diverged, 'config.txt'), 'port=5000\nmode=development\n');
    git(diverged, ['add', '--', 'config.txt']);
    git(diverged, ['commit', '-m', 'Synthetic competing port change']);
    await writeFile(path.join(dirty, 'config.txt'), 'port=6000\nmode=development\n');
    await writeFile(path.join(dirty, 'draft.txt'), 'Synthetic local file that must not be overwritten.\n');

    const result = await inspectRepository({ cwd: main, stash: '0' });
    return {
      ...await portableDemoReport(result, { main, diverged, dirty }),
      synthetic: true,
      demoDescription: 'Generated Git repository: main matches the stash base, diverged has a competing commit, and dirty has local edits plus an occupied draft path.',
    };
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('stashscope-demo-')) {
      throw new Error('Refusing to remove a path outside the generated demo directory.');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
