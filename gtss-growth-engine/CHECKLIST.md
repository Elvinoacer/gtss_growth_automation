# GTSS Growth Engine — Verification Checklist

This checklist tracks the end-to-end functionality of the GTSS Growth Engine system.

## 1. Authentication & Security
- [ ] **Login with correct passphrase**
  - Action: Visit `/login`, enter correct passphrase.
  - Expected: Redirected to Dashboard (`/`).
- [ ] **Login with wrong passphrase**
  - Action: Visit `/login`, enter incorrect passphrase.
  - Expected: Error message shown, remains on login page.
- [ ] **Startup Checks**
  - Action: Delete `ENCRYPTION_KEY` from `.env` and start server.
  - Expected: Server exits with error "ENCRYPTION_KEY is missing".

## 2. Dashboard & Analytics
- [ ] **Dashboard Stats Load**
  - Action: Visit `/`.
  - Expected: 6 stat cards show real data from database.
- [ ] **Funnel Chart**
  - Action: Check chart on Dashboard.
  - Expected: Horizontal bars show lead distribution; toggle between "All Platforms" and "By Platform" works.
- [ ] **CSV Export**
  - Action: Click "Export Data" -> "Leads".
  - Expected: File `leads_export.csv` downloads with correct columns.

## 3. Lead Discovery
- [ ] **Start Discovery Run**
  - Action: Go to `/discovery`, enter keyword "Nairobi Restaurant", select LinkedIn, click "Start".
  - Expected: SSE log shows "Searching...", leads appear in the discovery list, and are saved to DB.

## 4. Qualification
- [ ] **Run Qualification Batch**
  - Action: Go to `/qualification`, select discovered leads, click "Qualify Selected".
  - Expected: Gemini API called, leads get scores/reasons, status changes to 'qualified' or 'deprioritized'.
- [ ] **Gemini Retry Logic**
  - Action: Mock a 429 response from Gemini (simulated).
  - Expected: Logger shows "Retrying after 60s", qualification eventually succeeds or marks as failed.

## 5. Messaging
- [ ] **Generate Message Variants**
  - Action: Go to `/messages`, select a qualified lead, click "Generate Messages".
  - Expected: Variant A and B are returned and stored in DB.
- [ ] **Approve Variant**
  - Action: Click "Approve Variant A".
  - Expected: Message status becomes 'approved', lead is ready for automation.

## 6. Outreach Automation
- [ ] **Run Automation Queue**
  - Action: Go to `/automation`, click "Start Process".
  - Expected: Approved messages are sent via Playwright, lead status updates to 'messaged'.
- [ ] **Daily Limit Enforcement**
  - Action: Set LinkedIn limit to 1, send 1 message, try to send another.
  - Expected: SSE log shows "Daily limit reached. Skipping.", message remains 'approved'.
- [ ] **Session Expiry Detection**
  - Action: Use an expired cookie for a platform.
  - Expected: Automation detects login page, updates session as invalid, emits 'session_expired' event.

## 7. CRM & Follow-up
- [ ] **Detect Replies**
  - Action: Click "Detect New Replies" in CRM.
  - Expected: System checks platform inboxes, updates leads to 'replied' if found.
- [ ] **Manual Status Change**
  - Action: Move lead from 'replied' to 'meeting_booked'.
  - Expected: DB updated, touchpoint recorded.

## 8. Content Scheduler
- [ ] **Schedule a Post**
  - Action: Go to `/scheduler`, compose post for LinkedIn/X, set time, click "Schedule".
  - Expected: Appears in calendar and sidebar queue.
- [ ] **Automated Publishing**
  - Action: Wait for scheduled time.
  - Expected: `scheduledPoster` cron job triggers Playwright and publishes the post.

## 9. Settings
- [ ] **Save Gemini Key**
  - Action: Update key in `/settings`, click "Test".
  - Expected: "Connection valid" message.
- [ ] **Clear All Data**
  - Action: Click "Reset System" (if implemented).
  - Expected: Tables truncated, system remains bootable.

---
**Acceptance Result:** [ ] PASS / [ ] FAIL
**Tester:** Antigravity
**Date:** 2026-05-14
