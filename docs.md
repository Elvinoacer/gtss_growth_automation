# GTSS Growth Engine — System Requirements Specification

**Version:** 1.1 (Zero-Cost Edition)  
**Author:** Elvin Omondi, GTSS  
**Date:** May 2026  
**Status:** Draft

---

## 1. Overview

The GTSS Growth Engine is an internal, semi-automated social media growth and outreach system designed to acquire leads and grow brand presence across **LinkedIn**, **X (Twitter)**, **Facebook**, and **Instagram**. It is engineered to replace manual, ad-hoc outreach with a structured, data-driven pipeline that the founder operates — not replaces.

The system is built on the principle of **high-quality, low-volume outreach** over mass automation.

**Cost Design Constraint:** The system must run at near-zero ongoing cost. All infrastructure runs locally on the founder's machine. All AI usage stays within free-tier limits. No paid SaaS subscriptions, no cloud servers, no paid social media APIs.

---

## 2. Goals

- Systematically discover and qualify leads across all four platforms
- Generate personalized outreach messages using AI
- Automate repetitive browser interactions safely (human-mimicking)
- Track replies, follow-ups, and conversion state
- Grow GTSS social presence organically via content scheduling and engagement
- Provide a single internal dashboard for full pipeline visibility

---

## 3. Non-Goals

- Mass DM spam or automated bulk messaging
- Fake engagement (bot likes, fake followers, comment farms)
- Fully autonomous operation without founder approval
- Any system that violates platform Terms of Service

---

## 4. Platforms in Scope

| Platform    | Primary Use Case                                |
| ----------- | ----------------------------------------------- |
| LinkedIn    | B2B lead outreach — restaurant/SME owners       |
| X (Twitter) | Brand presence, thought leadership, DM outreach |
| Facebook    | Local business targeting, group engagement      |
| Instagram   | Visual brand building, DM outreach for SMEs     |

---

## 5. System Modules

### 5.1 Module 1 — Lead Discovery Engine

**Purpose:** Systematically find potential clients across platforms.

**Functional Requirements:**

- FR-1.1: Accept keyword-based search inputs (e.g., "restaurant owner Nairobi", "cafe Mombasa")
- FR-1.2: Scrape or collect publicly available profile data including: name, role, company, location, profile URL, website, platform
- FR-1.3: Support scraping from LinkedIn (Sales Navigator or public search), Facebook Groups, X search, and Instagram hashtags/bio search
- FR-1.4: De-duplicate leads across platforms using email or domain as unique key
- FR-1.5: Store all discovered leads in a central database
- FR-1.6: Tag each lead with the source platform and discovery date

**Technical Requirements:**

- Playwright for browser-based scraping
- Rate limiting: max 50 profile visits/hour per platform
- Random delays between actions: 3–15 seconds (human simulation)
- Rotating user-agent strings
- PostgreSQL or SQLite for lead storage

---

### 5.2 Module 2 — Lead Qualification Engine

**Purpose:** Score leads by likelihood to convert into paying GTSS clients.

**Functional Requirements:**

- FR-2.1: Each lead receives an AI-generated qualification score (0–100)
- FR-2.2: Scoring factors include: business type match, estimated business size, location (Kenya priority), activity recency, profile completeness, presence of a website
- FR-2.3: Leads below score threshold (configurable, default: 50) are automatically deprioritized
- FR-2.4: Founder can manually override or adjust scores
- FR-2.5: Qualification reasons must be stored and visible per lead

**Technical Requirements:**

- **Gemini 1.5 Flash API** (free tier: 15 RPM, 1M tokens/day) for scoring reasoning
- Structured JSON output from AI for score + justification
- Scoring runs as a background job after discovery
- Batch leads in groups of 10 per API call to stay well within free tier limits

---

### 5.3 Module 3 — AI Message Generator

**Purpose:** Draft personalized, context-aware outreach messages per lead.

**Functional Requirements:**

