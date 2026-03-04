Lords of the Manor — Dispatch Messages (Map v1 Workflow)
Date: 2026-02-17

Purpose
- Copy/paste dispatch messages for each persona to implement Map v1 workflow (presentation-only, deterministic, contract-first).
- Assumes Map v1 is built alongside current v0.2.x work (no sim dependencies).

How to use
1) Open the target persona chat.
2) Attach the relevant baseline repo zip + kickoff package zip (if applicable).
3) Paste the corresponding dispatch message from /dispatch/*.txt.

Attachment guidance (recommended)
- Engineering/CTO: baseline repo zip (current HEAD) + latest kickoff package for the current version.
- Map Specialist: baseline repo zip + map_v1_config placeholder (if exists).
- Art Lead: baseline repo zip (for asset paths) + any style references.
- QA: baseline repo zip (for preflight scripts) + golden seeds list (if needed).
- Balance: playtest packet (optional) + policy ids mapping.
- UX: baseline repo zip + current UX docs.

Non-goals
- Do not change sim mechanics. Map v1 is presentation-only.
- Any proposal to let map tags influence sim requires Workpad + Lock.

Files
- dispatch/CTO_ENGINEERING_MESSAGE.txt
- dispatch/MAP_SPECIALIST_MESSAGE.txt
- dispatch/ART_LEAD_MESSAGE.txt
- dispatch/QA_ENGINEER_MESSAGE.txt
- dispatch/BALANCE_ANALYST_MESSAGE.txt
- dispatch/UX_WRITER_MESSAGE.txt
- dispatch/RESEARCH_ANALYST_MESSAGE.txt
- dispatch/TECHNICAL_ARCHITECT_MESSAGE.txt
- dispatch/DEPLOY_HELPER_MESSAGE.txt
