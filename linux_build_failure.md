Run # DevDep for the test script (cross-env); --no-save keeps package.json clean.

# DevDep for the test script (cross-env); --no-save keeps package.json clean.

npm install --no-save cross-env

# System-Node ABI so `require('better-sqlite3')` works in tests.

npm rebuild better-sqlite3
npm test

# Restore Electron ABI for packaging.

cd ../desktop
npx electron-rebuild -f \
 --module-dir "/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine" \
 --which better-sqlite3 --which sharp \
 || npx electron-rebuild -f --module-dir "/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine"

# Re-verify after restore.

cd ../gtss-growth-engine
ELECTRON_BIN="$(cd ../desktop && node -p "require('electron')")"
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "require('better-sqlite3'); console.log('better-sqlite3 OK after test restore')"
shell: /usr/bin/bash -e {0}
env:
ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
NODE_ENV: test
TEST_NO_BROWSER_LAUNCH: true
DISABLE_CDP_AUTO_LAUNCH: true

up to date, audited 321 packages in 541ms

83 packages are looking for funding
run `npm fund` for details

found 0 vulnerabilities
rebuilt dependencies successfully

> gtss-growth-engine@1.0.0 test
> cross-env NODE_ENV=test TEST_NO_BROWSER_LAUNCH=true DISABLE_CDP_AUTO_LAUNCH=true node --test

TAP version 13

# ◇ injected env (0) from .env // tip: ◈ encrypted .env [www.dotenvx.com]

# ◇ injected env (0) from .env // tip: ◈ secrets for agents [www.dotenvx.com]

# ◇ injected env (0) from .env // tip: ⌘ multiple files { path: ['.env.local', '.env'] }

# [2026-07-18T07:33:41.480Z] [INFO] [SERVER] Creating sessions directory: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/sessions

# [2026-07-18T07:33:41.481Z] [INFO] [SERVER] Creating media directory: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/media

# [2026-07-18T07:33:41.481Z] [INFO] [SERVER] Creating uploads directory: /home/runner/work/gtss_growth_automation/gtss_growth_automation/public/uploads

# [2026-07-18T07:33:41.488Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# === GTSS INSTAGRAM PIPELINE INTEGRATION TEST SUITE ===

# Running T1 — Migration integrity...

# ✅ T1 Migration — PASS

# [2026-07-18T07:33:41.549Z] [INFO] [SERVER] GTSS Growth Engine v1.0.0 started on http://localhost:4567

# [2026-07-18T07:33:41.550Z] [INFO] [SOCKET] Socket.IO initialized

# [2026-07-18T07:33:41.550Z] [INFO] [SERVER] Background automation jobs disabled.

# Running T2 — Discovery filter logic...

# ✅ T2 Filter logic — PASS

# Running T3 — Warmup sequence lifecycle...

# ✅ T3 Warmup sequence lifecycle — PASS

# Running T4 — Rate limit enforcement...

# ✅ T4 Rate limit enforcement — PASS

# Running T5 — Block detection...

# ✅ T5 Block detection — PASS

# Running T6 — Settings API...

# [2026-07-18T07:33:41.593Z] [INFO] [WARMUP_API_DISPATCH] Instagram warmup step delay settings updated.

# ✅ T6 Settings API — PASS

# Running T7 — Warmup pipeline API...

# ✅ T7 Warmup pipeline API — PASS

# Running T8 — Shared CDP Context Diagnostics...

# ❌ TEST SUITE FAILED with error:

# Error: Shared CDP Chrome is not listening on http://127.0.0.1:9222 and TEST_NO_BROWSER_LAUNCH/SKIP_CDP_CHROME is set. Start Chrome with --remote-debugging-port=9222, or run: bash scripts/launch-chrome.sh

# at ensureSharedCdpChrome (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline/\_setup.js:78:11)

# at process.processTicksAndRejections (node:internal/process/task_queues:95:5)

# at async runPhase8 (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline/phase8-cdpContext.js:23:3)

# at async runTests (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline.js:54:5)

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline.js

not ok 1 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline.js

---

duration_ms: 711.785413
location: '/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/scripts/test-instagram-pipeline.js:1:1'
failureType: 'testCodeFailure'
exitCode: 1
signal: ~
error: 'test failed'
code: 'ERR_TEST_FAILURE'
...

# node:internal/process/promises:391

# triggerUncaughtException(err, true /_ fromPromise _/);

# ^

# browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell

# ╔════════════════════════════════════════════════════════════╗

# ║ Looks like Playwright was just installed or updated. ║

# ║ Please run the following command to download new browsers: ║

# ║ ║

# ║ npx playwright install ║

# ║ ║

# ║ <3 Playwright Team ║

# ╚════════════════════════════════════════════════════════════╝

# at /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-browser.js:3:34

# at Object.<anonymous> (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-browser.js:9:3) {

# log: [],

# name: 'Error'

# }

# Node.js v20.20.2

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-browser.js

not ok 2 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-browser.js

---

duration_ms: 350.031013
location: '/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-browser.js:1:1'
failureType: 'testCodeFailure'
exitCode: 1
signal: ~
error: 'test failed'
code: 'ERR_TEST_FAILURE'
...

# 20

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-init.js

ok 3 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test-init.js

---

duration_ms: 31.559545
...

# Subtest: manual auth detection accepts post-login Facebook and Instagram urls

ok 4 - manual auth detection accepts post-login Facebook and Instagram urls

---

duration_ms: 3.457086
...

# Subtest: manual auth detection accepts Gemini/Google post-login urls

ok 5 - manual auth detection accepts Gemini/Google post-login urls

---

duration_ms: 0.207836
...

# Subtest: manual auth detection accepts LinkedIn and X post-login urls

ok 6 - manual auth detection accepts LinkedIn and X post-login urls

---

duration_ms: 0.153738
...

# ◇ injected env (0) from .env // tip: ◈ secrets for agents [www.dotenvx.com]

# === RUNNING BACKGROUND JOBS CAMPAIGN QUEUE INTEGRATION TESTS ===

# Testing T1 — Graceful skip when no eligible jobs exist...

# [2026-07-18T07:33:41.848Z] [INFO] [SERVER] [CONNECTION-QUEUE] Starting campaign connection invite queue run...

# [2026-07-18T07:33:41.849Z] [INFO] [SERVER] [CONNECTION-QUEUE] No active platform campaigns have pending or retryable connection invite jobs.

# [2026-07-18T07:33:41.849Z] [INFO] [SERVER] [DM-QUEUE] Starting campaign DM messaging queue run...

# [2026-07-18T07:33:41.850Z] [INFO] [SERVER] [DM-QUEUE] No active platform campaigns have pending, scheduled, or retryable DM messaging jobs.

# T1 PASS: Skips safely without errors or browser triggers!

# Testing T2 — Pre-flight checking and platformAdapter wrapper execution...

# [2026-07-18T07:33:41.851Z] [INFO] [SERVER] [CONNECTION-QUEUE] Starting campaign connection invite queue run...

# [2026-07-18T07:33:41.851Z] [INFO] [SERVER] [CONNECTION-QUEUE] Pre-flight inspection: Launching contexts for platforms: instagram

# [2026-07-18T07:33:41.852Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Pre-launching browser context for platform: instagram

# [2026-07-18T07:33:41.852Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:41.853Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:41.853Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:9999] Postponed job to next business hour window (Snoozed until: 2026-07-19T09:00:00.000Z).

# [2026-07-18T07:33:41.854Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# [2026-07-18T07:33:41.854Z] [INFO] [SERVER] [CONNECTION-QUEUE] Connection queue batch processing complete: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# [2026-07-18T07:33:41.854Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Closing background browser context for platform: instagram

# Test suite failed: AssertionError [ERR_ASSERTION]: Wrapped instagram.followAccount should be triggered.

# at runBackgroundJobsQueueTests (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/backgroundJobs.test.js:103:5)

# at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {

# generatedMessage: false,

# code: 'ERR_ASSERTION',

# actual: false,

# expected: true,

# operator: '=='

# }

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/backgroundJobs.test.js

not ok 5 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/backgroundJobs.test.js

---

duration_ms: 523.513415
location: '/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/backgroundJobs.test.js:1:1'
failureType: 'testCodeFailure'
exitCode: 1
signal: ~
error: 'test failed'
code: 'ERR_TEST_FAILURE'
...

# [2026-07-18T07:33:41.871Z] [WARN] [BROWSER] Removing stale browser lock {"platform":"linkedin","mode":"persistent","filePath":"/tmp/gtss-browser-test-0woUFH/locks/linkedin-persistent-tmp-profile-b.lock","pid":99999999}

# [2026-07-18T07:33:41.873Z] [WARN] [BROWSER] Headless mode disabled for social automation {"platform":"linkedin"}

# [2026-07-18T07:33:41.875Z] [INFO] [APP] Session marked active {"platform":"x","authState":"AUTHENTICATED"}

# [2026-07-18T07:33:41.877Z] [INFO] [APP] Session marked active {"platform":"x","authState":"AUTHENTICATED"}

# [2026-07-18T07:33:41.877Z] [WARN] [SESSION] Session marked invalid {"platform":"x"}

# [2026-07-18T07:33:41.878Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# [2026-07-18T07:33:41.878Z] [WARN] [SESSION] Session marked invalid {"platform":"x"}

# [2026-07-18T07:33:41.878Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# [2026-07-18T07:33:41.878Z] [WARN] [SESSION] Session marked invalid {"platform":"x"}

# [2026-07-18T07:33:41.878Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# [2026-07-18T07:33:41.879Z] [WARN] [SESSION] Session marked invalid {"platform":"x"}

# [2026-07-18T07:33:41.879Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# Subtest: browser locks block concurrent use of the same profile

ok 8 - browser locks block concurrent use of the same profile

---

duration_ms: 2.463102
...

# Subtest: stale browser locks are cleaned up

ok 9 - stale browser locks are cleaned up

---

duration_ms: 1.344644
...

# Subtest: headless is disabled for social platforms unless explicitly allowed

ok 10 - headless is disabled for social platforms unless explicitly allowed

---

duration_ms: 1.588667
...

# Subtest: loginSession always forces a visible browser regardless of headless preference

ok 11 - loginSession always forces a visible browser regardless of headless preference

---

duration_ms: 0.164222
...

# Subtest: pipelines respect CDP_VISIBLE_DEFAULT=false as user's background preference

ok 12 - pipelines respect CDP_VISIBLE_DEFAULT=false as user's background preference

---

duration_ms: 0.156437
...

# Subtest: shared CDP takes precedence over persistent browser mode for social platforms

ok 13 - shared CDP takes precedence over persistent browser mode for social platforms

---

duration_ms: 0.215118
...

# Subtest: x search result pages are treated as authenticated

ok 14 - x search result pages are treated as authenticated

---

duration_ms: 1.918164
...

# Subtest: x session state detection classifies authenticated, login, captcha, rate limit, and unknown states

ok 15 - x session state detection classifies authenticated, login, captcha, rate limit, and unknown states

---

duration_ms: 2.306538
...

# [2026-07-18T07:33:42.050Z] [WARN] [INSTAGRAM_BLOCK] Instagram action block detected: "action blocked". Resuming at 2026-07-19T07:33:42.050Z

# [2026-07-18T07:33:42.051Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# [2026-07-18T07:33:42.052Z] [WARN] [INSTAGRAM_BLOCK] Instagram action block detected: "try again later". Resuming at 2026-07-19T07:33:42.052Z

# [2026-07-18T07:33:42.053Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

# [2026-07-18T07:33:42.054Z] [INFO] [BROWSER] Starting daily Instagram session warmup (fastTrack: false)...

# [2026-07-18T07:33:42.054Z] [INFO] [BROWSER] Simulating organic browse on Instagram home feed...

# [2026-07-18T07:33:42.054Z] [INFO] [BROWSER] Completed organic scroll 1/2

# [2026-07-18T07:33:42.055Z] [INFO] [BROWSER] Completed organic scroll 2/2

# [2026-07-18T07:33:42.055Z] [INFO] [BROWSER] Warmup elapsed: 50ms. Waiting remaining 50210ms to complete...

# [2026-07-18T07:33:42.055Z] [INFO] [BROWSER] Launching Instagram browser (prefers an existing Chrome tab when available)...

# Subtest: checkForInstagramBlock detects block phrases

ok 16 - checkForInstagramBlock detects block phrases

---

duration_ms: 2.89152
...

# Subtest: checkInstagramSessionState handles blocked, captcha, logged_out, authenticated, and unknown states

ok 17 - checkInstagramSessionState handles blocked, captcha, logged_out, authenticated, and unknown states

---

duration_ms: 1.309264
...

# Subtest: humanMouseMove moves mouse in 2-step approach

ok 18 - humanMouseMove moves mouse in 2-step approach

---

duration_ms: 0.316968
...

# Subtest: dailySessionWarmup executes simulateOrganicBrowse and completes

ok 19 - dailySessionWarmup executes simulateOrganicBrowse and completes

---

duration_ms: 0.654178
...

# [2026-07-18T07:33:42.062Z] [INFO] [BROWSER] CDP port 39999 is closed and CDP auto-launch is disabled.

# [2026-07-18T07:33:42.063Z] [INFO] [BROWSER] Attaching Instagram automation to Chrome via CDP {"endpoint":"http://127.0.0.1:39999"}

# [2026-07-18T07:33:42.063Z] [INFO] [BROWSER] No existing cookie session found for Instagram

# [2026-07-18T07:33:42.064Z] [INFO] [BROWSER] Navigating to Instagram home to check session...