- FR-3.1: Generate a personalized connection request or DM for each qualified lead
- FR-3.2: Message tone must be: warm, non-salesy, Kenya-context-aware, brief (under 300 characters for LinkedIn connection notes)
- FR-3.3: Inputs to the generator: lead name, role, business name, platform, pain point signals, GTSS product being pitched
- FR-3.4: Generate platform-appropriate messages (LinkedIn DM differs from Instagram DM)
- FR-3.5: Founder reviews and approves/edits each message before it is sent — no autonomous sending
- FR-3.6: Store all generated messages with their approval status and timestamps

**Technical Requirements:**

- Prompt templates per platform stored in local JSON config files
- Message variants: minimum 2 options generated per lead
- **Gemini 1.5 Flash API** (free tier) for message generation — at 20 leads/day, usage stays far below free limits
- Message history retained per lead in local SQLite DB for follow-up context

---

### 5.4 Module 4 — Browser Automation Layer

**Purpose:** Execute approved outreach actions on each platform safely.

**Functional Requirements:**

- FR-4.1: Send approved connection requests on LinkedIn with personalized note
- FR-4.2: Send approved DMs on LinkedIn, X, Instagram, and Facebook Messenger
- FR-4.3: Follow target accounts on X and Instagram before DMing (warm-up)
- FR-4.4: Like or comment on 1–2 posts before DMing (engagement warm-up, optional per lead)
- FR-4.5: Daily limits enforced per platform (see limits table below)
- FR-4.6: Actions logged with timestamps and outcome (sent / failed / skipped)
- FR-4.7: Session cookies/auth state stored securely and reused to avoid repeated logins

**Platform Daily Action Limits:**

| Platform  | Connection Requests | DMs | Follows | Likes |
| --------- | ------------------- | --- | ------- | ----- |
| LinkedIn  | 20                  | 15  | —       | 10    |
| X         | —                   | 10  | 30      | 20    |
| Instagram | —                   | 15  | 20      | 15    |
| Facebook  | —                   | 10  | —       | 10    |

**Technical Requirements:**

- Playwright as the core browser automation engine
- Session persistence: store cookies in encrypted local files
- Human-mimicking behavior: random scroll, random delays, non-linear mouse paths
- Retry logic: max 2 retries on failure, then flag for manual review
- Detect and abort on CAPTCHA or platform warning pages

---

### 5.5 Module 5 — CRM & Reply Tracker

**Purpose:** Track the full lifecycle of every lead from discovery to conversion.

**Functional Requirements:**

- FR-5.1: Each lead has a pipeline status: `discovered → qualified → messaged → replied → meeting_booked → converted → lost`
- FR-5.2: Log all outreach touchpoints per lead with timestamps
- FR-5.3: Flag leads who replied for founder review
- FR-5.4: Auto-generate follow-up message drafts for leads with no reply after N days (configurable, default: 5 days)
- FR-5.5: Track which GTSS product was pitched to each lead
- FR-5.6: Record final outcome: converted, rejected, no response, not interested

**Technical Requirements:**

- **SQLite** via better-sqlite3 — zero cost, zero setup, runs locally, sufficient for this data volume
- Polling-based reply detection via Playwright (check inbox on a schedule) — no webhook infrastructure needed
- Notifications via **nodemailer + Gmail SMTP** (free) when a lead replies — no Slack or paid services

---

### 5.6 Module 6 — Content Scheduler

**Purpose:** Maintain a consistent social media posting presence across all platforms.

**Functional Requirements:**

- FR-6.1: Schedule posts for LinkedIn, X, Facebook, and Instagram from a single interface
- FR-6.2: Support post types: text, image, link preview, carousel (where applicable)
- FR-6.3: Suggest optimal posting times per platform based on audience activity
- FR-6.4: Content calendar view showing scheduled posts per week
- FR-6.5: AI-assisted caption generation from a topic or bullet point input
- FR-6.6: Track basic post performance: likes, comments, reach (manually logged or scraped via Playwright)

**Technical Requirements:**

- **Playwright browser automation** handles all posting — eliminates need for paid API access (X API v2 Basic costs $100/month; Meta API requires lengthy app review; none required with this approach)
- **node-cron** for scheduled post delivery — zero cost, runs in-process, no Redis or BullMQ required
- Media files stored in local `/media` directory; Playwright handles file uploads natively
- **Gemini 1.5 Flash** (free tier) for AI caption generation (FR-6.5)

