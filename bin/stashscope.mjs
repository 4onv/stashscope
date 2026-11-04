#!/usr/bin/env node
import { inspectRepository, listStashes } from '../src/inspect.mjs';
import { runDemo } from '../src/demo.mjs';

const help = `StashScope — inspect a stash across linked worktrees

Usage:
  stashscope list [--repo PATH] [--json]
  stashscope inspect [--repo PATH] [--stash INDEX_OR_FULL_SHA] [--json]
  stashscope demo [--json]

Requires Node.js 22+ and Git 2.45+. Inspection does not apply or drop a stash.
Exit 0: completed inventory (findings may need review). Exit 2: invalid input/error.
The demo creates and removes its own temporary synthetic repository.
`;

// JSON quoting keeps filenames, branch names and errors from controlling a terminal.
const quote = value => JSON.stringify(String(value));
function render(report) {
  const lines = report.synthetic ? ['SYNTHETIC DEMO — generated Git history and worktrees', ''] : [];
  lines.push(`Stash ${report.stash.oid}`, `  ${quote(report.stash.subject ?? report.stash.selector)}`, '');
  for (const tree of report.worktrees) {
    lines.push(`${quote(tree.branch || '(detached)')}  ${quote(tree.path)}`);
    if (!tree.available) lines.push('  unavailable — review this worktree separately');
    for (const finding of tree.findings ?? []) {
      lines.push(`  ${finding.status.padEnd(17)} ${quote(finding.path)} (${finding.kind})`);
      if (finding.reason) lines.push(`    ${quote(finding.reason)}`);
    }
    for (const warning of tree.warnings ?? []) lines.push(`  note: ${quote(warning)}`);
    lines.push('');
  }
  lines.push('Evidence for review; this does not simulate git stash apply or prove ownership.');
  return lines.join('\n');
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    if (args.length > 1) throw new Error('Unexpected arguments after --help.');
    console.log(help);
  } else if (args[0] === '--version') {
    if (args.length > 1) throw new Error('Unexpected arguments after --version.');
    console.log('0.1.1');
  } else {
    const command = args.shift();
    if (!['list', 'inspect', 'demo'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const options = { cwd: process.cwd(), stash: '0' };
    let json = false;
    const seen = new Set();
    while (args.length) {
      const flag = args.shift();
      if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
      seen.add(flag);
      if (flag === '--json') { json = true; continue; }
      if (!['--repo', '--stash'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
      if (command === 'demo' || (command === 'list' && flag === '--stash')) throw new Error(`${flag} is not supported by ${command}.`);
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      options[flag === '--repo' ? 'cwd' : 'stash'] = value;
    }
    if (command === 'list') {
      const stashes = await listStashes(options);
      console.log(json ? JSON.stringify({ version: 1, stashes }, null, 2) :
        stashes.length ? stashes.map(s => `${quote(s.selector)}  ${s.oid}\n  ${quote(s.subject)}`).join('\n') : 'No stashes found.');
    } else {
      const report = command === 'demo' ? await runDemo() : await inspectRepository(options);
      console.log(json ? JSON.stringify(report, null, 2) : render(report));
    }
  }
} catch (error) {
  console.error(`stashscope: ${quote(error.message ?? error)}`);
  process.exitCode = 2;
}
