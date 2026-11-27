-- بوم‌گردی مهران: ثبت و تأیید واریزی کارت‌به‌کارت
-- این اسکریپت را یک‌بار در Supabase SQL Editor اجرا کنید.

CREATE TABLE IF NOT EXISTS public.reservation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  amount numeric(14,0) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL DEFAULT 'bank_transfer'
    CHECK (payment_method IN ('bank_transfer')),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed')),
  confirmed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure the FK exists even if this table was created by an earlier partial setup.
DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.reservation_payments'::regclass
       AND confrelid = 'public.reservations'::regclass
       AND contype = 'f'
  ) THEN
    ALTER TABLE public.reservation_payments
      ADD CONSTRAINT reservation_payments_reservation_id_fkey
      FOREIGN KEY (reservation_id)
      REFERENCES public.reservations(id)
      ON DELETE CASCADE;
  END IF;
END;
$;

CREATE INDEX IF NOT EXISTS reservation_payments_reservation_confirmed_idx
  ON public.reservation_payments (reservation_id, confirmed_at DESC);

ALTER TABLE public.reservation_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated managers read reservation payments"
  ON public.reservation_payments;
CREATE POLICY "Authenticated managers read reservation payments"
  ON public.reservation_payments
  FOR SELECT TO authenticated
  USING (true);

GRANT SELECT ON public.reservation_payments TO authenticated;
GRANT ALL ON public.reservation_payments TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_bank_transfer_payment(
  p_reservation_id uuid,
  p_amount numeric
)
RETURNS TABLE (
  payment_id uuid,
  paid_amount numeric,
  remaining_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric(14,0);
  v_paid numeric(14,0);
  v_status text;
  v_payment_id uuid;
  v_new_paid numeric(14,0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_AMOUNT';
  END IF;

  SELECT COALESCE(r.total_amount, 0), COALESCE(r.paid_amount, 0), r.status
    INTO v_total, v_paid, v_status
    FROM public.reservations AS r
   WHERE r.id = p_reservation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND';
  END IF;

  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'CANCELLED_RESERVATION';
  END IF;

  IF p_amount > GREATEST(0, v_total - v_paid) THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_BALANCE';
  END IF;

  INSERT INTO public.reservation_payments (
    reservation_id, amount, payment_method, status, confirmed_by
  )
  VALUES (
    p_reservation_id, p_amount, 'bank_transfer', 'confirmed', auth.uid()
  )
  RETURNING id INTO v_payment_id;

  v_new_paid := v_paid + p_amount;

  UPDATE public.reservations
     SET paid_amount = v_new_paid
   WHERE id = p_reservation_id;

  RETURN QUERY
    SELECT v_payment_id, v_new_paid, GREATEST(0, v_total - v_new_paid);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_bank_transfer_payment(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_bank_transfer_payment(uuid, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.confirm_bank_transfer_payment(uuid, numeric) TO authenticated;

-- Refresh PostgREST's relationship cache after installing the FK.
NOTIFY pgrst, 'reload schema';
