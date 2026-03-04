# Virtual Repo Rules (LOCKED)

**Last Updated:** 2026-02-13

Repo Zip (source): lotm_v0.2.1_repo.zip (includes docs/BUILD_INFO.json)  
Playtest Packet (evidence): lotm_v0.2.1_playtest_packet.zip

BUILD_INFO must include: app_version, sim_version, code_fingerprint, policy_ids, created_at_utc.  
QA/Balance reports must quote app_version + code_fingerprint.

Policy ID sanitizer (WP-10 LOCK): replace '/' with '__' for artifact folders.
