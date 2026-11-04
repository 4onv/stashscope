# Try the synthetic scenario

```sh
node bin/stashscope.mjs demo
node bin/stashscope.mjs demo --json
```

The demo generates an isolated temporary Git repository with three linked
worktrees, then runs the same inspection used for your repositories. All files,
branches, commits and stash messages in this scenario are **synthetic**.

The stash changes `config.txt` from port 3000 to port 4000 and saves an
untracked `draft.txt`. The report compares it with:

| Worktree | `config.txt` | `draft.txt` |
| --- | --- | --- |
| `main` | Still matches the stash base | Path is clear |
| `diverged` | Another commit changed the port to 5000 | Path is clear |
| `dirty` | Uncommitted local edit changed the port to 6000 | A local file already occupies the path |

StashScope reports these observations without applying the stash. A base match
does not prove a future stash application will succeed. It does not infer which
worktree originally created the stash.

The temporary repository is removed after inspection. Report paths use the
placeholder `<demo>`; they are illustrations, not paths to inspect afterward.
Your current working directory is not used for the demo's Git operations.
