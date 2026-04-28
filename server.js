// =============================================================
// server.js — Express HTTP API.
//
// Endpoints (all under /api):
//   GET    /health                  — server liveness
//   GET    /status                  — WhatsApp connection state + QR
//   GET    /settings                — app settings (e.g. stripNiqqud)
//   PUT    /settings                — update settings
//   POST   /send                    — send now, OR schedule if scheduleAt
//   GET    /logs                    — list logs (q, status, limit)
//   DELETE /logs                    — clear all logs
//   GET    /schedule                — list scheduled queue
//   PATCH  /schedule/:id            — edit a pending one-shot
//   DELETE /schedule/:id            — cancel a scheduled message
//   GET    /recurring               — list recurring schedules
//   POST   /recurring               — create a recurring schedule
//   PATCH  /recurring/:id           — toggle active OR full edit
//   DELETE /recurring/:id           — delete a recurring schedule
//   GET    /export                  — download a JSON backup of all schedules
//   POST   /import                  — restore schedules from a backup JSON
//   GET    /contacts                — WhatsApp contacts
//   GET    /groups                  — WhatsApp groups
//   GET    /profile-pic             — chat profile picture URL
//   POST   /upload                  — accept a file, return an internal: URL
//   POST   /test                    — quick send-to-self / send-to-X test
//   POST   /logout                  — log the WhatsApp session out
// =============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const whatsapp = require('./whatsapp');
const scheduler = require('./scheduler');

const PORT         = parseInt(process.env.PORT || '3001', 10);
const HOST         = process.env.HOST || '127.0.0.1';
const CORS_ORIGIN  = process.env.CORS_ORIGIN || '*';
const UPLOADS_DIR  = process.env.UPLOADS_DIR || './uploads';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// -------------------------------------------------------------
// App + middleware
// -------------------------------------------------------------
const app = express();

