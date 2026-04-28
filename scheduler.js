// =============================================================
// scheduler.js — Background dispatch loop. Two ticks per interval:
//   1) Scheduled queue: dispatch any one-shot messages whose send_at
//      has passed. Throttled, atomic claim, full audit log.
//   2) Recurring schedules: dispatch any recurring tasks whose
//      next_run_at has passed, then advance their next_run_at.
// =============================================================
const db = require('./db');
const whatsapp = require('./whatsapp');

const SCHEDULE_TICK_SEC      = parseInt(process.env.SCHEDULE_TICK_INTERVAL || '15', 10);
const SEND_THROTTLE_MS       = parseInt(process.env.SEND_THROTTLE_MS         || '1500', 10);
const SEND_BATCH_LIMIT       = parseInt(process.env.SEND_BATCH_LIMIT         || '10', 10);

let processing = false;
let scheduleTimer = null;

// -------------------------------------------------------------
// Scheduled-send tick
// -------------------------------------------------------------
async function runScheduledTick() {
  if (processing) return;
  if (!whatsapp.getStatus().ready) return;

  processing = true;
  try {
    const due = db.scheduled.dueNow.all({ limit: SEND_BATCH_LIMIT });
    if (!due.length) return;

    console.log(`[scheduler] dispatching ${due.length} due one-shot message(s)`);

    for (const item of due) {
      // Atomic claim — guards against re-entrancy if a tick overlaps.
      const claimed = db.scheduled.claim.run({ id: item.id });
      if (!claimed.changes) continue;

      const t0 = Date.now();
      try {
        const r = await whatsapp.send(item.phone, item.message, item.fileUrl);
        const duration = Date.now() - t0;

        db.scheduled.markSent.run({ id: item.id });
        db.logs.write({
          phone: item.phone,
          message: item.message,
          fileUrl: item.fileUrl,
          attachment: item.fileUrl ? guessAttachment(item.fileUrl) : null,
          status: 'success',
          source: item.source || 'scheduled',
          duration,
          scheduledFor: item.sendAt,
          sentAt: new Date().toISOString(),
          ts: Date.now()
        });
        console.log(`[scheduler] ✓ #${item.id} → ${item.phone} (${duration}ms, wa-id=${r.id})`);
      } catch (e) {
        const duration = Date.now() - t0;
        const msg = e.message || String(e);
        db.scheduled.markFailed.run({ id: item.id, error: msg });
        db.logs.write({
          phone: item.phone,
          message: item.message,
          fileUrl: item.fileUrl,
          attachment: item.fileUrl ? guessAttachment(item.fileUrl) : null,
          status: 'error',
          error: msg,
          source: item.source || 'scheduled',
          duration,
          scheduledFor: item.sendAt,
          ts: Date.now()
        });
        console.error(`[scheduler] ✗ #${item.id} → ${item.phone}: ${msg}`);
      }

      // Anti-ban throttle between sends in the same batch.
      if (SEND_THROTTLE_MS > 0) await sleep(SEND_THROTTLE_MS);
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e.message);
  } finally {
    processing = false;
  }
}

// -------------------------------------------------------------
// Recurring-schedule tick
// -------------------------------------------------------------
let processingRecurring = false;

