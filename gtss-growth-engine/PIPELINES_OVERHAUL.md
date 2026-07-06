# Pipeline Operations — Production-Grade Reliability & Control

This document describes the **Pipelines** page overhaul that turns the three core
automation pipelines (Auto-Content Posting, DM Inbox Checker, Lead Outreach) into
production-grade automation services with full lifecycle control, observability,
error recovery, and resilience.

## What changed

The Pipelines page is no longer a "set cron + toggle on" UI. It is now a full
**operations control center** that lets you:

- Run, pause, resume, stop, restart, and retry individual stages of any pipeline
- See real-time progress (current stage, % complete, current message) for the
  active execution
- Resume a failed run from the last successful checkpoint instead of restarting
  the entire workflow
- Inspect structured, searchable, filterable logs for every execution
- View health metrics (success rate, failure rate, avg duration, consecutive
  failures, retries, uptime) per pipeline
- Trust that scheduled pipelines survive application restarts and never run
  duplicate instances in parallel

## Lifecycle controls

Every pipeline exposes the following controls in the UI:

| Control | Behavior |
|---|---|
| **Run Now** | Immediately start a new execution. Refuses if one is already running or if the pipeline is paused. |
| **Pause** | Suspend the currently running execution at the next safe checkpoint. The pipeline stays paused across cron ticks until you explicitly Resume. |
| **Resume** | Continue a paused execution from where it left off (does NOT restart from stage 1). |
| **Stop** | Gracefully terminate the current execution. Already-completed stages keep their checkpoints. |
| **Restart** | Stop the current execution (if any) AND clear its checkpoints, then start a fresh run from stage 1. |
| **Retry Failed Step** | Re-run only the stage that failed in the most recent failed execution. Earlier completed stages are skipped (their checkpoints are reused). |
| **Resume from Checkpoint** | Resume the most recent failed/stopped execution from the first stage that does not have a 'completed' checkpoint. |

These controls call the new API endpoints documented below.

## States

Each pipeline's `current_state` is one of:

| State | Meaning |
|---|---|
| `idle` | Pipeline is enabled and waiting for the next cron tick (no active execution). |
| `scheduled` | A cron trigger is registered and will fire at `next_run_at`. |
| `running` | An execution is currently active. |
| `paused` | The active execution is suspended; the runner is blocked at `awaitResume()`. |
| `resuming` | A resume was requested; the runner is about to un-block. |
| `stopping` | A stop was requested; the runner will abort at the next checkpoint. |
| `stopped` | The execution was stopped by the user. |
| `completed` | The most recent execution finished successfully. |
| `failed` | The most recent execution failed. See logs for the error. |
| `retrying` | A stage retry is in progress. |

The UI shows a live status badge and pulse indicator for each pipeline.

## Real-time progress

The Pipelines page subscribes to two Socket.IO events:

- `pipeline:status` — fired on every state transition (running, paused, completed, failed, etc.)
- `pipeline:progress` — fired whenever a runner updates the current stage / message / progress %

A progress bar (`0%` → `100%`) and a stage pill row (`Discovery → Qualification → Messages → Send`)
are rendered for each pipeline. The stage pills are colored:
- **Green (done)** — stage has a 'completed' checkpoint
- **Blue (active)** — stage is currently running
- **Red (failed)** — stage is the failed_stage of the current execution
- **Gray (skipped)** — stage not yet started

## Health metrics

For each pipeline, the Pipelines page shows a collapsible "Pipeline Health & Metrics"
panel with:

- Last run (relative + absolute)
- Next scheduled run
- Success rate (last 24h)
- Failure rate (last 24h)
- Average duration (last 24h + all-time)
- Consecutive failures
- Total runs (all-time)
- Total failures (all-time)
- Total retries (all-time)
- Uptime (time since last successful run)
- Healthy / Unhealthy badge (healthy = enabled AND consecutive failures < 3 AND 24h success rate ≥ 50%)

A global health strip at the top of the page summarizes all pipelines at a glance.

