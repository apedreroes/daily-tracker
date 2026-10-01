// Edge Function "morning-reminder"
// Un cron la invoca cada hora. Para cada dispositivo suscrito cuya hora local
// coincide con la hora elegida, comprueba si el día anterior tiene registro y,
// si no lo tiene, envía una notificación push.
//
// Secretos necesarios (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:tu@correo), CRON_SECRET
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya existen en el entorno de la función.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// Fecha y hora locales de una zona horaria.
function localNow(tz: string, now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const yesterday = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - 1));
  return { hour: +parts.hour, yesterday: yesterday.toISOString().slice(0, 10) };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("No autorizado", { status: 401 });
  }
  // { "force": true } ignora la hora: útil para probar el envío a mano.
  const { force = false } = await req.json().catch(() => ({}));

  const { data: subs, error } = await supabase.from("push_subscriptions").select("*");
  if (error) return new Response(error.message, { status: 500 });

  const now = new Date();
  let sent = 0;
  let removed = 0;

  for (const sub of subs ?? []) {
    let local;
    try { local = localNow(sub.tz, now); } catch { local = localNow("Europe/Madrid", now); }
    if (!force && local.hour !== sub.hour) continue;

    const { data: entry } = await supabase
      .from("entries").select("day")
      .eq("space_id", sub.space_id).eq("day", local.yesterday)
      .maybeSingle();
    if (entry) continue; // ayer sí se registró

    const payload = JSON.stringify({
      title: "Hábitos: ayer quedó sin registrar",
      body: "Toca para completar el registro de ayer. Solo te llevará un momento.",
      day: local.yesterday,
    });

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 6 * 60 * 60 },
      );
      sent += 1;
    } catch (err) {
      // 404/410: la suscripción ya no existe (app desinstalada o permiso retirado).
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        removed += 1;
      } else {
        console.error("Error enviando push:", err);
      }
    }
  }

  return Response.json({ checked: subs?.length ?? 0, sent, removed });
});
