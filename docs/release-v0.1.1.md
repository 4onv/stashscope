# StashScope v0.1.1

The synthetic demo now consistently labels its generated worktrees as `<demo>/main`,
`<demo>/dirty` and `<demo>/diverged` on Windows and macOS. Version 0.1.0 could show an
absolute temporary path on Windows or `/private<demo>/main` on macOS because Git and
Node reported different forms of the same directory.

This patch fixes demo path handling and adds regression coverage for those aliases.
The read-only stash inspection engine and its findings are unchanged.

Requires Node.js 22+ and Git 2.45+:

```sh
npm install --global https://github.com/4onv/stashscope/releases/download/v0.1.1/4onv-stashscope-0.1.1.tgz
stashscope demo
```

The v0.1.0 release remains available unchanged. Packages are distributed through
GitHub releases, not npm. Inspection provides evidence for manual review; it does
not simulate a stash application or establish ownership.