# [2026-07-18T07:33:42.064Z] [INFO] [BROWSER] Instagram session state detected: authenticated

# [2026-07-18T07:33:42.065Z] [INFO] [BROWSER] Instagram daily warmup skipped for this browser session

# Subtest: createInstagramBrowser launches headed, configured with Nairobi geolocation

ok 20 - createInstagramBrowser launches headed, configured with Nairobi geolocation

---

duration_ms: 10.358362
...

# ◇ injected env (0) from .env // tip: ⌘ enable debugging { debug: true }

# ◇ injected env (0) from .env // tip: ⌘ multiple files { path: ['.env.local', '.env'] }

# === RUNNING CAMPAIGN INTEGRITY & RELIABILITY INTEGRATION TESTS ===

# Testing T1 — Startup Sweeper & Lock Initialization...

# [2026-07-18T07:33:42.299Z] [INFO] [SERVER] Background automation worker initializing.

# [2026-07-18T07:33:42.302Z] [INFO] [SERVER] [PIPELINE-RECOVERY] 0 stale execution(s) marked failed on startup.

# [2026-07-18T07:33:42.321Z] [INFO] [SERVER] [STARTUP-SWEEP] Reset 1 connection jobs stuck in 'running' status back to 'pending'.

# [2026-07-18T07:33:42.321Z] [INFO] [SERVER] [STARTUP-SWEEP] Reset 1 DM jobs stuck in 'running' status back to 'pending'.

# [2026-07-18T07:33:42.322Z] [INFO] [SERVER] [STARTUP-SWEEP] Initialized/Reset persistent campaign queue lock to 'false'.

# [2026-07-18T07:33:42.322Z] [INFO] [APP] Initializing Scheduled Poster cron job (runs every minute)

# [2026-07-18T07:33:42.337Z] [INFO] [INSTAGRAM_JOBS] Initializing Instagram Warmup & Unfollow background cron jobs (Africa/Nairobi timezone context)

# [2026-07-18T07:33:42.339Z] [INFO] [SERVER] Orphan upload cleanup cron registered: daily at 3:00 AM

# [2026-07-18T07:33:42.339Z] [INFO] [SERVER] Artifact cleanup cron registered: daily at 3:30 AM (ARTIFACTS_RETENTION_DAYS default 7)

# [2026-07-18T07:33:42.340Z] [INFO] [SERVER] Instagram follow-backs cron registered: daily at 4:00 AM

# [2026-07-18T07:33:42.340Z] [INFO] [SERVER] Campaign Connection Queue cron registered: every 20 minutes

# [2026-07-18T07:33:42.341Z] [INFO] [SERVER] Campaign DM Queue cron registered: every 2 minutes

# [2026-07-18T07:33:42.341Z] [INFO] [SERVER] Background automation worker initialized.

# ✅ T1 Startup Sweeper & Lock Initialization — PASS

# Testing T2 — Persistent advisory lock mutual exclusion...

# [2026-07-18T07:33:42.342Z] [INFO] [SERVER] [CONNECTION-QUEUE] Skipping execution: another cluster instance or runner has acquired the queue lock.

# ✅ T2 Persistent Advisory Lock Mutual Exclusion — PASS

# Testing T3 — Warm Lead Connection Bypass Gate...

# [2026-07-18T07:33:42.344Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.344Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.344Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:2] Postponed job to next business hour window (Snoozed until: 2026-07-19T09:00:00.000Z).

# [2026-07-18T07:33:42.345Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# ❌ CAMPAIGN INTEGRITY TESTS FAILED: AssertionError [ERR_ASSERTION]: Skipped already-connected leads must transition connection status directly to 'accepted'.

# + actual - expected

# + 'pending'

# - 'accepted'

# at runCampaignIntegrityTests (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignIntegrity.test.js:161:10)

# at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {

# generatedMessage: false,

# code: 'ERR_ASSERTION',

# actual: 'pending',

# expected: 'accepted',

# operator: 'strictEqual'

# }

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignIntegrity.test.js

not ok 8 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignIntegrity.test.js

---

duration_ms: 489.697627
location: '/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignIntegrity.test.js:1:1'
failureType: 'testCodeFailure'
exitCode: 1
signal: ~
error: 'test failed'
code: 'ERR_TEST_FAILURE'
...

# ◇ injected env (0) from .env // tip: ◈ encrypted .env [www.dotenvx.com]

# === RUNNING CAMPAIGN MIGRATION INTEGRATION TEST ===

# Running migrateCampaigns first time...

# [MIGRATE-CAMPAIGNS] Initiating campaign database migration...

# [MIGRATE-CAMPAIGNS] Enabled foreign_keys PRAGMA context.

# [MIGRATE-CAMPAIGNS] ✓ Table "campaigns" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "connection_jobs" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "dm_jobs" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "campaign_events" is ready.

# [MIGRATE-CAMPAIGNS] Provisioning high-performance indexes...

# [MIGRATE-CAMPAIGNS] ✓ All indexes created successfully.

# [MIGRATE-CAMPAIGNS] · Column "campaign_id" already exists in "daily_actions". Skipping alter.

# [MIGRATE-CAMPAIGNS] ✓ Index on "daily_actions(campaign_id)" is ready.

# [MIGRATE-CAMPAIGNS] Campaign migration successfully committed.

# ✅ T1: Table existence verified successfully.

# ✅ T2: Column 'campaign_id' exists in 'daily_actions'.

# ✅ T3: All high-performance indexes created successfully.

# ✅ T4: Foreign Key constraints enforce validation cleanly.

# Running migrateCampaigns a second time to verify complete idempotency...

# [MIGRATE-CAMPAIGNS] Initiating campaign database migration...

# [MIGRATE-CAMPAIGNS] Enabled foreign_keys PRAGMA context.

# [MIGRATE-CAMPAIGNS] ✓ Table "campaigns" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "connection_jobs" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "dm_jobs" is ready.

# [MIGRATE-CAMPAIGNS] ✓ Table "campaign_events" is ready.

# [MIGRATE-CAMPAIGNS] Provisioning high-performance indexes...

# [MIGRATE-CAMPAIGNS] ✓ All indexes created successfully.

# [MIGRATE-CAMPAIGNS] · Column "campaign_id" already exists in "daily_actions". Skipping alter.

# [MIGRATE-CAMPAIGNS] ✓ Index on "daily_actions(campaign_id)" is ready.

# [MIGRATE-CAMPAIGNS] Campaign migration successfully committed.

# ✅ T5: Idempotency check passed (no duplicate or structural error thrown).

# 🎉 ALL CAMPAIGN MIGRATION TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignMigration.test.js

ok 9 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignMigration.test.js

---

duration_ms: 152.294199
...

# === RUNNING CAMPAIGN ORCHESTRATOR TESTS ===

# Starting campaign...

# [2026-07-18T07:33:42.205Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Found 2 qualified leads. Commencing transactional enqueue.

# [2026-07-18T07:33:42.206Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Successfully enqueued job pair for lead 1.

# [2026-07-18T07:33:42.206Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Successfully enqueued job pair for lead 2.

# ✅ Campaign Start & Pair-Enqueue enqueued perfectly.

# ✅ Idempotency action fingerprints successfully registered.

# Pausing campaign...

# [2026-07-18T07:33:42.208Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Campaign successfully paused (reclaimed conn=0 dm=0).

# ✅ Campaign Pause OK.

# Adding newly qualified lead and resuming campaign...

# [2026-07-18T07:33:42.209Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Found 1 newly qualified leads to enqueue upon campaign resume.

# [2026-07-18T07:33:42.209Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:10] Successfully enqueued job pair for lead 4.

# ✅ Campaign Resume & Incremental-Enqueue enqueued perfectly.

# Retrieving campaign status report...

# ✅ Campaign Status Metrics resolved perfectly.

# 🎉 ALL CAMPAIGN ORCHESTRATOR TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignOrchestrator.test.js

ok 10 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignOrchestrator.test.js

---

duration_ms: 111.400593
...

# === RUNNING CAMPAIGN UTILS TEST SUITE ===

# --- TEST PURE CALCULATIONS ---

# Testing calculateBackoffDelay...

# ✅ calculateBackoffDelay OK

# Testing generateCampaignFingerprint...

# ✅ generateCampaignFingerprint OK

# Testing shouldPromoteToDm...

# ✅ shouldPromoteToDm OK

# Testing classifyOutcome...

# ✅ classifyOutcome OK

# Testing getNextDayBusinessHourWindow...

# ✅ getNextDayBusinessHourWindow OK

# Testing queueLog...

# [2026-07-18T07:33:42.197Z] [INFO] [QUEUE:TEST_QUEUE] [JOB:101] Test Message log { meta: 'test' }

# ✅ queueLog OK

# --- TEST SIDE EFFECTS & TRANSACTIONS ---

# ✅ isCampaignPaused OK

# ✅ recordCampaignEvent OK

# ✅ updateConnectionJobStatus & updateDmJobStatus OK

# Testing runInTransaction with successful commit...

# Testing runInTransaction with error rollback...

# ✅ runInTransaction & Rollback OK

# 🎉 ALL CAMPAIGN UTILS TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignUtils.test.js

ok 11 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignUtils.test.js

---

duration_ms: 165.878123
...

# ◇ injected env (0) from .env // tip: ⌘ suppress logs { quiet: true }

# ◇ injected env (0) from .env // tip: ⌘ enable debugging { debug: true }

# ◇ injected env (0) from .env // tip: ⌘ override existing { override: true }

# [2026-07-18T07:33:42.733Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# === RUNNING CAMPAIGN API ROUTES INTEGRATION TESTS ===

# Testing POST /api/campaigns — Validation...

# [2026-07-18T07:33:42.813Z] [INFO] [SERVER] GTSS Growth Engine v1.0.0 started on http://localhost:4568

# [2026-07-18T07:33:42.815Z] [INFO] [SOCKET] Socket.IO initialized

# [2026-07-18T07:33:42.815Z] [INFO] [SERVER] Background automation jobs disabled.

# ✅ POST /api/campaigns Validation — PASS

# Testing POST /api/campaigns — Success...

# [2026-07-18T07:33:42.852Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:1] Found 1 qualified leads. Commencing transactional enqueue.

# [2026-07-18T07:33:42.854Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:1] Successfully enqueued job pair for lead 9901.

# ✅ POST /api/campaigns Success — PASS

# Testing GET /api/campaigns — Pagination & filters...

# ✅ GET /api/campaigns List & Pagination — PASS

# Testing GET /api/campaigns/:id...

# ✅ GET /api/campaigns/:id Details & Metrics — PASS

# Testing POST /api/campaigns/:id/pause and resume...

# [2026-07-18T07:33:42.871Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:1] Campaign successfully paused (reclaimed conn=0 dm=0).

# [2026-07-18T07:33:42.875Z] [INFO] [QUEUE:ORCHESTRATOR] [JOB:1] Found 0 newly qualified leads to enqueue upon campaign resume.

# ✅ POST /api/campaigns/:id Pause & Resume — PASS

# Testing GET paginated sub-resources (events, connection-jobs, dm-jobs)...

# ✅ GET paginated sub-resources — PASS

# Testing POST /api/campaigns/run-\* triggers & lock protection...

# [2026-07-18T07:33:42.887Z] [INFO] [API] Manual run triggered for Connection Queue.

# [2026-07-18T07:33:42.887Z] [INFO] [SERVER] [CONNECTION-QUEUE] Starting campaign connection invite queue run...

# [2026-07-18T07:33:42.888Z] [INFO] [SERVER] [CONNECTION-QUEUE] Pre-flight inspection: Launching contexts for platforms: linkedin

# [2026-07-18T07:33:42.888Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Pre-launching browser context for platform: linkedin

# [2026-07-18T07:33:42.889Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.890Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.890Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Postponed job to next business hour window (Snoozed until: 2026-07-19T09:00:00.000Z).

# [2026-07-18T07:33:42.890Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# [2026-07-18T07:33:42.890Z] [INFO] [SERVER] [CONNECTION-QUEUE] Connection queue batch processing complete: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# [2026-07-18T07:33:42.890Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Closing background browser context for platform: linkedin

# [2026-07-18T07:33:42.891Z] [INFO] [BROWSER] Closed browser for linkedin — after failed attempt

# [2026-07-18T07:33:42.891Z] [WARN] [SESSION] Session marked invalid {"platform":"linkedin"}

# [2026-07-18T07:33:42.891Z] [WARN] [BROWSER] LinkedIn auth cookies missing on close; session remains invalid {"platform":"linkedin","mode":"persistent"}

# [2026-07-18T07:33:42.893Z] [INFO] [API] Manual run triggered for DM Queue.

# [2026-07-18T07:33:42.893Z] [INFO] [SERVER] [DM-QUEUE] Starting campaign DM messaging queue run...

# [2026-07-18T07:33:42.894Z] [INFO] [SERVER] [DM-QUEUE] Pre-flight inspection: Launching contexts for platforms: linkedin

# [2026-07-18T07:33:42.894Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Pre-launching browser context for platform: linkedin

# [2026-07-18T07:33:42.895Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:42.896Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] No eligible DM jobs found.

# [2026-07-18T07:33:42.896Z] [INFO] [SERVER] [DM-QUEUE] DM queue batch processing complete: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# [2026-07-18T07:33:42.896Z] [INFO] [SERVER] [CAMPAIGN-QUEUES] Closing background browser context for platform: linkedin

# [2026-07-18T07:33:42.896Z] [INFO] [BROWSER] Closed browser for linkedin — after failed attempt

