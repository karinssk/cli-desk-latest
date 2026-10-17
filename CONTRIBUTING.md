# Contributing to CliDeck

This document explains what we accept, what needs discussion first, and how to structure a PR so it gets reviewed fast.

## What to contribute

**Bug fixes and small improvements** — open a PR directly.
Crashes, rendering glitches, typos, broken links, edge cases, performance fixes.

**New features, architecture changes, or new agent presets** — [open an issue](https://github.com/karinssk/cli-desk-latest/issues) first.
Describe the problem, your proposed approach, and any trade-offs. If the idea gets a thumbs up, then open a PR.

**Plugins** — the best way to contribute new functionality.
CliDeck has a plugin system so features can be added without touching core code. See the bundled examples in `plugins/` and the API in `plugin-loader.js`.

## What we will reject

- PRs that change multiple unrelated things. One change per PR.
- PRs with no description of what changed or why.
- Formatting-only changes (whitespace, semicolons, reordering imports).
- Features that add external service dependencies or phone home.
- Changes that expose local prompts, transcripts, or credentials to external services without authorization.

## Before you open a PR

1. **Test locally.** Run `npm test`, then `node server.js`, open `http://localhost:4000`, and verify your change works.
2. **Keep it focused.** If you found a bug while working on a feature, that's two PRs.
3. **Match the existing style.** No linter is enforced, but stay consistent with surrounding code.
4. **Don't bundle dependency changes** unless your PR specifically requires them.

## PR structure

Fill out the PR template. The key fields:

- **What changed** — one or two sentences.
- **Why** — the problem this solves.
- **How to verify** — steps to confirm it works.
- **What's out of scope** — what you intentionally did not change.

Small PRs get reviewed faster. If your diff is over 300 lines, consider splitting it.

## Licensing of contributions

By submitting a contribution that is accepted into the repository, you agree
that it will be licensed under the MIT License.

## Conduct

Be constructive. Review comments are about the code, not the person. If a PR is rejected, the reason will be explained.
