/**
 * pipelineScheduler/cronParsing.js
 *
 * Pure cron-expression parsing + next-run computation. Has no DB / I/O
 * deps so it's safe to unit-test in isolation.
 *
 *   - parseCronField(field, min, max)  — parse one cron field (e.g. '*',
 *                                         '5', '1-5', 'every-15' written as
 *                                         star-slash-15, '0,15,30,45') into a
 *                                         Set of allowed integers.
 *                                         Returns null on invalid input.
 *   - computeNextRun(cronExpression, fromDate)  — given a 5-field cron
 *                                         expression (min hour day month dow),
 *                                         return the next ISO timestamp at
 *                                         or after `fromDate` (default: now)
 *                                         that matches. Returns null on
 *                                         invalid cron or if no match within
 *                                         ~1 year.
 *
 * Note: '7' in the day-of-week field is normalized to '0' (Sunday) per
 * standard cron convention.
 */

function parseCronField(field, min, max) {
  const allowed = new Set();
  const parts = String(field || '').split(',');

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) return null;

    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [rawStart, rawEnd] = rangePart.split('-').map(Number);
      start = rawStart;
      end = rawEnd;
    } else {
      start = Number(rangePart);
      end = Number(rangePart);
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      return null;
    }

    for (let value = start; value <= end; value += step) {
      allowed.add(value);
    }
  }

  return allowed;
}

function computeNextRun(cronExpression, fromDate = new Date()) {
  const parts = String(cronExpression || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, dayField, monthField, dowField] = parts;
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dows = parseCronField(dowField.replace(/\b7\b/g, '0'), 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return null;

  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxChecks = 366 * 24 * 60;
  for (let i = 0; i < maxChecks; i += 1) {
    if (
      minutes.has(candidate.getMinutes()) &&
      hours.has(candidate.getHours()) &&
      days.has(candidate.getDate()) &&
      months.has(candidate.getMonth() + 1) &&
      dows.has(candidate.getDay())
    ) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

module.exports = { parseCronField, computeNextRun };
