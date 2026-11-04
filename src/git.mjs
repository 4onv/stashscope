import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const MAX_OUTPUT = 8 * 1024 * 1024;

export function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' };
}

export async function git(cwd, args, { input, allowFailure = false } = {}) {
  const options = { cwd, env: gitEnvironment(), windowsHide: true, timeout: 10000, maxBuffer: MAX_OUTPUT, encoding: 'buffer' };
  const argv = ['--no-pager', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args];
  try {
    const task = execute('git', argv, options);
    if (input !== undefined) task.child.stdin.end(input);
    const { stdout } = await task;
    return { code: 0, text: new TextDecoder('utf-8', { fatal: true }).decode(stdout) };
  } catch (error) {
    if (allowFailure && Number.isInteger(error.code) && !error.killed) {
      return { code: error.code, text: new TextDecoder('utf-8', { fatal: true }).decode(error.stdout ?? new Uint8Array()) };
    }
    if (error.code === 'ENOENT') throw new Error('Git was not found. Install Git and put it on PATH.');
    if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git exceeded the 10-second or 8 MiB command limit.');
    // Never relay arbitrary command stderr: it can contain repository content.
    throw new Error(`Git ${args[0]} failed${Number.isInteger(error.code) ? ` (exit ${error.code})` : ''}. Check the repository and available objects.`);
  }
}

export function parseTree(text) {
  const entries = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Unsupported Git tree record.');
    entries.set(match[4], { mode: match[1], oid: match[3] });
  }
  return entries;
}

export function parseIndex(text) {
  const entries = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\S) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Unsupported Git index record.');
    const old = entries.get(match[5]);
    entries.set(match[5], { mode: match[2], oid: match[3], unmerged: match[4] !== '0' || old?.unmerged === true, hidden: match[1] === 'S' || match[1] === match[1].toLowerCase() });
  }
  return entries;
}

export function parseWorktrees(text) {
  const trees = [];
  let current;
  for (const record of text.split('\0')) {
    if (!record) {
      if (current) trees.push(current);
      current = undefined;
    } else if (record.startsWith('worktree ')) {
      current = { path: record.slice(9) };
    } else if (current) {
      const space = record.indexOf(' ');
      const key = space < 0 ? record : record.slice(0, space);
      const value = space < 0 ? true : record.slice(space + 1);
      current[key === 'HEAD' ? 'head' : key] = value;
    }
  }
  if (current) trees.push(current);
  return trees;
}

export function equalEntry(a, b) {
  return (!a && !b) || Boolean(a && b && a.oid === b.oid && a.mode === b.mode);
}
