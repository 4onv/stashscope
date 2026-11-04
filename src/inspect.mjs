import path from 'node:path';
import { lstat, open, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { git, parseTree, parseIndex, parseWorktrees, equalEntry } from './git.mjs';

const MAX_PATHS = 1000;
const MAX_WORKTREES = 32;
const MAX_FILE = 8 * 1024 * 1024;
const LIMITATIONS = [
  'This is a path-level snapshot, not a stash apply simulation or a guarantee of a successful merge.',
  'base-match and already-present describe exact blob and mode comparisons; they do not identify the intended owner of a stash.',
  'Concurrent edits can invalidate the report. Worktree contents are read without taking repository locks.',
  'Transforming attributes, autocrlf, sparse/assume-unchanged entries, and submodules can produce unknown findings.',
  'Stash subjects and file paths are included in reports. File contents are never included.'
];

async function config(cwd, name) {
  const result = await git(cwd, ['config', '--get', name], { allowFailure: true });
  if (result.code !== 0 && result.code !== 1) throw new Error('Cannot read Git configuration.');
  return result.code === 1 ? '' : result.text.trim().toLowerCase();
}

async function booleanConfig(cwd, name, fallback) {
  const result = await git(cwd, ['config', '--type=bool', '--get', name], { allowFailure: true });
  if (result.code === 1) return fallback;
  if (result.code !== 0 || !['true', 'false'].includes(result.text.trim())) throw new Error('Cannot read boolean Git configuration.');
  return result.text.trim() === 'true';
}

function selector(value) {
  const text = String(value);
  if (/^\d{1,6}$/.test(text)) return `stash@{${Number(text)}}`;
  if (/^stash@\{\d{1,6}\}$/.test(text) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(text)) return text;
  throw new Error('Stash must be an index, stash@{index}, or a full commit SHA.');
}

async function tree(cwd, oid) {
  return parseTree((await git(cwd, ['ls-tree', '-r', '-z', '--full-tree', oid])).text);
}

export async function listStashes({ cwd = process.cwd() } = {}) {
  const exists = await git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash'], { allowFailure: true });
  if (exists.code === 1) return [];
  if (exists.code !== 0) throw new Error('Cannot read this repository.');
  const records = (await git(cwd, ['log', '-g', '-z', '--max-count=101', '--format=%H%x00%gd%x00%gs%x00%cI', 'refs/stash'])).text.split('\0');
  if (records.at(-1) === '') records.pop();
  if (records.length % 4 !== 0) throw new Error('Unsupported stash reflog record.');
  if (records.length / 4 > 100) throw new Error('Stash listing exceeds the 100-entry limit; inspect a stash by its full SHA.');
  const result = [];
  for (let i = 0; i < records.length; i += 4) result.push({ oid: records[i], selector: records[i + 1], subject: records[i + 2], date: records[i + 3] });
  return result;
}

async function inspectStash(cwd, value) {
  const selected = selector(value);
  const resolved = await git(cwd, ['rev-parse', '--verify', '--quiet', `${selected}^{commit}`], { allowFailure: true });
  if (resolved.code !== 0) throw new Error('That stash does not resolve to an available commit. Run stashscope list first.');
  const oid = resolved.text.trim();
  const ancestry = (await git(cwd, ['rev-list', '--parents', '-n', '1', oid])).text.trim().split(' ');
  if (![3, 4].includes(ancestry.length)) throw new Error('The selected commit is not a supported two- or three-parent stash.');
  const [, baseOid, indexOid, untrackedOid] = ancestry;
  const indexParents = (await git(cwd, ['rev-list', '--parents', '-n', '1', indexOid])).text.trim().split(' ');
  if (indexParents.length !== 2 || indexParents[1] !== baseOid) throw new Error('The stash index parent does not match its base.');
  if (untrackedOid) {
    const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', untrackedOid])).text.trim().split(' ');
    if (parents.length !== 1) throw new Error('The stash untracked parent has an unsupported history.');
  }
  const base = await tree(cwd, baseOid);
  const stashed = await tree(cwd, oid);
  const index = await tree(cwd, indexOid);
  const paths = [];
  for (const name of new Set([...base.keys(), ...stashed.keys(), ...index.keys()])) {
    if (!equalEntry(base.get(name), stashed.get(name)) || !equalEntry(base.get(name), index.get(name))) {
      paths.push({ path: name, kind: 'tracked', base: base.get(name) ?? null, stashed: stashed.get(name) ?? null, index: index.get(name) ?? null });
    }
  }
  if (untrackedOid) {
    for (const [name, entry] of await tree(cwd, untrackedOid)) {
      if (paths.some(item => item.path === name) || base.has(name) || stashed.has(name) || index.has(name)) throw new Error('Stash contains an ambiguous tracked/untracked path.');
      paths.push({ path: name, kind: 'untracked', base: null, stashed: entry, index: null });
    }
  }
  if (paths.length > MAX_PATHS) throw new Error('Stash exceeds the 1000 changed-path limit.');
  paths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const subject = (await git(cwd, ['show', '-s', '--format=%s', oid])).text.trimEnd();
  return { oid, selector: selected, baseOid, indexOid, ...(untrackedOid ? { untrackedOid } : {}), subject, paths };
}

async function pathState(root, relative) {
  const pieces = relative.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.includes('\\')) || path.isAbsolute(relative)) return { unsupported: true };
  let target = root;
  for (let i = 0; i < pieces.length; i++) {
    target = path.join(target, pieces[i]);
    let stat;
    try { stat = await lstat(target); } catch (error) {
      if (error.code === 'ENOENT') return { absent: true };
      if (error.code === 'ENOTDIR') return { obstruction: true };
      return { unreadable: true };
    }
    if (i < pieces.length - 1) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { obstruction: true };
    } else return { stat, target };
  }
  return { unsupported: true };
}