app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploads read-only (so a remote dashboard could preview them).
app.use('/files', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// Serve the dashboard from ./public if present (single-origin = no CORS).
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const hasPublicDashboard = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
if (hasPublicDashboard) {
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
} else {
  // Friendly landing page so http://127.0.0.1:3001 isn't a bare 404.
  app.get('/', (_req, res) => {
    res.type('html').send(LANDING_HTML);
  });
}

// Multer disk storage with random filenames.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').slice(0, 12);
      const safe = Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext;
      cb(null, safe);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Lightweight access log
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${res.statusCode} ${req.method} ${req.path} ${Date.now() - t}ms`);
  });
  next();
});

// -------------------------------------------------------------
// Health
// -------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'pulse-whatsapp-backend',
    version: '1.0.0',
    uptime: process.uptime(),
    node: process.version
  });
});

// -------------------------------------------------------------
// Status — primary endpoint polled by the dashboard every ~6s
// -------------------------------------------------------------
app.get('/api/status', (_req, res) => {
  const w = whatsapp.getStatus();
  const c = db.logs.counts.get();
  const pending = db.scheduled.countPending.get().count || 0;
  const recurringActive = db.recurring.countActive.get().count || 0;

  res.json({
    ok: true,
    connected: w.connected,
    ready:     w.ready,
    qr:        w.qr,
    info:      w.info,
    loading:   w.loading,
    uptimeMs:  w.uptimeMs,
    lastReadyAt: w.lastReadyAt,
    lastError: w.lastError,
    stats: {
      logsTotal:    c.total        || 0,
      logsToday:    c.today        || 0,
      successToday: c.successToday || 0,
      errorsToday:  c.errorsToday  || 0,
      pendingLogs:  c.pending      || 0,
      pendingScheduled: pending,
      recurringActive
    }
  });
});

// -------------------------------------------------------------
// Send — immediate (no scheduleAt) or scheduled (with scheduleAt)
// -------------------------------------------------------------
app.post('/api/send', async (req, res) => {
  const {
    phone,
    message,
    fileUrl,
    fileName,
    scheduleAt,
    source = 'manual'
  } = req.body || {};

  if (!phone || (!message && !fileUrl)) {
    return res.status(400).json({
      ok: false, error: 'INVALID_INPUT',
      hint: 'phone is required, plus message or fileUrl'
    });
  }

  // Branch 1: schedule for the future (>=2s out)
  if (scheduleAt) {
    const at = new Date(scheduleAt);
    if (isNaN(at.getTime())) {
      return res.status(400).json({ ok: false, error: 'INVALID_SCHEDULE' });
    }
    if (at.getTime() > Date.now() + 2000) {
      try {
        const r = db.scheduled.insert.run({
          phone, message: message || '',
          file_url: fileUrl || null,
          send_at: at.toISOString(),
          source,
          external_id: null
        });
        return res.json({
          ok: true,
          scheduled: true,
          id: r.lastInsertRowid,
          sendAt: at.toISOString()
        });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'DB_ERROR', message: e.message });
      }
    }
    // else: schedule is in the past or imminent → fall through to immediate send
  }

  // Branch 2: immediate
  const t0 = Date.now();
  try {
    const r = await whatsapp.send(phone, message || '', fileUrl);
    const duration = Date.now() - t0;

    const ins = db.logs.write({
      phone, message: message || '', fileUrl: fileUrl || null,
      attachment: fileUrl ? scheduler.guessAttachment(fileUrl) : null,
      status: 'success', source, duration,
      sentAt: new Date().toISOString(),
      ts: Date.now()
    });

    res.json({
      ok: true,
      id: ins.lastInsertRowid,
      messageId: r.id,
      ack: r.ack,
      duration,
      status: 'success'
    });
  } catch (e) {
    const duration = Date.now() - t0;
    const msg = e.message || String(e);

    const ins = db.logs.write({
      phone, message: message || '', fileUrl: fileUrl || null,
      attachment: fileUrl ? scheduler.guessAttachment(fileUrl) : null,
      status: 'error', error: msg, source, duration,
      ts: Date.now()
    });

    res.status(httpStatusFor(e.code)).json({
      ok: false,
      id: ins.lastInsertRowid,
      error: e.code || 'SEND_FAILED',
      message: msg,
      status: 'error',
      duration
    });
  }
});

// -------------------------------------------------------------
// Logs
// -------------------------------------------------------------
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const status = req.query.status;
  const q = req.query.q;

  let rows;
  if (status && status !== 'all') {
    rows = db.logs.byStatus.all({ status, limit });
  } else if (q) {
    rows = db.logs.search.all({ q: `%${q}%`, limit });
  } else {
    rows = db.logs.recent.all({ limit });
  }
  res.json({ ok: true, count: rows.length, logs: rows });
});

app.delete('/api/logs', (_req, res) => {
  const r = db.logs.clear.run();
  res.json({ ok: true, deleted: r.changes });
});

// -------------------------------------------------------------
// Scheduled queue
// -------------------------------------------------------------
app.get('/api/schedule', (req, res) => {
  const status = req.query.status || 'pending';
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const rows = (status === 'all')
    ? db.scheduled.recent.all({ limit })
    : db.scheduled.byStatus.all({ status, limit });
  res.json({ ok: true, count: rows.length, scheduled: rows });
});

app.delete('/api/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  const r = db.scheduled.cancel.run({ id });
  if (!r.changes) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_TERMINAL' });
  res.json({ ok: true });
});

// -------------------------------------------------------------
// File upload — returns an "internal:" URL the /api/send endpoint
// understands (read straight from disk via MessageMedia.fromFilePath).
// -------------------------------------------------------------
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'NO_FILE' });
  const internalUrl = 'internal:' + path.join(UPLOADS_DIR, req.file.filename);
  const publicUrl   = `http://${HOST}:${PORT}/files/${encodeURIComponent(req.file.filename)}`;
  res.json({
    ok: true,
    url: internalUrl,           // pass back to /api/send as fileUrl
    publicUrl,                   // optional: for previewing in dashboard
    filename: req.file.originalname,
    storedAs: req.file.filename,
    size: req.file.size,
    mime: req.file.mimetype
  });
});

// -------------------------------------------------------------
// Test send + logout
// -------------------------------------------------------------
app.post('/api/test', async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  try {
    await whatsapp.send(phone, message || 'בדיקה מ־Pulse · WhatsApp Operations ✓');
    res.json({ ok: true });
  } catch (e) {
    res.status(httpStatusFor(e.code)).json({
      ok: false, error: e.code || 'SEND_FAILED', message: e.message
    });
  }
});

app.post('/api/logout', async (_req, res) => {
  await whatsapp.logout();
  res.json({ ok: true });
});

