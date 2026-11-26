const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function validISODate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
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
    url: env.SUPABASE_URL.replace(/\\/$/, ""),
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
      "Authorization": "Bearer " + cfg.key,
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
    .replace(/[\\s-]/g, "");
  if (phone.startsWith("+98")) phone = "0" + phone.slice(3);
  if (phone.startsWith("0098")) phone = "0" + phone.slice(4);
  return phone;
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
    return json({
      ok:true, service:"bomgardi-mehran", mode:"experimental",
      databaseConfigured:!!config(env), bookingEnabled:!!config(env),
      smsEnabled:false, otpEnabled:false
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
      if (checkIn && checkOut) {
        const overlaps = await supabase(env,
          "reservations?select=room_id&check_in=lt." + encodeURIComponent(checkOut) +
          "&check_out=gt." + encodeURIComponent(checkIn) +
          "&status=neq.cancelled"
        );
        busyIds = [...new Set((overlaps || []).map(r => r.room_id))];
      }
      return json({ok:true,rooms:(rooms || []).map(room => ({
        id:room.id, name:room.name, capacity:room.capacity,
        max_capacity:room.max_capacity, description:room.description,
        image_path:room.image_path,
        available:checkIn && checkOut ? !busyIds.includes(room.id) : null
      }))});
    } catch (error) {
      return json({ok:false,error:"دریافت اتاق‌ها با خطا مواجه شد."},500);
    }
  }

  if (url.pathname === "/api/bookings" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ok:false,error:"اطلاعات ارسالی معتبر نیست."},400); }
    const fullName = String(body.full_name || "").trim();
    const phone = normalizePhone(body.phone);
    const roomId = String(body.room_id || "");
    const checkIn = body.check_in;
    const checkOut = body.check_out;
    const adults = Number(body.adults);
    const children = Number(body.children || 0);
    const infants = Number(body.infants || 0);
    const notes = String(body.notes || "").trim().slice(0,1000);
    if (!fullName || fullName.length > 120) return json({ok:false,error:"نام و نام خانوادگی را کامل وارد کنید."},400);
    if (!/^09\\d{9}$/.test(phone)) return json({ok:false,error:"شماره موبایل باید به شکل ۰۹xxxxxxxxx باشد."},400);
    if (!roomId || !validISODate(checkIn) || !validISODate(checkOut) || checkOut <= checkIn) {
      return json({ok:false,error:"اتاق یا تاریخ‌های انتخاب‌شده معتبر نیستند."},400);
    }
    if (checkIn < tehranToday()) return json({ok:false,error:"تاریخ ورود نمی‌تواند در گذشته باشد."},400);
    if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0 ||
        !Number.isInteger(infants) || infants < 0 || adults+children+infants > 20) {
      return json({ok:false,error:"تعداد مسافران معتبر نیست."},400);
    }
    try {
      const rooms = await supabase(env,
        "rooms?select=id,name,capacity,max_capacity,is_active&id=eq." + encodeURIComponent(roomId) + "&is_active=eq.true"
      );
      const room = rooms?.[0];
      if (!room) return json({ok:false,error:"اتاق انتخاب‌شده فعال نیست."},404);
      const maxCapacity = Number(room.max_capacity || room.capacity || 0);
      if (maxCapacity > 0 && adults + children > maxCapacity) {
        return json({ok:false,error:"تعداد بزرگسالان و کودکان از ظرفیت اتاق بیشتر است."},400);
      }

      let guests = await supabase(env,
        "guests?select=id&phone=eq." + encodeURIComponent(phone) + "&limit=1"
      );
      let guest = guests?.[0];
      if (!guest) {
        const created = await supabase(env,"guests",{
          method:"POST",
          headers:{"Prefer":"return=representation"},
          body:JSON.stringify({full_name:fullName,phone})
        });
        guest = created?.[0];
      } else {
        await supabase(env,"guests?id=eq."+encodeURIComponent(guest.id),{
          method:"PATCH", headers:{"Prefer":"return=minimal"},
          body:JSON.stringify({full_name:fullName})
        });
      }
      if (!guest?.id) throw new Error("GUEST_CREATE_FAILED");

      const reservation = await supabase(env,"reservations",{
        method:"POST",
        headers:{"Prefer":"return=representation"},
        body:JSON.stringify({
          guest_id:guest.id, room_id:room.id,
          check_in:checkIn, check_out:checkOut,
          adults, children, infants,
          total_amount:0, deposit_amount:0, paid_amount:0,
          status:"pending",
          notes:[ "درخواست ثبت‌شده از سایت عمومی", notes ].filter(Boolean).join(" | ")
        })
      });
      const saved = reservation?.[0];
      return json({
        ok:true,
        message:"درخواست شما ثبت شد و پس از بررسی مدیر با شما تماس گرفته می‌شود.",
        tracking_code:saved?.id ? saved.id.slice(-8).toUpperCase() : null,
        status:"pending"
      },201);
    } catch (error) {
      if (error.code === "23P01" || error.code === "23505") {
        return json({ok:false,error:"این اتاق در بازه انتخابی قبلاً رزرو شده است. لطفاً اتاق یا تاریخ دیگری انتخاب کنید."},409);
      }
      return json({ok:false,error:"ثبت درخواست انجام نشد. لطفاً چند لحظه دیگر دوباره تلاش کنید."},500);
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