---

### 5.7 Module 7 — Analytics Dashboard

**Purpose:** Give the founder a single view of the entire growth pipeline.

**Functional Requirements:**

- FR-7.1: Display total leads discovered, qualified, messaged, replied, and converted (funnel view)
- FR-7.2: Breakdown by platform
- FR-7.3: Show message acceptance rate per platform and per message template
- FR-7.4: Show content performance: top posts by engagement per platform
- FR-7.5: Show daily action counts vs platform limits
- FR-7.6: Export data to CSV for offline review

**Technical Requirements:**

- **Express + plain HTML/JS dashboard** served locally on localhost — no Next.js build pipeline, no hosting, no deployment needed; this is an internal tool
- Charts: **Chart.js** via CDN (no npm install needed in the browser)
- Data read directly from SQLite — no ORM overhead
- Password-protected via a single hardcoded passphrase in Express middleware (no auth library needed at this scale)

---

## 6. Data Model (Core Entities)

```
leads
  id, platform, name, role, company, location, profile_url, website,
  lead_score, status, source_keyword, created_at

touchpoints
  id, lead_id, type (connection / dm / follow / like / comment),
  platform, message_id, sent_at, outcome

messages
  id, lead_id, platform, body, version, approved_by, approved_at,
  sent_at, is_follow_up

posts
  id, platform, body, media_url, scheduled_at, published_at,
  likes, comments, reach

platform_sessions
  id, platform, cookie_blob (encrypted), last_active, is_valid
```

---

## 7. Security Requirements

- SR-1: Platform session cookies stored encrypted at rest (AES-256)
- SR-2: All API keys stored in environment variables, never hardcoded
- SR-3: Dashboard protected with authentication (JWT or session-based)
- SR-4: No real user data (client PII) stored beyond what is publicly visible on profiles
- SR-5: Rate limit enforcement is mandatory — system must refuse to exceed limits even if manually triggered

---

## 8. Tech Stack

| Layer              | Technology                                         | Cost    |
| ------------------ | -------------------------------------------------- | ------- |
| Backend API        | Node.js + Express                                  | Free    |
| Database           | SQLite (better-sqlite3)                            | Free    |
| Browser Automation | Playwright                                         | Free    |
| AI                 | **Gemini 1.5 Flash API** (free tier)               | **$0**  |
| Job Scheduling     | node-cron (in-process)                             | Free    |
| Dashboard          | Express + plain HTML/JS (localhost)                | Free    |
| Auth               | Single passphrase middleware in Express            | Free    |
| Hosting            | **Local machine only** (internal tool)             | **$0**  |
| Social APIs        | **None** — Playwright handles all platform actions | **$0**  |
| Notifications      | nodemailer + Gmail SMTP                            | Free    |
| **Total Monthly**  |                                                    | **~$0** |

---

## 9. Phased Build Plan

| Phase | Milestone                                   | Timeline |
| ----- | ------------------------------------------- | -------- |
| 1     | Lead Discovery + DB storage                 | Week 1   |
| 2     | Qualification Engine + scoring              | Week 2   |
| 3     | AI Message Generator + approval UI          | Week 3   |
| 4     | Browser Automation Layer (LinkedIn first)   | Week 4   |
| 5     | CRM + Reply Tracker                         | Week 5   |
| 6     | Content Scheduler                           | Week 6   |
| 7     | Analytics Dashboard                         | Week 7   |
| 8     | Expand automation to X, Instagram, Facebook | Week 8   |

---

## 10. Constraints & Risks

| Risk                                  | Mitigation                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Platform bans for automation          | Strict rate limits, human-mimicking behavior, low volume                                                    |
| Gemini free tier rate limits          | Batch scoring; at 20 leads/day, usage is <1% of free quota                                                  |
| X/Meta blocking Playwright sessions   | Keep sessions warm with regular manual logins; rotate user-agents                                           |
| Cookie sessions expiring              | Alert via email when session invalidates; manual re-auth flow                                               |
| AI-generated messages feeling generic | Founder always reviews before send; multiple variants generated                                             |
| Scope creep into spam system          | Hard-coded daily limits enforced at DB level, not just UI                                                   |
| Gemini free tier discontinued         | All prompts are portable — swap to another free provider (Groq, Mistral free tier) with minimal code change |

