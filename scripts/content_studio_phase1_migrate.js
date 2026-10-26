require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: new nullable/defaulted columns on studio_topics and one new table (studio_comments).
// Usage: node scripts/content_studio_phase1_migrate.js          (dry run)
//        node scripts/content_studio_phase1_migrate.js --apply
const statements = [
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS content_format VARCHAR(10)`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS parent_id INTEGER`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS publish_date DATE`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS pub_title TEXT`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS pub_description TEXT`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS pub_hashtags TEXT`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS thumbnail_text VARCHAR(200)`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS checks JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS review_status VARCHAR(10) NOT NULL DEFAULT 'None'`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS review_note TEXT`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(100)`,
  `ALTER TABLE studio_topics ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='studio_topic_format_chk') THEN
       ALTER TABLE studio_topics ADD CONSTRAINT studio_topic_format_chk CHECK (content_format IS NULL OR content_format IN ('Shorts','Long','Both'));
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='studio_topic_review_chk') THEN
       ALTER TABLE studio_topics ADD CONSTRAINT studio_topic_review_chk CHECK (review_status IN ('None','Pending','Approved','Changes'));
     END IF;
   END $$`,

  `CREATE TABLE IF NOT EXISTS studio_comments (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    topic_id INTEGER NOT NULL,
    kind VARCHAR(10) NOT NULL DEFAULT 'comment',
    author_name VARCHAR(150),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT studio_comment_kind_chk CHECK (kind IN ('comment','log'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_studio_comment_topic ON studio_comments (organization_id, topic_id, created_at)`,
  `ALTER TABLE studio_comments ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE studio_comments FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS studio_comment_tenant_policy ON studio_comments`,
  `CREATE POLICY studio_comment_tenant_policy ON studio_comments
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN. Statements that would run:\n');
    statements.forEach(s => console.log(s.split('\n')[0].trim()));
    console.log('\nRun again with --apply.');
    return;
  }
  for (const sql of statements) await db.rawPool.query(sql);
  console.log('Content Studio phase 1 migration applied.');
}
run().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => db.rawPool.end());
