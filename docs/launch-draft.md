# Launch draft — not posted externally

Git worktrees share a stash stack. If several agents or developers use them at once,
`stash@{0}` may refer to different work by the time you inspect it again.

StashScope resolves the stash to a commit ID and shows how its affected paths compare with
every linked worktree: unchanged base, divergent commit, local edit, or occupied new path.
It includes saved untracked files and exposes uncertain cases instead of claiming restore safety.

Try the synthetic demo with Node.js 22+ and Git 2.45+:

```sh
npm install --global https://github.com/4onv/stashscope/releases/download/v0.1.1/4onv-stashscope-0.1.1.tgz
stashscope demo
```

Source: https://github.com/4onv/stashscope

Feedback most useful for the next release: real repository layouts where an unknown finding
could be made more precise without running filters or changing the index. Remove private
filenames and stash messages from any shared example.