# ✅ POST manual run triggers & lock protection — PASS

# Testing POST /api/campaigns/stop-queue...

# [2026-07-18T07:33:42.896Z] [WARN] [SESSION] Session marked invalid {"platform":"linkedin"}

# [2026-07-18T07:33:42.896Z] [WARN] [BROWSER] LinkedIn auth cookies missing on close; session remains invalid {"platform":"linkedin","mode":"persistent"}

# [2026-07-18T07:33:42.898Z] [INFO] [API] Campaign queue stop requested (inProgress=false, reclaimed conn=1 dm=1, lockCleared=true).

# ✅ POST /api/campaigns/stop-queue reclaim + lock clear — PASS

# 🎉 ALL CAMPAIGN ROUTE INTEGRATION TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignsRoutes.test.js

ok 12 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/campaignsRoutes.test.js

---

duration_ms: 772.326955
...

# === RUNNING CONNECTION QUEUE TESTS ===

# Testing T1 — Connection Action Success & DM Job Promotion...

# [2026-07-18T07:33:42.656Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.685Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.686Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Processing connection job for lead 9999 (https://instagram.com/test_queue_user).

# [2026-07-18T07:33:42.687Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Promoted related pending DM job for lead 9999 (Scheduled at: 2026-07-18T07:34:27.687Z).

# [2026-07-18T07:33:42.687Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Successfully sent connection invite.

# [2026-07-18T07:33:42.687Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":1,"success":1,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T2 — Daily limits & Warmup Snoozing...

# [2026-07-18T07:33:42.687Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Daily outreach rate limit met for campaign (1/0). Snoozed until tomorrow.

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T3 — Active Business Hours Window Compliance...

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Postponed job to next business hour window (Snoozed until: 2026-07-19T09:00:00.000Z).

# [2026-07-18T07:33:42.688Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T4 — Failure Retry Backoffs...

# [2026-07-18T07:33:42.689Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:33:42.689Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:33:42.689Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:1] Postponed job to next business hour window (Snoozed until: 2026-07-19T09:00:00.000Z).

# [2026-07-18T07:33:42.689Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# ❌ CONNECTION QUEUE TEST FAILED: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

# 0 !== 1

# at runConnectionQueueTests (/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/connectionQueue.test.js:152:10)

# at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {

# generatedMessage: true,

# code: 'ERR_ASSERTION',

# actual: 0,

# expected: 1,

# operator: 'strictEqual'

# }

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/connectionQueue.test.js

not ok 13 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/connectionQueue.test.js

---

duration_ms: 405.171237
location: '/home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/connectionQueue.test.js:1:1'
failureType: 'testCodeFailure'
exitCode: 1
signal: ~
error: 'test failed'
code: 'ERR_TEST_FAILURE'
...

# [2026-07-18T07:33:42.426Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# Subtest: getDailyActionCount ignores premium_required and failed outcomes

ok 27 - getDailyActionCount ignores premium_required and failed outcomes

---

duration_ms: 36.748012
...

# Subtest: isWithinLimit only trips after real successful sends reach the cap

ok 28 - isWithinLimit only trips after real successful sends reach the cap

---

duration_ms: 3.125857
...

# [2026-07-18T07:33:42.887Z] [INFO] [DISCOVERY_PERSISTENCE] Lead persistence batch completed {"total":3,"inserted":2,"duplicates":1,"invalid":0}

# Subtest: Instagram lead persistence keeps ig\_\* fields through mapping and insert

ok 29 - Instagram lead persistence keeps ig\_\* fields through mapping and insert

---

duration_ms: 4.804384
...

# Subtest: lead discovery sources only include lead-bearing social platforms

ok 30 - lead discovery sources only include lead-bearing social platforms

---

duration_ms: 2.504172
...

# Subtest: x discovery parser extracts normalized lead fields from a search snapshot

ok 31 - x discovery parser extracts normalized lead fields from a search snapshot

---

duration_ms: 2.333849
...

# Subtest: x discovery parser ignores non-profile search snapshots

ok 32 - x discovery parser ignores non-profile search snapshots

---

duration_ms: 0.250751
...

# Subtest: facebook discovery parser normalizes profile.php and extracts lead fields

ok 33 - facebook discovery parser normalizes profile.php and extracts lead fields

---

duration_ms: 1.370435
...

# Subtest: facebook discovery parser accepts mobile profile URLs and rejects reserved paths

ok 34 - facebook discovery parser accepts mobile profile URLs and rejects reserved paths

---

duration_ms: 0.83272
...

# === RUNNING DM MESSAGING QUEUE TESTS ===

# Testing T1 — LinkedIn Waiting Gate (Not Accepted yet)...

# [2026-07-18T07:33:43.353Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:43.392Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:33:43.393Z] [INFO] [QUEUE:DM_QUEUE] [JOB:1] LinkedIn connection not ready yet (status: pending). Snoozing DM check for 6 hours.

# [2026-07-18T07:33:43.393Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T2 — LinkedIn Outreach Success & Atomic Data Sync...

# [2026-07-18T07:33:43.394Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:43.394Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:33:43.397Z] [INFO] [QUEUE:DM_QUEUE] [JOB:1] Processing DM job for lead 9999 (https://linkedin.com/in/test_dm_user).

# [2026-07-18T07:33:43.398Z] [INFO] [QUEUE:DM_QUEUE] [JOB:1] Successfully sent DM to lead.

# [2026-07-18T07:33:43.399Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":1,"success":1,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T3 — Anti-Duplication Spam Blocker...

# [2026-07-18T07:33:43.400Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:43.400Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:33:43.401Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":0,"success":0,"failed":0,"skipped":1,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T4 — Temporary Failures & Retry scheduling...

# [2026-07-18T07:33:43.402Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:43.402Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:33:43.400Z] [WARN] [QUEUE:DM_QUEUE] [JOB:1] Prevented duplicate DM send to lead 9999. Skipping.

# [2026-07-18T07:33:43.404Z] [INFO] [QUEUE:DM_QUEUE] [JOB:1] Processing DM job for lead 9999 (https://linkedin.com/in/test_dm_user).

# [2026-07-18T07:33:43.404Z] [WARN] [QUEUE:DM_QUEUE] [JOB:1] Attempt 1 failed (failed: Message UI Locked). Retrying (1/2)...

# [2026-07-18T07:33:45.598Z] [WARN] [QUEUE:DM_QUEUE] [JOB:1] Attempt 2 failed (failed: Message UI Locked). Retrying (2/2)...

# [2026-07-18T07:33:48.827Z] [WARN] [QUEUE:DM_QUEUE] [JOB:1] Retryable DM failure: Message UI Locked. Scheduled retry at: 2026-07-18T08:35:42.322Z

# [2026-07-18T07:33:48.827Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":1,"success":0,"failed":1,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T5 — Pinned Message Ownership Safety Block...

# [2026-07-18T07:33:48.828Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:48.828Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

Error: -07-18T07:33:48.828Z] [ERROR] [QUEUE:DM_QUEUE] [JOB:2] SAFETY BLOCK: Pinned message \#10001 belongs to lead \#10002, not the current lead \#10001 ("Lilian Test"). Job failed to prevent a wrong-person send.

# [2026-07-18T07:33:48.828Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":0,"success":0,"failed":1,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# Testing T6 — Lead-scoped Approved Message Selection...

# [2026-07-18T07:33:48.829Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:33:48.829Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:33:48.830Z] [INFO] [QUEUE:DM_QUEUE] [JOB:3] Processing DM job for lead 10003 (https://linkedin.com/in/lilian-scoped).

# [2026-07-18T07:33:48.830Z] [INFO] [QUEUE:DM_QUEUE] [JOB:3] Successfully sent DM to lead.

# [2026-07-18T07:33:48.830Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":1,"success":1,"failed":0,"skipped":0,"blocked":0,"sessionExpired":0,"reclaimed":0,"stopped":false}

# 🎉 ALL DM MESSAGING QUEUE TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/dmQueue.test.js

ok 17 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/dmQueue.test.js

---

duration_ms: 5919.810061
...

# Subtest: DOM recorder only considers pages belonging to the selected platform

ok 36 - DOM recorder only considers pages belonging to the selected platform

---

duration_ms: 0.991395
...

# Subtest: envWriter

    # Subtest: prefers GTSS_ENV_PATH over defaults
    ok 1 - prefers GTSS_ENV_PATH over defaults
      ---
      duration_ms: 0.689697
      ...
    # Subtest: falls back to DOTENV_CONFIG_PATH when GTSS_ENV_PATH is unset
    ok 2 - falls back to DOTENV_CONFIG_PATH when GTSS_ENV_PATH is unset
      ---
      duration_ms: 0.202378
      ...
    # Subtest: writes and updates keys at the configured path
    ok 3 - writes and updates keys at the configured path
      ---
      duration_ms: 1.647024
      ...
    # Subtest: does not write into the server-root .env when GTSS_ENV_PATH is set
    ok 4 - does not write into the server-root .env when GTSS_ENV_PATH is set
      ---
      duration_ms: 0.355919
      ...
    1..4

ok 37 - envWriter

---

duration_ms: 5.988667
type: 'suite'
...

# Subtest: explicit message action types are normalized and honored

ok 38 - explicit message action types are normalized and honored

---

duration_ms: 0.925386
...

# Subtest: LinkedIn connect action does not reuse inbox DM body as connection note

ok 39 - LinkedIn connect action does not reuse inbox DM body as connection note

---

duration_ms: 5387.771255
...

# Subtest: LinkedIn DM action still sends the approved inbox message body

ok 40 - LinkedIn DM action still sends the approved inbox message body

---

duration_ms: 150.541472
...

# Subtest: outcomeObj declared in for-loop body scope is accessible after try/catch (the scope fix)

ok 41 - outcomeObj declared in for-loop body scope is accessible after try/catch (the scope fix)

---

duration_ms: 1.920472
...

# Subtest: the OLD (buggy) pattern would throw ReferenceError — confirm the test harness detects it

ok 42 - the OLD (buggy) pattern would throw ReferenceError — confirm the test harness detects it

---

duration_ms: 0.429132
...

# Subtest: closeStrayTabs is exported by browserBase and is callable

ok 43 - closeStrayTabs is exported by browserBase and is callable

---

duration_ms: 285.597962
...

# Subtest: closeStrayTabs is exported by dmQueue and connectionQueue paths

ok 44 - closeStrayTabs is exported by dmQueue and connectionQueue paths

---

duration_ms: 17.606457
...

# Subtest: recordOutcome handles null/undefined outcomeObj without throwing

ok 45 - recordOutcome handles null/undefined outcomeObj without throwing

---

duration_ms: 37.904451
...

# Subtest: platformAdapter runConnectionAction / runDmAction return a value for unhandled outcomes

ok 46 - platformAdapter runConnectionAction / runDmAction return a value for unhandled outcomes

---

duration_ms: 0.241275
...

# === RUNNING FACEBOOK INTEGRATION TESTS ===

# Testing T1 — Session Expiration / Checkpoint Challenge...

# Testing T2 — Profile Page Not Found / Restricted Page...

# Testing T3 — Friend connection invite success...

# Testing T4 — Already connected connection gate...

# Testing T5 — Messenger DM outreach flow...

# Testing T6 — platformAdapter Connection & DM Routing...

# [2026-07-18T07:34:17.841Z] [INFO] [QUEUE:ADAPTER] [JOB:facebook] Initiating connection action for lead 1234.

# [2026-07-18T07:34:26.870Z] [INFO] [QUEUE:ADAPTER] [JOB:facebook] Initiating DM action for lead 1234.

# 🎉 ALL FACEBOOK INTEGRATION TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/facebook.test.js

ok 22 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/facebook.test.js

---

duration_ms: 55468.01962
...

# Subtest: action fingerprints are stable for equivalent targets

ok 48 - action fingerprints are stable for equivalent targets

---

duration_ms: 1.216088
...

# Subtest: idempotency reservations prevent duplicate actions until released

ok 49 - idempotency reservations prevent duplicate actions until released

---

duration_ms: 0.524587
...

# Subtest: igFollowTracker - getFollowingCount, getUnfollowEligible, markUnfollowEligible, getFollowBackRate, isFollowing, getFollowsBySource

ok 50 - igFollowTracker - getFollowingCount, getUnfollowEligible, markUnfollowEligible, getFollowBackRate, isFollowing, getFollowsBySource

---

duration_ms: 1.609526
...

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/instagram/\_helpers.js

ok 25 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/instagram/\_helpers.js

---

duration_ms: 287.487316
...

# [2026-07-18T07:33:49.552Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @restricted_account to follow {}

# [2026-07-18T07:33:49.554Z] [WARN] [INSTAGRAM_BLOCK] Instagram action block detected: "try again later". Resuming at 2026-07-19T07:33:49.554Z

# [2026-07-18T07:33:49.554Z] [DEBUG] [NOTIFY] Email notification skipped; Gmail is not configured

Error: -07-18T07:33:49.554Z] [ERROR] [INSTAGRAM_OUTREACH] Instagram block detected: Instagram action block detected: "try again later" {}

# [2026-07-18T07:33:49.556Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @already_following to follow {}

# [2026-07-18T07:33:49.556Z] [INFO] [INSTAGRAM_OUTREACH] Already following @already_following {}

# [2026-07-18T07:33:49.557Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @pending_request to follow {}

# [2026-07-18T07:33:49.557Z] [INFO] [INSTAGRAM_OUTREACH] Follow request is already pending/requested for @pending_request {}

# [2026-07-18T07:33:49.558Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @fresh_user to follow {}