// -------------------------------------------------------------
// Contacts & Groups
// -------------------------------------------------------------
app.get('/api/contacts', async (req, res) => {
  try {
    const fresh = req.query.fresh === '1';
    const q = (req.query.q || '').trim().toLowerCase();
    let list = await whatsapp.getContacts(fresh);
    if (q) {
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) || c.phone.includes(q)
      );
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    res.json({ ok: true, count: list.length, contacts: list.slice(0, limit) });
  } catch (e) {
    res.status(httpStatusFor(e.code)).json({
      ok: false, error: e.code || 'CONTACTS_FAILED', message: e.message
    });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const fresh = req.query.fresh === '1';
    const q = (req.query.q || '').trim().toLowerCase();
    let list = await whatsapp.getGroups(fresh);
    if (q) list = list.filter(g => g.name.toLowerCase().includes(q));
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    res.json({ ok: true, count: list.length, groups: list.slice(0, limit) });
  } catch (e) {
    res.status(httpStatusFor(e.code)).json({
      ok: false, error: e.code || 'GROUPS_FAILED', message: e.message
    });
  }
});

// -------------------------------------------------------------
// Profile picture lookup (lazy, cached)
// -------------------------------------------------------------
app.get('/api/profile-pic', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  try {
    const url = await whatsapp.getProfilePic(id);
    res.json({ ok: true, id, url });
  } catch (e) {
    // Never fail this endpoint hard — null url is a graceful fallback.
    res.json({ ok: true, id, url: null, error: e.code || 'PIC_FAILED' });
  }
});

// -------------------------------------------------------------
// Recurring schedules
// -------------------------------------------------------------
app.get('/api/recurring', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const onlyActive = req.query.active === '1';
  const rows = onlyActive
    ? db.recurring.active.all({ limit })
    : db.recurring.recent.all({ limit });
  res.json({ ok: true, count: rows.length, recurring: rows });
});

app.post('/api/recurring', (req, res) => {
  const { phone, message, fileUrl, frequency, startAt, label } = req.body || {};

  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  }
  const allowed = ['hourly', 'daily', 'weekly', 'monthly'];
  if (!allowed.includes(frequency)) {
    return res.status(400).json({ ok: false, error: 'INVALID_FREQUENCY' });
  }
  const start = startAt ? new Date(startAt) : new Date();
  if (isNaN(start.getTime())) {
    return res.status(400).json({ ok: false, error: 'INVALID_START' });
  }

  let next;
  try {
    next = scheduler.computeNextRun(frequency, start.toISOString());
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const r = db.recurring.insert.run({
    phone, message,
    file_url:    fileUrl || null,
    frequency,
    start_at:    start.toISOString(),
    next_run_at: next.toISOString(),
    label:       label || null
  });

  res.json({ ok: true, id: r.lastInsertRowid, nextRunAt: next.toISOString() });
});

app.patch('/api/recurring/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

  const body = req.body || {};

  // Pure toggle — kept for backward compatibility with existing UI.
  if (Object.keys(body).length === 1 && 'active' in body) {
    const active = body.active ? 1 : 0;
    const r = db.recurring.setActive.run({ id, active });
    if (!r.changes) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true });
  }

  // Full edit — load current row, merge incoming fields, recompute next_run_at
  // when start_at or frequency change.
  const current = db.recurring.byId.get({ id });
  if (!current) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const VALID = ['hourly', 'daily', 'weekly', 'monthly'];
  const merged = {
    id,
    phone:    body.phone     ?? current.phone,
    message:  body.message   ?? current.message,
    file_url: 'fileUrl' in body ? (body.fileUrl || null) : current.fileUrl,
    frequency: body.frequency ?? current.frequency,
    start_at:  body.startAt   ?? current.startAt,
    label:     body.label     ?? current.label
  };
  if (!VALID.includes(merged.frequency)) {
    return res.status(400).json({ ok: false, error: 'INVALID_FREQUENCY' });
  }

  // If startAt or frequency changed, recompute next_run_at; else keep it.
  if (body.startAt || body.frequency) {
    const start = new Date(merged.start_at);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ ok: false, error: 'INVALID_START_AT' });
    }
    merged.next_run_at = scheduler
      .computeNextRun(merged.frequency, start.toISOString())
      .toISOString();
  } else {
    merged.next_run_at = current.nextRunAt;
  }

  if ('active' in body) {
    db.recurring.setActive.run({ id, active: body.active ? 1 : 0 });
  }
  const r = db.recurring.update.run(merged);
  if (!r.changes) return res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  res.json({ ok: true, recurring: db.recurring.byId.get({ id }) });
});

