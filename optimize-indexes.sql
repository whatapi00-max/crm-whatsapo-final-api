-- ============================================================
-- SAFE LIVE INDEXES — CONCURRENTLY mode
-- ============================================================
-- SAFE TO RUN WHILE MARKETERS ARE WORKING.
-- CONCURRENTLY = zero table locking, no blocked writes, no downtime.
-- Each statement must be run ONE AT A TIME (not all together).
-- Copy each block below individually into Supabase SQL Editor and click Run.
-- ============================================================

-- ── STEP 1 of 12 ────────────────────────────────────────────
-- conversations: active-chats lookup (tenant + phone + time sort)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_tenant_phone_created
  ON conversations(tenant_id, phone, created_at DESC);

-- ── STEP 2 of 12 ────────────────────────────────────────────
-- conversations: stats/trends (tenant + direction + time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_tenant_direction_created
  ON conversations(tenant_id, direction, created_at DESC);

-- ── STEP 3 of 12 ────────────────────────────────────────────
-- conversations: /api/messages/:phone chat view
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_tenant_created
  ON conversations(tenant_id, created_at DESC);

-- ── STEP 4 of 12 ────────────────────────────────────────────
-- conversations: unread count (partial index — incoming+received only)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_unread
  ON conversations(tenant_id, phone)
  WHERE direction = 'incoming' AND status = 'received';

-- ── STEP 5 of 12 ────────────────────────────────────────────
-- conversations: webhook status update (find last sent msg per phone)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_tenant_phone_status
  ON conversations(tenant_id, phone, created_at DESC)
  WHERE direction = 'outgoing';

-- ── STEP 6 of 12 ────────────────────────────────────────────
-- leads: active-chats sort by last_message_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_tenant_last_message
  ON leads(tenant_id, last_message_at DESC);

-- ── STEP 7 of 12 ────────────────────────────────────────────
-- leads: stats per-status counts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_tenant_status
  ON leads(tenant_id, status);

-- ── STEP 8 of 12 ────────────────────────────────────────────
-- leads: webhook upsert lookup + broadcast targeting
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_tenant_phone
  ON leads(tenant_id, phone);

-- ── STEP 9 of 12 ────────────────────────────────────────────
-- scheduled_messages: scheduler poll every 2 min
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_messages_pending
  ON scheduled_messages(status, scheduled_at)
  WHERE status = 'pending';

-- ── STEP 10 of 12 ───────────────────────────────────────────
-- broadcast_recipients: fetch pending recipients per broadcast
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_recipients_pending
  ON broadcast_recipients(broadcast_id, status)
  WHERE status = 'pending';

-- ── STEP 11 of 12 ───────────────────────────────────────────
-- auto_replies: webhook checks on every inbound message
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auto_replies_tenant_active
  ON auto_replies(tenant_id, priority DESC)
  WHERE is_active = true;

-- ── STEP 12 of 12 ───────────────────────────────────────────
-- activity_log: storage stats count
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_tenant_created
  ON activity_log(tenant_id, created_at DESC);

-- ── FINAL: Update query planner stats (safe, run all at once) ─
ANALYZE conversations;
ANALYZE leads;
ANALYZE scheduled_messages;
ANALYZE broadcast_recipients;
ANALYZE auto_replies;
ANALYZE activity_log;