# [2026-07-18T07:33:49.558Z] [INFO] [INSTAGRAM_OUTREACH] Attempting to follow @fresh_user {}

# [2026-07-18T07:33:49.558Z] [INFO] [INSTAGRAM_OUTREACH] Dismissing private confirmation or info dialogue... {}

# [2026-07-18T07:33:49.559Z] [INFO] [INSTAGRAM_OUTREACH] Successfully followed @fresh_user (State: following) {}

# Subtest: followAccount detects action blocks successfully

ok 52 - followAccount detects action blocks successfully

---

duration_ms: 4.253161
...

# Subtest: followAccount identifies Already Following state

ok 53 - followAccount identifies Already Following state

---

duration_ms: 1.086174
...

# Subtest: followAccount identifies Requested state

ok 54 - followAccount identifies Requested state

---

duration_ms: 0.739774
...

# Subtest: followAccount handles successful follow and handles popup confirm

ok 55 - followAccount handles successful follow and handles popup confirm

---

duration_ms: 2.10681
...

# Subtest: Inbox helpers delegate to the working reply checker or report unsupported operations

ok 56 - Inbox helpers delegate to the working reply checker or report unsupported operations

---

duration_ms: 2.441031
...

# [2026-07-18T07:33:49.907Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @no_posts_user to like recent post {}

# [2026-07-18T07:33:49.908Z] [INFO] [INSTAGRAM_OUTREACH] No posts found {}

# [2026-07-18T07:33:49.909Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @fresh_post_user to like recent post {}

# [2026-07-18T07:33:49.909Z] [INFO] [INSTAGRAM_OUTREACH] Successfully liked recent post for @fresh_post_user {}

# [2026-07-18T07:33:49.909Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @liked_post_user to like recent post {}

# [2026-07-18T07:33:49.910Z] [INFO] [INSTAGRAM_OUTREACH] Post is already liked by us. {}

# [2026-07-18T07:33:49.910Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @miss_user to like recent post {}

# [2026-07-18T07:33:49.910Z] [WARN] [INSTAGRAM_OUTREACH] Selector miss: Like button not found after clicking post. {}

# Subtest: likeRecentPost handles no posts state gracefully

ok 57 - likeRecentPost handles no posts state gracefully

---

duration_ms: 2.611332
...

# Subtest: likeRecentPost clicks to like post and closes modal

ok 58 - likeRecentPost clicks to like post and closes modal

---

duration_ms: 0.695201
...

# Subtest: likeRecentPost detects already-liked state and skips click

ok 59 - likeRecentPost detects already-liked state and skips click

---

duration_ms: 0.389487
...

# Subtest: likeRecentPost returns selector_miss if like button is not found

ok 60 - likeRecentPost returns selector_miss if like button is not found

---

duration_ms: 0.412685
...

# Subtest: Instagram module exports all 10 outreach functions

ok 61 - Instagram module exports all 10 outreach functions

---

duration_ms: 0.856289
...

# Subtest: postCarousel executes successfully and updates DB

ok 62 - postCarousel executes successfully and updates DB

---

duration_ms: 32.428698
...

# Subtest: postCarousel fails when validation fails on a non-existent image

ok 63 - postCarousel fails when validation fails on a non-existent image

---

duration_ms: 0.297939
...

# Subtest: postCarousel falls back to profile page verification when toast not found

ok 64 - postCarousel falls back to profile page verification when toast not found

---

duration_ms: 8.552204
...

# [2026-07-18T07:33:50.353Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: NAVIGATE {}

# [2026-07-18T07:33:50.353Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to Instagram inbox to check for existing thread with @target_user {}

# [2026-07-18T07:33:50.353Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: DETECT_THREAD {}

# [2026-07-18T07:33:50.354Z] [INFO] [INSTAGRAM_OUTREACH] Found existing conversation thread for @target_user. Inspecting history... {}

# [2026-07-18T07:33:50.354Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: INSPECT_THREAD {}

# [2026-07-18T07:33:50.354Z] [INFO] [INSTAGRAM_OUTREACH] Already messaged @target_user (last message was sent by us) {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: NAVIGATE {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to Instagram inbox to check for existing thread with @reply_user {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: DETECT_THREAD {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] Found existing conversation thread for @reply_user. Inspecting history... {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: INSPECT_THREAD {}

# [2026-07-18T07:33:50.355Z] [INFO] [INSTAGRAM_OUTREACH] @reply_user has replied to us. Skipping re-send. {}

# [2026-07-18T07:33:50.356Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: NAVIGATE {}

# [2026-07-18T07:33:50.356Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to Instagram inbox to check for existing thread with @new_user {}

# [2026-07-18T07:33:50.356Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: DETECT_THREAD {}

# [2026-07-18T07:33:50.357Z] [INFO] [INSTAGRAM_OUTREACH] No existing thread found for @new_user in inbox. {}

# [2026-07-18T07:33:50.357Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: CREATE_NEW_THREAD {}

# [2026-07-18T07:33:50.357Z] [INFO] [INSTAGRAM_OUTREACH] Opening DM composer for @new_user {}

# [2026-07-18T07:33:50.357Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: TYPE_MESSAGE {}

# [2026-07-18T07:33:50.357Z] [INFO] [INSTAGRAM_OUTREACH] Composer ready — typing message {}

# [2026-07-18T07:33:50.358Z] [INFO] [INSTAGRAM_OUTREACH] Composer text did not match the outgoing message. Attempting backup write. {}

# [2026-07-18T07:33:50.358Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: CLICK_SEND {}

# [2026-07-18T07:33:50.358Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: AWAIT_CONFIRMATION_OR_DELIVERY {}

# [2026-07-18T07:33:50.358Z] [INFO] [INSTAGRAM_OUTREACH] Message request confirmation dialog detected. Transitioning to CONFIRM_REQUEST. {}

# [2026-07-18T07:33:50.358Z] [INFO] [INSTAGRAM_OUTREACH] Clicking send anyway/request button... {}

# [2026-07-18T07:33:50.359Z] [INFO] [INSTAGRAM_OUTREACH] DM sent to @new_user {}

# [2026-07-18T07:33:50.359Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: NAVIGATE {}

# [2026-07-18T07:33:50.359Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to Instagram inbox to check for existing thread with @error_user {}

# [2026-07-18T07:33:50.359Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: DETECT_THREAD {}

# [2026-07-18T07:33:50.360Z] [INFO] [INSTAGRAM_OUTREACH] No existing thread found for @error_user in inbox. {}

# [2026-07-18T07:33:50.360Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: CREATE_NEW_THREAD {}

# [2026-07-18T07:33:50.360Z] [INFO] [INSTAGRAM_OUTREACH] Opening DM composer for @error_user {}

# [2026-07-18T07:33:50.360Z] [INFO] [INSTAGRAM_OUTREACH] [DM_STATE_MACHINE] State: TYPE_MESSAGE {}

Error: -07-18T07:33:50.360Z] [ERROR] [APP] Instagram sendDM Failed {"username":"error_user","error":"composer_timeout"}
Error: -07-18T07:33:50.360Z] [ERROR] [INSTAGRAM_OUTREACH] Send DM failed: composer_timeout {}

# [2026-07-18T07:33:50.361Z] [WARN] [BROWSER] Failed to capture failure screenshot {"platform":"instagram","error":"page.screenshot is not a function"}

# Subtest: sendDM rejects empty messages or long messages

ok 65 - sendDM rejects empty messages or long messages

---

duration_ms: 1.226575
...

# Subtest: sendDM detects already_messaged state in existing thread check

ok 66 - sendDM detects already_messaged state in existing thread check

---

duration_ms: 2.657765
...

# Subtest: sendDM detects hadReply state when they sent the last message

ok 67 - sendDM detects hadReply state when they sent the last message

---

duration_ms: 0.976075
...

# Subtest: sendDM executes successful DM send with message request popups

ok 68 - sendDM executes successful DM send with message request popups

---

duration_ms: 3.093553
...

# Subtest: sendDM handles timeout and errors when composer fails to load

ok 69 - sendDM handles timeout and errors when composer fails to load

---

duration_ms: 2.06747
...

# [2026-07-18T07:33:50.571Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @not_following to unfollow {}

# [2026-07-18T07:33:50.572Z] [INFO] [INSTAGRAM_OUTREACH] Not currently following @not_following {}

# [2026-07-18T07:33:50.574Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @fresh_user to unfollow {}

# [2026-07-18T07:33:50.574Z] [INFO] [INSTAGRAM_OUTREACH] Clicking unfollow overlay trigger... {}

# [2026-07-18T07:33:50.574Z] [INFO] [INSTAGRAM_OUTREACH] Confirming unfollow choice... {}

# [2026-07-18T07:33:50.575Z] [INFO] [INSTAGRAM_OUTREACH] Successfully unfollowed @fresh_user {}

# Subtest: unfollowAccount identifies Not Following state

ok 70 - unfollowAccount identifies Not Following state

---

duration_ms: 3.211377
...

# Subtest: unfollowAccount executes unfollow with popup confirm and database update

ok 71 - unfollowAccount executes unfollow with popup confirm and database update

---

duration_ms: 1.722985
...

# [2026-07-18T07:33:50.689Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @no_story_user to view story {}

# [2026-07-18T07:33:50.690Z] [INFO] [INSTAGRAM_OUTREACH] No active story found {}

# [2026-07-18T07:33:50.691Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @story_user to view story {}

# Subtest: viewStory handles no-story case without error

ok 72 - viewStory handles no-story case without error

---

duration_ms: 2.198552
...

# [2026-07-18T07:33:56.117Z] [INFO] [INSTAGRAM_OUTREACH] Watching story... {}

# [2026-07-18T07:34:04.866Z] [INFO] [INSTAGRAM_OUTREACH] Successfully watched story for @story_user {}

# Subtest: viewStory waits 4-7 seconds before closing (verify via timing)

ok 73 - viewStory waits 4-7 seconds before closing (verify via timing)

---

duration_ms: 14176.282086
...

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/instagramDiscovery/\_helpers.js

ok 34 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/instagramDiscovery/\_helpers.js

---

duration_ms: 281.653801
...

# [2026-07-18T07:33:51.184Z] [INFO] [INSTAGRAM_DISCOVERY] Starting location Nairobi City discovery at https://www.instagram.com/explore/locations/12345/ {}

# [2026-07-18T07:33:51.185Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] iteration 1: visible=2, fresh=2, processed=0, saved=0, duplicates=0 {}

# [2026-07-18T07:33:51.185Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] Opening post https://www.instagram.com/p/location-1/ {}

# [2026-07-18T07:33:51.186Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @geo_alpha_user {}

# [2026-07-18T07:33:51.187Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.187Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @geo_alpha_user {"display_name":"Geo Alpha","username":"geo_alpha_user","bio":"boutique owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Boutique","email":"alpha@example.com","phone":"+254700000005","is_verified":true,"profile_url":"https://www.instagram.com/geo_alpha_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.187Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @geo_alpha_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Boutique) {"display_name":"Geo Alpha","username":"geo_alpha_user","bio":"boutique owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Boutique","email":"alpha@example.com","phone":"+254700000005","is_verified":true,"profile_url":"https://www.instagram.com/geo_alpha_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.187Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] Opening post https://www.instagram.com/p/location-2/ {}

# [2026-07-18T07:33:51.187Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @geo_beta_user {}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @geo_beta_user {"display_name":"Geo Beta","username":"geo_beta_user","bio":"cafe founder in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Cafe","email":"beta@example.com","phone":"+254700000006","is_verified":true,"profile_url":"https://www.instagram.com/geo_beta_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @geo_beta_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Cafe) {"display_name":"Geo Beta","username":"geo_beta_user","bio":"cafe founder in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Cafe","email":"beta@example.com","phone":"+254700000006","is_verified":true,"profile_url":"https://www.instagram.com/geo_beta_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] location Nairobi City pagination scroll result: links=3, scrollHeight=2000, grew=true {}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] iteration 2: visible=3, fresh=1, processed=2, saved=2, duplicates=2 {}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] Opening post https://www.instagram.com/p/location-3/ {}

# [2026-07-18T07:33:51.188Z] [INFO] [INSTAGRAM_DISCOVERY] Skipping @geo_beta_user (already processed in this discovery session) {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] location Nairobi City pagination scroll result: links=4, scrollHeight=3000, grew=true {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] iteration 3: visible=4, fresh=1, processed=3, saved=2, duplicates=5 {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] [location Nairobi City] Opening post https://www.instagram.com/p/location-4/ {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @geo_gamma_user {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @geo_gamma_user {"display_name":"Geo Gamma","username":"geo_gamma_user","bio":"salon owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Salon","email":"gamma@example.com","phone":"+254700000007","is_verified":true,"profile_url":"https://www.instagram.com/geo_gamma_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @geo_gamma_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Salon) {"display_name":"Geo Gamma","username":"geo_gamma_user","bio":"salon owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Salon","email":"gamma@example.com","phone":"+254700000007","is_verified":true,"profile_url":"https://www.instagram.com/geo_gamma_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.189Z] [INFO] [INSTAGRAM_DISCOVERY] location Nairobi City discovery finished (target reached). Saved 3 qualified leads. Metrics: {"iterations":3,"visibleLinks":4,"freshLinks":1,"processedLinks":4,"duplicateLinks":5,"duplicateUsernames":1,"dbDuplicates":0,"scrollAttempts":2} {}

# Subtest: discoverViaGeolocation scrolls forward without reloads, deduplicates, and grows lead counts