---

## 11. Success Metrics

- 20+ qualified leads discovered per week across all platforms
- ≥ 30% connection/follow acceptance rate on LinkedIn and Instagram
- ≥ 10% reply rate on outreach messages
- 1 new client converted per month from pipeline within 90 days of launch
- GTSS social following grows by 100+ per month across all platforms

---

## 12. Cost Breakdown

| Item                     | Original Stack              | This Stack              | Saving/Month  |
| ------------------------ | --------------------------- | ----------------------- | ------------- |
| AI API                   | OpenAI GPT-4o (~$20+)       | Gemini 1.5 Flash (free) | ~$20+         |
| Database hosting         | Supabase / Postgres         | SQLite (local file)     | ~$0–25        |
| Server / hosting         | DigitalOcean Droplet        | Local machine           | ~$6–12        |
| Job queue infrastructure | Redis (managed)             | node-cron (in-process)  | ~$0–15        |
| Social media APIs        | X API Basic ($100/mo), Meta | Playwright (browser)    | ~$100+        |
| Dashboard hosting        | Vercel / Railway            | localhost               | ~$0–5         |
| **Total**                | **~$140–170/month**         | **~$0/month**           | **~$140–170** |

**Gemini Free Tier Reference (as of May 2026):**

- Gemini 1.5 Flash: 15 requests/minute, 1,500 requests/day, 1M tokens/day — free
- At 20 leads/day × 2 AI calls each (scoring + message): 40 requests/day — well under limits

**Upgrade path:** If GTSS scales to 200+ leads/day, Gemini 1.5 Flash paid tier starts at ~$0.075 per 1M input tokens — still extremely cheap.

---

---

## 13. UI Specification

The system has **9 pages** served by the local Express server. All pages share a common shell (sidebar nav + topbar). The UI is plain HTML + CSS + vanilla JS — no framework required. Chart.js is loaded from CDN where needed.

---

### 13.0 Global Shell (Present on All Pages)

**Sidebar Navigation**

- GTSS logo / wordmark at top
- Nav links: Dashboard, Lead Discovery, Qualification, Messages, Automation, CRM Pipeline, Content Scheduler, Settings
- Active page indicator (highlighted link)
- Platform session status indicators — small colored dots (green/red) per platform: LinkedIn, X, Facebook, Instagram
- Collapse/expand toggle for sidebar

**Topbar**

- Current page title
- Today's date
- Global action count badge — "Actions today: 34 / 65 limit" with color shift to red as limit approaches
- Notification bell — shows unread reply alerts
- Quick-run button — triggers the next pending automation job

---

### 13.1 Page 1 — Login

**Purpose:** Single passphrase gate before accessing the system.

**Route:** `/login`

**Components:**

- GTSS logo centered
- Single password input field — `type="password"`, placeholder: "Enter access passphrase"
- Submit button — "Enter"
- Error state — inline red text: "Incorrect passphrase"
- No "forgot password" link (internal tool — if lost, reset in config file)

---

### 13.2 Page 2 — Dashboard (Home)

**Purpose:** Full-system overview at a glance. First page after login.

**Route:** `/`

**Components:**

**Stat Cards Row (top)**

- Total Leads Discovered — count + delta vs last 7 days
- Leads Qualified — count + percentage of discovered
- Messages Sent — count + this week
- Replies Received — count + reply rate %
- Meetings Booked — count
- Converted — count

**Outreach Funnel Chart**

- Horizontal funnel bar chart (Chart.js)
- Stages: Discovered → Qualified → Messaged → Replied → Converted
- Per-platform color coding (LinkedIn blue, X black, Facebook navy, Instagram gradient approximated as pink)

**Daily Action Usage Panel**

- Per-platform progress bars showing actions used vs daily limit
- Platforms: LinkedIn, X, Instagram, Facebook
- Color: green → yellow → red as limit approaches

**Recent Replies Feed**

- List of the 5 most recent lead replies
- Each item: lead name, platform icon, message snippet (truncated), timestamp, "Review" button → goes to CRM page for that lead

