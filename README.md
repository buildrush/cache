# buildrush/cache

> Drop-in replacement for `actions/cache@v5` backed by [Build_Rush](https://buildrush.io).

Same inputs. Same outputs. Faster cache.

## Quickstart

Replace this:

```yaml
- uses: actions/cache@v5
  with:
    key: ${{ runner.os }}-deps-${{ hashFiles('**/package-lock.json') }}
    path: node_modules
```

With this:

```yaml
jobs:
  build:
    permissions:
      id-token: write    # required — Build_Rush mints an OIDC token to authenticate
      contents: read
    steps:
      - uses: buildrush/cache@v1
        with:
          key: ${{ runner.os }}-deps-${{ hashFiles('**/package-lock.json') }}
          path: node_modules
```

Sign up at [buildrush.io](https://buildrush.io) and enable cache for your installation.

## Split usage

If you already use `actions/cache/restore` and `actions/cache/save` separately
(for explicit save-on-success or save-from-failure workflows), the Build_Rush
analogues are drop-in too:

```yaml
- id: cache-restore
  uses: buildrush/cache/restore@v1
  with:
    key: ${{ runner.os }}-deps-${{ hashFiles('**/package-lock.json') }}
    path: node_modules

# ...build steps...

- uses: buildrush/cache/save@v1
  if: always() && steps.cache-restore.outputs.cache-hit != 'true'
  with:
    key: ${{ runner.os }}-deps-${{ hashFiles('**/package-lock.json') }}
    path: node_modules
```

Both split actions need `permissions: id-token: write` on the job (same as the
combined action).

## Compatibility

Drop-in surface-compatible with `actions/cache@v5`: identical input names
(`key`, `path`, `restore-keys`, `enableCrossOsArchive`, `fail-on-cache-miss`,
`lookup-only`, `upload-chunk-size`) and outputs (`cache-hit`, plus
`cache-primary-key` and `cache-matched-key` on the split restore action).

The upstream-deprecated `save-always` input is intentionally omitted — prefer
the split restore/save flow shown above. Build_Rush adds the BR-specific
`audience`, `fallback`, and `buildrush-reason` extensions described below.

## Inputs

| Input                  | Required | Default                       | Notes                                                                       |
| ---------------------- | -------- | ----------------------------- | --------------------------------------------------------------------------- |
| `key`                  | yes      | —                             | Primary cache key.                                                          |
| `path`                 | yes      | —                             | Files, directories, and wildcard patterns to cache and restore.             |
| `restore-keys`         | no       | —                             | Ordered prefix-matched keys for stale-cache fallback. `cache-hit` stays `false` on a partial match. |
| `enableCrossOsArchive` | no       | `false`                       | Allow Windows runners to save/restore caches that other platforms can read. |
| `fail-on-cache-miss`   | no       | `false`                       | Fail the step if the primary key isn't found.                               |
| `lookup-only`          | no       | `false`                       | Check whether an entry exists without downloading it.                       |
| `upload-chunk-size`    | no       | `33554432` (32 MiB)           | Bytes per chunk. Applies when the cache service returns a resumable session URI (typically for archives >128 MiB). |
| **`fallback`**         | no       | `github`                      | Build_Rush-specific. See "Fallback behavior" below.                          |
| **`audience`**         | no       | `https://cache.buildrush.io`  | Build_Rush-specific. OIDC audience to mint. Override only for non-production cache services. |

## Outputs

| Output             | Description                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `cache-hit`        | `"true"` if an exact match for the primary key was found, otherwise `"false"`.             |
| `buildrush-reason` | Reason code if a fallback was applied, empty string on success. See "Reason codes" below.  |

### Inputs and outputs — `buildrush/cache/restore@v1`

Restore only. Same input names as `actions/cache/restore@v5` plus the two
Build_Rush-specific inputs.

| Input                  | Required | Default                       | Notes                                |
| ---------------------- | -------- | ----------------------------- | ------------------------------------ |
| `key`                  | yes      | —                             | Primary key.                         |
| `path`                 | yes      | —                             | Files / directories / patterns.      |
| `restore-keys`         | no       | —                             | Ordered fallback keys.               |
| `enableCrossOsArchive` | no       | `false`                       | Cross-OS restore.                    |
| `fail-on-cache-miss`   | no       | `false`                       | Fail the step if no key matched.     |
| `lookup-only`          | no       | `false`                       | Check existence without downloading. |
| `fallback`             | no       | `github`                      | Build_Rush-specific.                  |
| `audience`             | no       | `https://cache.buildrush.io`  | Build_Rush-specific.                  |

| Output              | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `cache-hit`         | `"true"` if exact `key` matched, else `"false"`.                         |
| `cache-primary-key` | Echo of the input `key`.                                                 |
| `cache-matched-key` | Matched key (empty string on miss).                                      |
| `buildrush-reason`  | Reason code if fallback was applied, empty string on success.            |

### Inputs and outputs — `buildrush/cache/save@v1`

Save only. Same input names as `actions/cache/save@v5` plus the two
Build_Rush-specific inputs.

| Input                  | Required | Default                       | Notes                            |
| ---------------------- | -------- | ----------------------------- | -------------------------------- |
| `key`                  | yes      | —                             | Primary key.                     |
| `path`                 | yes      | —                             | Files / directories / patterns.  |
| `enableCrossOsArchive` | no       | `false`                       | Cross-OS save.                   |
| `upload-chunk-size`    | no       | `33554432` (32 MiB)           | Bytes per chunk.                 |
| `fallback`             | no       | `github`                      | Build_Rush-specific.              |
| `audience`             | no       | `https://cache.buildrush.io`  | Build_Rush-specific.              |

| Output             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `buildrush-reason` | Reason code if fallback was applied, empty string on success.            |

## Fallback behavior

If the Build_Rush cache service is unreachable, the `fallback` input chooses how
to respond:

- **`github`** (default) — emit a warning annotation and continue without a
  cached step. Subsequent steps see the action as a miss.
  - Annotation: `::warning::Build_Rush Cache unavailable — falling back to GitHub cache (reason: <code>)`
- **`skip`** — disable caching entirely for this step by exporting
  `ACTIONS_CACHE_DISABLED=true`. Other cache-aware actions later in the job will
  also no-op.
  - Annotation: `::warning::Build_Rush Cache unavailable — caching skipped for this step (reason: <code>)`
- **`fail`** — fail the workflow step.
  - Annotation: `::error::Build_Rush Cache unavailable — failing step (reason: <code>)`

On success you'll see: `::notice::Using Build_Rush cache`.

## Reason codes

When a fallback is applied, the annotation (and the `buildrush-reason` output)
contains one of these codes:

| Code                       | What it means                                                                  | What to do                                                              |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `oidc-mint-failed`         | Workflow lacks `permissions: id-token: write`.                                 | Add the permission to your workflow YAML.                               |
| `network-error`            | Couldn't reach `cache.buildrush.io`.                                           | Usually transient.                                                      |
| `oidc-rejected`            | Build_Rush rejected the OIDC token (signature/audience/issuer/expiry).          | Open a support ticket — this should not happen in normal operation.     |
| `installation-not-enabled` | Cache is not enabled for your installation.                                    | Enable cache for your installation in the Build_Rush dashboard.          |
| `rate-limited`             | Too many requests.                                                             | Back off; open a ticket if persistent.                                  |
| `service-unavailable`      | Build_Rush cache service is having a bad day.                                   | Check [status.buildrush.io](https://status.buildrush.io).               |

## Troubleshooting

- **Always seeing `oidc-mint-failed`?** Your workflow is missing `permissions: id-token: write`. Add it at workflow or job level.
- **Always seeing `installation-not-enabled`?** Visit the [Build_Rush dashboard](https://buildrush.io) and confirm cache is enabled for your installation.
- **Always seeing `oidc-rejected`?** The audience or issuer doesn't match what we expect. Don't override `BUILDRUSH_CACHE_URL` — it's intended for self-tests only.

## Versioning

We use SemVer with our own version numbers (not mirroring upstream
`actions/cache`).

- **`@v1`** (floating) — recommended pinning. Auto-updates within `v1.x.y`.
- **`@v1.0.0`** (immutable) — pin if you need byte-for-byte stability.
- **No `@main` or `@latest`** — both are unsupported.

A new major arrives only on a documented breaking change. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full bump-rules contract.

## How it works

This is a first-party Node 24 action that implements the Build_Rush cache
protocol directly — there's no runtime dependency on `@actions/cache` and no
vendor object-store SDK in the upload/download path. All blob I/O uses standard
HTTP (`PUT`, `GET`, `Content-Range`, `Range`).

Three entry points share one auth implementation and one archive pipeline:

1. **`buildrush/cache@v1`** (combined) — Node action with restore as the `main`
   step and save as the `post` step.
2. **`buildrush/cache/restore@v1`** (split) — restore only.
3. **`buildrush/cache/save@v1`** (split) — save only.

The action mints a GitHub OIDC token, exchanges it at
`POST cache.buildrush.io/api/cache/auth/exchange` for a Build_Rush-issued cache
JWT, then makes REST calls (`/api/cache/entries`, `/api/cache/entries/lookup`,
`/api/cache/entries/finalize`) using that JWT. Archives are tar + zstd via the
`tar` npm package and Node 24's built-in `node:zlib` zstd.

Source lives in `src/auth/`, `src/client/`, `src/archive/`, `src/transport/`,
and `src/retry/`. The action entry points are `restore/src/main.ts` and
`save/src/main.ts`. Bundled outputs at `dist/restore/index.js` and
`dist/save/index.js`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
