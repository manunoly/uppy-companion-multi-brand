# Vendored: auth-verify

Copied verbatim from abeduls3. **Do not edit any `.ts` file in this directory.**

| | |
|---|---|
| Upstream repo | `git@github.com:manunoly/abeduls3.git` |
| Upstream path | `packages/auth-verify/src/` |
| Synced at commit | `708c52cca8bef241fd3decc491053182a23a8cad` |
| Synced on | `2026-09-11` |
| Validated against | `better-auth@1.7.2` (upstream's `tests/betterAuthConformance.test.ts` at that commit) |
| Runtime dependency | `jose@^6.2.10` |

## Re-sync

```bash
cp <abeduls3>/packages/auth-verify/src/*.ts src/vendor/auth-verify/
(cd src/vendor/auth-verify && sha256sum $(ls *.ts | grep -v '\.test\.ts$') > MANIFEST.sha256)
```

Then update the table above and run `pnpm test src/vendor`.

## Verify this copy is current

```bash
diff -r <abeduls3>/packages/auth-verify/src src/vendor/auth-verify
```

No output on the `.ts` files means in sync.

## Why you must not edit these files

A fix made here is overwritten by the next sync and, until then, silently diverges this
service's authentication from every other service in the fleet — one accepting what another
rejects, with no error anywhere. Fix it in abeduls3 first, then re-sync.

`better-auth` is the thing that actually drifts: a version bump in `auth-service` can change
the cookie's wire format. Upstream's conformance test diffs this code against
`better-auth/cookies`' own `getCookieCache`, so such a change fails there first.
