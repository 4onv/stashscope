# StashScope

**Which worktree fits this stash? Inspect the evidence before restoring it.**

[![CI](https://github.com/4onv/stashscope/actions/workflows/ci.yml/badge.svg)](https://github.com/4onv/stashscope/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Git worktrees share a stash stack. StashScope resolves a stash to its commit ID,
then compares its tracked, staged and untracked paths against every linked worktree.
See unchanged bases, divergent destinations, local edits and occupied paths in one report.

```text
SYNTHETIC DEMO — generated Git history and worktrees

main        config.txt  base-match      draft.txt  path-clear
diverged    config.txt  diverged        draft.txt  path-clear
dirty       config.txt  local-changes   draft.txt  path-occupied
```

The table above condenses the runnable demo. Findings are evidence for review;
StashScope does not simulate `git stash apply`, establish stash ownership, or restore files.

## Try it

Requires **Node.js 22+ and Git 2.45+**. No runtime dependencies, account, API key or network calls during inspection.

```sh
npm install --global https://github.com/4onv/stashscope/releases/download/v0.1.0/4onv-stashscope-0.1.0.tgz
stashscope demo
```

The demo creates three temporary worktrees, runs the actual inspector, then removes its
generated repository. Your current repository is not involved. The package is distributed
through GitHub releases; it is not published to npm.

Or run directly from source:

```sh
git clone https://github.com/4onv/stashscope.git
cd stashscope
node bin/stashscope.mjs demo
```

## Inspect your stash

```sh
stashscope list --repo /path/to/project
stashscope inspect --repo /path/to/project --stash 0
stashscope inspect --repo /path/to/project --stash 0 --json
```

`--repo` defaults to the current directory. `--stash` defaults to the newest stash.
Use the full commit ID printed by `list` to keep inspecting the same stash after another
worktree pushes onto the shared stack. A numeric selector is resolved once per inspection.

| Finding | Evidence |
| --- | --- |
| `base-match` | The affected destination path matches the stash's original base. |
| `path-clear` | A new stashed path is absent at this destination. |
| `already-present` | The destination already matches the stashed version. |
| `diverged` | The committed destination differs from both the base and stashed version. |
| `local-changes` | Local index or working-file changes affect this path. |
| `path-occupied` | An existing file, directory or parent obstruction occupies a new path. |
| `unknown` | Unsupported or incomplete evidence needs manual review. |

Even a base match is not permission to restore: Git may reject the whole operation for
other reasons, and a compatible stash may belong to another task. The report includes the
resolved stash ID and per-path explanations. It does not include file contents, but it does
contain local paths and stash messages; inspect those before sharing a report.

Successful inventory commands exit **0**, including findings that need review.
Invalid input or a failed inspection exits **2**. JSON output is suitable for local tools;
do not treat exit 0 as an automated restore gate.

## Use the API

```js
import { inspectRepository, listStashes } from '@4onv/stashscope';

const stashes = await listStashes({ cwd: '/path/to/project' });
if (stashes.length) {
  const report = await inspectRepository({ cwd: '/path/to/project', stash: stashes[0].oid });
  console.log(report.worktrees);
}
```

## Scope and limits

- Inspection leaves refs, indexes and working files in place. It does not run stash mutation
  commands or external clean/text conversion filters.
- This is a bounded snapshot, not an atomic capture while agents keep writing. Pause writers
  and inspect again before making a recovery decision.
- Exact blob and mode comparisons deliberately do not predict textual merges. A divergent
  path might merge cleanly. Staged-only differences are included for review.
- Sparse checkouts, special index states, submodules and file transformations may produce
  `unknown`. Conservative findings are preferable to an invented all-clear.
- The first version targets ordinary local Git repositories. See [the inspection model](docs/model.md)
  for limits and status precedence.

## Why this exists

Worktrunk's [November 3 fix for failed stash transfers](https://github.com/max-sixty/worktrunk/pull/4678)
and [reports of agents exchanging shared stashes](https://github.com/objectstack-ai/objectstack/issues/5742)
show why inspecting a stash's identity and destination matters. StashScope complements
worktree managers and stash browsers with a read-only comparison across linked worktrees.
See the [dated research and alternatives](docs/research-2026-11-03.md).

## Development

```sh
npm test
npm run test:package
```

Tests create real temporary Git repositories. CI exercises Node 22/24 on Linux, Windows
and macOS, including offline installation of the packed CLI and its runnable demo.
See [contributing](CONTRIBUTING.md). MIT licensed.