## Checkpointing

Every time a stage of a pipeline finishes (success or failure), a checkpoint is
written to the `pipeline_checkpoints` table with:

- `execution_id` — which execution this checkpoint belongs to
- `pipeline_id` — which pipeline
- `stage` — which stage (e.g. `discovery`, `image_gen`, `publish`)
- `status` — `completed` | `failed` | `skipped`
- `payload_json` — stage result snapshot (e.g. `{ newLeads: 5 }` for discovery)
- `error_message` — if the stage failed
- `duration_ms`

When a pipeline fails and you click **Resume from Checkpoint**, the system finds
the first stage that does NOT have a `completed` checkpoint and re-runs the
pipeline starting from that stage. All earlier stages are skipped.

When you click **Retry Failed Step**, the system re-runs ONLY the failed stage
(earlier completed stages are still skipped via their checkpoints).

For example, if the Auto-Content pipeline successfully:

1. Generated the image,
2. Generated captions,
3. Created the post draft,

but then failed while publishing to Instagram, restarting would normally repeat
the entire workflow. With checkpointing, **Resume from Checkpoint** skips
stages 1-3 and only re-runs the publish stage.

## Logging

Every pipeline now writes structured logs to the `pipeline_logs` table with:

- `pipeline_id`
- `execution_id`
- `stage`
- `level` (debug | info | warn | error | retry | success)
- `message`
- `stack_trace` (for errors)
- `context_json` (arbitrary structured context)
- `browser_event` (e.g. `navigation`, `click`, `timeout`, `captcha`)
- `retry_attempt`
- `source` (system | browser | user | scheduler)
- `created_at`

Logs are also mirrored into the legacy `pipeline_events` table for backward
compatibility with the existing Monitoring page.

The Pipelines page exposes a **Logs** button on each pipeline card that opens a
modal with:

- Free-text search on the message field
- Filter by level (info, success, warn, error, retry, debug)
- Filter by stage
- Live tail toggle (Socket.IO `pipeline:log` events stream in real time)
- Aggregated counts by level (X errors / Y retries / Z info, etc.)

## Scheduling reliability

The pipeline scheduler (`src/jobs/pipelineScheduler.js`) enforces:

1. **Single-instance execution** — only one execution per pipeline at a time. If
   a cron tick fires while an execution is already running, it is skipped with a
   warning log.
2. **Survives application restarts** — on boot, `pipelineStateService.recoverOnStartup()`
   sweeps the `pipeline_executions` table for any rows left in transient states
   (running, paused, resuming, stopping, retrying) and marks them as `failed`
   with the message "Server restarted while execution was in state 'X'". The
   UI will never show a phantom "still running" pipeline after a restart.
3. **Paused pipelines stay paused** — the `pipeline_<id>_paused` setting is
   persisted in the `settings` table, so a paused pipeline remains paused
   across restarts (this is intentional — pausing is a user intent, not a
   transient state).
4. **Prevents duplicate executions** — the `runPipelineWithLifecycle()` helper
   checks `pipelineState.canStart()` before creating a new execution and
   refuses if one is already active.

## New database tables

The overhaul adds three new tables (all created idempotently on first boot,
so existing databases are migrated automatically):

### `pipeline_executions`
Per-execution lifecycle tracking. One row per run of any pipeline.

### `pipeline_checkpoints`
Per-stage checkpoint persistence. Used for resume-from-checkpoint and retry-stage.

### `pipeline_logs`
Structured searchable logs. Extends the legacy `pipeline_events` table with
additional fields (stack traces, browser events, retry attempts, sources).

The `pipeline_schedules` table also gains new columns:
- `current_state` — the live state of the pipeline (idle, running, paused, etc.)
- `current_execution_id` — FK to the active execution
- `last_error` — the most recent error message
- `last_success_at` / `last_failure_at`
- `total_runs`, `total_failures`, `total_retries`
- `consecutive_failures`
- `avg_duration_ms`

