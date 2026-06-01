const db = require('../db');

const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS chat_threads (
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
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
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
    edited_at TIMESTAMPTZ,
    edited_by_type VARCHAR(20),
    edited_by_id VARCHAR(80),
    deleted_at TIMESTAMPTZ,
    deleted_by_type VARCHAR(20),
    deleted_by_id VARCHAR(80),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS chat_participants (
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
  )`,
  `CREATE TABLE IF NOT EXISTS chat_mentions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    mentioned_type VARCHAR(20) NOT NULL,
    mentioned_id VARCHAR(80) NOT NULL,
    mentioned_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS chat_attachments (
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
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS chat_message_audit (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_org_last ON chat_threads(organization_id, last_message_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_client ON chat_threads(organization_id, client_id, last_message_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(organization_id, thread_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(organization_id, participant_type, participant_id, unread_count)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(organization_id, mentioned_type, mentioned_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(organization_id, message_id)`,
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
  `INSERT INTO chat_quick_templates (title, body, category)
   SELECT v.title, v.body, v.category
   FROM (VALUES
     ('Bank Statement Request','Please send bank statement for the required period so we can complete the work.','Documents'),
     ('DSC OTP Request','Please share the DSC OTP when received.','MCA'),
     ('ITR Documents Pending','ITR filing documents are pending. Please share Form 16, bank statement, investment proofs and AIS/TIS details.','Income Tax'),
     ('GST Data Pending','GST data/invoices are pending. Please share purchase, sales and expense details.','GST'),
     ('KYC Documents Pending','PAN, Aadhaar and required KYC documents are pending. Please share clear copies.','KYC')
   ) AS v(title, body, category)
   WHERE NOT EXISTS (SELECT 1 FROM chat_quick_templates q WHERE q.organization_id=current_organization_id() AND q.title=v.title)`,
];

async function main() {
  console.log(apply ? 'Applying chat migration...' : 'Dry run chat migration. Use --apply to execute.');
  if (!apply) {
    statements.forEach((sql, i) => console.log(`${i + 1}. ${sql.split('\n')[0]}`));
    return;
  }
  await db.runWithTenant({ bypassTenant: true }, async () => {
    for (const sql of statements) await db.query(sql);
  });
  console.log('Chat migration applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => db.rawPool.end());