ok 75 - discoverViaGeolocation scrolls forward without reloads, deduplicates, and grows lead counts

---

duration_ms: 7.799491
...

# [2026-07-18T07:33:51.516Z] [INFO] [INSTAGRAM_DISCOVERY] Starting hashtag \#nairobi discovery at https://www.instagram.com/explore/tags/nairobi/ {}

# [2026-07-18T07:33:51.517Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] iteration 1: visible=2, fresh=2, processed=0, saved=0, duplicates=0 {}

# [2026-07-18T07:33:51.517Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] Opening post https://www.instagram.com/p/post-a/ {}

# [2026-07-18T07:33:51.518Z] [INFO] [INSTAGRAM_DISCOVERY] Skipping @duplicate_user (already exists in the database) {}

# [2026-07-18T07:33:51.518Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] Opening post https://www.instagram.com/p/post-b/ {}

# [2026-07-18T07:33:51.518Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @qualified_user {}

# [2026-07-18T07:33:51.519Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.519Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @qualified_user {"display_name":"Qualified User","username":"qualified_user","bio":"restaurant owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Restaurant","email":"qualified@example.com","phone":"+254700000002","is_verified":true,"profile_url":"https://www.instagram.com/qualified_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.520Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @qualified_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Restaurant) {"display_name":"Qualified User","username":"qualified_user","bio":"restaurant owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Restaurant","email":"qualified@example.com","phone":"+254700000002","is_verified":true,"profile_url":"https://www.instagram.com/qualified_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.520Z] [INFO] [INSTAGRAM_DISCOVERY] hashtag \#nairobi pagination scroll result: links=4, scrollHeight=2000, grew=true {}

# [2026-07-18T07:33:51.520Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] iteration 2: visible=4, fresh=2, processed=2, saved=1, duplicates=2 {}

# [2026-07-18T07:33:51.520Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] Opening post https://www.instagram.com/p/post-c/ {}

# [2026-07-18T07:33:51.520Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @qualified_geo_user {}

# [2026-07-18T07:33:51.521Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.521Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @qualified_geo_user {"display_name":"Qualified Geo User","username":"qualified_geo_user","bio":"cafe founder in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Cafe","email":"geo@example.com","phone":"+254700000003","is_verified":true,"profile_url":"https://www.instagram.com/qualified_geo_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.521Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @qualified_geo_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Cafe) {"display_name":"Qualified Geo User","username":"qualified_geo_user","bio":"cafe founder in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Cafe","email":"geo@example.com","phone":"+254700000003","is_verified":true,"profile_url":"https://www.instagram.com/qualified_geo_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.521Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] Opening post https://www.instagram.com/p/post-d/ {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] Skipping @qualified_user (already processed in this discovery session) {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] hashtag \#nairobi pagination scroll result: links=5, scrollHeight=3000, grew=true {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] iteration 3: visible=5, fresh=1, processed=4, saved=2, duplicates=6 {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] [hashtag \#nairobi] Opening post https://www.instagram.com/p/post-e/ {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @qualified_scroll_user {}

# [2026-07-18T07:33:51.522Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:51.523Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @qualified_scroll_user {"display_name":"Qualified Scroll User","username":"qualified_scroll_user","bio":"boutique owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Boutique","email":"scroll@example.com","phone":"+254700000004","is_verified":true,"profile_url":"https://www.instagram.com/qualified_scroll_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.523Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @qualified_scroll_user - Reason: Qualified: Match score 4 indicators: (website_in_bio, contact_info_present, bio_keywords_matched, business_category_Boutique) {"display_name":"Qualified Scroll User","username":"qualified_scroll_user","bio":"boutique owner in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Boutique","email":"scroll@example.com","phone":"+254700000004","is_verified":true,"profile_url":"https://www.instagram.com/qualified_scroll_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# [2026-07-18T07:33:51.523Z] [INFO] [INSTAGRAM_DISCOVERY] hashtag \#nairobi discovery finished (target reached). Saved 3 qualified leads. Metrics: {"iterations":3,"visibleLinks":5,"freshLinks":1,"processedLinks":5,"duplicateLinks":6,"duplicateUsernames":1,"dbDuplicates":1,"scrollAttempts":2} {}

# Subtest: discoverViaHashtag scrolls forward without reloads, deduplicates, and keeps loading new posts

ok 76 - discoverViaHashtag scrolls forward without reloads, deduplicates, and keeps loading new posts

---

duration_ms: 9.776926
...

# Subtest: filterBusinessProfile qualifies profiles correctly

ok 77 - filterBusinessProfile qualifies profiles correctly

---

duration_ms: 0.923789
...

# Subtest: parseIgCount parses standard metrics and handles K/M suffixes

ok 78 - parseIgCount parses standard metrics and handles K/M suffixes

---

duration_ms: 0.853408
...

# [2026-07-18T07:33:52.344Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @business_user {}

# [2026-07-18T07:33:52.345Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:52.346Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @business_user {"display_name":"The Nairobi Cafe","username":"business_user","bio":"Best restaurant grill in Nairobi","website":"https://example.com","follower_count":0,"following_count":0,"post_count":0,"is_business":true,"business_category":"Restaurant & Grill","email":"business@example.com","phone":"+254700000000","is_verified":true,"profile_url":"https://www.instagram.com/business_user/","last_post_date":"2026-05-17T20:00:00.000Z"}

# Subtest: scrapeProfileForLead scrapes all metadata fields and clicks first post

ok 79 - scrapeProfileForLead scrapes all metadata fields and clicks first post

---

duration_ms: 3.352256
...

# [2026-07-18T07:33:52.698Z] [INFO] [BROWSER] Starting daily Instagram session warmup (fastTrack: true)...

# [2026-07-18T07:33:52.698Z] [INFO] [BROWSER] Simulating organic browse on Instagram home feed...

# [2026-07-18T07:33:52.698Z] [INFO] [BROWSER] Completed organic scroll 1/3

# [2026-07-18T07:33:52.699Z] [INFO] [BROWSER] Completed organic scroll 2/3

# [2026-07-18T07:33:52.699Z] [INFO] [BROWSER] Completed organic scroll 3/3

# [2026-07-18T07:33:52.699Z] [INFO] [BROWSER] Warmup elapsed: 50ms. Waiting remaining 5974ms to complete...

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Starting suggested accounts crawl for @base_user (Lead ID: 1008)

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Navigating to https://www.instagram.com/base_user/

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Clicking Similar accounts toggle button to show suggestions

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Clicking See all button/link to expand suggestions list

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Found suggested usernames pool: suggested_user_1, suggested_user_2, already_leads_user

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Queued suggested user: @suggested_user_1

# [2026-07-18T07:33:52.701Z] [INFO] [IG_DISCOVERY] Queued suggested user: @suggested_user_2

# [2026-07-18T07:33:52.702Z] [INFO] [IG_DISCOVERY] Skipping @already_leads_user (already exists in database)

# [2026-07-18T07:33:52.702Z] [INFO] [IG_DISCOVERY] Successfully queued 2 suggested accounts for @base_user

# Subtest: 1. dailySessionWarmup fast-track configuration supports 5-10s duration

ok 80 - 1. dailySessionWarmup fast-track configuration supports 5-10s duration

---

duration_ms: 2.08695
...

# Subtest: 2. Action block reset handles DB settings updates

ok 81 - 2. Action block reset handles DB settings updates

---

duration_ms: 0.293125
...

# Subtest: 3. Selector failure health tracks warning thresholds

ok 82 - 3. Selector failure health tracks warning thresholds

---

duration_ms: 0.142559
...

# Subtest: 4. Suggested Accounts crawler populates ig_discovery_queue and skips duplicates

ok 83 - 4. Suggested Accounts crawler populates ig_discovery_queue and skips duplicates

---

duration_ms: 1.814492
...

# Subtest: 5. Instagram settings Express endpoints GET and POST respond correctly

ok 84 - 5. Instagram settings Express endpoints GET and POST respond correctly

---

duration_ms: 0.831166
...

# [2026-07-18T07:33:52.977Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping followers of @competitor1 {}

# [2026-07-18T07:33:52.979Z] [INFO] [INSTAGRAM_DISCOVERY] Discovered 2 followers in dialog list. {}

# [2026-07-18T07:33:52.979Z] [INFO] [INSTAGRAM_DISCOVERY] Processing follower: @lead_biz_owner {}

# [2026-07-18T07:33:52.979Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @lead_biz_owner {}

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Opening first grid post to extract publication time... {}

# [2026-07-18T07:33:52.980Z] [WARN] [IG_DISCOVERY] Failed to get last post date for lead_biz_owner: Cannot read properties of undefined (reading 'move')

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @lead_biz_owner {"display_name":"lead_biz_owner","username":"lead_biz_owner","bio":"restaurant owner in Nairobi. cafe. website: example.com","website":"https://example.com","follower_count":500,"following_count":300,"post_count":12,"is_business":true,"business_category":"lead_biz_owner","email":"/a[href^=\\"mailto:\\"]/","phone":"/a[href^=\\"tel:\\"]/","is_verified":true,"profile_url":"https://www.instagram.com/lead_biz_owner/","last_post_date":null}

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Saved qualified business lead: @lead_biz_owner - Reason: Qualified: Match score 6 indicators: (website_in_bio, contact_info_present, follower_count_in_range_500, bio_keywords_matched, active_posts_12, business_category_lead_biz_owner) {"display_name":"lead_biz_owner","username":"lead_biz_owner","bio":"restaurant owner in Nairobi. cafe. website: example.com","website":"https://example.com","follower_count":500,"following_count":300,"post_count":12,"is_business":true,"business_category":"lead_biz_owner","email":"/a[href^=\\"mailto:\\"]/","phone":"/a[href^=\\"tel:\\"]/","is_verified":true,"profile_url":"https://www.instagram.com/lead_biz_owner/","last_post_date":null}

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Navigating back to followers list... {}

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Processing follower: @noise_user {}

# [2026-07-18T07:33:52.980Z] [INFO] [INSTAGRAM_DISCOVERY] Scraping profile for @noise_user {}

# [2026-07-18T07:33:52.981Z] [INFO] [INSTAGRAM_DISCOVERY] Scraped data for @noise_user {"display_name":"noise_user","username":"noise_user","bio":"","website":null,"follower_count":10,"following_count":10,"post_count":1,"is_business":false,"business_category":"noise_user","email":null,"phone":null,"is_verified":true,"profile_url":"https://www.instagram.com/noise_user/","last_post_date":null}

# [2026-07-18T07:33:52.981Z] [INFO] [INSTAGRAM_DISCOVERY] Filtered out @noise_user - Reason: Disqualified: Match score 1 indicators: (business_category_noise_user) {"display_name":"noise_user","username":"noise_user","bio":"","website":null,"follower_count":10,"following_count":10,"post_count":1,"is_business":false,"business_category":"noise_user","email":null,"phone":null,"is_verified":true,"profile_url":"https://www.instagram.com/noise_user/","last_post_date":null}

# [2026-07-18T07:33:52.981Z] [INFO] [INSTAGRAM_DISCOVERY] Navigating back to followers list... {}

# [2026-07-18T07:33:52.981Z] [INFO] [INSTAGRAM_DISCOVERY] Competitor follower discovery finished. Successfully saved 1 qualified leads from @competitor1 {}

# Subtest: discoverViaCompetitorFollowers crawls followers, qualifies business leads, and ignores duplicates

ok 85 - discoverViaCompetitorFollowers crawls followers, qualifies business leads, and ignores duplicates

---

duration_ms: 4.96852
...

# [2026-07-18T07:33:53.283Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# Subtest: preparePlatformPostBody keeps X captions inside 280 characters

ok 86 - preparePlatformPostBody keeps X captions inside 280 characters

---

duration_ms: 66.088083
...

# Subtest: preparePlatformPostBody adds a trailing space after final Facebook hashtag

ok 87 - preparePlatformPostBody adds a trailing space after final Facebook hashtag

---

duration_ms: 0.830013
...

# Subtest: validateForFeed correctly qualifies and rejects formats, sizes, and ratios

ok 88 - validateForFeed correctly qualifies and rejects formats, sizes, and ratios

---

duration_ms: 3.837862
...

# Subtest: validateForStory correctly qualifies 9:16 and rejects 1:1

ok 89 - validateForStory correctly qualifies 9:16 and rejects 1:1

---

duration_ms: 1.114662
...

# Subtest: prepareForFeed converts 9:16 story media into a valid feed image

ok 90 - prepareForFeed converts 9:16 story media into a valid feed image

---

duration_ms: 54.929477
...

# Subtest: postImage successfully executes entire crop -> filter -> caption -> share sequence

ok 91 - postImage successfully executes entire crop -> filter -> caption -> share sequence

---

duration_ms: 3.486125
...

# Subtest: postImage prepares story-ratio media instead of failing feed validation

ok 92 - postImage prepares story-ratio media instead of failing feed validation

---

duration_ms: 49.091036
...

# Subtest: postStory successfully performs avatar click or direct navigation, upload, and story share

ok 93 - postStory successfully performs avatar click or direct navigation, upload, and story share

---

duration_ms: 1.979174
...

# Subtest: scheduledPoster postToInstagram dispatches story and feed types correctly

ok 94 - scheduledPoster postToInstagram dispatches story and feed types correctly

---

duration_ms: 2.187974
...

# [2026-07-18T07:33:53.744Z] [DEBUG] [INSTAGRAM_REPLY_CHECKER] SLACK_WEBHOOK_URL not configured. Skipping Slack alert.

