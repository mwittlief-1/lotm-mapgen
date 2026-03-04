# Distribution — Hosted Web (Vercel) + Virtual Repo

## Contract (v0.1.0+)
Each release produces:
1) Hosted Stable URL (accepted build)
2) Hosted Preview URLs (per PR/branch)
3) Repo zip + Playtest Packet zip (virtual repo artifacts)

## Recommended approach
Maintain a small "deployment mirror repo" that contains the current repo contents (unzip -> commit -> tag).
Vercel connects to this mirror repo to provide Stable + Preview deployments automatically.

## Vercel settings
- Framework: Vite
- Install: npm ci
- Build: npm run build
- Output: dist
- SPA routing: this repo includes vercel.json rewrites.

## Version visibility
APP_VERSION is shown in the UI header. Consider also showing BUILD_INFO fingerprint in Debug for drift-proof testing.
