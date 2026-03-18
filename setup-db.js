// ============================================
// WhatsApp CRM Pro - One-time Database Setup
// Run: node setup-db.js
// ============================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function setupDatabase() {
  console.log('🔧 Setting up Supabase database tables...\n');

  // 1. conversations
  console.log('Creating conversations table...');
  const { error: e1 } = await supabase.rpc('exec_sql', {
    sql: `CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      message TEXT NOT NULL,
      direction VARCHAR(10) NOT NULL CHECK (direction IN ('incoming','outgoing')),
      status VARCHAR(20) DEFAULT 'delivered',
      media_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);`
  });
  if (e1) console.log('  (will use fallback method)');

  // Try direct insert-based check (works without RPC)
  await createTableViaInsertCheck();
}

async function createTableViaInsertCheck() {
  // Test if tables exist already
  const { error: testLeads } = await supabase.from('leads').select('id').limit(1);
  const { error: testConv } = await supabase.from('conversations').select('id').limit(1);
  const { error: testQR } = await supabase.from('quick_replies').select('id').limit(1);

  const leadsMissing = testLeads && testLeads.code === '42P01';
  const convMissing = testConv && testConv.code === '42P01';
  const qrMissing = testQR && testQR.code === '42P01';

  if (!leadsMissing && !convMissing && !qrMissing) {
    console.log('\n✅ All tables already exist! Database is ready.');
    console.log('\n🚀 You can now run: node server.js');
    process.exit(0);
  }

  console.log('\n⚠️  Tables are missing. Please follow these steps:\n');
  console.log('1. Go to: https://supabase.com/dashboard/project/' + extractProjectId() + '/sql/new');
  console.log('2. Paste the contents of supabase.sql into the editor');
  console.log('3. Click RUN');
  console.log('4. Come back and run: node server.js\n');
  console.log('Or open supabase.sql in VS Code and copy its contents.\n');

  // Auto-open browser to the SQL editor
  const { exec } = require('child_process');
  const url = `https://supabase.com/dashboard/project/${extractProjectId()}/sql/new`;
  exec(`start ${url}`);
  console.log(`🌐 Opening Supabase SQL editor: ${url}`);

  process.exit(1);
}

function extractProjectId() {
  const url = process.env.SUPABASE_URL || '';
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match ? match[1] : 'your-project-id';
}

setupDatabase().catch(err => {
  console.error('Setup error:', err.message);
  process.exit(1);
});