// Edit a one-shot scheduled message (only when still pending).
app.patch('/api/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

  const current = db.scheduled.byId.get({ id });
  if (!current) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (current.status !== 'pending') {
    return res.status(409).json({ ok: false, error: 'NOT_EDITABLE' });
  }

  const body = req.body || {};
  const merged = {
    id,
    phone:    body.phone    ?? current.phone,
    message:  body.message  ?? current.message,
    file_url: 'fileUrl' in body ? (body.fileUrl || null) : current.fileUrl,
    send_at:  body.sendAt   ?? current.sendAt
  };

  if (body.sendAt) {
    const d = new Date(body.sendAt);
    if (isNaN(d.getTime())) return res.status(400).json({ ok: false, error: 'INVALID_SEND_AT' });
    merged.send_at = d.toISOString();
  }

  const r = db.scheduled.update.run(merged);
  if (!r.changes) return res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  res.json({ ok: true, scheduled: db.scheduled.byId.get({ id }) });
});

app.delete('/api/recurring/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  db.recurring.remove.run({ id });
  res.json({ ok: true });
});

// -------------------------------------------------------------
// Export / Import — backup the schedule queues to a portable JSON.
// -------------------------------------------------------------
app.get('/api/export', (_req, res) => {
  const recurring = db.recurring.recent.all({ limit: 5000 });
  // Only export pending one-shots — sent/cancelled rows are history,
  // re-importing them would be confusing.
  const scheduled = db.scheduled.byStatus.all({ status: 'pending', limit: 5000 });
  res.json({
    ok: true,
    version: 1,
    kind: 'pulse-schedules-backup',
    exportedAt: new Date().toISOString(),
    counts: { recurring: recurring.length, scheduled: scheduled.length },
    recurring,
    scheduled
  });
});

app.post('/api/import', (req, res) => {
  const body = req.body || {};
  if (body.kind && body.kind !== 'pulse-schedules-backup') {
    return res.status(400).json({ ok: false, error: 'WRONG_BACKUP_KIND' });
  }
  if (body.version && body.version > 1) {
    return res.status(400).json({ ok: false, error: 'UNSUPPORTED_VERSION' });
  }

  const VALID_FREQ = ['hourly', 'daily', 'weekly', 'monthly'];
  let addedR = 0, addedS = 0, skipped = 0;

  // Recurring
  for (const r of (body.recurring || [])) {
    if (!r.phone || !r.message || !VALID_FREQ.includes(r.frequency) || !r.startAt) {
      skipped++;
      continue;
    }
    try {
      const start = new Date(r.startAt);
      if (isNaN(start.getTime())) { skipped++; continue; }
      const next = scheduler.computeNextRun(r.frequency, start.toISOString());
      db.recurring.insert.run({
        phone:       r.phone,
        message:     r.message,
        file_url:    r.fileUrl || null,
        frequency:   r.frequency,
        start_at:    start.toISOString(),
        next_run_at: next.toISOString(),
        label:       r.label || null
      });
      addedR++;
    } catch { skipped++; }
  }

  // One-shot scheduled — only future-dated, otherwise they'd fire immediately.
  const now = Date.now();
  for (const s of (body.scheduled || [])) {
    if (!s.phone || !s.message || !s.sendAt) { skipped++; continue; }
    const t = new Date(s.sendAt).getTime();
    if (isNaN(t) || t <= now) { skipped++; continue; }
    try {
      db.scheduled.insert.run({
        phone:       s.phone,
        message:     s.message,
        file_url:    s.fileUrl || null,
        send_at:     new Date(t).toISOString(),
        source:      'import',
        external_id: null
      });
      addedS++;
    } catch { skipped++; }
  }

  res.json({
    ok: true,
    added: { recurring: addedR, scheduled: addedS },
    skipped
  });
});

// -------------------------------------------------------------
// 404 + error handler
// -------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ ok: false, error: err.code || 'SERVER_ERROR', message: err.message });
});

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function httpStatusFor(code) {
  switch (code) {
    case 'INVALID_PHONE':
    case 'EMPTY_MESSAGE':
    case 'INVALID_FILE_URL':
      return 400;
    case 'NOT_REGISTERED':
    case 'FILE_NOT_FOUND':
      return 404;
    case 'NOT_READY':
      return 503;
    default:
      return 500;
  }
}

