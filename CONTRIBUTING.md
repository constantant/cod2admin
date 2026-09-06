# Contributing

## Setup

- Node 24, pnpm via Corepack (`corepack pnpm ...` if bare `pnpm` isn't on your `PATH`)
- `pnpm install`

## Before opening a PR

```sh
pnpm exec nx run-many -t lint test build typecheck e2e
```

This is the same check CI runs. `main` is protected: PRs require this CI job (`main`) to pass
before merging, and direct pushes to `main` are blocked for everyone except the repo admin.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are required — enforced locally by
a `commit-msg` git hook and re-checked in CI on every PR. Commit types/scopes drive automatic
version bumps and `CHANGELOG.md` generation, so get the format right rather than relying on a
squash-merge to clean it up later:

```
<type>(<scope>): <description>

feat(gateway): add /mute command
fix(rcon-client): handle empty status response
```

## Releases

Releases (version bump, `CHANGELOG.md`, the installer archive, and the GitHub Release) are cut by
a maintainer via `pnpm run release` — see `scripts/release.sh`. Contributors don't need to do
anything release-related; just write Conventional Commits.