async function rawEntry(state, format, filemode, indexMode) {
  if (state.absent) return null;
  if (!state.stat || state.stat.isDirectory()) return undefined;
  let bytes;
  let mode;
  if (state.stat.isSymbolicLink()) {
    bytes = Buffer.from(await readlink(state.target));
    mode = '120000';
  } else if (state.stat.isFile()) {
    if (state.stat.size > MAX_FILE) return undefined;
    const handle = await open(state.target, 'r');
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > MAX_FILE) return undefined;
      bytes = Buffer.alloc(current.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used !== current.size) return undefined;
      bytes = bytes.subarray(0, used);
      mode = filemode ? ((current.mode & 0o111) ? '100755' : '100644') : (indexMode === '100755' ? '100755' : '100644');
    } finally { await handle.close(); }
  } else return undefined;
  return { mode, oid: createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
}

async function attributes(cwd, paths) {
  if (!paths.length) return new Set();
  const raw = (await git(cwd, ['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'working-tree-encoding', 'ident'], { input: `${paths.join('\0')}\0` })).text.split('\0');
  if (raw.at(-1) === '') raw.pop();
  if (raw.length !== paths.length * 15) throw new Error('Unexpected Git attributes response.');
  const transformed = new Set();
  for (let i = 0; i < raw.length; i += 3) {
    if (!['unspecified', 'unset'].includes(raw[i + 2])) transformed.add(raw[i]);
  }
  return transformed;
}

async function inspectWorktree(cwd, item, stash) {
  const result = { path: item.path, branch: typeof item.branch === 'string' ? item.branch.replace(/^refs\/heads\//, '') : null, head: item.head ?? null, available: false, findings: [], warnings: [] };
  if (item.bare || item.prunable) {
    result.warnings.push(item.bare ? 'Bare repository: no working directory to inspect.' : 'Git marks this worktree as prunable; inspect its location manually.');
    return result;
  }
  try {
    const root = await lstat(item.path);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Worktree root is missing or is a symlink.');
    const head = (await git(item.path, ['rev-parse', '--verify', 'HEAD'])).text.trim();
    result.head = head;
    const headEntries = await tree(item.path, head);
    const index = parseIndex((await git(item.path, ['ls-files', '-v', '--stage', '-z'])).text);
    const format = (await git(item.path, ['rev-parse', '--show-object-format'])).text.trim();
    if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported Git object format.');
    const autocrlf = await config(item.path, 'core.autocrlf');
    const filemode = await booleanConfig(item.path, 'core.filemode', true);
    const ignorecase = await booleanConfig(item.path, 'core.ignorecase', false);
    const trackedNames = new Set([...headEntries.keys(), ...index.keys()]);
    const transformed = await attributes(item.path, stash.paths.map(entry => entry.path));
    result.available = true;
    if (item.locked) result.warnings.push('Git marks this worktree as locked.');
    for (const entry of stash.paths) {
      const present = headEntries.get(entry.path) ?? null;
      const staged = index.get(entry.path) ?? null;
      const finding = { path: entry.path, kind: entry.kind, status: 'unknown', reason: '', headEntry: present, indexEntry: staged ? { oid: staged.oid, mode: staged.mode } : null };
      const comparedPath = ignorecase ? entry.path.toLowerCase() : entry.path;
      const pathCollision = [...trackedNames].some(name => {
        if (name === entry.path) return false;
        const comparedName = ignorecase ? name.toLowerCase() : name;
        return comparedName === comparedPath || comparedName.startsWith(`${comparedPath}/`) || comparedPath.startsWith(`${comparedName}/`);
      });
      const disk = await pathState(item.path, entry.path);
      const unsupported = [present, staged, entry.base, entry.stashed, entry.index].some(value => value && !['100644', '100755', '120000'].includes(value.mode));
      if (unsupported || staged?.hidden) {
        finding.reason = unsupported ? 'Submodule or unsupported file mode needs manual inspection.' : 'Sparse or assume-unchanged index entry needs manual inspection.';
      } else if (staged?.unmerged) {
        finding.status = 'local-changes'; finding.reason = 'The target index has unresolved merge stages for this path.';
      } else if (!equalEntry(present, staged)) {
        finding.status = 'local-changes'; finding.reason = 'The target index differs from HEAD for this path.';
      } else if (pathCollision) {
        finding.status = 'path-occupied'; finding.reason = 'HEAD or the index tracks an ancestor, descendant, or case-alias of this path.';
      } else if (disk.unsupported || disk.unreadable) {
        finding.reason = 'This path cannot be inspected safely on this filesystem.';
      } else if (disk.obstruction) {
        finding.status = 'path-occupied'; finding.reason = 'A parent path is a file or symlink.';
      } else if (!present && !disk.absent) {
        finding.status = 'path-occupied'; finding.reason = 'An untracked or ignored filesystem entry occupies this path.';
      } else if (present && disk.stat?.isDirectory()) {
        finding.status = 'local-changes'; finding.reason = 'The tracked file has been replaced by a directory.';
      } else if (present && (transformed.has(entry.path) || (autocrlf && autocrlf !== 'false'))) {
        finding.reason = 'Attributes or core.autocrlf can transform bytes; raw content cannot prove a clean checkout.';
      } else {
        let working;
        try { working = await rawEntry(disk, format, filemode, staged?.mode); } catch { working = undefined; }
        if (working === undefined) {
          finding.reason = 'File is unreadable, changed during reading, special, or exceeds 8 MiB.';
        } else if (!equalEntry(working, present)) {
          finding.status = 'local-changes'; finding.reason = 'Working-directory bytes or mode differ from HEAD.';
        } else if (entry.kind === 'untracked') {
          finding.status = present ? 'path-occupied' : 'path-clear';
          finding.reason = present ? 'The stashed untracked path is tracked in this worktree.' : 'The stashed untracked path is absent from this worktree.';
        } else if (equalEntry(entry.base, entry.stashed) && !equalEntry(entry.base, entry.index)) {
          finding.reason = 'The stash preserves staged changes that are absent from its final worktree snapshot; index restoration needs manual review.';
        } else if (equalEntry(present, entry.stashed) && equalEntry(entry.index, entry.stashed)) {
          finding.status = 'already-present'; finding.reason = 'HEAD already matches the stashed final bytes and mode.';
        } else if (equalEntry(present, entry.base)) {
          finding.status = present ? 'base-match' : 'path-clear';
          finding.reason = present ? 'Clean path exactly matches the stash base bytes and mode.' : 'The added path is absent, as it was in the stash base.';
        } else if (equalEntry(present, entry.stashed)) {
          finding.status = 'already-present'; finding.reason = 'HEAD matches final stash bytes; the stash also records a different staged state.';
        } else {
          finding.status = 'diverged'; finding.reason = 'Clean HEAD differs from both the stash base and final bytes or mode.';
        }
      }
      result.findings.push(finding);
    }
    if ((await git(item.path, ['rev-parse', '--verify', 'HEAD'])).text.trim() !== head) {
      result.warnings.push('HEAD changed during inspection; findings are stale.');
      result.findings = result.findings.map(finding => ({ ...finding, status: 'unknown', reason: 'HEAD changed during inspection.' }));
    }
  } catch (error) {
    result.available = false;
    result.findings = [];
    result.warnings.push(error.message);
  }
  return result;
}

export async function inspectRepository({ cwd = process.cwd(), stash = '0' } = {}) {
  const selected = await inspectStash(cwd, stash);
  const entries = parseWorktrees((await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).text);
  if (entries.length > MAX_WORKTREES) throw new Error('Repository exceeds the 32-worktree limit.');
  const worktrees = [];
  for (const entry of entries) worktrees.push(await inspectWorktree(cwd, entry, selected));
  return { version: 1, observedAtUtc: new Date().toISOString(), stash: selected, worktrees, limitations: [...LIMITATIONS] };
}
