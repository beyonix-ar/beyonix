/**
 * Netlify Scheduled Function: dispara la sincronización automática de
 * tracking Andreani en el sitio real de producción (Netlify -- el proyecto
 * Vercel nunca tuvo un deploy, ver auditoría 2026-08-26).
 *
 * Deliberadamente NO reimporta lib/andreani/* acá: esos módulos importan
 * el paquete "server-only", que sólo resuelve a un no-op bajo el condition
 * "react-server" que aplica el build de Next.js. Empaquetado directo con el
 * bundler de Netlify Functions (esbuild, sin ese condition) haría que
 * "server-only" tire al importarse. En cambio, esta función sólo hace un
 * GET autenticado contra la ruta Next.js ya existente y ya auditada
 * (app/api/cron/andreani-sync-tracking/route.ts) -- cero lógica
 * duplicada, cero riesgo de bundling.
 *
 * Seguridad: Netlify no permite invocar una scheduled function por HTTP
 * externo (sólo su propio scheduler, "Run now" en el dashboard, o
 * `netlify functions:invoke` con sesión autenticada) -- ver
 * https://docs.netlify.com/build/functions/scheduled-functions/. La ruta
 * Next.js de destino, además, sigue exigiendo su propio CRON_SECRET.
 */
const handler = async () => {
  const startedAt = Date.now();
  const baseUrl = process.env.URL || process.env.NEXT_PUBLIC_SITE_URL;
  const cronSecret = process.env.CRON_SECRET;

  if (!baseUrl) {
    console.error("ANDREANI_SYNC_SCHEDULED_FUNCTION_ERROR", {
      reason: "missing_site_url",
    });
    return new Response("Falta URL del sitio.", { status: 500 });
  }

  try {
    const response = await fetch(
      `${baseUrl}/api/cron/andreani-sync-tracking`,
      {
        headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
      },
    );

    const body = await response.json().catch(() => null);
    const durationMs = Date.now() - startedAt;

    console.log("ANDREANI_SYNC_SCHEDULED_FUNCTION_RUN", {
      status: response.status,
      ok: body?.ok ?? false,
      checked: body?.checked ?? null,
      updated: body?.updated ?? null,
      statusChanged: body?.statusChanged ?? null,
      errors: body?.errors ?? null,
      durationMs,
    });

    return new Response(null, { status: response.ok ? 200 : 502 });
  } catch (error) {
    console.error("ANDREANI_SYNC_SCHEDULED_FUNCTION_ERROR", {
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return new Response("No se pudo ejecutar la sincronización.", {
      status: 502,
    });
  }
};

export default handler;

export const config = {
  schedule: "*/15 * * * *",
};
