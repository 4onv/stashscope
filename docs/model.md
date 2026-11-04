# Inspection model

StashScope records evidence for a manual recovery decision. It never selects a destination,
applies a stash, writes an index, or changes refs. The bundled `demo` separately creates and
removes only its own generated temporary repository.

## What gets compared

1. Resolve a numeric selector or full commit ID once. Validate the two- or three-parent
   stash shape and its index parent relationship.
2. Read the base, saved working tree and saved index trees. Include a tracked path whenever
   either saved tree differs from the base. Include third-parent untracked entries separately.
   Renames are naturally represented as deleted and added paths; no similarity guesses are made.
3. Enumerate linked worktrees using Git's NUL-delimited porcelain format. Read each HEAD
   and index, retaining unresolved stages and special index flags.
4. Inspect affected filesystem paths. Check parent components for obstructions, including
   symlinks, and check existing untracked/ignored entries. Hash ordinary files using Git's
   blob framing; compare object IDs and modes with HEAD/index.
5. Emit exact evidence or a conservative reason for review. A changed HEAD during the
   inspection invalidates that worktree's findings.

Paths and metadata must decode as UTF-8; unusual unsupported Git records fail explicitly.
There is no network lookup and no external diff, clean filter, text converter or filesystem
monitor invocation. Inherited `GIT_*` settings are removed so another command's repository
selection does not redirect inspection. Git optional locks and lazy object fetching are disabled.
Git 2.45+ is required; the global `--no-lazy-fetch` option makes older Git fail closed.
Case aliases use `core.ignorecase` and lowercase comparison; this is not a complete model
of every filesystem's Unicode normalization rules.

## Why a result may be unknown

Raw bytes cannot reliably prove a checkout clean when attributes or `core.autocrlf`
transform them. Sparse or assume-unchanged index entries, submodules, unsupported paths,
large/unreadable files and differing saved index/final states need manual review. Staged
restoration (`git stash apply --index`) has additional semantics beyond this inventory.

Local index changes, local file edits and occupied paths take priority over exact base
matches where they can be established. StashScope does not compare unchanged unrelated
paths or evaluate every repository-wide reason a restore could fail. A reported path-clear
does not imply that a whole stash can be applied.

Read-only inspection still has concurrency limits: refs, indexes, attributes or files can
change between reads. Files and refs are not locked. Pause writers before relying on a report.
Only inspect repositories and local configuration you trust; this utility is not a sandbox.

## Bounds

| Resource | Limit |
| --- | --- |
| Changed paths in a stash | 1,000 |
| Linked worktrees | 32 |
| Entries returned by `list` | 100; inspect an older full SHA directly |
| Output from each Git command | 8 MiB |
| Ordinary file content read | 8 MiB per affected file |
| Each Git command | 10 seconds |

Limits are explicit errors or unknown findings. A failed/unavailable worktree stays in the
report with warnings; it is not silently treated as an empty clean destination.

## API and output

`listStashes({cwd})` returns records with `selector`, `oid`, `subject`, and `date`.
`inspectRepository({cwd, stash})` returns a version-1 report with:

- `observedAtUtc`: time the inspection finished.
- `stash`: resolved IDs, subject, selector and affected paths with base/stashed/index entries.
- `worktrees`: path, branch, observed HEAD, availability, findings and warnings. Each finding
  includes the destination `headEntry` and `indexEntry` object ID/mode evidence.
- `limitations`: concise reminders of the inspection boundary.

Finding statuses are documented in the README. JSON contains file paths and stash subjects,
but not file contents. The text renderer quotes names and messages to escape control characters.
Inventory success exits 0 even with warnings; error exits 2. Neither is a restore approval.