## New API endpoints

All endpoints are under `/api/pipelines`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List all pipelines (with runtime state, health, active execution) |
| `GET` | `/health` | Health snapshot for all pipelines |
| `GET` | `/:id/health` | Health snapshot for one pipeline |
| `GET` | `/:id/executions` | List recent executions |
| `GET` | `/:id/executions/:eid` | Get a single execution with checkpoints + recent logs |
| `GET` | `/:id/logs` | Searchable / filterable structured logs (with `?level`, `?stage`, `?search`, `?since`, `?until`, `?executionId`, `?limit`, `?offset`) |
| `GET` | `/:id/checkpoints` | List checkpoints for the active or specified execution |
| `GET` | `/:id/history` | Legacy history endpoint (kept for backward compat) |
| `PATCH` | `/:id` | Update cron, enabled, limits |
| `POST` | `/:id/run` | Trigger a manual run now |
| `POST` | `/:id/restart` | Stop current (if any) + start fresh |
| `POST` | `/:id/pause` | Pause the active execution (and schedule) |
| `POST` | `/:id/resume` | Resume a paused execution (and schedule) |
| `POST` | `/:id/stop` | Gracefully stop the active execution |
| `POST` | `/:id/retry-stage` | Retry a specific failed stage of the most recent failed execution |
| `POST` | `/:id/resume-from-checkpoint` | Resume the most recent failed/stopped execution from the last successful checkpoint |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Pipelines Page (UI)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Pipeline Card│  │ Health Panel │  │ Logs Viewer      │   │
│  │ + Lifecycle  │  │ + Metrics    │  │ + Search/Filter  │   │
│  │ Controls     │  │              │  │ + Live Tail      │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
└─────────┼─────────────────┼───────────────────┼──────────────┘
          │                 │                   │
          ▼                 ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│                  /api/pipelines (routes)                     │
└──────────────────────────────┬───────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ pipelineState   │  │ pipelineHealth   │  │ pipelineLogger   │
│ Service         │  │ Service          │  │                  │
│ (state machine, │  │ (metrics,        │  │ (structured,     │
│  lifecycle,     │  │  aggregates)     │  │  searchable)     │
│  recovery)      │  │                  │  │                  │
└────────┬────────┘  └──────────────────┘  └──────────────────┘
         │
         ▼
┌─────────────────┐  ┌──────────────────┐
│ pipelineCheck-  │  │ pipelineScheduler│
│ point Service   │  │ (cron, single-   │
│ (save/load)     │  │  instance lock)  │
└─────────────────┘  └────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌──────────────────┐            ┌──────────────────┐
    │ pipelineRunner   │            │ contentPipeline  │
    │ (outreach)       │            │ (auto-content)   │
    └──────────────────┘            └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ pipelineQueue    │
    │ (single-flight)  │
    └──────────────────┘
```

## Testing the new behavior

```bash
# 1. Trigger a manual run
curl -X POST http://localhost:3000/api/pipelines/outreach/run

# 2. Watch real-time progress in the Pipelines page UI

# 3. Pause mid-run
curl -X POST http://localhost:3000/api/pipelines/outreach/pause

# 4. Resume
curl -X POST http://localhost:3000/api/pipelines/outreach/resume

# 5. Stop
curl -X POST http://localhost:3000/api/pipelines/outreach/stop

# 6. View execution history
curl http://localhost:3000/api/pipelines/outreach/executions

# 7. View logs (filtered by error level)
curl 'http://localhost:3000/api/pipelines/outreach/logs?level=error&limit=50'

# 8. Retry a failed stage
curl -X POST http://localhost:3000/api/pipelines/outreach/retry-stage \
  -H 'Content-Type: application/json' \
  -d '{"stage":"messages"}'

# 9. Resume from the last successful checkpoint
curl -X POST http://localhost:3000/api/pipelines/outreach/resume-from-checkpoint

# 10. View health metrics
curl http://localhost:3000/api/pipelines/outreach/health
```