# [2026-07-18T07:33:53.744Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Reply email alert sent successfully for lead ID 101

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Navigating to Instagram Primary Inbox...

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Detected 2 unread threads.

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Tracked lead @john_doe_ig has unread messages. Loading thread...

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Extracted message content from @john_doe_ig: "Yes, send me the documentation...."

# [2026-07-18T07:33:53.746Z] [DEBUG] [INSTAGRAM_REPLY_CHECKER] SLACK_WEBHOOK_URL not configured. Skipping Slack alert.

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Reply email alert sent successfully for lead ID 101

# [2026-07-18T07:33:53.746Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Unread thread from non-tracked profile @untracked_user_ig. Skipping.

# [2026-07-18T07:33:53.747Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Navigating to Message Requests page...

# [2026-07-18T07:33:53.747Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Detected 2 request items.

# [2026-07-18T07:33:53.747Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Tracked lead @john_doe_ig sent message request. Click thread...

# [2026-07-18T07:33:53.747Z] [DEBUG] [INSTAGRAM_REPLY_CHECKER] SLACK_WEBHOOK_URL not configured. Skipping Slack alert.

# [2026-07-18T07:33:53.748Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Reply email alert sent successfully for lead ID 101

# [2026-07-18T07:33:53.748Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Successfully accepted message request from @john_doe_ig

# [2026-07-18T07:33:53.748Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Request from non-tracked profile @untracked_user_ig. Skipping.

# [2026-07-18T07:33:53.748Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Initializing checkFollowBacks scan...

# [2026-07-18T07:33:53.748Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Detected active username @my_growth_account. Loading followers list...

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Scrolling followers container to lazy load entries...

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Discovered 3 loaded followers.

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Recorded follow-back state for lead @john_doe_ig

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Recorded follow-back state for lead @alice_smith_ig

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Follow-back checks successfully completed. Marked 2 profiles.

# [2026-07-18T07:33:53.749Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Initializing inbox reply scan...

# [2026-07-18T07:33:53.750Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Navigating to Instagram Primary Inbox...

# [2026-07-18T07:33:53.750Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Detected 0 unread threads.

# [2026-07-18T07:33:53.750Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Navigating to Message Requests page...

# [2026-07-18T07:33:53.750Z] [INFO] [INSTAGRAM_REPLY_CHECKER] Detected 0 request items.

# Subtest: updateLeadReply writes DB touchpoint, sets lead to replied, and dispatches HTML email alert

ok 95 - updateLeadReply writes DB touchpoint, sets lead to replied, and dispatches HTML email alert

---

duration_ms: 2.419622
...

# Subtest: checkPrimaryInbox parses unread direct threads, extracts name, and processes tracked lead

ok 96 - checkPrimaryInbox parses unread direct threads, extracts name, and processes tracked lead

---

duration_ms: 1.323594
...

# Subtest: checkMessageRequests navigates requests, reads tracked lead, accepts request

ok 97 - checkMessageRequests navigates requests, reads tracked lead, accepts request

---

duration_ms: 1.164441
...

# Subtest: checkFollowBacks detects profile username, scrolls follower dialog, matches leads

ok 98 - checkFollowBacks detects profile username, scrolls follower dialog, matches leads

---

duration_ms: 1.360943
...

# Subtest: checkInbox launches browser, runs warms, crawls inbox and requests, and closes context safely

ok 99 - checkInbox launches browser, runs warms, crawls inbox and requests, and closes context safely

---

duration_ms: 0.469946
...

# [2026-07-18T07:33:54.073Z] [INFO] [QUEUE:ADAPTER] [JOB:instagram] Initiating connection action for lead 42.

# [2026-07-18T07:33:54.093Z] [INFO] [QUEUE:ADAPTER] [JOB:instagram] Initiating DM action for lead 42.

# Subtest: Instagram username resolver prefers ig_username, then profile_url, then x_handle

ok 100 - Instagram username resolver prefers ig_username, then profile_url, then x_handle

---

duration_ms: 0.998498
...

# Subtest: Instagram follow and DM flows receive the resolved Instagram username

ok 101 - Instagram follow and DM flows receive the resolved Instagram username

---

duration_ms: 62.079917
...

# [2026-07-18T07:33:54.373Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @lead_follow to follow {}

# [2026-07-18T07:33:54.374Z] [INFO] [INSTAGRAM_OUTREACH] Attempting to follow @lead_follow {}

# [2026-07-18T07:33:54.374Z] [INFO] [INSTAGRAM_OUTREACH] Successfully followed @lead_follow (State: following) {}

# [2026-07-18T07:33:54.375Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @lead_story to view story {}

# [2026-07-18T07:33:54.376Z] [INFO] [INSTAGRAM_OUTREACH] No active story found {}

# [2026-07-18T07:33:54.376Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @lead_like to like recent post {}

# [2026-07-18T07:33:54.377Z] [INFO] [INSTAGRAM_OUTREACH] Successfully liked recent post for @lead_like {}

# [2026-07-18T07:33:54.380Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @fail_username to follow {}

Error: -07-18T07:33:54.380Z] [ERROR] [INSTAGRAM_OUTREACH] Could not find a follow control for @fail_username {}

# [2026-07-18T07:33:54.380Z] [INFO] [INSTAGRAM_OUTREACH] Navigating to @fail_username to follow {}

Error: -07-18T07:33:54.381Z] [ERROR] [INSTAGRAM_OUTREACH] Could not find a follow control for @fail_username {}

# [2026-07-18T07:33:54.382Z] [INFO] [INSTAGRAM_WARMUP] Skipping job run: today's IG actions (35) reached maximum limit (35)

# Subtest: startWarmupSequence creates sequence and sets status to pending

ok 102 - startWarmupSequence creates sequence and sets status to pending

---

duration_ms: 1.53875
...

# Subtest: getLeadsDueForStep filters leads correctly based on next_step_after

ok 103 - getLeadsDueForStep filters leads correctly based on next_step_after

---

duration_ms: 0.514977
...

# Subtest: advanceWarmupStep executes follow step successfully

ok 104 - advanceWarmupStep executes follow step successfully

---

duration_ms: 2.76811
...

# Subtest: advanceWarmupStep executes story view successfully

ok 105 - advanceWarmupStep executes story view successfully

---

duration_ms: 1.061722
...

# Subtest: advanceWarmupStep executes post like successfully

ok 106 - advanceWarmupStep executes post like successfully

---

duration_ms: 1.235998
...

# Subtest: advanceWarmupStep executes complete transition and drafts DM with correct message request status

ok 107 - advanceWarmupStep executes complete transition and drafts DM with correct message request status

---

duration_ms: 2.004341
...

# Subtest: advanceWarmupStep failure increments attempt count and transitions to failed state on 3rd retry

ok 108 - advanceWarmupStep failure increments attempt count and transitions to failed state on 3rd retry

---

duration_ms: 1.73607
...

# Subtest: instagramWarmupJob respects daily action limits

ok 109 - instagramWarmupJob respects daily action limits

---

duration_ms: 1.527456
...

# Subtest: increment_action_count inserts record in daily_actions correctly

ok 110 - increment_action_count inserts record in daily_actions correctly

---

duration_ms: 0.691446
...

# Subtest: isWithinLimit correctly enforces configuration limits and fallback mechanisms

ok 111 - isWithinLimit correctly enforces configuration limits and fallback mechanisms

---

duration_ms: 0.793464
...

# [2026-07-18T07:33:54.689Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# [2026-07-18T07:33:54.691Z] [INFO] [WARMUP_API_DISPATCH] Instagram warmup step delay settings updated.

# [2026-07-18T07:33:54.693Z] [INFO] [WARMUP_API_DISPATCH] [info]

# [2026-07-18T07:33:54.693Z] [INFO] [WARMUP_API_DISPATCH] Manually skipped sequence ID 501 to DM Ready.

# [2026-07-18T07:33:54.693Z] [INFO] [WARMUP_API_DISPATCH] Abandoned sequence ID 502 (lead ID 102).

# [2026-07-18T07:33:54.693Z] [INFO] [WARMUP_API_DISPATCH] Manual execution of Instagram warmup job triggered.

# Subtest: Instagram Warmup Pages & API Router Integration Tests

    # Subtest: GET /api/instagram/warmup-pipeline returns correct structure, stats and pipeline cards
    ok 1 - GET /api/instagram/warmup-pipeline returns correct structure, stats and pipeline cards
      ---
      duration_ms: 0.881772
      ...
    # Subtest: POST /api/settings/instagram saves step delay variables into SQLite database
    ok 2 - POST /api/settings/instagram saves step delay variables into SQLite database
      ---
      duration_ms: 0.535528
      ...
    # Subtest: POST /api/instagram/warmup/:sequenceId/skip completes sequence, generates draft messages
    ok 3 - POST /api/instagram/warmup/:sequenceId/skip completes sequence, generates draft messages
      ---
      duration_ms: 1.351087
      ...
    # Subtest: POST /api/instagram/warmup/:sequenceId/abandon marks sequence and lead as skipped
    ok 4 - POST /api/instagram/warmup/:sequenceId/abandon marks sequence and lead as skipped
      ---
      duration_ms: 0.394003
      ...
    # Subtest: POST /api/jobs/instagram-warmup/run triggers warmup job runner asynchronously
    ok 5 - POST /api/jobs/instagram-warmup/run triggers warmup job runner asynchronously
      ---
      duration_ms: 0.287721
      ...
    1..5

ok 112 - Instagram Warmup Pages & API Router Integration Tests

---

duration_ms: 7.117865
type: 'suite'
...

# [2026-07-18T07:33:54.697Z] [INFO] [INSTAGRAM_WARMUP] No Instagram leads due for warmup steps.

# [2026-07-18T07:33:54.697Z] [INFO] [WARMUP_API_DISPATCH] [info]

# Subtest: diag.flush() does not throw when AUTOMATION_ARTIFACTS_DIR is unwritable

ok 113 - diag.flush() does not throw when AUTOMATION_ARTIFACTS_DIR is unwritable

---

duration_ms: 0.870255
...

# Subtest: diag.flush() preserves the caller's original outcome when called from a finally block

ok 114 - diag.flush() preserves the caller's original outcome when called from a finally block

---

duration_ms: 0.232648
...

# Subtest: diag.isEnabled() reflects LINKEDIN_DM_DEBUG env

ok 115 - diag.isEnabled() reflects LINKEDIN_DM_DEBUG env

---

duration_ms: 0.075987
...

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/linkedinDmEditorSelection/\_helpers.js

ok 48 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/linkedinDmEditorSelection/\_helpers.js

---

duration_ms: 268.665852
...

# Subtest: bringToFront restores document.hasFocus() in a background tab (Bug \#1 regression)

