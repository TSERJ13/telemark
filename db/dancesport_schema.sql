-- =====================================================================
-- Supabase Schema for dancesport.ge (Remote Database)
-- =====================================================================
-- Run this in your Supabase SQL Editor to create the mirror tables 
-- that the Telemark application uses to pull and push data.

-- 1. Tournaments Table
CREATE TABLE tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  event_date DATE,
  location TEXT,
  organizer_names TEXT,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Tournament Categories Table
CREATE TABLE tournament_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL,
  allowed_classes TEXT, -- e.g., "E,D,C"
  min_age INTEGER DEFAULT 0,
  max_age INTEGER DEFAULT 99,
  session_number INTEGER DEFAULT 0,
  session_time TEXT,
  category_order INTEGER DEFAULT 0,
  entry_fee NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Tournament Judges / Officials Table
CREATE TABLE tournament_judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'judge' NOT NULL -- judge|chairman|scrutineer|mc|staff
);

-- 4. Studios Table
CREATE TABLE studios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_name TEXT NOT NULL
);

-- 5. Athletes Table
CREATE TABLE athletes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  first_name_ka TEXT,
  last_name_ka TEXT,
  is_couple BOOLEAN DEFAULT FALSE,
  partner_first_name TEXT,
  partner_last_name TEXT,
  partner_first_name_ka TEXT,
  partner_last_name_ka TEXT
);

-- 6. Tournament Registrations / Entries Table
CREATE TABLE tournament_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES tournament_categories(id) ON DELETE CASCADE,
  athlete1_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  athlete2_id UUID REFERENCES athletes(id) ON DELETE RESTRICT, -- Null for solos
  studio_id UUID REFERENCES studios(id) ON DELETE SET NULL,
  result_place INTEGER, -- This is updated (patched) by Telemark
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Telemark DB State Table (for serverless persistence)
CREATE TABLE IF NOT EXISTS telemark_db_state (
  id INTEGER PRIMARY KEY,
  db_base64 TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

