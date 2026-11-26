-- بوم‌گردی مهران: امکانات تکمیلی مدیریت اقامتگاه
-- این اسکریپت را یک‌بار در Supabase SQL Editor اجرا کنید.

-- 1) توکن اختصاصی برای دریافت نظر مهمان پس از پایان اقامت
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS review_token text;

UPDATE public.reservations
SET review_token = gen_random_uuid()::text
WHERE review_token IS NULL;

ALTER TABLE public.reservations
  ALTER COLUMN review_token SET DEFAULT gen_random_uuid()::text;

ALTER TABLE public.reservations
  ALTER COLUMN review_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_review_token_uidx
  ON public.reservations (review_token);

-- 2) قوانین قیمت‌گذاری اتاق‌ها
CREATE TABLE IF NOT EXISTS public.room_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('normal','weekend','holiday','nowruz','peak')),
  title text NOT NULL,
  price_per_night numeric(14,0) NOT NULL CHECK (price_per_night >= 0),
  start_date date NULL,
  end_date date NULL,
  days_of_week smallint[] NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_pricing_rules_date_range_check
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS room_pricing_rules_room_dates_idx
  ON public.room_pricing_rules (room_id, start_date, end_date);

ALTER TABLE public.room_pricing_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated admins manage room pricing rules" ON public.room_pricing_rules;
CREATE POLICY "Authenticated admins manage room pricing rules"
  ON public.room_pricing_rules
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- 3) بازخورد مهمانان؛ هر رزرو فقط یک نظر ثبت می‌کند
CREATE TABLE IF NOT EXISTS public.guest_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE REFERENCES public.reservations(id) ON DELETE CASCADE,
  cleanliness smallint NOT NULL CHECK (cleanliness BETWEEN 1 AND 5),
  staff smallint NOT NULL CHECK (staff BETWEEN 1 AND 5),
  room_quality smallint NOT NULL CHECK (room_quality BETWEEN 1 AND 5),
  overall smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  comment text NULL CHECK (char_length(comment) <= 1500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guest_reviews_created_at_idx
  ON public.guest_reviews (created_at DESC);

ALTER TABLE public.guest_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated admins read guest reviews" ON public.guest_reviews;
CREATE POLICY "Authenticated admins read guest reviews"
  ON public.guest_reviews
  FOR SELECT TO authenticated
  USING (true);

-- نوشتن نظر مهمان فقط از طریق Worker سمت سرور و service role انجام می‌شود.
