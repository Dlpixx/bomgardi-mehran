-- بوم‌گردی مهران: حذف کامل کد ورود اختصاصی ۴۸ کاراکتری مهمان
-- پس از انتشار نسخه جدید Worker، این دستور را یک‌بار در Supabase SQL Editor اجرا کنید.
-- این ستون فقط هش کد قدیمی را نگه می‌داشت؛ اطلاعات رزرو و مهمان حذف نمی‌شود.

DROP INDEX IF EXISTS public.reservations_guest_access_token_hash_uidx;

ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS guest_access_token_hash;

NOTIFY pgrst, 'reload schema';
