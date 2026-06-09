-- =====================================================================
-- Demo/Test Data for dancesport.ge Supabase Database
-- =====================================================================
-- Run this in your Supabase SQL Editor AFTER running the schema script.
-- This creates a test tournament (ID: 77777777-7777-7777-7777-777777777777),
-- category, judges, and registrations for testing the sync.

-- 1. Insert a test tournament
INSERT INTO tournaments (id, name, event_date, location, organizer_names)
VALUES (
  '77777777-7777-7777-7777-777777777777', 
  'Test Championship 2026', 
  '2026-06-02', 
  'Tbilisi, Georgia', 
  'Dancesport Georgia'
) ON CONFLICT (id) DO NOTHING;

-- 2. Insert a test category
INSERT INTO tournament_categories (id, tournament_id, category_name, allowed_classes, min_age, max_age, category_order, entry_fee)
VALUES (
  '11111111-1111-1111-1111-111111111111', 
  '77777777-7777-7777-7777-777777777777', 
  'Adult Standard', 
  'A,B,C', 
  18, 
  99, 
  1, 
  50.00
) ON CONFLICT (id) DO NOTHING;

-- 3. Insert test judges (3 judges)
INSERT INTO tournament_judges (id, tournament_id, full_name, role) VALUES
('22222222-2222-2222-2222-222222222221', '77777777-7777-7777-7777-777777777777', 'Lasha Tabidze', 'judge'),
('22222222-2222-2222-2222-222222222222', '77777777-7777-7777-7777-777777777777', 'Nino Gelashvili', 'judge'),
('22222222-2222-2222-2222-222222222223', '77777777-7777-7777-7777-777777777777', 'David Kapanadze', 'judge')
ON CONFLICT (id) DO NOTHING;

-- 4. Insert test studios
INSERT INTO studios (id, studio_name) VALUES
('33333333-3333-3333-3333-333333333331', 'Studio Rhythm'),
('33333333-3333-3333-3333-333333333332', 'Studio Imedi')
ON CONFLICT (id) DO NOTHING;

-- 5. Insert test athletes (4 athletes forming 2 couples)
INSERT INTO athletes (id, first_name, last_name, first_name_ka, last_name_ka) VALUES
('44444444-4444-4444-4444-444444444441', 'George', 'Beridze', 'გიორგი', 'ბერიძე'),
('44444444-4444-4444-4444-444444444442', 'Elena', 'Maisuradze', 'ელენე', 'მაისურაძე'),
('44444444-4444-4444-4444-444444444443', 'Luka', 'Kapanadze', 'ლუკა', 'კაპანაძე'),
('44444444-4444-4444-4444-444444444444', 'Nino', 'Lomidze', 'ნინო', 'ლომიძე')
ON CONFLICT (id) DO NOTHING;

-- 6. Insert tournament registrations (couples linked to tournament and category)
INSERT INTO tournament_registrations (id, tournament_id, category_id, athlete1_id, athlete2_id, studio_id) VALUES
(
  '55555555-5555-5555-5555-555555555551', 
  '77777777-7777-7777-7777-777777777777', 
  '11111111-1111-1111-1111-111111111111', 
  '44444444-4444-4444-4444-444444444441', 
  '44444444-4444-4444-4444-444444444442', 
  '33333333-3333-3333-3333-333333333331'
),
(
  '55555555-5555-5555-5555-555555555552', 
  '77777777-7777-7777-7777-777777777777', 
  '11111111-1111-1111-1111-111111111111', 
  '44444444-4444-4444-4444-444444444443', 
  '44444444-4444-4444-4444-444444444444', 
  '33333333-3333-3333-3333-333333333332'
) ON CONFLICT (id) DO NOTHING;