ok 117 - bringToFront restores document.hasFocus() in a background tab (Bug \#1 regression) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.955717
...

# Subtest: waitForEditorInteractive resolves once pointer-events transitions from none to auto

ok 118 - waitForEditorInteractive resolves once pointer-events transitions from none to auto # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.742114
...

# Subtest: activateDmEditor dispatches pointerdown before mousedown so React onPointerDown fires

ok 119 - activateDmEditor dispatches pointerdown before mousedown so React onPointerDown fires # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.122618
...

# Subtest: LinkedIn DM editor selection prefers message body over subject field

ok 120 - LinkedIn DM editor selection prefers message body over subject field # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.755219
...

# Subtest: findBestDmEditor picks msg-form\_\_contenteditable over a generic contenteditable

ok 121 - findBestDmEditor picks msg-form\_\_contenteditable over a generic contenteditable # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.085572
...

# Subtest: findBestDmEditor picks the alternate compose modal's editor over a background conversation bubble (wrong-recipient regression)

ok 122 - findBestDmEditor picks the alternate compose modal's editor over a background conversation bubble (wrong-recipient regression) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.069778
...

# Subtest: findBestDmEditor never picks an editor from a minimized conversation bubble

ok 123 - findBestDmEditor never picks an editor from a minimized conversation bubble # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.059962
...

# Subtest: findBestDmEditor fails safe (returns null) when two equally-prominent chat bubbles are present and no compose modal

ok 124 - findBestDmEditor fails safe (returns null) when two equally-prominent chat bubbles are present and no compose modal # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.064373
...

# Subtest: verifyModalRecipient blocks send when the modal's recipient name does not match the expected lead

ok 125 - verifyModalRecipient blocks send when the modal's recipient name does not match the expected lead # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.769856
...

# Subtest: verifyModalRecipient blocks send when the modal has no extractable recipient name

ok 126 - verifyModalRecipient blocks send when the modal has no extractable recipient name # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.081048
...

# Subtest: verifyModalRecipient prefers profile-card recipient over message-group sender on existing threads

ok 127 - verifyModalRecipient prefers profile-card recipient over message-group sender on existing threads # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.083162
...

# Subtest: verifyModalRecipient reads the compose recipient chip on full-page /messaging/compose

ok 128 - verifyModalRecipient reads the compose recipient chip on full-page /messaging/compose # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.064951
...

# Subtest: verifyModalRecipient trusts matching compose URL when a stale sender name is scraped

ok 129 - verifyModalRecipient trusts matching compose URL when a stale sender name is scraped # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.070087
...

# Subtest: findProfileMessageAction locates the visible primary profile Message CTA

ok 130 - findProfileMessageAction locates the visible primary profile Message CTA # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.717796
...

# Subtest: detectMessagingBlocked classifies LinkedIn premium messaging blocks

ok 131 - detectMessagingBlocked classifies LinkedIn premium messaging blocks # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.082456
...

# Subtest: detectPremiumRequired classifies Build your dream team premium wall

ok 132 - detectPremiumRequired classifies Build your dream team premium wall # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.070077
...

# Subtest: detectPremiumRequired ignores For Business explore panel

ok 133 - detectPremiumRequired ignores For Business explore panel # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.056615
...

# Subtest: verifyModalRecipient ignores Status is reachable chrome text

ok 134 - verifyModalRecipient ignores Status is reachable chrome text # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.064907
...

# Subtest: findSendButtonForEditor tracks aria-disabled send buttons inside the composer

ok 135 - findSendButtonForEditor tracks aria-disabled send buttons inside the composer # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.792109
...

# Subtest: findSendButtonForEditor scopes Send lookup to the active composer

ok 136 - findSendButtonForEditor scopes Send lookup to the active composer # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.083654
...

# Subtest: clickSendButtonRobust clicks icon-only LinkedIn Send controls

ok 137 - clickSendButtonRobust clicks icon-only LinkedIn Send controls # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.063627
...

# Subtest: findSendButtonForEditor returns null when the editor's container has no send button — no page-root fallback (wrong-recipient regression)

ok 138 - findSendButtonForEditor returns null when the editor's container has no send button — no page-root fallback (wrong-recipient regression) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.061658
...

# Subtest: typeLikeHuman accepts LinkedIn's flattened textContent for multi-line DMs

ok 139 - typeLikeHuman accepts LinkedIn's flattened textContent for multi-line DMs # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.749228
...

# Subtest: typeLikeHuman can type after the editor node is replaced by a React re-render

ok 140 - typeLikeHuman can type after the editor node is replaced by a React re-render # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.078011
...

# Subtest: typeLikeHuman can still type when pointer events block regular clicks

ok 141 - typeLikeHuman can still type when pointer events block regular clicks # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.061859
...

# Subtest: typeFast writes the DM body into the message editor and leaves subject blank

ok 142 - typeFast writes the DM body into the message editor and leaves subject blank # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.057895
...

# Subtest: sendDirectMessage aborts and returns failed when message text is not in editor before send

ok 143 - sendDirectMessage aborts and returns failed when message text is not in editor before send # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.101151
...

# Subtest: pasteTextViaClipboard updates the editor and fires React-style paste/input events

ok 144 - pasteTextViaClipboard updates the editor and fires React-style paste/input events # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.050029
...

# Subtest: setEditorTextWithDomEvents writes text and dispatches input when keyboard input is ignored

ok 145 - setEditorTextWithDomEvents writes text and dispatches input when keyboard input is ignored # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.047123
...

# Subtest: forceClearDmDraft clears a stale 'Hi Letrise' draft left by a previous recipient

ok 146 - forceClearDmDraft clears a stale 'Hi Letrise' draft left by a previous recipient # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.746709
...

# Subtest: forceClearDmDraft returns true when the editor is already empty (no-op case)

ok 147 - forceClearDmDraft returns true when the editor is already empty (no-op case) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.102023
...

# Subtest: typeLikeHuman clears stale draft and types the new (correct) message

ok 148 - typeLikeHuman clears stale draft and types the new (correct) message # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.057762
...

# Subtest: typeLikeHuman returns false for empty text

ok 149 - typeLikeHuman returns false for empty text # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.055863
...

# Subtest: isStrayTabUrl correctly classifies known stray and non-stray URLs

ok 150 - isStrayTabUrl correctly classifies known stray and non-stray URLs

---

duration_ms: 0.21275
...

# Subtest: installStrayTabInterceptor closes a popup that navigates to /talent/job-posting-redirect

ok 151 - installStrayTabInterceptor closes a popup that navigates to /talent/job-posting-redirect # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.054953
...

# Subtest: installStrayTabInterceptor does NOT close a popup that navigates to a /in/ profile URL

ok 152 - installStrayTabInterceptor does NOT close a popup that navigates to a /in/ profile URL # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.046721
...

# Subtest: installStrayTabInterceptor is idempotent — calling twice replaces the handler

ok 153 - installStrayTabInterceptor is idempotent — calling twice replaces the handler

---

duration_ms: 0.141411
...

# Subtest: closeStrayTabs closes /job-posting tabs and preserves the /in/ profile tab

ok 154 - closeStrayTabs closes /job-posting tabs and preserves the /in/ profile tab # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.091714
...

# Subtest: detectMessagingContext returns mode=page when URL contains /messaging/

ok 155 - detectMessagingContext returns mode=page when URL contains /messaging/ # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.782623
...

# Subtest: detectMessagingContext returns mode=shadow when a legacy .msg-form editor is in the main page

ok 156 - detectMessagingContext returns mode=shadow when a legacy .msg-form editor is in the main page # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.083089
...

# Subtest: detectMessagingContext does NOT pick shadow mode for an EMPTY \#interop-outlet (regression)

ok 157 - detectMessagingContext does NOT pick shadow mode for an EMPTY \#interop-outlet (regression) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.063686
...

# Subtest: detectMessagingContext returns mode=shadow when an editor is inside \#interop-outlet

ok 158 - detectMessagingContext returns mode=shadow when an editor is inside \#interop-outlet # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.059804
...

# Subtest: detectMessagingContext returns mode=iframe when an editor is inside a /preload/ iframe (production case)

ok 159 - detectMessagingContext returns mode=iframe when an editor is inside a /preload/ iframe (production case) # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.104115
...

# Subtest: detectMessagingContext returns mode=iframe when a frame URL contains /messaging/compose

ok 160 - detectMessagingContext returns mode=iframe when a frame URL contains /messaging/compose # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.051873
...

# Subtest: iframe DM typing selects the message body instead of Subject

ok 161 - iframe DM typing selects the message body instead of Subject # SKIP Playwright browser binary is not installed at /home/runner/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome

---

duration_ms: 0.051863
...

# Subtest: LINKEDIN_OUTREACH_MODE env overrides stale DB setting

ok 162 - LINKEDIN_OUTREACH_MODE env overrides stale DB setting

---

duration_ms: 1.030736
...

# [2026-07-18T07:33:58.347Z] [WARN] [MASS-FOLLOW-PIPELINE] Skipping unsupported platform: myspace

# [2026-07-18T07:33:58.351Z] [INFO] [MASS-FOLLOW-PIPELINE] [a10115fa-9b0b-4418-8f5c-0352971849f8] start: Run started (trigger: test, platforms: instagram)

# [2026-07-18T07:33:58.375Z] [INFO] [PIPELINE] [mass_follow:a10115fa/start] Run started (trigger: test, platforms: instagram)

# [2026-07-18T07:33:58.376Z] [INFO] [MASS-FOLLOW-PIPELINE] [a10115fa-9b0b-4418-8f5c-0352971849f8] select_targets: No eligible targets — nothing to follow this run.

# [2026-07-18T07:33:58.376Z] [INFO] [PIPELINE] [mass_follow:a10115fa/select_targets] No eligible targets — nothing to follow this run.

# [2026-07-18T07:33:58.376Z] [WARN] [MASS-FOLLOW-PIPELINE] No supported platforms configured — skipping run

# [2026-07-18T07:33:58.377Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] start: Run started (trigger: test, platforms: x, instagram)

# [2026-07-18T07:33:58.377Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/start] Run started (trigger: test, platforms: x, instagram)

# [2026-07-18T07:33:58.377Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] select_targets: Selected 3 target(s) across 2 platform(s)

# [2026-07-18T07:33:58.377Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/select_targets] Selected 3 target(s) across 2 platform(s)

# [2026-07-18T07:33:58.378Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: Following https://x.com/u1 on x (1/3)

# [2026-07-18T07:33:58.378Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] Following https://x.com/u1 on x (1/3) {"targetId":14,"platform":"x","profileUrl":"https://x.com/u1"}

# [2026-07-18T07:33:58.378Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: https://x.com/u1 → sent

# [2026-07-18T07:33:58.378Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] https://x.com/u1 → sent

# Subtest: MASS_FOLLOW_STAGES is the expected triplet

ok 163 - MASS_FOLLOW_STAGES is the expected triplet

---

duration_ms: 1.07907
...

# Subtest: SUPPORTED_PLATFORMS includes the four mass-follow networks

ok 164 - SUPPORTED_PLATFORMS includes the four mass-follow networks

---

duration_ms: 0.130596
...

# Subtest: selectTargetsBatch returns pending rows and skips platforms at their daily limit

ok 165 - selectTargetsBatch returns pending rows and skips platforms at their daily limit

---

duration_ms: 1.191016
...

# Subtest: selectTargetsBatch skips a platform that has reached its weekly follow limit

ok 166 - selectTargetsBatch skips a platform that has reached its weekly follow limit

---

duration_ms: 1.643995
...

# Subtest: selectTargetsBatch excludes platforms that are not supported

ok 167 - selectTargetsBatch excludes platforms that are not supported

---

duration_ms: 1.191476
...

# Subtest: selectTargetsBatch does not return failed targets that haven't reached their backoff window

ok 168 - selectTargetsBatch does not return failed targets that haven't reached their backoff window

---

duration_ms: 0.596409
...

# Subtest: recordOutcome flips target to 'sent' and writes a daily_actions row on success

ok 169 - recordOutcome flips target to 'sent' and writes a daily_actions row on success

---

duration_ms: 0.44679
...

# Subtest: recordOutcome flips target to 'skipped' when adapter returns 'skipped'

ok 170 - recordOutcome flips target to 'skipped' when adapter returns 'skipped'

---

duration_ms: 0.295792
...

# Subtest: recordOutcome increments retry_count and schedules backoff for transient failures

ok 171 - recordOutcome increments retry_count and schedules backoff for transient failures

---

duration_ms: 0.377292
...

# Subtest: recordOutcome marks target as terminal 'failed' after max_retries is exceeded

ok 172 - recordOutcome marks target as terminal 'failed' after max_retries is exceeded

---

duration_ms: 0.392155
...

# Subtest: recordOutcome maps 'session_required' to 'pending' so the next run retries

ok 173 - recordOutcome maps 'session_required' to 'pending' so the next run retries

---

duration_ms: 0.254504
...

# Subtest: runMassFollowPipelineNow returns non-success with no targets when the queue is empty

ok 174 - runMassFollowPipelineNow returns non-success with no targets when the queue is empty

---

duration_ms: 25.246538
...

# Subtest: runMassFollowPipelineNow returns a hard error when no supported platforms are configured

ok 175 - runMassFollowPipelineNow returns a hard error when no supported platforms are configured

---

duration_ms: 0.416718
...

# [2026-07-18T07:34:03.387Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: Following https://x.com/u2 on x (2/3)

# [2026-07-18T07:34:03.387Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] Following https://x.com/u2 on x (2/3) {"targetId":15,"platform":"x","profileUrl":"https://x.com/u2"}

# [2026-07-18T07:34:03.387Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: https://x.com/u2 → sent

# [2026-07-18T07:34:03.387Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] https://x.com/u2 → sent

# [2026-07-18T07:34:08.396Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: Following https://instagram.com/v1 on instagram (3/3)

# [2026-07-18T07:34:08.396Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] Following https://instagram.com/v1 on instagram (3/3) {"targetId":16,"platform":"instagram","profileUrl":"https://instagram.com/v1"}

# [2026-07-18T07:34:08.396Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] follow: https://instagram.com/v1 → skipped

# [2026-07-18T07:34:08.396Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/follow] https://instagram.com/v1 → skipped

# [2026-07-18T07:34:08.397Z] [INFO] [MASS-FOLLOW-PIPELINE] [3cb55d8c-eb29-4f7a-9529-27be48c713db] report: Run complete — sent: 2, skipped: 1, failed: 0, pending: 0

# [2026-07-18T07:34:08.397Z] [INFO] [PIPELINE] [mass_follow:3cb55d8c/report] Run complete — sent: 2, skipped: 1, failed: 0, pending: 0 {"total":3,"sent":2,"skipped":1,"failed":0,"pending":0,"perPlatform":{"x":{"sent":2,"skipped":0,"failed":0,"pending":0},"instagram":{"sent":0,"skipped":1,"failed":0,"pending":0}},"skippedPlatforms":[]}

# [2026-07-18T07:34:08.398Z] [INFO] [MASS-FOLLOW-PIPELINE] [84f547a8-b04a-4404-a11c-26a1b7ce5b44] start: Run started (trigger: test, platforms: x)

# [2026-07-18T07:34:08.398Z] [INFO] [PIPELINE] [mass_follow:84f547a8/start] Run started (trigger: test, platforms: x)

# [2026-07-18T07:34:08.481Z] [INFO] [MASS-FOLLOW-PIPELINE] [84f547a8-b04a-4404-a11c-26a1b7ce5b44] select_targets: Selected 2 target(s) across 1 platform(s)

# [2026-07-18T07:34:08.481Z] [INFO] [PIPELINE] [mass_follow:84f547a8/select_targets] Selected 2 target(s) across 1 platform(s)

# [2026-07-18T07:34:08.481Z] [INFO] [MASS-FOLLOW-PIPELINE] [84f547a8-b04a-4404-a11c-26a1b7ce5b44] follow: Following https://x.com/rate1 on x (1/2)

# [2026-07-18T07:34:08.481Z] [INFO] [PIPELINE] [mass_follow:84f547a8/follow] Following https://x.com/rate1 on x (1/2) {"targetId":17,"platform":"x","profileUrl":"https://x.com/rate1"}

# [2026-07-18T07:34:08.482Z] [INFO] [MASS-FOLLOW-PIPELINE] [84f547a8-b04a-4404-a11c-26a1b7ce5b44] follow: x reported a rate limit; holding remaining x targets for a later run

# [2026-07-18T07:34:08.482Z] [WARN] [PIPELINE] [mass_follow:84f547a8/follow] x reported a rate limit; holding remaining x targets for a later run

# [2026-07-18T07:34:08.482Z] [INFO] [MASS-FOLLOW-PIPELINE] [84f547a8-b04a-4404-a11c-26a1b7ce5b44] follow: https://x.com/rate1 → pending

# [2026-07-18T07:34:08.482Z] [INFO] [PIPELINE] [mass_follow:84f547a8/follow] https://x.com/rate1 → pending

# Subtest: runMassFollowPipelineNow follows all eligible targets and writes per-platform summaries

ok 176 - runMassFollowPipelineNow follows all eligible targets and writes per-platform summaries

---

duration_ms: 10020.883472
...

# Subtest: runMassFollowPipelineNow holds remaining platform targets after a rate-limit response

ok 177 - runMassFollowPipelineNow holds remaining platform targets after a rate-limit response

---

duration_ms: 5091.392608
...

# [2026-07-18T07:34:05.273Z] [INFO] [MESSAGES] Skipping AI message generation — no GEMINI_API_KEY and no CDP endpoint; using template

# [2026-07-18T07:34:05.275Z] [INFO] [MESSAGES] Skipping AI message generation — no GEMINI_API_KEY and no CDP endpoint; using template

# Subtest: Message generation template resolution and character limit enforcement

ok 178 - Message generation template resolution and character limit enforcement

---

duration_ms: 4.445629
...

# ◇ injected env (0) from .env // tip: ◈ encrypted .env [www.dotenvx.com]

# ◇ injected env (0) from .env // tip: ⌘ suppress logs { quiet: true }

# ◇ injected env (0) from .env // tip: ⌁ auth for agents [www.vestauth.com]

# [2026-07-18T07:34:05.619Z] [INFO] [DB] Migrated 2 keywords from keywords.json to context store

# === RUNNING CAMPAIGN OBSERVABILITY LAYER INTEGRATION TESTS ===

# Testing T1 — Event recording DB write, Socket.IO emits, and SSE streams...

# ✅ T1 Event Recording & Broadcasts — PASS

# Testing T2 — Queue log streaming via Socket.IO...

# [2026-07-18T07:34:05.659Z] [WARN] [QUEUE:DM_QUEUE] [JOB:1024] Slow platform page load detected. { latencyMs: 5000 }

# ✅ T2 Queue Log Streaming — PASS

# Testing T3 — Live SSE stream router endpoint /api/campaigns/:id/stream...

# [2026-07-18T07:34:05.668Z] [INFO] [SERVER] GTSS Growth Engine v1.0.0 started on http://localhost:4569

# [2026-07-18T07:34:05.668Z] [INFO] [SERVER] Background automation jobs disabled.

# ✅ T3 SSE HTTP Endpoint — PASS

# Testing T4 — GET /api/campaigns/:id/events JSON metadata parser...

# ✅ T4 Event Metadata Parsing Route — PASS

# Testing T5 — Session expiry email notification triggers...

# [2026-07-18T07:34:05.695Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Executing connection queue processing loop...

# [2026-07-18T07:34:05.696Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Found 1 eligible connection jobs for active campaigns.

# [2026-07-18T07:34:05.696Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:9990] Processing connection job for lead 9990 (https://linkedin.com/in/jane_obs).

# [2026-07-18T07:34:05.697Z] [WARN] [QUEUE:CONNECTION_QUEUE] [JOB:9990] Platform session validation expired. Postponing job.

# [2026-07-18T07:34:05.697Z] [INFO] [QUEUE:CONNECTION_QUEUE] [JOB:SYSTEM] Connection queue batch finished: {"processed":1,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":1,"reclaimed":0,"stopped":false}

# [2026-07-18T07:34:05.698Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Executing DM messaging queue processing loop...

# [2026-07-18T07:34:05.698Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] Found 1 eligible DM jobs for active campaigns.

# [2026-07-18T07:34:05.699Z] [INFO] [QUEUE:DM_QUEUE] [JOB:9990] Processing DM job for lead 9990 (https://linkedin.com/in/jane_obs).

# [2026-07-18T07:34:05.700Z] [WARN] [QUEUE:DM_QUEUE] [JOB:9990] Platform session validation expired. Postponing job.

# [2026-07-18T07:34:05.700Z] [INFO] [QUEUE:DM_QUEUE] [JOB:SYSTEM] DM messaging queue batch finished: {"processed":1,"success":0,"failed":0,"skipped":0,"blocked":0,"sessionExpired":1,"reclaimed":0,"stopped":false}

# ✅ T5 Session Expiry Notifications — PASS

# 🎉 ALL CAMPAIGN OBSERVABILITY TESTS PASSED SUCCESSFULLY! EXITING 0.

# Observability test server shut down.

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/observability.test.js

ok 61 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/observability.test.js

---

duration_ms: 4424.893147
...

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/pipelineControls/\_mockDb.js

ok 62 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/pipelineControls/\_mockDb.js

---

duration_ms: 19.41318
...

# Subtest: canStart returns true for a manual run on a disabled schedule

ok 181 - canStart returns true for a manual run on a disabled schedule

---

duration_ms: 6.45902
...

# Subtest: canStart returns false when paused and no force

ok 182 - canStart returns false when paused and no force

---

duration_ms: 2.452531
...

# Subtest: hasStuckDbRow detects transient-state rows

ok 183 - hasStuckDbRow detects transient-state rows

---

duration_ms: 6.249543
...

# Subtest: isExecutionProgressing returns true for recently-updated rows

ok 184 - isExecutionProgressing returns true for recently-updated rows

---

duration_ms: 2.444969
...

# Subtest: createExecution refuses when an active execution already exists

ok 185 - createExecution refuses when an active execution already exists

---

duration_ms: 29.199814
...

# Subtest: markExecutionFailed does not overwrite a STOPPED state

ok 186 - markExecutionFailed does not overwrite a STOPPED state

---

duration_ms: 1.273397
...

# Subtest: forceClearExecution marks stuck DB rows as failed and resets schedule state

ok 187 - forceClearExecution marks stuck DB rows as failed and resets schedule state

---

duration_ms: 35.347991
...

# Subtest: forceClearExecution clears the schedule-level pause flag by default

ok 188 - forceClearExecution clears the schedule-level pause flag by default

---

duration_ms: 1.468688
...

# Subtest: forceClearExecution preserves the pause flag when keepPauseIntent is true

ok 189 - forceClearExecution preserves the pause flag when keepPauseIntent is true

---

duration_ms: 2.378753
...

# Subtest: forceClearExecution releases the content pipeline DB lock

ok 190 - forceClearExecution releases the content pipeline DB lock

---

duration_ms: 1.610201
...

# Subtest: requestResume on a schedule-level pause (no active execution) clears the pause flag

ok 191 - requestResume on a schedule-level pause (no active execution) clears the pause flag

---

duration_ms: 33.460947
...

# Subtest: requestStop on a schedule-level pause (no active execution) sweeps the stuck DB row

ok 192 - requestStop on a schedule-level pause (no active execution) sweeps the stuck DB row

---

duration_ms: 35.458793
...

# Subtest: Pipeline Architecture Generalization & Multi-Platform Validation

    # Subtest: Discovery Pipeline processes mixed keywords and respects DISCOVERY_PLATFORMS overrides
    ok 1 - Discovery Pipeline processes mixed keywords and respects DISCOVERY_PLATFORMS overrides
      ---
      duration_ms: 1.404685
      ...
    # Subtest: Send Pipeline targets only active platforms with queued messages
    ok 2 - Send Pipeline targets only active platforms with queued messages
      ---
      duration_ms: 1.225497
      ...
    1..2

ok 193 - Pipeline Architecture Generalization & Multi-Platform Validation

---

duration_ms: 3.780981
...

# [2026-07-18T07:34:10.466Z] [INFO] [PIPELINE-QUEUE] Queued content run second {"position":1,"activeRun":null}

# Subtest: pipeline queue runs only one pipeline at a time and preserves order

ok 194 - pipeline queue runs only one pipeline at a time and preserves order

---

duration_ms: 32.329375
...

# === RUNNING PLATFORM ADAPTER TESTS ===

# Testing LinkedIn Connection Success...

# [2026-07-18T07:34:10.763Z] [INFO] [QUEUE:ADAPTER] [JOB:linkedin] Initiating connection action for lead 101.

# Testing LinkedIn Connection Already Connected...

# [2026-07-18T07:34:10.785Z] [INFO] [QUEUE:ADAPTER] [JOB:linkedin] Initiating connection action for lead 101.

# Testing LinkedIn Connection Timeout Error...

# [2026-07-18T07:34:10.785Z] [INFO] [QUEUE:ADAPTER] [JOB:linkedin] Initiating connection action for lead 101.

Error: -07-18T07:34:10.785Z] [ERROR] [QUEUE:ADAPTER] [JOB:linkedin] connection action failed: Timeout waiting for element (Retryable: true)