// -------------------------------------------------------------
// Boot
// -------------------------------------------------------------
async function main() {
  console.log('━'.repeat(64));
  console.log('  Pulse · WhatsApp Operations — Backend v1.0.0');
  console.log('━'.repeat(64));

  const server = app.listen(PORT, HOST, () => {
    console.log(`[http]      listening on http://${HOST}:${PORT}`);
    console.log(`[http]      dashboard → set Backend URL to http://${HOST}:${PORT}`);
    console.log(`[http]      health   → http://${HOST}:${PORT}/api/health`);
  });

  // Bring up the WhatsApp client (may take 10–30s on first start).
  console.log('[whatsapp]  initializing (this may take a moment on first run)…');
  whatsapp.start().catch(e => console.error('[whatsapp] init error:', e.message));

  // Background loops once HTTP & WhatsApp are queued up.
  setTimeout(() => scheduler.start(), 2000);

  // Graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n[shutdown] received ${sig} — closing…`);
    scheduler.stop();
    server.close();
    try { await whatsapp.client?.destroy(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    console.error('[uncaught]', e);
  });
  process.on('unhandledRejection', (e) => {
    console.error('[unhandled]', e);
  });
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});

// -------------------------------------------------------------
// Landing HTML (shown only when ./public/index.html doesn't exist)
// -------------------------------------------------------------
const LANDING_HTML = `<!doctype html>
<html lang="he" dir="rtl"><head>
<meta charset="utf-8"><title>Pulse · Backend</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
    font-family:-apple-system,'Segoe UI',Heebo,system-ui,sans-serif;
    background:#0a0a0a;color:#e5e5e5;padding:24px}
  .card{max-width:640px;width:100%;background:#141414;border:1px solid #262626;
    border-radius:18px;padding:36px 32px;box-shadow:0 24px 60px -20px #000}
  h1{margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-.01em}
  .sub{color:#737373;font-size:14px;margin-bottom:28px}
  .ok{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;
    border-radius:999px;background:#0a2818;color:#22c55e;font-size:13px;
    font-weight:500;border:1px solid #14532d;margin-bottom:24px}
  .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;
    box-shadow:0 0 8px #22c55e;animation:p 2s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
  h2{font-size:13px;font-weight:600;color:#a3a3a3;text-transform:uppercase;
    letter-spacing:.08em;margin:24px 0 10px}
  ol{margin:0;padding:0 18px 0 0;line-height:1.8;color:#d4d4d4;font-size:14px}
  ol li{margin-bottom:6px}
  code{background:#262626;padding:2px 8px;border-radius:6px;font-size:12.5px;
    font-family:'JetBrains Mono',Menlo,monospace;color:#d4a574}
  .ep{display:grid;grid-template-columns:80px 1fr;gap:12px;font-size:13px;
    padding:8px 0;border-bottom:1px solid #1f1f1f;font-family:'JetBrains Mono',Menlo,monospace}
  .ep:last-child{border:0}
  .m-get{color:#3b82f6}.m-post{color:#22c55e}.m-put{color:#f59e0b}.m-del{color:#ef4444}
  a{color:#d4a574;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
  <div class="ok"><span class="dot"></span>Backend פעיל</div>
  <h1>Pulse · WhatsApp Operations</h1>
  <div class="sub">Backend API server · v1.0.0</div>
  <p style="color:#a3a3a3;font-size:14px;line-height:1.7;margin:0 0 12px">
    זהו שרת ה־API. הדשבורד הוא קובץ נפרד שצריך לפתוח בנפרד.
  </p>
  <h2>איך לפתוח את הדשבורד</h2>
  <ol>
    <li>אפשרות א׳ — דאבל קליק על <code>index.html</code> מתיקיית הדשבורד</li>
    <li>אפשרות ב׳ <em>(מומלץ)</em> — צור תיקייה <code>public/</code> כאן ב־
      <code>whatsapp-backend</code>, העתק לתוכה את שלושת קבצי הדשבורד
      (<code>index.html</code>, <code>app.css</code>, <code>app.js</code>),
      והפעל מחדש. הדשבורד יוגש מאותה כתובת — אפס CORS.</li>
    <li>בהגדרות הדשבורד הגדר את ה־Backend URL ל־
      <code>http://127.0.0.1:3001</code></li>
  </ol>
  <h2>Endpoints</h2>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/health">/api/health</a> · liveness</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/status">/api/status</a> · WhatsApp state + QR</span></div>
  <div class="ep"><span class="m-post">POST</span><span>/api/send · שליחת/תזמון הודעה</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/logs">/api/logs</a> · היסטוריה</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/schedule">/api/schedule</a> · תור מתוזמן חד־פעמי</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/recurring">/api/recurring</a> · תזמונים חוזרים</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/contacts">/api/contacts</a> · אנשי קשר</span></div>
  <div class="ep"><span class="m-get">GET</span><span><a href="/api/groups">/api/groups</a> · קבוצות</span></div>
  <div class="ep"><span class="m-post">POST</span><span>/api/upload · העלאת קובץ (multipart)</span></div>
</div>
</body></html>`;
