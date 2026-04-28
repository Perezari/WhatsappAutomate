// =============================================================
// db.js — SQLite layer (better-sqlite3, synchronous, fast).
// Tables: logs (audit), scheduled (one-shot queue),
//         recurring_schedules (repeating tasks), settings (kv).
// =============================================================
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './data/pulse.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// -------------------------------------------------------------
// Schema
// -------------------------------------------------------------
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT NOT NULL,
    message       TEXT NOT NULL,
    file_url      TEXT,
    attachment    TEXT,                          -- 'IMG' | 'PDF' | 'FILE' | NULL
    status        TEXT NOT NULL,                 -- 'success' | 'pending' | 'error'
    error         TEXT,
    source        TEXT DEFAULT 'manual',         -- 'manual' | 'scheduled' | 'recurring' | 'api'
    duration_ms   INTEGER,
    scheduled_for TEXT,
    sent_at       TEXT,
    ts_ms         INTEGER NOT NULL,              -- epoch ms — used by frontend
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_logs_status  ON logs(status);
  CREATE INDEX IF NOT EXISTS idx_logs_ts      ON logs(ts_ms);

  CREATE TABLE IF NOT EXISTS scheduled (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phone        TEXT NOT NULL,
    message      TEXT NOT NULL,
    file_url     TEXT,
    send_at      TEXT NOT NULL,                  -- ISO timestamp
    status       TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled'
    source       TEXT DEFAULT 'manual',          -- 'manual' | 'api'
    external_id  TEXT UNIQUE,                    -- dedupe key (rarely used)
    error        TEXT,
    sent_at      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled(status, send_at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS recurring_schedules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT NOT NULL,
    message         TEXT NOT NULL,
    file_url        TEXT,
    frequency       TEXT NOT NULL,                 -- 'hourly' | 'daily' | 'weekly' | 'monthly'
    start_at        TEXT NOT NULL,                 -- ISO — anchor for the schedule
    next_run_at     TEXT NOT NULL,                 -- ISO — when scheduler should fire next
    last_run_at     TEXT,
    last_status     TEXT,                          -- 'success' | 'error'
    last_error      TEXT,
    runs_count      INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,    -- 0/1
    label           TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_schedules(active, next_run_at);
`);

// -------------------------------------------------------------
// Logs
// -------------------------------------------------------------
const LOG_SELECT = `
  SELECT id, phone, message, file_url AS fileUrl, attachment, status, error,
         source, duration_ms AS duration, scheduled_for AS scheduledFor,
         sent_at AS sentAt, ts_ms AS ts, created_at AS createdAt
  FROM logs
`;

const logs = {
  insert: sqlite.prepare(`
    INSERT INTO logs
      (phone, message, file_url, attachment, status, error, source,
       duration_ms, scheduled_for, sent_at, ts_ms)
    VALUES
      (@phone, @message, @file_url, @attachment, @status, @error, @source,
       @duration_ms, @scheduled_for, @sent_at, @ts_ms)
  `),

  recent: sqlite.prepare(`${LOG_SELECT} ORDER BY id DESC LIMIT @limit`),

  byStatus: sqlite.prepare(`
    ${LOG_SELECT} WHERE status = @status ORDER BY id DESC LIMIT @limit
  `),

  search: sqlite.prepare(`
    ${LOG_SELECT}
    WHERE phone LIKE @q OR message LIKE @q
    ORDER BY id DESC LIMIT @limit
  `),

  clear: sqlite.prepare(`DELETE FROM logs`),

  counts: sqlite.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN date(created_at) = date('now') AND status='success' THEN 1 ELSE 0 END) AS successToday,
      SUM(CASE WHEN date(created_at) = date('now') AND status='error'   THEN 1 ELSE 0 END) AS errorsToday,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
    FROM logs
  `)
};

// helper that fills in defaults
logs.write = (row) => logs.insert.run({
  phone:         row.phone,
  message:       row.message ?? '',
  file_url:      row.fileUrl ?? row.file_url ?? null,
  attachment:    row.attachment ?? null,
  status:        row.status,
  error:         row.error ?? null,
  source:        row.source ?? 'manual',
  duration_ms:   row.duration_ms ?? row.duration ?? null,
  scheduled_for: row.scheduled_for ?? row.scheduledFor ?? null,
  sent_at:       row.sent_at ?? row.sentAt ?? null,
  ts_ms:         row.ts_ms ?? row.ts ?? Date.now()
});

// -------------------------------------------------------------
// Scheduled
// -------------------------------------------------------------
const SCHED_SELECT = `
  SELECT id, phone, message, file_url AS fileUrl, send_at AS sendAt,
         status, source, external_id AS externalId, error,
         sent_at AS sentAt, created_at AS createdAt
  FROM scheduled
`;