# Testing LinkedIn Connection Session Expired Error...

# [2026-07-18T07:34:10.785Z] [INFO] [QUEUE:ADAPTER] [JOB:linkedin] Initiating connection action for lead 101.

Error: -07-18T07:34:10.785Z] [ERROR] [QUEUE:ADAPTER] [JOB:linkedin] Expired or invalid session detected during connection action.

# Testing LinkedIn DM Premium Required Paywall...

# [2026-07-18T07:34:10.786Z] [INFO] [QUEUE:ADAPTER] [JOB:linkedin] Initiating DM action for lead 101.

# Testing X Follow Suspended Account...

# [2026-07-18T07:34:10.786Z] [INFO] [QUEUE:ADAPTER] [JOB:x] Initiating connection action for lead 101.

# Testing X DM Not Found Account...

# [2026-07-18T07:34:10.786Z] [INFO] [QUEUE:ADAPTER] [JOB:x] Initiating DM action for lead 101.

# Testing Instagram Follow Account Blocked...

# [2026-07-18T07:34:10.786Z] [INFO] [QUEUE:ADAPTER] [JOB:instagram] Initiating connection action for lead 101.

# Testing Instagram DM Already Messaged...

# [2026-07-18T07:34:10.787Z] [INFO] [QUEUE:ADAPTER] [JOB:instagram] Initiating DM action for lead 101.

# Testing Unsupported Platform Validation...

# [2026-07-18T07:34:10.787Z] [INFO] [QUEUE:ADAPTER] [JOB:pinterest] Initiating connection action for lead 101.

# 🎉 ALL PLATFORM ADAPTER TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/platformAdapter.test.js

ok 70 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/platformAdapter.test.js

---

duration_ms: 315.968739
...

# === RUNNING PLATFORM POLICIES & LIMITS TEST ===

# Verifying backward compatibility properties...

# ✅ T1: Backward compatibility daily limits match perfectly.

# Verifying extended hourly limits in limits.js...

# ✅ T2: Nested hourly/queue limits mapped perfectly.

# Verifying platformPolicies.js rules schema...

# ✅ T3: Platform policies rules layout structured perfectly.

# 🎉 ALL PLATFORM POLICY CONFIGURATION TESTS PASSED SUCCESSFULLY!

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/platformPolicies.test.js

ok 71 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/platformPolicies.test.js

---

duration_ms: 28.361605
...

# Subtest: automation queues an approved Gemini message, not an auto-approved fallback

ok 197 - automation queues an approved Gemini message, not an auto-approved fallback

---

duration_ms: 1.514999
...

# Subtest: AI body beats an older founder-approved template in the send queue

ok 198 - AI body beats an older founder-approved template in the send queue

---

duration_ms: 0.65418
...

# Subtest: pipeline-auto template alone is never auto-sendable

ok 199 - pipeline-auto template alone is never auto-sendable

---

duration_ms: 0.568494
...

# Subtest: founder template is sendable only when no AI body exists

ok 200 - founder template is sendable only when no AI body exists

---

duration_ms: 0.576122
...

# Subtest: retireTemplateMessages skips template drafts so AI owns the queue

ok 201 - retireTemplateMessages skips template drafts so AI owns the queue

---

duration_ms: 0.438636
...

# Subtest: needsAiMessageSql treats template-only leads as still needing generation

ok 202 - needsAiMessageSql treats template-only leads as still needing generation

---

duration_ms: 0.382527
...

# Subtest: listFallbackLeads includes message_approved leads stuck on template fallback

ok 203 - listFallbackLeads includes message_approved leads stuck on template fallback

---

duration_ms: 1.130811
...

# === reclaimStuckJobs unit tests ===

# ✅ global reclaim — PASS

# ✅ per-campaign reclaim — PASS

# ✅ per-job reclaimIfStillRunning — PASS

# 🎉 reclaimStuckJobs tests passed

# Subtest: /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/reclaimStuckJobs.test.js

ok 73 - /home/runner/work/gtss_growth_automation/gtss_growth_automation/gtss-growth-engine/test/reclaimStuckJobs.test.js

---

duration_ms: 32.672686
...

# Subtest: X (Twitter) outreach module exports all required interface functions

ok 205 - X (Twitter) outreach module exports all required interface functions

---

duration_ms: 0.907472
...

# Subtest: Backward compatibility mapping connects sendConnectionRequest to followUser

ok 206 - Backward compatibility mapping connects sendConnectionRequest to followUser

---

duration_ms: 0.099376
...

# Subtest: X_OUTREACH_MODE env overrides DB setting and controls action types
