-- =============================================
-- Migration: WhatsApp Cloud API Support
-- Run this in your Supabase SQL Editor
-- =============================================

-- Add Cloud API columns to tenants table
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_access_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_waba_id TEXT;

-- Add index for webhook routing (find tenant by phone_number_id)
CREATE INDEX IF NOT EXISTS idx_tenants_wa_phone_number_id ON tenants(wa_phone_number_id);
