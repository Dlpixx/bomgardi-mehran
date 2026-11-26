-- بوم‌گردی مهران: ورود امن مهمانان به رزرو تأییدشده
-- این دستور را یک‌بار در Supabase SQL Editor اجرا کنید.

-- فقط هش SHA-256 کلید ورود ذخیره می‌شود؛ کلید اصلی فقط یک‌بار به مهمان نمایش داده می‌شود.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS guest_access_token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_guest_access_token_hash_uidx
  ON public.reservations (guest_access_token_hash)
  WHERE guest_access_token_hash IS NOT NULL;

COMMENT ON COLUMN public.reservations.guest_access_token_hash IS
  'SHA-256 hash of a random guest portal access key; raw key is never stored.';
