# Asbury Law website

Static HTML website imported from the supplied Drive archive and iterated on the `mvp-preview` branch. The original import remains available in Git history.

## Preview locally

From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000. No dependency installation or build step is required. Google Fonts requires an internet connection.

## Source

- Archive: [Asbury Law — Modern Counsel. Lasting Legacy. (Copy).zip](https://drive.google.com/file/d/1CrUpKj2RMfiQWH4fxZSoXxyX5u6bOAwK/view)
- Imported: 2026-10-07
- Archive SHA-256: `39b5a0aa92fb6da9e57ed156c4e7a944c20dcb887f157e13099b05f93682505c`

## Current boundaries

This repository has a protected Vercel test project. A test deployment is not a production release, verified form integration, or ownership transfer to Tom.

## Design review deployment

- Repository: `Smithright/asbury-law-test` (interim working repo from 2026-10-15). The original `Smithright/asbury-law.com` moved to `Asbury-Law/asbury-law.com`; Claude has no access there yet. Once access is settled, push `mvp-preview` back to `Asbury-Law/asbury-law.com` and archive this repo.
- Design branch: `mvp-preview`
- Vercel team: `smithrights-projects` (`team_GQmzsp4WbmsngwjpyJ97SFoZ`)
- Vercel project: `asbury-law-test` (`prj_sUqAegcqxmoEtTjJkzz73QU00DsY`)
- Environment: Preview. Keep `main` as the production branch.
- Review URL: https://asbury-law-test-git-mvp-preview-smithrights-projects.vercel.app
- Protection: Vercel Authentication on all deployments. Reviewers require authorized access.
- Build: plain static HTML; repository root, no framework, output directory `.`.

Claude Design changes must be applied to the actual site files, committed and pushed to `mvp-preview`. Preserve attribution and exclude design annotation/review overlays. Vercel's Git integration is intended to publish each pushed revision; automatic triggering was observed on 2026-10-12 for an authenticated GitHub-owner commit.

Before reporting an iteration ready, verify its full commit SHA against the Vercel deployment, wait for READY, and check the protected live pages at desktop and phone widths. Record the immutable deployment URL and any unresolved behavior. The branch URL is the moving review link; the immutable URL identifies the exact review version.

If no deployment appears or it fails, report that revision as pending/failed, inspect the account Git connection, repository integration and build logs, and retain the last successful preview. A successful push alone does not establish deployment. Codex owns setup and recovery; Vercel executes routine deployments; Tom reviews design and copy. Production promotion requires a separate release approval.

Baseline preview verified READY: commit `717d8e91203cd08dbbcca0018157f0fd4bfd2b2d`, deployment `dpl_BA4KUg3QWNBnpPMvQGWNHkEKPECR`. Subsequent GitHub-owner commit `2ed4a43257c8d9e3466d4645bbe07bed1259bfda` deployed automatically as `dpl_GtHv7Ff6cv653BVkuaE6SSpghvKf` (source: git, READY). Desktop/mobile Home and Legacy Vault, mobile menu/About navigation, anonymous SSO protection, and missing-page recovery were checked. Forms remain unintegrated; no submission was sent.

Author identity matters: the original Claude-authored commit was deployed explicitly; that alone does not prove automatic deployment from Claude's own commit identity. The verified automatic path uses the authenticated repository owner's GitHub integration. Preserve AI contribution in the commit message/co-author attribution. If a Claude-authored push produces no deployment, report the missing deployment instead of claiming success; the deployment owner must reconcile Git identity/access. Do not rewrite existing authors or change plan/access to conceal a failure.

The supplied form script marks submissions as sent even when no backend endpoint is configured, and it does not verify delivery success. Do not treat the displayed confirmation as evidence of a delivered inquiry. Form integration and end-to-end verification are required before launch.

A private GitHub repository does not automatically make a hosted website private. Configure deployment access protection before publishing review content.