async function runRecurringTick() {
  if (processingRecurring) return;
  if (!whatsapp.getStatus().ready) return;

  processingRecurring = true;
  try {
    const due = db.recurring.dueNow.all({ limit: 25 });
    if (!due.length) return;

    console.log(`[recurring] dispatching ${due.length} recurring task(s)`);

    for (const item of due) {
      const t0 = Date.now();
      let status = 'success', errorMsg = null;
      try {
        await whatsapp.send(item.phone, item.message, item.fileUrl);
        const duration = Date.now() - t0;
        db.logs.write({
          phone: item.phone, message: item.message,
          fileUrl: item.fileUrl,
          attachment: item.fileUrl ? guessAttachment(item.fileUrl) : null,
          status: 'success', source: 'recurring',
          duration, sentAt: new Date().toISOString(), ts: Date.now()
        });
        console.log(`[recurring] ✓ #${item.id} → ${item.phone} (${duration}ms)`);
      } catch (e) {
        status = 'error';
        errorMsg = e.message || String(e);
        const duration = Date.now() - t0;
        db.logs.write({
          phone: item.phone, message: item.message,
          fileUrl: item.fileUrl,
          attachment: item.fileUrl ? guessAttachment(item.fileUrl) : null,
          status: 'error', error: errorMsg, source: 'recurring',
          duration, ts: Date.now()
        });
        console.error(`[recurring] ✗ #${item.id} → ${item.phone}: ${errorMsg}`);
      }

      // Compute next occurrence and persist
      try {
        const next = computeNextRun(item.frequency, item.nextRunAt);
        db.recurring.advance.run({
          id: item.id,
          next_run_at: next.toISOString(),
          last_status: status,
          last_error:  errorMsg
        });
      } catch (e) {
        console.error(`[recurring] cannot advance #${item.id}: ${e.message}`);
        db.recurring.setActive.run({ id: item.id, active: 0 });
      }

      if (SEND_THROTTLE_MS > 0) await sleep(SEND_THROTTLE_MS);
    }
  } catch (e) {
    console.error('[recurring] tick error:', e.message);
  } finally {
    processingRecurring = false;
  }
}

// -------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------
let heartbeatTick = 0;
function start() {
  scheduleTimer = setInterval(() => {
    runScheduledTick().catch(() => {});
    runRecurringTick().catch(() => {});

    // Every ~2 minutes, print queue health for diagnostics.
    heartbeatTick++;
    if (heartbeatTick % 4 === 0) {
      const pendingScheduled = db.scheduled.countPending.get().count || 0;
      const activeRecurring = db.recurring.countActive.get().count || 0;
      if (pendingScheduled || activeRecurring) {
        console.log(`[scheduler] heartbeat · ${activeRecurring} recurring · ${pendingScheduled} scheduled · ready=${whatsapp.getStatus().ready}`);
      }
    }
  }, SCHEDULE_TICK_SEC * 1000);

  console.log(
    `[scheduler] started · tick=${SCHEDULE_TICK_SEC}s · ` +
    `throttle=${SEND_THROTTLE_MS}ms · batch=${SEND_BATCH_LIMIT}`
  );
}

function stop() {
  if (scheduleTimer) clearInterval(scheduleTimer);
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function guessAttachment(fileUrl) {
  const url = String(fileUrl).toLowerCase();
  if (/\.(pdf)(\?|$)/.test(url))                         return 'PDF';
  if (/\.(jpe?g|png|gif|webp|bmp|svg|heic)(\?|$)/.test(url)) return 'IMG';
  return 'FILE';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Given a frequency and an anchor (start_at), compute the next occurrence
 * strictly in the future relative to `from`. Anchor preserves the original
 * minute/hour/day-of-week/day-of-month, so the schedule "remembers" its rhythm.
 */
function computeNextRun(frequency, anchorISO, from = new Date()) {
  const anchor = new Date(anchorISO);
  if (isNaN(anchor.getTime())) {
    throw new Error('INVALID_ANCHOR');
  }
  const next = new Date(anchor);

  // Walk forward from the anchor by the appropriate step until we're past `from`.
  // Bounded loop so a malformed anchor doesn't trap the scheduler.
  for (let i = 0; i < 100000; i++) {
    if (next > from) return next;
    switch (frequency) {
      case 'hourly':  next.setHours(next.getHours() + 1); break;
      case 'daily':   next.setDate(next.getDate() + 1); break;
      case 'weekly':  next.setDate(next.getDate() + 7); break;
      case 'monthly': next.setMonth(next.getMonth() + 1); break;
      default: throw new Error('INVALID_FREQUENCY');
    }
  }
  return next;
}

module.exports = { start, stop, runScheduledTick, runRecurringTick, guessAttachment, computeNextRun };