const scheduled = {
  insert: sqlite.prepare(`
    INSERT OR IGNORE INTO scheduled
      (phone, message, file_url, send_at, source, external_id)
    VALUES
      (@phone, @message, @file_url, @send_at, @source, @external_id)
  `),

  dueNow: sqlite.prepare(`
    SELECT id, phone, message, file_url AS fileUrl, send_at AS sendAt, source
    FROM scheduled
    WHERE status='pending' AND datetime(send_at) <= datetime('now')
    ORDER BY send_at ASC
    LIMIT @limit
  `),

  // claim a pending row atomically. Returns changes=1 on success.
  claim: sqlite.prepare(`
    UPDATE scheduled SET status='processing'
    WHERE id=@id AND status='pending'
  `),

  markSent: sqlite.prepare(`
    UPDATE scheduled SET status='sent', sent_at=datetime('now') WHERE id=@id
  `),

  markFailed: sqlite.prepare(`
    UPDATE scheduled SET status='failed', error=@error WHERE id=@id
  `),

  byStatus: sqlite.prepare(`
    ${SCHED_SELECT} WHERE status=@status ORDER BY send_at ASC LIMIT @limit
  `),

  recent: sqlite.prepare(`${SCHED_SELECT} ORDER BY id DESC LIMIT @limit`),

  cancel: sqlite.prepare(`
    UPDATE scheduled SET status='cancelled'
    WHERE id=@id AND status IN ('pending','processing')
  `),

  update: sqlite.prepare(`
    UPDATE scheduled
    SET phone=@phone, message=@message, file_url=@file_url, send_at=@send_at
    WHERE id=@id AND status='pending'
  `),

  byId: sqlite.prepare(`${SCHED_SELECT} WHERE id=@id`),

  countPending: sqlite.prepare(
    `SELECT COUNT(*) AS count FROM scheduled WHERE status='pending'`
  )
};

// -------------------------------------------------------------
// Recurring schedules
// -------------------------------------------------------------
const RECUR_SELECT = `
  SELECT id, phone, message, file_url AS fileUrl, frequency,
         start_at AS startAt, next_run_at AS nextRunAt,
         last_run_at AS lastRunAt, last_status AS lastStatus, last_error AS lastError,
         runs_count AS runsCount, active, label, created_at AS createdAt
  FROM recurring_schedules
`;

const recurring = {
  insert: sqlite.prepare(`
    INSERT INTO recurring_schedules
      (phone, message, file_url, frequency, start_at, next_run_at, label)
    VALUES
      (@phone, @message, @file_url, @frequency, @start_at, @next_run_at, @label)
  `),

  dueNow: sqlite.prepare(`
    SELECT id, phone, message, file_url AS fileUrl, frequency,
           next_run_at AS nextRunAt
    FROM recurring_schedules
    WHERE active=1 AND datetime(next_run_at) <= datetime('now')
    ORDER BY next_run_at ASC
    LIMIT @limit
  `),

  advance: sqlite.prepare(`
    UPDATE recurring_schedules
    SET next_run_at=@next_run_at,
        last_run_at=datetime('now'),
        last_status=@last_status,
        last_error=@last_error,
        runs_count=runs_count+1
    WHERE id=@id
  `),

  setActive: sqlite.prepare(`
    UPDATE recurring_schedules SET active=@active WHERE id=@id
  `),

  update: sqlite.prepare(`
    UPDATE recurring_schedules
    SET phone=@phone, message=@message, file_url=@file_url,
        frequency=@frequency, start_at=@start_at, next_run_at=@next_run_at,
        label=@label
    WHERE id=@id
  `),

  byId: sqlite.prepare(`${RECUR_SELECT} WHERE id=@id`),

  remove: sqlite.prepare(`DELETE FROM recurring_schedules WHERE id=@id`),

  recent: sqlite.prepare(`${RECUR_SELECT} ORDER BY id DESC LIMIT @limit`),

  active: sqlite.prepare(`${RECUR_SELECT} WHERE active=1 ORDER BY next_run_at ASC LIMIT @limit`),

  countActive: sqlite.prepare(
    `SELECT COUNT(*) AS count FROM recurring_schedules WHERE active=1`
  )
};

// -------------------------------------------------------------
// Settings (key-value)
// -------------------------------------------------------------
const _settingGet = sqlite.prepare(`SELECT value FROM settings WHERE key=?`);
const _settingSet = sqlite.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);
const _settingDel = sqlite.prepare(`DELETE FROM settings WHERE key=?`);

const settings = {
  get: (key) => {
    const r = _settingGet.get(key);
    return r ? r.value : null;
  },
  getJSON: (key) => {
    const v = settings.get(key);
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  },
  set: (key, value) => _settingSet.run(key, String(value)),
  setJSON: (key, value) => _settingSet.run(key, JSON.stringify(value)),
  del: (key) => _settingDel.run(key)
};

module.exports = { sqlite, logs, scheduled, recurring, settings };
