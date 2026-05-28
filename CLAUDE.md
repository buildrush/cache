# CLAUDE.md — Project context for Claude Code

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.


## What this repo is

`buildrush/cache@v1` — a TypeScript composite GitHub Action that drops in for `actions/cache@v5` and routes through the Build_Rush cache service. See [README.md](README.md) for the user-facing description.

## Canonical references — read first

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — commit conventions, bump table, `dist/` policy, code style, what NOT to change without coordination. The authoritative source for working in this repo.

### Local-only working docs (not in the remote)

`docs/superpowers/` is **gitignored** — it exists only in the maintainer's local clone and is not committed. Treat anything you find there as in-progress / historical context, not as a public contract.

If `docs/superpowers/` exists in this clone, you may consult:
- `docs/superpowers/specs/` — design specs.
- `docs/superpowers/plans/` — implementation plans.
- `docs/superpowers/repo-settings-checklist.md` — one-time GitHub settings.

If it doesn't exist (e.g. a fresh clone by another contributor), there is no remote substitute — work from the committed sources (this file, [CONTRIBUTING.md](CONTRIBUTING.md), the code) alone.

## Workflow rules

These override default Claude Code behavior. Apply them on every session.

### Commit and PR messages

- **Never add AI-attribution trailers.** No `Co-Authored-By: Claude`, no `🤖 Generated with Claude Code`, no equivalent. Commits and PR descriptions attribute to the human author only.
- **Conventional Commits on PR titles** — squash-merge means the PR title becomes the merge commit message. See the bump table in [CONTRIBUTING.md](CONTRIBUTING.md#bump-table--the-breaking-change-contract).
- **Linear history only.** No merge commits anywhere — neither locally (use `rebase`, not `merge`) nor in the GitHub merge strategy (repo is configured for squash-merge only).

### Local commit flow during development

Intermediate commits are temporary and disposable. **Don't GPG-sign them** — it interrupts flow with pinentry prompts.

Skip signing per-commit:
```bash
git commit --no-gpg-sign -m "wip: ..."
```

Or disable signing for the local repo while iterating:
```bash
git config commit.gpgsign false
```

### Before pushing — required sequence

1. **Squash intermediates into one commit via soft reset.** This collapses N local commits into one staged change, which is much easier to rebase cleanly.
   ```bash
   git reset --soft $(git merge-base HEAD origin/<target>)
   git commit -S -m "<conventional-commit title>"
   ```
   `-S` signs the commit. If GPG signing is not configured on this machine, omit `-S` and flag to the user that the commit is unsigned.

2. **Rebase onto the latest target branch.** No merges. The branch must be up to date with the target before push.
   ```bash
   git fetch origin
   git rebase origin/<target>
   ```
   Resolve conflicts. If the squash in step 1 produced a single commit, you have at most one set of conflicts.

3. **Push.** Use `--force-with-lease` (not `--force`) since the rebase rewrote history.
   ```bash
   git push --force-with-lease
   ```

### When signing isn't available

If GPG is not configured on the local machine, push unsigned and explicitly tell the user. Do not block work, do not silently skip — the user needs to know which commits are unsigned.

## Code conventions specific to this repo

(Full details in [CONTRIBUTING.md](CONTRIBUTING.md). Highlights that trip up new sessions:)

- **TypeScript imports use `.js` extensions** (`from "./types.js"`). The project uses `moduleResolution: bundler` — `.ts` extensions or extensionless imports may pass `tsc` but break in stricter resolvers.
- **ESLint flat config** (`eslint.config.mjs`) is a raw array export — no `tseslint.config()` wrapper.
- **`auth/dist/` is bot-managed** on release-please PR branches. Do not commit it on source PRs. See [CONTRIBUTING.md](CONTRIBUTING.md#dist-policy).
- Tests: `npm test`. Typecheck: `npm run typecheck`. Lint: `npm run lint`. Build: `npm run build`.

## What to never change without coordination

Surface that operators or BR-713 depend on. See the full list in [CONTRIBUTING.md](CONTRIBUTING.md#what-not-to-change-without-coordination):

- The 6 reason-code strings
- The annotation prefix `Build_Rush Cache unavailable —`
- The default `fallback: github`
- The `cache.buildrush.io` audience string