**Upcoming Scheduled Posts**

- List of next 3 posts queued in the content scheduler
- Each item: platform icon, post preview (first 80 chars), scheduled time, "Edit" link

**System Status Row**

- Platform session health cards — one per platform
- Each card: platform name, icon, status (Active / Expired / Not logged in), last active timestamp, "Re-authenticate" button

---

### 13.3 Page 3 — Lead Discovery

**Purpose:** Run keyword searches and collect new leads from platforms.

**Route:** `/discovery`

**Components:**

**Discovery Form Panel**

- Keyword input — text field, e.g. "restaurant owner Nairobi"
- Platform checkboxes — LinkedIn, X, Facebook, Instagram (multi-select)
- Max leads input — number field, default 20
- "Start Discovery" button
- Running state — spinner + live log output area showing Playwright actions as they run (streamed via SSE)
- Stop button — cancels the running job

**Discovery Results Table**

- Columns: Name, Role, Company, Location, Platform, Profile URL, Website, Discovered At, Actions
- Row actions: "View Profile" (opens URL in new tab), "Add to Queue" (sends to qualification), "Dismiss"
- Bulk action bar: "Qualify Selected" button (appears when rows are checked)
- Pagination — 20 rows per page
- Search/filter bar: filter by platform, by keyword used, by date

**Discovery History Panel** (collapsible)

- Past discovery runs listed: keyword used, platform, leads found, date run
- Re-run button per history item

---

### 13.4 Page 4 — Lead Qualification

**Purpose:** Review AI-generated scores and decide which leads enter the outreach pipeline.

**Route:** `/qualification`

**Components:**

**Queue Stats Bar**

- Pending qualification count
- Auto-qualified (above threshold) count
- Deprioritized (below threshold) count
- "Run Qualification on All Pending" button — triggers batch Gemini API scoring

**Lead Qualification Table**

- Columns: Name, Platform, Company, Location, Score (0–100 with color badge: red <40, amber 40–69, green 70+), Score Reason (tooltip/expand), Status, Actions
- Row actions: "Approve" (move to messaging queue), "Reject", "Override Score" (inline number edit)
- Filter tabs: All | Pending | Approved | Rejected | Overridden
- Sort by: Score (default desc), Name, Platform, Date

**Lead Detail Drawer** (slides in from right on row click)

- Full lead profile: name, role, company, location, profile URL, platform
- AI qualification reasoning — full text from Gemini response
- Score override input + save button
- Manual notes textarea — founder can add context
- Quick actions: Approve, Reject, Skip
- Touchpoint history (empty at this stage)

---

### 13.5 Page 5 — Message Generator

**Purpose:** Generate, review, edit, and approve outreach messages per lead before any sending occurs.

**Route:** `/messages`

**Components:**

**Filter Bar**

- Filter tabs: All | Pending Approval | Approved | Sent | Follow-ups Due
- Platform filter dropdown
- Search by lead name

**Message Queue Table**

- Columns: Lead Name, Platform, Company, Message Preview (first 60 chars), Variant (A/B), Status, Generated At, Actions
- Row actions: "Review & Approve", "Regenerate", "Skip Lead"

**Message Review Modal** (opens on "Review & Approve")

- Lead context panel (left): lead name, role, company, platform, score, any notes
- Message variants panel (right):
  - Variant A — full message text in editable textarea
  - Variant B — full message text in editable textarea
  - Character counter per variant (enforces platform limits: 300 chars for LinkedIn note, 1000 for DMs)
  - Platform limit indicator — green if within limit, red if over
- "Regenerate Both" button — calls Gemini API for fresh variants
- "Approve Variant A" / "Approve Variant B" buttons
- "Approve with Edits" — approves whichever textarea was last edited
- "Skip This Lead" — deprioritizes without sending

**Message Generation Settings Panel** (collapsible sidebar)

- Active prompt template selector per platform — dropdown showing saved templates
- Tone selector: Friendly / Professional / Casual
- Product pitch selector: Restaurant Manager / JustInTime / Custom
- "Edit Templates" link → Settings page

**Follow-ups Tab**

