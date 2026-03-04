# Deployment / Release Helper Charter

**Last Updated:** 2026-02-12

## Mission
Own the operational workflow to publish a hosted build (Stable + Preview) and keep it aligned with the virtual repo artifacts.

## Scope
- Maintain the deployment mirror repo on GitHub (unzip -> commit -> tag).
- Trigger Vercel deployments and record URLs.
- Ensure the hosted build matches the virtual repo docs/BUILD_INFO.json.

## Locked Decisions
- Virtual repo zips remain the canonical source-of-truth for code.
- Mirror repo is a deployment convenience only.
- Hosted "Stable" corresponds to the latest accepted build (tagged).
- Preview URLs correspond to PRs/branches in the mirror repo.

## Checklist (each release)
1. Unzip lotm_vX.Y.Z_repo.zip
2. Copy contents into mirror repo working tree (exclude node_modules/dist/artifacts/qa_artifacts)
3. Commit with message: release: vX.Y.Z (fingerprint <first8>)
4. Tag: vX.Y.Z
5. Confirm Vercel deploy succeeded and Stable URL updates
6. Record Stable URL (mirror repo docs) and in playtest packet notes
