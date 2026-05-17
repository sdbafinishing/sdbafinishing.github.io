-- ============================================================
-- SDBA RDMS — Supabase Schema Setup
-- Run this in Supabase SQL Editor (Dashboard → SQL → New Query)
-- Safe to re-run: drops existing policies/functions first.
-- ============================================================

-- Cleanup existing policies (safe if they don't exist)
DO $$ BEGIN
  DROP POLICY IF EXISTS "race_snapshots_public_read" ON race_snapshots;
  DROP POLICY IF EXISTS "race_snapshots_auth_write" ON race_snapshots;
  DROP POLICY IF EXISTS "race_snapshots_auth_update" ON race_snapshots;
  DROP POLICY IF EXISTS "race_snapshots_auth_delete" ON race_snapshots;
  DROP POLICY IF EXISTS "event_config_public_read" ON event_config;
  DROP POLICY IF EXISTS "event_config_auth_write" ON event_config;
  DROP POLICY IF EXISTS "event_config_auth_update" ON event_config;
  DROP POLICY IF EXISTS "rdms_users_read_own" ON rdms_users;
  DROP POLICY IF EXISTS "rdms_users_admin_read" ON rdms_users;
  DROP POLICY IF EXISTS "rdms_users_admin_insert" ON rdms_users;
  DROP POLICY IF EXISTS "rdms_users_admin_update" ON rdms_users;
  DROP POLICY IF EXISTS "rdms_users_admin_delete" ON rdms_users;
  DROP POLICY IF EXISTS "Admin manage users" ON rdms_users;
  DROP POLICY IF EXISTS "Users read own" ON rdms_users;
  DROP POLICY IF EXISTS "Public read" ON race_snapshots;
  DROP POLICY IF EXISTS "Auth write" ON race_snapshots;
  DROP POLICY IF EXISTS "Public read" ON event_config;
  DROP POLICY IF EXISTS "Auth write" ON event_config;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DROP FUNCTION IF EXISTS is_rdms_admin();

-- 1. User management (RBAC)
CREATE TABLE IF NOT EXISTS rdms_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Race snapshots (synced from operator's IndexedDB)
CREATE TABLE IF NOT EXISTS race_snapshots (
  race_number INT NOT NULL,
  event_ref TEXT NOT NULL,
  snapshot JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (race_number, event_ref)
);

CREATE INDEX IF NOT EXISTS idx_race_snapshots_event ON race_snapshots (event_ref);

-- 3. Event config (synced from operator)
CREATE TABLE IF NOT EXISTS event_config (
  event_ref TEXT PRIMARY KEY,
  config JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Helper function to check admin role (avoids RLS recursion)
-- ============================================================

CREATE OR REPLACE FUNCTION is_rdms_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM rdms_users WHERE email = auth.email() AND role = 'admin'
  );
$$;

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================

ALTER TABLE rdms_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_config ENABLE ROW LEVEL SECURITY;

-- Race snapshots: public read, authenticated write
CREATE POLICY "race_snapshots_public_read"
  ON race_snapshots FOR SELECT
  USING (true);

CREATE POLICY "race_snapshots_auth_write"
  ON race_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "race_snapshots_auth_update"
  ON race_snapshots FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "race_snapshots_auth_delete"
  ON race_snapshots FOR DELETE
  TO authenticated
  USING (true);

-- Event config: public read, authenticated write
CREATE POLICY "event_config_public_read"
  ON event_config FOR SELECT
  USING (true);

CREATE POLICY "event_config_auth_write"
  ON event_config FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "event_config_auth_update"
  ON event_config FOR UPDATE
  TO authenticated
  USING (true);

-- Users: everyone can read own row, admins can read all
CREATE POLICY "rdms_users_read_own"
  ON rdms_users FOR SELECT
  USING (email = auth.email());

CREATE POLICY "rdms_users_admin_read"
  ON rdms_users FOR SELECT
  USING (is_rdms_admin());

-- Users: admins can insert/update/delete (uses function, no recursion)
CREATE POLICY "rdms_users_admin_insert"
  ON rdms_users FOR INSERT
  TO authenticated
  WITH CHECK (is_rdms_admin());

CREATE POLICY "rdms_users_admin_update"
  ON rdms_users FOR UPDATE
  TO authenticated
  USING (is_rdms_admin());

CREATE POLICY "rdms_users_admin_delete"
  ON rdms_users FOR DELETE
  TO authenticated
  USING (is_rdms_admin());

-- ============================================================
-- Enable Realtime for live dashboard subscriptions
-- ============================================================

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE race_snapshots;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE event_config;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Seed: Create initial admin user
-- Replace with your email. Run AFTER creating the user in
-- Supabase Auth (Dashboard → Authentication → Add User).
-- ============================================================

-- INSERT INTO rdms_users (email, role, display_name)
-- VALUES ('admin@example.com', 'admin', 'Admin');