- Lists leads who were messaged 5+ days ago with no reply
- Same review modal for follow-up message draft
- "Snooze 3 days" option per lead

---

### 13.6 Page 6 — Automation Control

**Purpose:** Review the outreach action queue and trigger/monitor browser automation execution.

**Route:** `/automation`

**Components:**

**Daily Limit Dashboard**

- Four platform cards: LinkedIn, X, Instagram, Facebook
- Each card: actions used today / daily limit, progress bar, last action timestamp
- "Pause Platform" toggle per card — pauses all automation for that platform

**Action Queue Table**

- Columns: Lead Name, Platform, Action Type (Connect / DM / Follow / Like), Message Preview, Status (Queued / Running / Done / Failed / Skipped), Scheduled For, Actions
- Row actions: "Run Now", "Skip", "Edit Message"
- Bulk actions: "Run All Queued (safe)", "Clear Failed"
- Status badges with icons: gray (queued), blue (running), green (done), red (failed), yellow (skipped)

**Live Execution Log**

- Real-time scrolling log panel (SSE stream from server)
- Shows Playwright actions as they execute: "Visiting profile...", "Clicking connect...", "Inserting message...", "Waiting 7s..."
- Color coded: gray (info), green (success), red (error), yellow (warning/CAPTCHA detected)
- "Stop Automation" red button — halts the running job immediately

**CAPTCHA / Warning Alert Banner**

- Appears when Playwright detects a CAPTCHA or account warning
- Red banner: "⚠ LinkedIn detected unusual activity. Automation paused. Manual login required."
- "Open Platform" button — opens the browser window so founder can solve manually
- "Resume" button — restarts after manual resolution

**Execution History**

- Table of past automation runs: date, platform, actions attempted, success count, fail count, duration

---

### 13.7 Page 7 — CRM Pipeline

**Purpose:** Manage every lead's lifecycle from first contact to close.

**Route:** `/crm`

**Components:**

**Kanban Board** (primary view)

- Columns (left to right): Messaged | Replied | Meeting Booked | Converted | Lost
- Each card: lead name, platform icon, company, days since last contact, product pitched
- Drag-and-drop between columns to update status
- Click card → opens Lead Detail Panel

**Lead Detail Panel** (right-side drawer)

- Lead profile header: name, role, company, platform, profile URL link
- Product pitched badge
- Full touchpoint timeline:
  - Each event: icon (sent / replied / followed / liked), timestamp, message body or action description
- Reply thread — shows the lead's reply text if available
- Notes textarea — free-form founder notes, auto-saved
- Next action selector: "Schedule Follow-up", "Book Meeting", "Mark Converted", "Mark Lost"
- Follow-up date picker (if scheduling follow-up)

**List View Toggle**

- Switch between Kanban and table list view
- Table columns: Lead Name, Platform, Status, Days in Stage, Product Pitched, Last Contact, Actions

**Search + Filter Bar**

- Search by name or company
- Filter by: platform, status, product pitched, days since contact

**Summary Stats Bar**

- Total active leads in pipeline
- Avg. days to reply
- Avg. days to convert
- Current conversion rate %

---

### 13.8 Page 8 — Content Scheduler

**Purpose:** Write, schedule, and track social media posts across all platforms.

**Route:** `/scheduler`

**Components:**

**Compose Panel** (top section)

- Platform selector — checkbox row: LinkedIn, X, Facebook, Instagram (post to multiple at once)
- Post body textarea — with live character counter per selected platform (X: 280, LinkedIn: 3000, Facebook: 63,206, Instagram: 2200); highlights platform whose limit is closest to being hit
- Media upload area — drag-and-drop for images; thumbnail preview after upload
- AI Caption Generator sub-panel:
  - Topic/bullet input field
  - "Generate Caption" button → Gemini API call
  - Generated caption appears in textarea (editable)
- Schedule picker — date + time input
- "Post Now" button — triggers Playwright immediately
- "Schedule" button — queues for node-cron delivery

**Content Calendar** (main view)

- Weekly calendar grid (Mon–Sun columns)
- Each scheduled post shown as a card in its time slot: platform icon, post preview text
- Click post card → opens edit modal
- "Previous Week" / "Next Week" navigation
- Color coding per platform

