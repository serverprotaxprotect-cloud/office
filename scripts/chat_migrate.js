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
