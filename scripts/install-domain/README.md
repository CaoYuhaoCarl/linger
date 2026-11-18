# Publish the Linger shell download endpoints

`heylinger.com/install.sh` serves the archived Simplex installer for
compatibility. Use the [current Linger install guide](https://docs.heylinger.com/install/desktop-app)
for new desktop installations. `heylinger.com/stack.sh` serves the standalone
local model stack. Both endpoints stream the existing stable CDN objects
without changing their bytes. They do not publish or pin a new version.

## Verify before deploying

From the repository root, run the tests and bundle the Worker:

```sh
pnpm vitest run scripts/install-domain.test.ts
bundle_dir=$(mktemp -d)
pnpm dlx wrangler@4.164.0 deploy --dry-run \
  --config scripts/install-domain/wrangler.toml --outdir "$bundle_dir"
```

Before an approved deployment, verify that the account owns the
`heylinger.com` Cloudflare zone and that the apex has no conflicting DNS record
or route. Wrangler attaches the Worker as the apex Custom Domain. The Worker
returns 404 for paths other than `/install.sh` and `/stack.sh`. The deployment
does not change `simplexai.com` or any `heylinger.com` subdomain.

After the zone owner approves the apex binding, deploy with the same config:

```sh
pnpm dlx wrangler@4.164.0 deploy --config scripts/install-domain/wrangler.toml
```

## Verify after deploying

Download and compare both scripts without running them:

```sh
set -eu
downloads=$(mktemp -d)
for script in install.sh stack.sh; do
  new_url="https://heylinger.com/$script"
  curl -fsSL "https://simplexai.com/$script" -o "$downloads/old-$script"
  test "$(curl -fsS -w '%{http_code}' -o "$downloads/new-$script" "$new_url")" = 200
  test "$(curl -fsSI -w '%{http_code}' -o /dev/null "$new_url")" = 200
  cmp "$downloads/old-$script" "$downloads/new-$script"
done
```

Run this check before updating downstream links. If a script differs or fails to
download, keep the old links and remove the new `heylinger.com` Custom Domain
binding to roll back the first deployment.
