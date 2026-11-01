---
name: release
description: "ONLY activated by the explicit /release slash command. Never auto-triggered by conversation content. Project-local maintenance skill for releasing fgc-mixtools: survey changes since the last tag, pick one semver bump, stamp it into the plugin and extension manifests, build mixtools.mcpb, commit, tag, push, and publish a GitHub release with the bundle attached."
---

# /release — cut an fgc-mixtools release

Releases **the whole repository at one version**. The repository ships two things that work only together:

- **The `mixtools` plugin** at `plugins/mixtools/`. Claude Desktop and Claude Code install it from this marketplace. Its version is the update key: a client updates when the number changes.
- **The mixtools desktop extension** at `extension/`. The release packs it into `mixtools.mcpb` and attaches it to a GitHub release. The `mixtools-setup` skill sends users to `https://github.com/fallguyconsulting/fgc-mixtools/releases/latest/download/mixtools.mcpb`.

The skills call the extension's tools by name, so a plugin and an extension from different releases can disagree. One version keeps them paired. Three files carry it, and all three always match:

| File | Field |
| --- | --- |
| `plugins/mixtools/.claude-plugin/plugin.json` | `version` |
| `extension/manifest.json` | `version` |
| `extension/package.json` | `version` |

The extension server reads its version from `extension/manifest.json` at startup, so the server code carries no version of its own.

This is a repo-maintenance tool. It lives in the repo-root `.claude/skills/`, not in the plugin, so users never see it.

## What "release" means here

**Release the repo as it stands right now, capturing and committing everything in it.** The working tree *is* the release: staged, unstaged, and untracked changes all go in.

- **Do not curate the commit.** One release commit, whole tree, `git add -A`.
- **Do not treat uncommitted work as suspect.** A dirty tree is the normal starting state.
- **Do not stop to ask** whether some subset should be excluded.
- **Do report what went in:** the file count and which parts changed (plugin, extension, marketplace, docs).

Surface a genuine defect found along the way (a broken manifest, a failed validation, a conflict marker). Fix nothing silently; say what you found.

This skill commits, pushes, and publishes. The user invoking `/release` **is** the authorization. Run end to end without pausing. Stop only on a preflight or assertion failure.

## The release is mechanical

The release changes only the three `version` fields, builds `dist/mixtools.mcpb` (ignored by git, uploaded to GitHub), and creates the commit, tag, and GitHub release. It verifies itself with deterministic checks only: validation (step 5), version agreement (step 6), the bundle's reported version (step 7), and the download link (step 11). It dispatches no agents. **The semver level (step 3) is the release's only judgment.** Write no release notes beyond the one-line body in step 10.

## A release is not done until a user can install it

Two things must be true at `origin`:

1. **The marketplace serves the new plugin.** Claude resolves a marketplace to the repository's default branch unless the user pinned a `ref`. The release commit must be on the default branch at `origin`.
2. **The download link serves the new extension.** `releases/latest/download/mixtools.mcpb` must return the bundle built in this release.

Never report a release as done without step 11 confirming both.

Read the default branch from the remote. Never assume `main`:

```bash
default_branch=$(git ls-remote --symref origin HEAD | awk '/^ref:/ {sub("refs/heads/","",$2); print $2}')
```

## Preflight — abort with a clear message if any fail

- Inside a git repo, on a branch: `git rev-parse --abbrev-ref HEAD` is not `HEAD`.
- An `origin` remote exists: `git remote get-url origin`.
- The remote reports a default branch: the command above prints a name.
- `.claude-plugin/marketplace.json` exists.
- All three version files exist and each has a `"version"` field.
- `node` and `npx` are on PATH.
- `gh auth status` succeeds, and `gh repo view --json viewerPermission -q .viewerPermission` prints `ADMIN`, `MAINTAIN`, or `WRITE`.

If a check fails, report exactly what is missing and stop. Do not repair the repo.

## Procedure

### 1. Find the baseline and survey the changes

```bash
last_tag=$(git describe --tags --abbrev=0 2>/dev/null)
echo "last_tag: ${last_tag:-<none>}"
git status --short
grep -H '"version"' plugins/mixtools/.claude-plugin/plugin.json extension/manifest.json extension/package.json
```

- **A tag exists:** the change set is `git log --oneline "$last_tag"..HEAD` and `git diff "$last_tag"..HEAD`, plus everything uncommitted (`git diff HEAD` and untracked files).
- **No tag exists (first release):** the change set is everything. Judge the bump from the current version (step 2), not from history.

Read enough of the diff to judge the bump. Attribute each change to the plugin (`plugins/mixtools/`), the extension (`extension/`), or the repo (`.claude-plugin/`, README, this skill).

**Nothing to release:** a tag exists, `"$last_tag"..HEAD` is empty, and the tree is clean. Report "nothing to release since `$last_tag`" and stop.

### 2. Read the current version

Read the three `version` fields.

- **Normally they match.** That is the current version.
- **If they differ,** the current version is the **highest** of them. Say so in the report. Never pick a lower one: a lower plugin version strands existing installs on old files.

Tags are this string with a `v` prefix (`v0.3.0`). The `version` fields carry no `v`.

### 3. Decide the bump

Judge **major / minor / patch** from what the change set does to what users and the skills depend on: the skill names, the extension's tool names and arguments, the workspace layout under `~/Music/Mixtools/`, and the Ardour build the extension requires.

