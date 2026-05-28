# Contributing to buildrush/cache

Thanks for contributing! This action is a drop-in replacement for `actions/cache@v5`, implemented as a first-party Node 24 action that talks to the Build_Rush cache REST surface directly. The repo is intentionally small.

## Quickstart

```bash
git clone git@github.com:buildrush/cache.git
cd cache
npm install
npm test
```

## Project structure

Three entry points, all `using: node24`:

- Root `action.yml` — combined drop-in for `actions/cache@v5`. Node action with `main: dist/restore/index.js` (restore step) and `post: dist/save/index.js` (save step).
- `restore/action.yml` — split drop-in for `actions/cache/restore@v5`. Node action with `main: ../dist/restore/index.js`. The `..` is required because GitHub resolves `main` relative to the sub-action's own directory (this is the same pattern upstream `actions/cache@v5/restore/action.yml` uses).
- `save/action.yml` — split drop-in for `actions/cache/save@v5`. Node action with `main: ../dist/save/index.js` (same `..` rationale).

Shared TypeScript lives under `src/` (auth, REST client, archive pipeline, transport, retry). The action entry points are `restore/src/main.ts` and `save/src/main.ts`. Bundled outputs go to `dist/restore/index.js` and `dist/save/index.js`. Workflows in `.github/workflows/`.

## Branch naming

Match Linear's `gitBranchName`: `feature/br-<ticket>-<slug>`.

## Commit and PR conventions

We squash-merge. The **PR title** becomes the merge commit message and is what `release-please` reads. Individual commits inside a PR are not parsed.

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The PR-title linter in `ci.yml` enforces this.

| PR title prefix | Resulting bump            |
| --------------- | ------------------------- |
| `feat!:` or footer `BREAKING CHANGE:` | major (`v1` → `v2`)  |
| `feat:`         | minor                     |
| `fix:`, `fix(deps):` | patch                |
| `chore:`, `chore(deps):`, `docs:`, `refactor:`, `test:`, `ci:`, `build:` | no release |

## Bump table — the breaking-change contract

Use this to decide which prefix your PR needs.

| Change                                                                       | Prefix       |
| ---------------------------------------------------------------------------- | ------------ |
| Rename/remove input, reason code, fallback mode, or annotation prefix        | `feat!:`     |
| Change input default in a behavior-affecting way                             | `feat!:`     |
| Upstream `actions/cache` major bump                                          | `feat!:`     |
| Add input / reason code / fallback mode                                      | `feat:`      |
| Upstream `actions/cache` minor/patch bump                                    | `feat:`      |
| Bug fix, no surface change                                                   | `fix:`       |
| Runtime dependency bump                                                      | `fix(deps):` |
| Annotation wording polish (prefix preserved)                                 | `fix:`       |
| Dev dependency / tooling                                                     | `chore(deps):` |
| Docs only                                                                    | `docs:`      |

## `dist/` policy

**Don't commit `dist/` on source PRs.** Our `release-prep.yml` workflow rebuilds the `dist/` tree on the `release-please` PR branch in a clean CI environment. Committing dist on a source PR creates noise but won't break anything — the next release-prep run overwrites it.

If you need to invoke `buildrush/cache@your-feature-branch` from a workflow elsewhere for manual testing, run `npm run build` locally and stage a one-off dist commit on your branch. Drop the commit before merging.

## Local testing

- **Unit tests:** `npm test` (Vitest)
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run lint`
- **Build:** `npm run build` (produces `dist/restore/index.js` and `dist/save/index.js`)
- **End-to-end:** push your feature branch — `self-test.yml` runs the full job matrix against the staging endpoint (real round-trip read/write on the combined and split actions, plus the force-status fallback jobs)

## Release process

1. Land your PR with a conventional-commit title.
2. `release-please` updates the open release PR (`chore: release X.Y.Z`) with the version bump and CHANGELOG entry.
3. `release-prep` rebuilds the `dist/` tree on the release PR branch automatically.
4. When ready to ship, **a human merges the release PR.** We do not auto-merge.
5. On merge: `release-please` cuts the immutable tag (`v1.0.1`) and force-updates the floating major tag (`v1`).
6. No marketplace publish in v1 — that's deferred to GA (BR-726).

## Code style

- TypeScript strict mode. No `any` without a comment explaining why.
- `eslint` flat config in `eslint.config.mjs`. Run `npm run lint` before pushing.
- One responsibility per file. If `main.ts` grows past ~80 lines, extract.
- Don't leak the OIDC token or the runtime token to logs — ever. Audit every `core.warning` / `core.error` / `core.notice` call.
- Imports use explicit `.js` extensions (e.g. `from "./types.js"`) — the project uses `moduleResolution: bundler` with strict ESM-style imports.

## What NOT to change without coordination

- The 6 reason-code strings (`oidc-mint-failed`, `network-error`, `oidc-rejected`, `installation-not-enabled`, `rate-limited`, `service-unavailable`) — operators may grep for them.
- The annotation prefix `Build_Rush Cache unavailable —` — same reason.
- The default `fallback: github` — changing it is a `feat!:`.
- The `cache.buildrush.io` audience string — coordinate with BR-713 owner.