**Post Edit Modal**

- Same fields as compose panel, pre-filled with the post's current content
- "Update" / "Delete" / "Post Now" buttons

**Published Posts Log** (tab)

- Table of past posts: platform, post preview, published at, likes (if manually logged), comments
- "View on Platform" link per row (opens profile URL in new tab)

**Queue Status Panel** (sidebar)

- Upcoming 5 scheduled posts listed in order
- Each: platform icon, time, first 50 chars of post body
- "Pause Scheduler" toggle — pauses all upcoming posts without deleting them

---

### 13.9 Page 9 — Settings

**Purpose:** Configure all system parameters — platform sessions, API keys, limits, and prompt templates.

**Route:** `/settings`

**Sections:**

**Platform Sessions**

- One card per platform (LinkedIn, X, Facebook, Instagram)
- Each card: session status badge (Active / Expired), last active timestamp
- "Login / Re-authenticate" button — opens Playwright browser window for manual login; system saves resulting cookies
- "Clear Session" button — deletes stored cookies for that platform

**API Configuration**

- Gemini API Key field — masked input with "Show/Hide" toggle, Save button
- Key validation button — fires a test Gemini call and shows "Valid ✓" or "Invalid ✗"

**Daily Action Limits**

- Editable number inputs per platform per action type (mirroring the limits table from Section 5.4)
- Reset to defaults button
- Save button

**Notification Settings**

- Gmail SMTP email address input
- Gmail app password input (masked)
- Notify on: checkboxes — "Lead replies", "Session expired", "Daily limit reached", "Automation errors"
- "Send Test Email" button

**Prompt Templates**

- Tab selector: LinkedIn Connect | LinkedIn DM | X DM | Instagram DM | Facebook DM | Follow-up
- Textarea per tab showing the active prompt template
- Available variables listed below textarea: `{{lead_name}}`, `{{role}}`, `{{company}}`, `{{location}}`, `{{product}}`, `{{pain_point}}`
- "Save Template" button per tab
- "Reset to Default" button per tab

**System**

- Change passphrase — current passphrase input + new passphrase input + confirm + Save
- "Clear All Data" — wipes SQLite DB (requires typing "DELETE" to confirm)
- App version display

---

### 13.10 UI Component Inventory (Shared/Reusable)

These components are used across multiple pages and should be built once.

| Component             | Used On                                        | Description                                        |
| --------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `StatCard`            | Dashboard, CRM                                 | Metric + delta badge in a bordered card            |
| `PlatformBadge`       | All pages                                      | Platform icon + name pill (LinkedIn/X/FB/IG)       |
| `StatusBadge`         | Qualification, Messages, Automation, CRM       | Colored pill: queued/approved/sent/failed etc.     |
| `ScoreBadge`          | Qualification, CRM                             | 0–100 score in red/amber/green circle              |
| `LeadDetailDrawer`    | Qualification, CRM                             | Right-slide panel with full lead profile           |
| `ActionLimitBar`      | Dashboard, Automation                          | Progress bar showing actions used vs limit         |
| `LiveLogPanel`        | Discovery, Automation                          | SSE-fed scrolling log with color-coded lines       |
| `MessageReviewModal`  | Messages                                       | A/B message editor + approval buttons              |
| `ConfirmModal`        | Settings, Automation, Qualification            | Generic "Are you sure?" dialog with confirm/cancel |
| `NotificationToast`   | All pages                                      | Slide-in bottom-right alert for reply/error events |
| `SessionStatusDot`    | Sidebar, Dashboard, Settings                   | Green/red dot showing platform login status        |
| `CharacterCounter`    | Messages, Scheduler                            | Live count + platform limit indicator              |
| `PlatformCheckboxRow` | Discovery, Scheduler                           | Row of platform toggles with icons                 |
| `DataTable`           | Discovery, Qualification, Messages, Automation | Sortable/filterable table with row actions         |
| `EmptyState`          | All table pages                                | Centered illustration + message when no data       |

---

_This document is internal to GTSS. It is a living specification and will be updated as each module is built and validated._