| Level | When |
| --- | --- |
| **major** | A skill or extension tool is removed or renamed; a tool argument is removed, renamed, or changes meaning; the workspace layout changes so existing songs, references, or bounces stop being found; the extension starts requiring a newer mixtools Ardour build (for example, a new Ardour MCP tool from a new patch). |
| **minor** | A new skill, extension tool, or tool argument; a new capability inside an existing skill or tool that stays backward compatible. |
| **patch** | Everything else: skill wording, reference tables, measurement fixes, bug fixes, README edits. |

The highest level found wins. If it is genuinely ambiguous between two levels, choose the higher and say so. On a first release with no tag, release the current version as is when it has never been tagged; bump only if the current version was already published some other way.

Print the chosen level, the new version, and a one-line rationale citing the change that drove it.

### 4. Apply the bump

Edit the `version` field in all three files to the new version. Use the Edit tool per file for a single-line change. Touch no other field.

### 5. Validate — do not skip

```bash
claude plugin validate . --strict
claude plugin validate plugins/mixtools --strict
(cd extension && npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json)
for f in extension/server/*.js; do node --check "$f" || exit 1; done
```

A plugin-directory advisory such as a missing icon is not a failure. Any failed validation or syntax check is: report it and stop before step 8, so no release commit exists.

### 6. Assert the versions agree — do not skip

Run this with `X.Y.Z` replaced by the new version. Stop on any failure. Never tag a mixed set.

```bash
new="X.Y.Z"
mismatch=0
for f in plugins/mixtools/.claude-plugin/plugin.json extension/manifest.json extension/package.json; do
  v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
  if [ "$v" != "$new" ]; then
    echo "MIXED VERSION: $f carries ${v:-<none>}, expected $new"
    mismatch=1
  fi
done
[ "$mismatch" -eq 0 ] && echo "all manifests at v$new" || exit 1
```

### 7. Build the extension bundle — do not skip

Remove the previous bundle first, so a bundle found afterwards can only be this release's build:

```bash
rm -f dist/mixtools.mcpb
mkdir -p dist
(cd extension && npx -y @anthropic-ai/mcpb@2.1.2 pack . ../dist/mixtools.mcpb) || { echo "pack failed"; exit 1; }
test -f dist/mixtools.mcpb || { echo "pack produced no dist/mixtools.mcpb"; exit 1; }
ls -l dist/mixtools.mcpb
```

Then start the server and check the version it reports and its tool count:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node extension/server/index.js \
  | node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{const m=JSON.parse(l);if(m.id===1)console.log("server version",m.result.serverInfo.version);if(m.id===2)console.log("tools",m.result.tools.length)})'
```

The server version must equal the new version. A failed pack or a wrong version is a preflight failure: report it and stop before step 8. `dist/` is ignored by git; the bundle ships only as the GitHub release asset.

### 8. Commit

```bash
git add -A
```

Commit with body `Release vX.Y.Z`, ending with the trailer this environment requires:

```
Co-Authored-By: <the model cutting the release, per this environment's commit-trailer rule> <noreply@anthropic.com>
```

### 9. Land on the default branch, tag, and push

- **Already on the default branch** (the normal case): nothing to do.
- **On another branch:** `git checkout "$default_branch" && git merge --ff-only -`. If the fast-forward is refused, make an ordinary merge commit; that merge commit is the release commit. On a conflict, **stop**, report the conflicting paths, and leave the repo for the author. Never force, never rebase published history.

Then tag the tip of the default branch and push both:

```bash
git tag -a "vX.Y.Z" -m "Release vX.Y.Z"
git push origin "$default_branch"
git push origin "vX.Y.Z"
```

If the release was cut on another branch, push that branch too.

### 10. Publish the GitHub release

```bash
gh release create "vX.Y.Z" dist/mixtools.mcpb \
  --title "mixtools vX.Y.Z" \
  --notes "mixtools vX.Y.Z. Install the plugin from this marketplace, then download mixtools.mcpb below or say \"set up mixtools\" in Claude." \
  --latest \
  --verify-tag
```

`--latest` is required: the setup skill's link resolves through GitHub's latest release.

### 11. Verify a user can install it — do not skip

Check at `origin`, not locally:

```bash
git ls-remote origin "refs/heads/$default_branch" "refs/tags/vX.Y.Z"
git branch -r --contains "vX.Y.Z" | grep "origin/$default_branch"
git show "origin/$default_branch:plugins/mixtools/.claude-plugin/plugin.json" | grep '"version"'

tmp=$(mktemp -d)
curl -sSfL -o "$tmp/mixtools.mcpb" https://github.com/fallguyconsulting/fgc-mixtools/releases/latest/download/mixtools.mcpb
cmp "$tmp/mixtools.mcpb" dist/mixtools.mcpb && echo "download link serves this release's bundle"
rm -rf "$tmp"
```

All must pass: the tag exists at `origin`; the default branch at `origin` contains it; the plugin manifest there carries the new version; and the download link returns a file identical to `dist/mixtools.mcpb`. If any check fails, say so plainly in the report. A release a user cannot install is not a release.

### 12. Report

Print: previous version → new version; the bump level and its one-line rationale; which parts changed (plugin, extension, repo); the file count in the release commit; the commit SHA; the tag; the default branch the release landed on; the GitHub release URL; and the step 11 result, stated as the plain fact that the new version is installable.

## Notes

- **The release does not ship Ardour.** The extension requires the mixtools build of Ardour, which `ardour/build-ardour.sh` builds, signs, and notarizes, and which is hand-delivered separately. When a release raises the Ardour requirement, that is a major bump (step 3), and the new Ardour build must reach users before or with it.
- Users who pinned a `ref` when adding the marketplace stay on that pin. That is their choice, not a problem to solve here.
