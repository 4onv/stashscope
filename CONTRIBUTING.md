# Contributing

Use Node.js 22+ and Git 2.45+, then run `npm test` and `npm run test:package`.
There are no runtime dependencies. Tests create synthetic, temporary Git repositories.

Please include a minimal reproducer for new Git layouts or incorrect findings.
Remove private filenames and stash messages before sharing reports. Add a regression
test that checks observed behavior and preserves the original repository state.

Keep inspection read-only. If evidence is incomplete, report `unknown` with a reason.
Do not replace uncertainty with a promise that applying a stash will succeed.
