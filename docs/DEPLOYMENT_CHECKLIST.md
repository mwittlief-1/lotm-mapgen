# v0.1.0 Deployment Checklist (Vercel)

## Preconditions
- GitHub repo exists (deployment mirror repo)
- Vercel project connected to the repo
- Build uses Vite: npm run build => dist/

## Steps (each release)
1) Download the release repo zip (e.g., lotm_v0.1.0_repo.zip)
2) Unzip locally
3) Copy files into your deployment mirror repo folder
   - Do NOT copy: node_modules/, dist/, artifacts/, qa_artifacts/
4) Ensure lockfile:
   - If package-lock.json is present, Vercel can use npm ci
   - If missing, set Vercel Install Command temporarily to npm install and commit the generated lockfile later
5) Commit + push to main
6) Confirm Vercel deploy succeeded
7) Open Stable URL and verify:
   - APP_VERSION visible in UI
   - App loads and can advance 1 turn

## SPA routing
This repo includes vercel.json to rewrite all routes to /index.html.
