-- =============================================
-- Migration: WhatsApp Cloud API Support
-- Run this in your Supabase SQL Editor
-- =============================================

-- Add Cloud API columns to tenants table
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_access_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_waba_id TEXT;

-- Add media_url column for voice message playback
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS media_url TEXT;

-- Add index for webhook routing (find tenant by phone_number_id)
CREATE INDEX IF NOT EXISTS idx_tenants_wa_phone_number_id ON tenants(wa_phone_number_id);

-- Add ban persistence columns (auto-migrated by server on startup)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_reason TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_banned_at TIMESTAMPTZ;

-- Create exec_sql helper function (needed for server auto-migrations)
CREATE OR REPLACE FUNCTION exec_sql(sql TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql;
END;
$$;

-- Enable Supabase Realtime on conversations table
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
