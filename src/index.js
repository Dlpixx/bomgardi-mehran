const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function validISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value;
}
function tehranToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function config(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return {
    url: env.SUPABASE_URL.replace(/\/$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY
  };
}
async function supabase(env, path, options={}) {
  const cfg = config(env);
  if (!cfg) throw new Error("SERVER_NOT_CONFIGURED");
  const response = await fetch(cfg.url + "/rest/v1/" + path, {
    ...options,
    headers: {
      "apikey": cfg.key,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.details || "DATABASE_ERROR");
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}
function normalizePhone(value) {
  let phone = String(value || "").replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[\s-]/g, "");
  if (phone.startsWith("+98")) phone = "0" + phone.slice(3);
  if (phone.startsWith("0098")) phone = "0" + phone.slice(4);
  return phone;
}

async function sendMelipayamakSms(env, to, text) {
  const phone = normalizePhone(to);
  if (!(phone.length === 11 && phone.startsWith("09") && /^[0-9]+$/.test(phone))) {
    return { ok:false, reason:"INVALID_RECIPIENT" };
  }
  if (!env.MELIPAYAMAK_API_URL || !env.MELIPAYAMAK_FROM) {
    return { ok:false, reason:"SMS_NOT_CONFIGURED" };
  }

  try {
    const response = await fetch(env.MELIPAYAMAK_API_URL, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        from:env.MELIPAYAMAK_FROM,
        to:phone,
        text
      })
    });
    const raw = await response.text();
    let result = null;
    try { result = raw ? JSON.parse(raw) : null; } catch {}
    const ok = response.ok && result && result.recId;
    if (!ok) {
      console.error("MELIPAYAMAK_SEND_FAILED", {
        httpStatus:response.status,
        providerStatus:result?.status || null
      });
      return { ok:false, reason:"PROVIDER_REJECTED" };
    }
    return { ok:true, recId:result.recId };
  } catch (error) {
    console.error("MELIPAYAMAK_REQUEST_FAILED", {
      message:String(error?.message || "unknown").slice(0,200)
    });
    return { ok:false, reason:"NETWORK_ERROR" };
  }
}
function getPriceForNight(rules, roomId, iso) {
  const day = new Date(iso + "T12:00:00Z").getUTCDay();
  const priority = {nowruz:50, holiday:40, peak:30, weekend:20, normal:10};
  const matched = (rules || []).filter(rule => {
    if (rule.room_id && String(rule.room_id) !== String(roomId)) return false;
    if (rule.start_date && iso < rule.start_date) return false;
    if (rule.end_date && iso > rule.end_date) return false;
    if (rule.rule_type === "weekend" && day !== 4 && day !== 5) return false;
    if (["holiday","nowruz","peak"].includes(rule.rule_type) && (!rule.start_date || !rule.end_date)) return false;
    return true;
  }).sort((a,b) =>
    (priority[b.rule_type] || 0) - (priority[a.rule_type] || 0) ||
    Number(!!b.room_id) - Number(!!a.room_id) ||
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  return matched.length ? Number(matched[0].price_per_night) : null;
}
function calculateStayPrice(rules, roomId, checkIn, checkOut) {
  if (!validISODate(checkIn) || !validISODate(checkOut) || checkOut <= checkIn) return null;
  let total = 0, nights = 0;
  const date = new Date(checkIn + "T12:00:00Z");
  const end = new Date(checkOut + "T12:00:00Z");
  while (date < end && nights < 90) {
    const price = getPriceForNight(rules, roomId, date.toISOString().slice(0,10));
    if (price === null || !Number.isFinite(price)) return null;
    total += price;
    nights++;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return nights > 0 && nights < 90 ? {total, nights} : null;
}
async function getPricingRules(env) {
  try {
    return await supabase(env,
      "room_pricing_rules?select=room_id,rule_type,price_per_night,start_date,end_date,days_of_week,created_at"
    ) || [];
  } catch (error) {
    console.warn("PRICING_RULES_UNAVAILABLE", {code:error.code || null, status:error.status || null});
    return [];
  }
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {status:204, headers:{
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Max-Age":"86400"
    }});
  }
  if (url.pathname === "/api/health" && request.method === "GET") {
    const configured = !!config(env);
    let databaseReachable = false;
    let databaseErrorCode = null;
    if (configured) {
      try {
        await supabase(env, "rooms?select=id&limit=1");
        databaseReachable = true;
      } catch (error) {
        databaseErrorCode = error.code || (error.status ? String(error.status) : "DB_ERROR");
        console.error("SUPABASE_HEALTH_CHECK_FAILED", {
          code: error.code || null, status: error.status || null,
          message: String(error.message || "unknown").slice(0, 300)
        });
      }
    }
    return json({
      ok:true, service:"bomgardi-mehran", mode:"experimental",
      databaseConfigured:configured, databaseReachable,
      databaseErrorCode, bookingEnabled:configured && databaseReachable,
      smsEnabled:!!(env.MELIPAYAMAK_API_URL && env.MELIPAYAMAK_FROM),
      smsApiUrlConfigured:!!(env.MELIPAYAMAK_API_URL),
      smsFromConfigured:!!(env.MELIPAYAMAK_FROM),
      adminSmsEnabled:!!(env.MELIPAYAMAK_ADMIN_PHONE), otpEnabled:false
    });
  }
  if (!config(env)) return json({
    ok:false, error:"سامانه هنوز به اطلاعات محرمانه دیتابیس متصل نشده است."
  }, 503);

  if (url.pathname === "/api/rooms" && request.method === "GET") {
    const checkIn = url.searchParams.get("check_in");
    const checkOut = url.searchParams.get("check_out");
    if ((checkIn || checkOut) && (!validISODate(checkIn) || !validISODate(checkOut) || checkOut <= checkIn)) {
      return json({ok:false,error:"تاریخ ورود و خروج معتبر نیست."},400);
    }
    try {
      const rooms = await supabase(env,
        "rooms?select=id,name,capacity,max_capacity,description,image_path,is_active,display_order&is_active=eq.true&order=display_order.asc"
      );
      let busyIds = [];
      let pricingRules = [];
      if (checkIn && checkOut) {
        const overlaps = await supabase(env,
          "reservations?select=room_id&check_in=lt." + encodeURIComponent(checkOut) +
          "&check_out=gt." + encodeURIComponent(checkIn) +
          "&status=neq.cancelled"
        );
        busyIds = [...new Set((overlaps || []).map(r => r.room_id))];
        pricingRules = await getPricingRules(env);
      }
      return json({ok:true,rooms:(rooms || []).map(room => {
        const quote = checkIn && checkOut ? calculateStayPrice(pricingRules, room.id, checkIn, checkOut) : null;
        return {
          id:room.id, name:room.name, capacity:room.capacity,
          max_capacity:room.max_capacity, description:room.description,
          image_path:room.image_path,
          available:checkIn && checkOut ? !busyIds.includes(room.id) : null,
          price_per_stay:quote ? quote.total : null,
          price_nights:quote ? quote.nights : null
        };
      })});
    } catch (error) {
      console.error("ROOMS_QUERY_FAILED", {
        code: error.code || null, status: error.status || null,
        message: String(error.message || "unknown").slice(0, 300)
      });
      return json({ok:false,error:"دریافت اتاق‌ها با خطا مواجه شد.", diagnostic_code:error.code || (error.status ? String(error.status) : "DB_ERROR")},500);
    }
  }

  if (url.pathname === "/api/guest/login" && request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return json({ok:false,error:"اطلاعات ورود معتبر نیست."},400); }

    const phone = normalizePhone(body.phone);
    const trackingCode = String(body.tracking_code || "").trim().toUpperCase();

    if (!/^09\d{9}$/.test(phone) || !/^[0-9A-F]{8}$/.test(trackingCode)) {
      return json({ok:false,error:"شماره موبایل یا کد پیگیری معتبر نیست."},400);
    }

    try {
      // Find the guest by the phone number supplied during booking, then match
      // the final eight hexadecimal characters of the reservation UUID.
      const guests = await supabase(env,
        "guests?select=id,full_name,phone&phone=eq." + encodeURIComponent(phone) + "&limit=1"
      );
      const guest = guests?.[0];
      if (!guest?.id) {
        return json({ok:false,error:"اطلاعات ورود صحیح نیست یا رزرو پیدا نشد."},401);
      }

      const reservations = await supabase(env,
        "reservations?select=id,booking_group_id,check_in,check_out,status,adults,children,infants,total_amount,deposit_amount,paid_amount,rooms(name)&guest_id=eq." +
        encodeURIComponent(guest.id) + "&order=created_at.desc&limit=1000"
      );
      const reservation = (reservations || []).find(item =>
        String(item.booking_group_id || item.id || "").slice(-8).toUpperCase() === trackingCode
      );

      if (!reservation) {
        return json({ok:false,error:"اطلاعات ورود صحیح نیست یا رزرو پیدا نشد."},401);
      }

      const members=reservation.booking_group_id?reservations.filter(x=>x.booking_group_id===reservation.booking_group_id):[reservation];
      if (!members.every(x=>["confirmed","checked_in","checked_out"].includes(x.status))) {
        return json({ok:false,error:"ورود مهمان پس از تأیید رزرو توسط مدیریت فعال می‌شود."},403);
      }

      const sum=k=>members.reduce((n,x)=>n+Number(x[k]||0),0);
      const total=sum("total_amount"),paid=sum("paid_amount");
      return json({
        ok:true,
        guest:{full_name:guest.full_name || "مهمان گرامی",phone},
        reservation:{
          tracking_code:trackingCode,
          room_name:members.map(x=>x.rooms?.name||"اتاق").join("، "),
          check_in:reservation.check_in,
          check_out:reservation.check_out,
          status:reservation.status,
          adults:sum("adults"),
          children:sum("children"),
          infants:sum("infants"),
          total_amount:total,
          deposit_amount:sum("deposit_amount"),
          paid_amount:paid,
          remaining_amount:Math.max(0,total-paid)
        }
      });
    } catch (error) {
      console.error("GUEST_LOGIN_FAILED",{code:error.code||null,status:error.status||null});
      return json({ok:false,error:"ورود مهمان در حال حاضر امکان‌پذیر نیست. لطفاً بعداً تلاش کنید."},500);
    }
  }

  if (url.pathname === "/api/feedback" && request.method === "GET") {
    const token = String(url.searchParams.get("token") || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ok:false,error:"لینک نظرسنجی معتبر نیست."},400);
    try {
      const matches = await supabase(env,
        "reservations?select=id,check_out,status,rooms(name),guests(full_name)&review_token=eq." +
        encodeURIComponent(token) + "&limit=1"
      );
      const reservation = matches?.[0];
      if (!reservation) return json({ok:false,error:"این لینک پیدا نشد یا معتبر نیست."},404);
      const eligible = reservation.status !== "cancelled" && (reservation.status === "checked_out" || reservation.check_out < tehranToday());
      if (!eligible) return json({ok:false,error:"فرم رضایت پس از پایان اقامت فعال می‌شود."},403);
      const existing = await supabase(env,
        "guest_reviews?select=id,cleanliness,staff,room_quality,overall,comment,created_at&reservation_id=eq." +
        encodeURIComponent(reservation.id) + "&limit=1"
      );
      return json({
        ok:true,
        guest_name:reservation.guests?.full_name || "مهمان گرامی",
        room_name:reservation.rooms?.name || "اقامتگاه",
        check_out:reservation.check_out,
        submitted:!!existing?.length,
        review:existing?.[0] || null
      });
    } catch (error) {
      console.error("FEEDBACK_LOOKUP_FAILED", {code:error.code||null,status:error.status||null});
      return json({ok:false,error:"دریافت اطلاعات فرم رضایت با خطا مواجه شد."},500);
    }
  }

  if (url.pathname === "/api/feedback" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ok:false,error:"اطلاعات ارسالی معتبر نیست."},400); }
    const token = String(body.token || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ok:false,error:"لینک نظرسنجی معتبر نیست."},400);
    const fields = ["cleanliness","staff","room_quality","overall"];
    const ratings = {};
    for (const field of fields) {
      const value = Number(body[field]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return json({ok:false,error:"لطفاً برای همه موارد امتیاز ۱ تا ۵ انتخاب کنید."},400);
      }
      ratings[field] = value;
    }
    const comment = String(body.comment || "").trim().slice(0,1500);
    try {
      const matches = await supabase(env,
        "reservations?select=id,check_out,status&review_token=eq." +
        encodeURIComponent(token) + "&limit=1"
      );
      const reservation = matches?.[0];
      if (!reservation) return json({ok:false,error:"این لینک پیدا نشد یا معتبر نیست."},404);
      const eligible = reservation.status !== "cancelled" && (reservation.status === "checked_out" || reservation.check_out < tehranToday());
      if (!eligible) return json({ok:false,error:"فرم رضایت پس از پایان اقامت فعال می‌شود."},403);
      const existing = await supabase(env,
        "guest_reviews?select=id&reservation_id=eq." + encodeURIComponent(reservation.id) + "&limit=1"
      );
      if (existing?.length) return json({ok:false,error:"نظر این اقامت قبلاً ثبت شده است."},409);
      await supabase(env,"guest_reviews",{
        method:"POST",
        headers:{"Prefer":"return=minimal"},
        body:JSON.stringify({...ratings,comment:comment||null,reservation_id:reservation.id})
      });
      return json({ok:true,message:"از اینکه تجربه اقامتتان را با ما به اشتراک گذاشتید سپاسگزاریم."},201);
    } catch (error) {
      if (error.code === "23505") return json({ok:false,error:"نظر این اقامت قبلاً ثبت شده است."},409);
      console.error("FEEDBACK_SUBMIT_FAILED", {code:error.code||null,status:error.status||null});
      return json({ok:false,error:"ثبت نظر با خطا مواجه شد. لطفاً دوباره تلاش کنید."},500);
    }
  }

  if (url.pathname === "/api/bookings" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ok:false,error:"اطلاعات ارسالی معتبر نیست."},400); }
    const fullName=String(body.full_name||"").trim(), phone=normalizePhone(body.phone);
    const type=String(body.customer_type||""), org=String(body.organization||"").trim();
    const nationalId=String(body.national_id||"").trim(), birth=body.birth_date;
    const checkIn=body.check_in, checkOut=body.check_out;
    const selections=body.rooms;
    if(!fullName||fullName.length>120||!/^09\d{9}$/.test(phone)||!["person","company"].includes(type)||(type==="company"&&(!org||org.length>160))||!/^\d{10}$/.test(nationalId)||!validISODate(birth)||birth>="2022-03-21") return json({ok:false,error:"مشخصات هویتی سرپرست رزرو معتبر نیست."},400);
    if(!validISODate(checkIn)||!validISODate(checkOut)||checkOut<=checkIn||checkIn<tehranToday()) return json({ok:false,error:"تاریخ اقامت معتبر نیست."},400);
    if(!Array.isArray(selections)||!selections.length||selections.length>9||new Set(selections.map(x=>x?.room_id)).size!==selections.length) return json({ok:false,error:"اتاق‌ها را انتخاب کنید."},400);
    for(const x of selections) if(!x||!/^[0-9a-f-]{36}$/i.test(String(x.room_id))||![x.adults,x.children,x.infants].every(Number.isInteger)||x.adults<1||x.children<0||x.infants<0||x.adults+x.children+x.infants>20) return json({ok:false,error:"تعداد مسافران هر اتاق معتبر نیست."},400);
    try {
      const rules=await getPricingRules(env);
      const rows=selections.map(x=>({room_id:x.room_id,adults:x.adults,children:x.children,infants:x.infants,total_amount:calculateStayPrice(rules,x.room_id,checkIn,checkOut)?.total??0,deposit_amount:0}));
      const saved=await supabase(env,"rpc/create_multi_room_booking",{method:"POST",body:JSON.stringify({p_name:fullName,p_phone:phone,p_type:type,p_org:org,p_national_id:nationalId,p_birth:birth,p_in:checkIn,p_out:checkOut,p_source:"سایت بوم‌گردی مهران",p_notes:String(body.notes||"").trim().slice(0,1000),p_rooms:rows})});
      return json({ok:true,bookings:saved,tracking_code:saved?.[0]?.tracking_code,status:"pending"},201);
    } catch(error) {
      if(error.code==="23P01") return json({ok:false,error:"یکی از اتاق‌ها قبلاً رزرو شده است؛ هیچ رزروی ثبت نشد."},409);
      if(error.code==="PGRST202") return json({ok:false,error:"به‌روزرسانی دیتابیس هنوز نصب نشده است."},503);
      if(error.code==="P0001") return json({ok:false,error:"مشخصات، ظرفیت یا مبلغ رزرو معتبر نیست."},400);
      return json({ok:false,error:"ثبت درخواست انجام نشد."},500);
    }
  }
  return json({ok:false,error:"مسیر API پیدا نشد."},404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request,env,url);
    if (url.pathname === "/admin") return Response.redirect(new URL("/admin/",url),302);
    if (!env.ASSETS) return new Response("Static assets binding ASSETS is not configured.",{status:500});
    return env.ASSETS.fetch(request);
  }
};
