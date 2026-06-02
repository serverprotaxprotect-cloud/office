const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { put } = require('@vercel/blob');
const { EventEmitter } = require('events');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const portalAuth = require('../middleware/portalAuth');
const { createNotif } = require('./notifications');

const router = express.Router();
const portalRouter = express.Router();
const bus = new EventEmitter();
bus.setMaxListeners(200);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function sseAuth(req, res, next) {
  const header = req.headers.authorization;
  const raw = (header && header.split(' ')[1]) || req.query.token;
  if (!raw) return res.status(401).json({ success: false, message: 'Login required' });
  try {
    const decoded = jwt.verify(raw, process.env.JWT_SECRET);
    if (!decoded.organization_id) return res.status(401).json({ success: false, message: 'Organisation context missing' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
}
const VALID_MESSAGE_TYPES = new Set(['message', 'call_log']);
const CALL_STATUSES = new Set(['Called', 'Connected', 'No Response', 'Client Will Send', 'Pending From Client', 'Refused/Denied', 'Callback Scheduled']);
const THREAD_STATUSES = new Set(['Open', 'Waiting for Client', 'Resolved', 'Closed']);
const ATTACHMENT_CATEGORIES = new Set(['General', 'PAN', 'Aadhaar', 'Bank Statement', 'GST Data', 'MCA Document', 'Income Tax Document', 'KYC Document']);

function actorFromUser(user = {}) {
  const isAdmin = user.user_type === 'admin' || user.is_admin;
  return {
    type: isAdmin ? 'admin' : 'employee',
    id: user.emp_id || user.username || String(user.id || ''),
    name: user.formal_name || user.name || user.username || user.emp_id || 'User',
    isAdmin,
  };
}

function actorFromPortal(user = {}) {
  return {
    type: user.account_type === 'agent' ? 'agent' : 'client',
    id: user.account_type === 'agent' ? user.agent_id : user.client_id,
    name: user.display_name || user.login_id || 'Portal User',
  };
}

function escLike(value) {
  return `%${String(value || '').trim()}%`;
}

async function ensureTables() {
  await db.query(`CREATE TABLE IF NOT EXISTS chat_threads (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_type VARCHAR(40) NOT NULL DEFAULT 'general',
    visibility VARCHAR(40) NOT NULL DEFAULT 'internal',
    client_id VARCHAR(50),
    agent_id VARCHAR(50),
    linked_module VARCHAR(40),
    linked_record_id VARCHAR(100),
    linked_task_id VARCHAR(100),
    subject TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Open',
    created_by_type VARCHAR(20) NOT NULL,
    created_by_id VARCHAR(80) NOT NULL,
    created_by_name TEXT,
    waiting_since TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    escalated_at TIMESTAMPTZ,
    next_follow_up_at TIMESTAMPTZ,
    followup_notified_at TIMESTAMPTZ,
    last_client_visible_at TIMESTAMPTZ,
    last_client_seen_at TIMESTAMPTZ,
    last_client_reply_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL,
    sender_id VARCHAR(80) NOT NULL,
    sender_name TEXT,
    message_type VARCHAR(30) NOT NULL DEFAULT 'message',
    body TEXT,
    client_visible BOOLEAN NOT NULL DEFAULT FALSE,
    call_status VARCHAR(50),
    follow_up_at TIMESTAMPTZ,
    seen_by_client_at TIMESTAMPTZ,
    attachment_category VARCHAR(80),
    edited_at TIMESTAMPTZ,
    edited_by_type VARCHAR(20),
    edited_by_id VARCHAR(80),
    deleted_at TIMESTAMPTZ,
    deleted_by_type VARCHAR(20),
    deleted_by_id VARCHAR(80),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS chat_participants (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    participant_type VARCHAR(20) NOT NULL,
    participant_id VARCHAR(80) NOT NULL,
    participant_name TEXT,
    last_read_message_id INTEGER,
    last_read_at TIMESTAMPTZ,
    unread_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id, thread_id, participant_type, participant_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS chat_mentions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    mentioned_type VARCHAR(20) NOT NULL,
    mentioned_id VARCHAR(80) NOT NULL,
    mentioned_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS chat_attachments (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_id INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    pathname TEXT,
    filename TEXT NOT NULL,
    mime_type VARCHAR(120),
    size_bytes INTEGER,
    uploaded_by_type VARCHAR(20),
    uploaded_by_id VARCHAR(80),
    uploaded_by_name TEXT,
    category VARCHAR(80),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS chat_message_audit (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    message_id INTEGER NOT NULL,
    action VARCHAR(20) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    actor_type VARCHAR(20),
    actor_id VARCHAR(80),
    actor_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  const alters = [
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS followup_notified_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_client_visible_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_client_seen_at TIMESTAMPTZ`,
    `ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_client_reply_at TIMESTAMPTZ`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS seen_by_client_at TIMESTAMPTZ`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_category VARCHAR(80)`,
    `ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS category VARCHAR(80)`,
    `CREATE TABLE IF NOT EXISTS chat_quick_templates (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category VARCHAR(80),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_threads_followup ON chat_threads(organization_id, status, next_follow_up_at)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_client_seen ON chat_messages(organization_id, thread_id, client_visible, seen_by_client_at)`,
  ];
  for (const sql of alters) await db.query(sql);
  await db.query(
    `INSERT INTO chat_quick_templates (title, body, category)
     SELECT v.title, v.body, v.category
     FROM (VALUES
       ('Bank Statement Request','Please send bank statement for the required period so we can complete the work.','Documents'),
       ('DSC OTP Request','Please share the DSC OTP when received.','MCA'),
       ('ITR Documents Pending','ITR filing documents are pending. Please share Form 16, bank statement, investment proofs and AIS/TIS details.','Income Tax'),
       ('GST Data Pending','GST data/invoices are pending. Please share purchase, sales and expense details.','GST'),
       ('KYC Documents Pending','PAN, Aadhaar and required KYC documents are pending. Please share clear copies.','KYC')
     ) AS v(title, body, category)
     WHERE NOT EXISTS (SELECT 1 FROM chat_quick_templates q WHERE q.organization_id=current_organization_id() AND q.title=v.title)`
  );
}

function emitChat(orgId, event) {
  bus.emit(`org:${orgId}`, event);
}

async function upsertParticipant(conn, threadId, type, id, name) {
  if (!id) return;
  await conn.query(
    `INSERT INTO chat_participants (thread_id, participant_type, participant_id, participant_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, thread_id, participant_type, participant_id)
     DO UPDATE SET participant_name=COALESCE(EXCLUDED.participant_name, chat_participants.participant_name)`,
    [threadId, type, id, name || id]
  );
}

async function loadEmployeeNames(conn, ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return new Map();
  const r = await conn.query(
    `SELECT emp_id, COALESCE(formal_name, name, emp_id) AS name FROM emplist WHERE emp_id = ANY($1)
     UNION ALL
     SELECT username AS emp_id, name FROM admins WHERE username = ANY($1)`,
    [clean]
  );
  return new Map(r.rows.map(row => [row.emp_id, row.name]));
}

async function addAllTeamParticipants(conn, threadId) {
  const r = await conn.query(
    `SELECT emp_id, COALESCE(formal_name, name, emp_id) AS name FROM emplist WHERE COALESCE(status,'Active')='Active'
     UNION ALL
     SELECT username AS emp_id, name FROM admins WHERE COALESCE(status,'Active')='Active'`
  );
  for (const row of r.rows) await upsertParticipant(conn, threadId, 'employee', row.emp_id, row.name);
}

async function createChatNotifications(conn, thread, message, actor, mentionedIds) {
  const participants = await conn.query(
    `SELECT participant_type, participant_id FROM chat_participants
     WHERE organization_id=$2 AND thread_id=$1 AND participant_type IN ('employee','admin')`,
    [thread.id, thread.organization_id]
  );
  const notifyIds = new Set(participants.rows.map(p => p.participant_id).filter(id => id && id !== actor.id));
  (mentionedIds || []).forEach(id => { if (id && id !== actor.id) notifyIds.add(id); });
  const title = mentionedIds?.length ? `You were mentioned: ${thread.subject}` : `New chat: ${thread.subject}`;
  const body = String(message.body || message.call_status || 'New chat activity').slice(0, 250);
  for (const empId of notifyIds) {
    await createNotif(empId, mentionedIds?.includes(empId) ? 'chat_mention' : 'chat_message', title, body, `CHAT-${thread.id}`);
  }
}

async function updateThreadStatus(conn, threadId, orgId, status) {
  if (!THREAD_STATUSES.has(status)) {
    const err = new Error('Invalid thread status');
    err.statusCode = 400;
    throw err;
  }
  const r = await conn.query(
    `UPDATE chat_threads
     SET status=$2,
         waiting_since=CASE WHEN $2::varchar='Waiting for Client' AND waiting_since IS NULL THEN NOW() WHEN $2::varchar <> 'Waiting for Client' THEN NULL ELSE waiting_since END,
         resolved_at=CASE WHEN $2::varchar='Resolved' THEN NOW() ELSE resolved_at END,
         closed_at=CASE WHEN $2::varchar='Closed' THEN NOW() ELSE closed_at END,
         updated_at=NOW()
     WHERE id=$1 AND organization_id=$3
     RETURNING *`,
    [threadId, status, orgId]
  );
  return r.rows[0];
}

async function notifyFollowups(conn, orgId) {
  const r = await conn.query(
    `SELECT id, subject, next_follow_up_at, created_by_id
     FROM chat_threads
     WHERE status IN ('Open','Waiting for Client')
       AND organization_id=$1
       AND next_follow_up_at IS NOT NULL
       AND next_follow_up_at <= NOW()
       AND (followup_notified_at IS NULL OR followup_notified_at < next_follow_up_at)
     LIMIT 100`,
    [orgId]
  );
  for (const row of r.rows) {
    await createNotif(row.created_by_id, 'chat_followup', `Chat follow-up due: ${row.subject}`, `Follow-up date/time reached for chat #${row.id}`, `CHAT-${row.id}`);
  }
  if (r.rows.length) {
    await conn.query(`UPDATE chat_threads SET followup_notified_at=NOW() WHERE organization_id=$1 AND id = ANY($2)`, [orgId, r.rows.map(x => x.id)]);
    emitChat(orgId, { type: 'thread_unread_changed' });
  }
}

async function applyEscalations(conn, orgId) {
  const r = await conn.query(
    `UPDATE chat_threads
     SET escalated_at=NOW(), updated_at=NOW()
     WHERE status='Waiting for Client'
       AND organization_id=$1
       AND waiting_since IS NOT NULL
       AND waiting_since <= NOW() - INTERVAL '3 days'
       AND escalated_at IS NULL
     RETURNING id, subject, created_by_id`,
    [orgId]
  );
  for (const row of r.rows) {
    await createNotif(row.created_by_id, 'chat_escalation', `Client reply overdue: ${row.subject}`, 'Client response is pending for more than 3 days.', `CHAT-${row.id}`);
  }
  return r.rows.length;
}

async function addMessage(conn, thread, actor, payload, portalMode = false) {
  const messageType = VALID_MESSAGE_TYPES.has(payload.message_type) ? payload.message_type : 'message';
  const clientVisible = portalMode ? true : !!payload.client_visible;
  if (clientVisible && !thread.client_id && !thread.agent_id) {
    const err = new Error('Client/agent selection required for client-visible message');
    err.statusCode = 400;
    throw err;
  }
  if (messageType === 'call_log' && payload.call_status && !CALL_STATUSES.has(payload.call_status)) {
    const err = new Error('Invalid call status');
    err.statusCode = 400;
    throw err;
  }
  if (!String(payload.body || '').trim() && messageType === 'message') {
    const err = new Error('Message required');
    err.statusCode = 400;
    throw err;
  }
  const msg = await conn.query(
    `INSERT INTO chat_messages
       (thread_id, sender_type, sender_id, sender_name, message_type, body, client_visible, call_status, follow_up_at, attachment_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [thread.id, actor.type, actor.id, actor.name, messageType, payload.body || null, clientVisible, payload.call_status || null, payload.follow_up_at || null, ATTACHMENT_CATEGORIES.has(payload.attachment_category) ? payload.attachment_category : null]
  );
  const message = msg.rows[0];
  const mentionNames = await loadEmployeeNames(conn, payload.mention_ids || []);
  if (payload.tell_all_team) await addAllTeamParticipants(conn, thread.id);
  for (const [id, name] of mentionNames.entries()) {
    await upsertParticipant(conn, thread.id, 'employee', id, name);
    await conn.query(
      `INSERT INTO chat_mentions (thread_id, message_id, mentioned_type, mentioned_id, mentioned_name)
       VALUES ($1,$2,'employee',$3,$4)`,
      [thread.id, message.id, id, name]
    );
  }
  if (Array.isArray(payload.attachment_ids) && payload.attachment_ids.length) {
    await conn.query(
      `UPDATE chat_attachments
       SET thread_id=$1, message_id=$2, category=COALESCE($4, category)
       WHERE id = ANY($3) AND organization_id=$5 AND message_id IS NULL`,
      [thread.id, message.id, payload.attachment_ids.map(Number).filter(Boolean), ATTACHMENT_CATEGORIES.has(payload.attachment_category) ? payload.attachment_category : null, thread.organization_id]
    );
  }
  await upsertParticipant(conn, thread.id, actor.type, actor.id, actor.name);
  await conn.query(`UPDATE chat_threads SET last_message_at=NOW(), updated_at=NOW() WHERE id=$1 AND organization_id=$2`, [thread.id, thread.organization_id]);
  if (clientVisible || messageType === 'call_log' || payload.follow_up_at || actor.type === 'client' || actor.type === 'agent') {
    await conn.query(
      `UPDATE chat_threads
       SET last_client_visible_at=CASE WHEN $2 THEN NOW() ELSE last_client_visible_at END,
           last_client_reply_at=CASE WHEN $3 THEN NOW() ELSE last_client_reply_at END,
           next_follow_up_at=COALESCE($4, next_follow_up_at),
           status=CASE WHEN $5 THEN 'Waiting for Client' WHEN $3 AND status='Waiting for Client' THEN 'Open' ELSE status END,
           waiting_since=CASE WHEN $5 THEN COALESCE(waiting_since, NOW()) WHEN $3 THEN NULL ELSE waiting_since END,
           updated_at=NOW()
       WHERE id=$1 AND organization_id=$6`,
      [thread.id, clientVisible, ['client', 'agent'].includes(actor.type), payload.follow_up_at || null, payload.call_status === 'Pending From Client' || payload.call_status === 'Client Will Send', thread.organization_id]
    );
  }
  await conn.query(
    `UPDATE chat_participants SET unread_count=unread_count+1
     WHERE thread_id=$1 AND organization_id=$4 AND NOT (participant_type=$2 AND participant_id=$3)`,
    [thread.id, actor.type, actor.id, thread.organization_id]
  );
  if (!portalMode) {
    await createChatNotifications(conn, thread, message, actor, [...mentionNames.keys()]);
  } else {
    await createChatNotifications(conn, thread, message, actor, []);
  }
  return message;
}

async function getThreadForOffice(id, orgId) {
  const r = await db.query(`SELECT * FROM chat_threads WHERE id=$1 AND organization_id=$2`, [id, orgId]);
  return r.rows[0] || null;
}

async function getThreadForPortal(id, portalUser) {
  const params = [id, portalUser.organization_id];
  let where = 'id=$1 AND organization_id=$2 AND status <> $3';
  params.push('Deleted');
  if (portalUser.account_type === 'agent') {
    params.push(portalUser.agent_id);
    where += ` AND agent_id=$${params.length}`;
  } else {
    params.push(portalUser.client_id);
    where += ` AND client_id=$${params.length}`;
  }
  const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(`SELECT * FROM chat_threads WHERE ${where}`, params));
  return r.rows[0] || null;
}

router.get('/threads', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    await notifyFollowups(db, req.user.organization_id).catch(() => {});
    await applyEscalations(db, req.user.organization_id).catch(() => {});
    const actor = actorFromUser(req.user);
    const params = [req.user.organization_id];
    const conds = [`t.organization_id=$1`, `t.status <> 'Deleted'`];
    if (req.query.client_id) { params.push(req.query.client_id); conds.push(`t.client_id=$${params.length}`); }
    if (req.query.module) { params.push(req.query.module); conds.push(`t.linked_module=$${params.length}`); }
    if (req.query.record_id) { params.push(req.query.record_id); conds.push(`t.linked_record_id=$${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`t.status=$${params.length}`); }
    if (req.query.inbox === 'unread') conds.push(`COALESCE(p2.unread_count,0) > 0`);
    if (req.query.inbox === 'pending_followup') conds.push(`t.next_follow_up_at IS NOT NULL AND t.next_follow_up_at <= NOW() AND t.status IN ('Open','Waiting for Client')`);
    if (req.query.inbox === 'client_replies') conds.push(`t.last_client_reply_at IS NOT NULL AND (p2.last_read_at IS NULL OR t.last_client_reply_at > p2.last_read_at)`);
    if (req.query.inbox === 'mentioned') conds.push(`EXISTS (SELECT 1 FROM chat_mentions cm WHERE cm.organization_id=t.organization_id AND cm.thread_id=t.id AND cm.mentioned_id=$${params.length + 1})`);
    if (req.query.inbox === 'mentioned') params.push(actor.id);
    if (req.query.search) {
      params.push(escLike(req.query.search));
      conds.push(`(t.subject ILIKE $${params.length} OR t.client_id ILIKE $${params.length} OR t.linked_task_id ILIKE $${params.length})`);
    }
    const participantJoin = actor.isAdmin ? '' : `LEFT JOIN chat_participants p ON p.organization_id=t.organization_id AND p.thread_id=t.id AND p.participant_type=$${params.length + 1} AND p.participant_id=$${params.length + 2}`;
    if (!actor.isAdmin) {
      params.push(actor.type, actor.id);
      conds.push(`(p.id IS NOT NULL OR t.created_by_id=$${params.length + 1})`);
      params.push(actor.id);
    }
    const r = await db.query(
      `SELECT t.*,
              COALESCE(p2.unread_count,0) AS unread_count,
              (SELECT COUNT(*) FROM chat_messages cm WHERE cm.organization_id=t.organization_id AND cm.thread_id=t.id AND cm.client_visible=true AND cm.seen_by_client_at IS NULL AND cm.sender_type IN ('employee','admin')) AS client_unseen_count,
              (SELECT body FROM chat_messages m WHERE m.organization_id=t.organization_id AND m.thread_id=t.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_message_body
       FROM chat_threads t
       ${participantJoin}
       LEFT JOIN chat_participants p2 ON p2.organization_id=t.organization_id AND p2.thread_id=t.id AND p2.participant_type=$${params.length + 1} AND p2.participant_id=$${params.length + 2}
       WHERE ${conds.join(' AND ')}
       ORDER BY t.last_message_at DESC LIMIT 200`,
      [...params, actor.type, actor.id]
    );
    res.json({ success: true, threads: r.rows });
  } catch (err) {
    console.error('[chat threads]', err);
    res.status(500).json({ success: false, message: err.message || 'Chat load failed' });
  }
});

router.get('/templates', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(
      `SELECT id, title, body, category
       FROM chat_quick_templates
       WHERE organization_id=$1 AND active=true
       ORDER BY category, title`,
      [req.user.organization_id]
    );
    res.json({ success: true, templates: r.rows, statuses: [...THREAD_STATUSES], attachment_categories: [...ATTACHMENT_CATEGORIES] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Templates load failed' });
  }
});

router.get('/followups', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    await notifyFollowups(db, req.user.organization_id).catch(() => {});
    await applyEscalations(db, req.user.organization_id).catch(() => {});
    const r = await db.query(
      `SELECT id, subject, client_id, agent_id, status, next_follow_up_at, waiting_since, escalated_at, last_client_reply_at
       FROM chat_threads
       WHERE status IN ('Open','Waiting for Client')
         AND organization_id=$1
         AND (next_follow_up_at <= NOW() OR status='Waiting for Client')
       ORDER BY COALESCE(next_follow_up_at, waiting_since, updated_at) ASC
       LIMIT 200`,
      [req.user.organization_id]
    );
    res.json({ success: true, followups: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Follow-up list failed' });
  }
});

router.get('/report', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const params = [req.user.organization_id];
    const conds = [`t.organization_id=$1`, `m.organization_id=$1`, `t.status <> 'Deleted'`];
    if (req.query.client_id) { params.push(req.query.client_id); conds.push(`t.client_id=$${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`m.created_at::date >= $${params.length}::date`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`m.created_at::date <= $${params.length}::date`); }
    if (req.query.module) { params.push(req.query.module); conds.push(`t.linked_module=$${params.length}`); }
    const r = await db.query(
      `SELECT t.id AS thread_id, t.subject, t.client_id, t.agent_id, t.linked_module, t.linked_task_id, t.status AS thread_status,
              m.id AS message_id, m.sender_type, m.sender_name, m.message_type, m.call_status, m.client_visible,
              m.body, m.follow_up_at, m.seen_by_client_at, m.created_at
       FROM chat_threads t
       JOIN chat_messages m ON m.organization_id=t.organization_id AND m.thread_id=t.id
       WHERE ${conds.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT 1000`,
      params
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Report load failed' });
  }
});

router.get('/timeline', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const module = req.query.module || '';
    const recordId = req.query.record_id || '';
    if (!module || !recordId) return res.json({ success: true, threads: [] });
    const r = await db.query(
      `SELECT t.*, (SELECT body FROM chat_messages m WHERE m.organization_id=t.organization_id AND m.thread_id=t.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_message_body
       FROM chat_threads t
       WHERE t.organization_id=$3 AND t.status <> 'Deleted'
         AND (t.linked_module=$1 AND (t.linked_record_id=$2 OR t.linked_task_id=$2))
       ORDER BY t.last_message_at DESC
       LIMIT 50`,
      [module, recordId, req.user.organization_id]
    );
    res.json({ success: true, threads: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Timeline load failed' });
  }
});

router.post('/threads', authMiddleware, async (req, res) => {
  await ensureTables();
  const actor = actorFromUser(req.user);
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const visibility = ['client', 'client_visible'].includes(req.body.visibility) ? 'client' : 'internal';
    if (visibility === 'client' && !req.body.client_id && !req.body.agent_id) {
      await conn.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Client/agent required for client-visible thread' });
    }
    const t = await conn.query(
      `INSERT INTO chat_threads
        (thread_type, visibility, client_id, agent_id, linked_module, linked_record_id, linked_task_id, subject, created_by_type, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.body.thread_type || 'general', visibility, req.body.client_id || null, req.body.agent_id || null, req.body.linked_module || null, req.body.linked_record_id || null, req.body.linked_task_id || null, req.body.subject || 'Chat', actor.type, actor.id, actor.name]
    );
    const thread = t.rows[0];
    await upsertParticipant(conn, thread.id, actor.type, actor.id, actor.name);
    const names = await loadEmployeeNames(conn, req.body.participant_ids || []);
    for (const [id, name] of names.entries()) await upsertParticipant(conn, thread.id, 'employee', id, name);
    const message = await addMessage(conn, thread, actor, {
      body: req.body.message || req.body.body || 'Thread started',
      message_type: req.body.message_type || 'message',
      client_visible: visibility === 'client',
      call_status: req.body.call_status || null,
      follow_up_at: req.body.follow_up_at || null,
      mention_ids: req.body.mention_ids || [],
      attachment_ids: req.body.attachment_ids || [],
      attachment_category: req.body.attachment_category || null,
      tell_all_team: !!req.body.tell_all_team,
    });
    await conn.query('COMMIT');
    emitChat(req.user.organization_id, { type: 'message_created', thread_id: thread.id, message_id: message.id });
    res.json({ success: true, message: 'Chat thread created', thread, first_message: message });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[chat create]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Chat create failed' });
  } finally {
    conn.release();
  }
});

router.put('/threads/:id/status', authMiddleware, async (req, res) => {
  const actor = actorFromUser(req.user);
  const conn = await db.pool.connect();
  try {
    await ensureTables();
    await conn.query('BEGIN');
    const old = (await conn.query(`SELECT * FROM chat_threads WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [req.params.id, req.user.organization_id])).rows[0];
    if (!old) throw Object.assign(new Error('Thread not found'), { statusCode: 404 });
    const thread = await updateThreadStatus(conn, old.id, req.user.organization_id, req.body.status || 'Open');
    await conn.query(
      `INSERT INTO chat_message_audit (message_id, action, old_value, new_value, actor_type, actor_id, actor_name)
       VALUES (0,'thread_status',$1,$2,$3,$4,$5)`,
      [JSON.stringify({ status: old.status }), JSON.stringify({ status: thread.status }), actor.type, actor.id, actor.name]
    );
    await conn.query('COMMIT');
    emitChat(req.user.organization_id, { type: 'thread_unread_changed', thread_id: thread.id });
    res.json({ success: true, message: 'Thread status updated', thread });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Status update failed' });
  } finally {
    conn.release();
  }
});

router.post('/threads/:id/resolve', authMiddleware, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await ensureTables();
    await conn.query('BEGIN');
    const thread = await updateThreadStatus(conn, req.params.id, req.user.organization_id, 'Resolved');
    if (!thread) throw Object.assign(new Error('Thread not found'), { statusCode: 404 });
    await conn.query('COMMIT');
    emitChat(req.user.organization_id, { type: 'thread_unread_changed', thread_id: thread.id });
    res.json({ success: true, message: 'Thread resolved', thread });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Resolve failed' });
  } finally {
    conn.release();
  }
});

router.get('/threads/:id/messages', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const thread = await getThreadForOffice(req.params.id, req.user.organization_id);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found' });
    const r = await db.query(
      `SELECT m.*,
              COALESCE(json_agg(json_build_object('id',a.id,'url',a.url,'filename',a.filename,'mime_type',a.mime_type,'size_bytes',a.size_bytes,'category',a.category)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
       FROM chat_messages m
       LEFT JOIN chat_attachments a ON a.message_id=m.id AND a.organization_id=m.organization_id
       WHERE m.thread_id=$1 AND m.organization_id=$2
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [thread.id, req.user.organization_id]
    );
    res.json({ success: true, thread, messages: r.rows });
  } catch (err) {
    console.error('[chat messages]', err);
    res.status(500).json({ success: false, message: 'Messages load failed' });
  }
});

router.post('/threads/:id/messages', authMiddleware, async (req, res) => {
  await ensureTables();
  const actor = actorFromUser(req.user);
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const thread = (await conn.query(`SELECT * FROM chat_threads WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [req.params.id, req.user.organization_id])).rows[0];
    if (!thread) throw Object.assign(new Error('Thread not found'), { statusCode: 404 });
    const message = await addMessage(conn, thread, actor, req.body);
    await conn.query('COMMIT');
    emitChat(req.user.organization_id, { type: 'message_created', thread_id: thread.id, message_id: message.id });
    res.json({ success: true, message: 'Message sent', chat_message: message });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[chat send]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Message send failed' });
  } finally {
    conn.release();
  }
});

router.put('/messages/:id', authMiddleware, async (req, res) => {
  const actor = actorFromUser(req.user);
  try {
    await ensureTables();
    const old = await db.query(`SELECT * FROM chat_messages WHERE id=$1 AND organization_id=$2`, [req.params.id, req.user.organization_id]);
    const msg = old.rows[0];
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    const created = new Date(msg.created_at).getTime();
    if (Date.now() - created > 24 * 60 * 60 * 1000 && !actor.isAdmin) return res.status(403).json({ success: false, message: 'Edit window expired' });
    if (!actor.isAdmin && (msg.sender_type !== actor.type || msg.sender_id !== actor.id)) return res.status(403).json({ success: false, message: 'Cannot edit this message' });
    const updated = await db.query(
      `UPDATE chat_messages SET body=$1, edited_at=NOW(), edited_by_type=$2, edited_by_id=$3 WHERE id=$4 AND organization_id=$5 RETURNING *`,
      [req.body.body || '', actor.type, actor.id, msg.id, req.user.organization_id]
    );
    await db.query(
      `INSERT INTO chat_message_audit (message_id, action, old_value, new_value, actor_type, actor_id, actor_name)
       VALUES ($1,'edit',$2,$3,$4,$5,$6)`,
      [msg.id, JSON.stringify({ body: msg.body }), JSON.stringify({ body: req.body.body || '' }), actor.type, actor.id, actor.name]
    );
    emitChat(req.user.organization_id, { type: 'message_edited', thread_id: msg.thread_id, message_id: msg.id });
    res.json({ success: true, message: 'Message edited', chat_message: updated.rows[0] });
  } catch (err) {
    console.error('[chat edit]', err);
    res.status(500).json({ success: false, message: 'Message edit failed' });
  }
});

router.delete('/messages/:id', authMiddleware, async (req, res) => {
  const actor = actorFromUser(req.user);
  if (!actor.isAdmin) return res.status(403).json({ success: false, message: 'Only admin can delete messages' });
  try {
    await ensureTables();
    const old = await db.query(`SELECT * FROM chat_messages WHERE id=$1 AND organization_id=$2`, [req.params.id, req.user.organization_id]);
    const msg = old.rows[0];
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    await db.query(`UPDATE chat_messages SET deleted_at=NOW(), deleted_by_type=$1, deleted_by_id=$2 WHERE id=$3 AND organization_id=$4`, [actor.type, actor.id, msg.id, req.user.organization_id]);
    await db.query(
      `INSERT INTO chat_message_audit (message_id, action, old_value, actor_type, actor_id, actor_name)
       VALUES ($1,'delete',$2,$3,$4,$5)`,
      [msg.id, JSON.stringify({ body: msg.body, client_visible: msg.client_visible }), actor.type, actor.id, actor.name]
    );
    emitChat(req.user.organization_id, { type: 'message_deleted', thread_id: msg.thread_id, message_id: msg.id });
    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('[chat delete]', err);
    res.status(500).json({ success: false, message: 'Message delete failed' });
  }
});

router.post('/threads/:id/read', authMiddleware, async (req, res) => {
  const actor = actorFromUser(req.user);
  try {
    await ensureTables();
    await db.query(
      `UPDATE chat_participants SET unread_count=0, last_read_at=NOW()
       WHERE thread_id=$1 AND organization_id=$4 AND participant_type=$2 AND participant_id=$3`,
      [req.params.id, actor.type, actor.id, req.user.organization_id]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

router.get('/mentions/search', authMiddleware, async (req, res) => {
  try {
    const q = escLike(req.query.q || '');
    const r = await db.query(
      `SELECT emp_id, COALESCE(formal_name,name,emp_id) AS name, designation, photo
       FROM emplist
       WHERE status='Active' AND (emp_id ILIKE $1 OR formal_name ILIKE $1 OR name ILIKE $1)
       ORDER BY name LIMIT 20`,
      [q]
    );
    res.json({ success: true, employees: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Mention search failed' });
  }
});

router.get('/context/search', authMiddleware, async (req, res) => {
  try {
    const q = escLike(req.query.q || '');
    const [clients, tasks] = await Promise.all([
      db.query(
        `SELECT client_id, COALESCE(legal_name,business_name,client_id) AS name, agent_id, agent_name
         FROM clients
         WHERE client_id ILIKE $1 OR legal_name ILIKE $1 OR business_name ILIKE $1 OR mobile_number ILIKE $1
         ORDER BY name LIMIT 15`,
        [q]
      ),
      db.query(
        `SELECT task_id, client_id, COALESCE(legal_name,business_name,client_id) AS client_name, work_name, status
         FROM tasks
         WHERE task_id ILIKE $1 OR client_id ILIKE $1 OR legal_name ILIKE $1 OR business_name ILIKE $1 OR work_name ILIKE $1
         ORDER BY created_at DESC LIMIT 15`,
        [q]
      ),
    ]);
    const results = [
      ...clients.rows.map(c => ({
        type: 'client',
        id: c.client_id,
        client_id: c.client_id,
        label: `${c.name || c.client_id} (${c.client_id})`,
      })),
      ...tasks.rows.map(t => ({
        type: 'task',
        id: t.task_id,
        client_id: t.client_id,
        label: `${t.work_name || 'Task'} - ${t.client_name || t.client_id} (${t.task_id})`,
      })),
    ];
    res.json({ success: true, clients: clients.rows, tasks: tasks.rows, results });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Context search failed' });
  }
});

router.post('/attachments', authMiddleware, upload.single('file'), async (req, res) => {
  const actor = actorFromUser(req.user);
  try {
    await ensureTables();
    if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Only image/PDF allowed' });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({ success: false, message: 'Vercel Blob token is not configured' });
    }
    const safeName = String(req.file.originalname || 'attachment').replace(/[^a-z0-9._-]/gi, '_');
    const blob = await put(`chat/${req.user.organization_id}/${Date.now()}-${safeName}`, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
    });
    const category = ATTACHMENT_CATEGORIES.has(req.body.category) ? req.body.category : 'General';
    const inserted = await db.query(
      `INSERT INTO chat_attachments (url, pathname, filename, mime_type, size_bytes, uploaded_by_type, uploaded_by_id, uploaded_by_name, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [blob.url, blob.pathname, req.file.originalname || safeName, req.file.mimetype, req.file.size, actor.type, actor.id, actor.name, category]
    );
    res.json({ success: true, attachment: inserted.rows[0] });
  } catch (err) {
    console.error('[chat attachment]', err);
    res.status(500).json({ success: false, message: err.message || 'Attachment upload failed' });
  }
});

router.get('/events', sseAuth, async (req, res) => {
  const orgId = req.user.organization_id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const handler = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  bus.on(`org:${orgId}`, handler);
  req.on('close', () => bus.off(`org:${orgId}`, handler));
});

portalRouter.get('/threads', portalAuth, async (req, res) => {
  try {
    await ensureTables();
    const params = [req.portalUser.organization_id];
    let where = `t.organization_id=$1 AND t.status <> 'Deleted'`;
    if (req.portalUser.account_type === 'agent') {
      params.push(req.portalUser.agent_id);
      where += ` AND t.agent_id=$${params.length}`;
    } else {
      params.push(req.portalUser.client_id);
      where += ` AND t.client_id=$${params.length}`;
    }
    const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT t.id, t.subject, t.client_id, t.agent_id, t.linked_module, t.linked_task_id, t.last_message_at,
              (SELECT body FROM chat_messages m WHERE m.organization_id=t.organization_id AND m.thread_id=t.id AND m.client_visible=true AND m.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_message_body
       FROM chat_threads t
       WHERE ${where}
         AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.organization_id=t.organization_id AND m.thread_id=t.id AND m.client_visible=true)
       ORDER BY t.last_message_at DESC LIMIT 100`,
      params
    ));
    res.json({ success: true, threads: r.rows });
  } catch (err) {
    console.error('[portal chat threads]', err);
    res.status(500).json({ success: false, message: 'Chat load failed' });
  }
});

portalRouter.get('/threads/:id/messages', portalAuth, async (req, res) => {
  try {
    await ensureTables();
    const thread = await getThreadForPortal(req.params.id, req.portalUser);
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found' });
    await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `UPDATE chat_messages
       SET seen_by_client_at=COALESCE(seen_by_client_at, NOW())
       WHERE organization_id=$1 AND thread_id=$2 AND client_visible=true AND sender_type IN ('employee','admin')`,
      [req.portalUser.organization_id, thread.id]
    ));
    await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `UPDATE chat_threads SET last_client_seen_at=NOW(), updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [req.portalUser.organization_id, thread.id]
    ));
    const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT m.id, m.thread_id, m.sender_type, m.sender_id, m.sender_name, m.message_type,
              CASE WHEN m.deleted_at IS NULL THEN m.body ELSE 'Message removed' END AS body,
              m.call_status, m.follow_up_at, m.created_at, m.deleted_at,
              COALESCE(json_agg(json_build_object('id',a.id,'url',a.url,'filename',a.filename,'mime_type',a.mime_type,'size_bytes',a.size_bytes,'category',a.category)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
       FROM chat_messages m
       LEFT JOIN chat_attachments a ON a.organization_id=m.organization_id AND a.message_id=m.id
       WHERE m.organization_id=$2 AND m.thread_id=$1 AND m.client_visible=true
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [thread.id, req.portalUser.organization_id]
    ));
    res.json({ success: true, thread, messages: r.rows });
  } catch (err) {
    console.error('[portal chat messages]', err);
    res.status(500).json({ success: false, message: 'Messages load failed' });
  }
});

portalRouter.post('/threads/:id/messages', portalAuth, async (req, res) => {
  await ensureTables();
  const actor = actorFromPortal(req.portalUser);
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const thread = await getThreadForPortal(req.params.id, req.portalUser);
    if (!thread) throw Object.assign(new Error('Thread not found'), { statusCode: 404 });
    const message = await addMessage(conn, thread, actor, { body: req.body.body, client_visible: true }, true);
    await conn.query('COMMIT');
    emitChat(req.portalUser.organization_id, { type: 'message_created', thread_id: thread.id, message_id: message.id });
    res.json({ success: true, message: 'Reply sent', chat_message: message });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Reply failed' });
  } finally {
    conn.release();
  }
});

module.exports = { router, portalRouter };
