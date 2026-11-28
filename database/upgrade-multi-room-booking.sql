-- Run once in Supabase SQL Editor. Existing reservations remain unchanged.
CREATE TABLE IF NOT EXISTS public.booking_identity (
 reservation_id uuid PRIMARY KEY REFERENCES public.reservations(id) ON DELETE CASCADE,
 customer_type text NOT NULL CHECK(customer_type IN ('person','company')),
 organization text,
 contact_name text NOT NULL,
 national_id text NOT NULL CHECK(national_id ~ '^[0-9]{10}$'),
 birth_date date NOT NULL CHECK(birth_date < DATE '2022-03-21')
);
ALTER TABLE public.booking_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_identity FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.booking_identity TO authenticated;
GRANT ALL ON public.booking_identity TO service_role;
DROP POLICY IF EXISTS booking_identity_read ON public.booking_identity;
CREATE POLICY booking_identity_read ON public.booking_identity FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS booking_identity_insert ON public.booking_identity;
CREATE POLICY booking_identity_insert ON public.booking_identity FOR INSERT TO authenticated WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.create_multi_room_booking(p_name text,p_phone text,p_type text,p_org text,p_national_id text,p_birth date,p_in date,p_out date,p_source text,p_notes text,p_rooms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
 g uuid; rid uuid; item jsonb; rm record; result jsonb := '[]'::jsonb;
 a integer; c integer; b integer; amount numeric; deposit numeric;
BEGIN
 IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 120 OR p_phone IS NULL OR p_phone !~ '^09[0-9]{9}$' OR
 p_type IS NULL OR p_type NOT IN ('person','company') OR (p_type='company' AND coalesce(trim(p_org),'')='') OR
 p_national_id IS NULL OR p_national_id !~ '^[0-9]{10}$' OR p_birth IS NULL OR p_birth >= DATE '2022-03-21' OR
 p_in IS NULL OR p_out IS NULL OR p_out<=p_in OR jsonb_typeof(p_rooms) IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'INVALID_BOOKING';
 END IF;
 IF jsonb_array_length(p_rooms) NOT BETWEEN 1 AND 9 OR
 (SELECT count(DISTINCT x->>'room_id') FROM jsonb_array_elements(p_rooms) x) <> jsonb_array_length(p_rooms) THEN RAISE EXCEPTION 'INVALID_ROOMS'; END IF;
 -- Serialize concurrent bookings through this function in deterministic room order.
 PERFORM pg_advisory_xact_lock(hashtextextended(x->>'room_id',0)) FROM jsonb_array_elements(p_rooms) x ORDER BY x->>'room_id';
 SELECT id INTO g FROM public.guests WHERE phone=p_phone LIMIT 1;
 IF g IS NULL THEN INSERT INTO public.guests(full_name,phone) VALUES(p_name,p_phone) RETURNING id INTO g; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
  SELECT id,name,capacity,max_capacity INTO rm FROM public.rooms WHERE id=(item->>'room_id')::uuid AND is_active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ROOM'; END IF;
  a:=(item->>'adults')::integer; c:=(item->>'children')::integer; b:=(item->>'infants')::integer;
  amount:=(item->>'total_amount')::numeric; deposit:=(item->>'deposit_amount')::numeric;
  IF a IS NULL OR c IS NULL OR b IS NULL OR a<1 OR c<0 OR b<0 OR a+c+b>20 OR a+c>coalesce(rm.max_capacity,rm.capacity,0) OR amount IS NULL OR deposit IS NULL OR amount<0 OR deposit<0 OR deposit>amount OR trunc(amount)<>amount OR trunc(deposit)<>deposit THEN RAISE EXCEPTION 'INVALID_CAPACITY_OR_AMOUNT'; END IF;
  IF EXISTS(SELECT 1 FROM public.reservations WHERE room_id=rm.id AND status<>'cancelled' AND check_in<p_out AND check_out>p_in) THEN RAISE EXCEPTION 'ROOM_BUSY' USING ERRCODE='23P01'; END IF;
  INSERT INTO public.reservations(guest_id,room_id,check_in,check_out,adults,children,infants,total_amount,deposit_amount,paid_amount,status,booking_source,notes)
  VALUES(g,rm.id,p_in,p_out,a,c,b,amount,deposit,deposit,'pending',p_source,p_notes) RETURNING id INTO rid;
  INSERT INTO public.booking_identity VALUES(rid,p_type,CASE WHEN p_type='company' THEN p_org ELSE NULL END,p_name,p_national_id,p_birth);
  result:=result||jsonb_build_array(jsonb_build_object('id',rid,'room_name',rm.name,'tracking_code',upper(right(rid::text,8))));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_multi_room_booking(text,text,text,text,text,date,date,date,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_multi_room_booking(text,text,text,text,text,date,date,date,text,text,jsonb) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
