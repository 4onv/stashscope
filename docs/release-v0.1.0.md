# StashScope v0.1.0

Inspect one Git stash across every linked worktree before choosing a recovery destination.

- Stable stash commit IDs plus tracked, saved-index and untracked path coverage.
- Per-worktree base matches, divergences, local changes and path occupancy evidence.
- Read-only CLI and JavaScript API, with conservative unknown findings for unsupported states.
- A one-command, clearly labeled synthetic demonstration using real Git repositories.
- No runtime dependencies. Install the attached archive with Node.js 22+ and Git 2.45+.

```sh
npm install --global https://github.com/4onv/stashscope/releases/download/v0.1.0/4onv-stashscope-0.1.0.tgz
stashscope demo
```

This inventory does not predict successful stash application or determine ownership.
Pause concurrent writers before making recovery decisions. See the README and inspection
model for supported states and bounds. The archive is distributed on GitHub, not npm.
