/**
 * Bomgardi Mehran experimental Worker.
 * This branch only tests routing and static asset delivery.
 * Booking, OTP, SMS, database writes and scheduled reminders are NOT enabled.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "bomgardi-mehran",
        mode: "experimental",
        bookingEnabled: false,
        smsEnabled: false
      }, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (url.pathname === "/admin") {
      return Response.redirect(new URL("/admin/", url), 302);
    }

    if (!env.ASSETS) {
      return new Response("Static assets binding ASSETS is not configured.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
