# Emails de autenticación de BEYONIX

Esta carpeta versiona en Git los templates HTML que se pegan manualmente en
**Supabase Dashboard > Authentication > Emails**. Supabase Auth dispara estos
emails automáticamente (no hay código de la app que arme el HTML ni el
subject); el repo es la fuente de verdad de qué HTML *debería* estar
configurado, pero **el Dashboard no se sincroniza solo con Git** — cada
cambio acá requiere volver a copiar el archivo a mano en el Dashboard para
que tenga efecto en los emails reales.

## Qué template corresponde a cada flujo

| Flujo (Dashboard)            | Archivo                    | ¿Se usa hoy? | Dispara desde |
|-------------------------------|----------------------------|:---:|---|
| **Reset Password**            | `reset-password.html`      | Sí  | `lib/auth/forgot-password.ts` → `admin.auth.resetPasswordForEmail()`, vía `app/api/auth/forgot-password/route.ts` |
| **Confirm signup**             | `confirm-signup.html`      | Sí  | `context/auth-context.tsx` → `supabase.auth.signUp()`; reenvío en `lib/auth/resend-confirmation.ts` y `app/verificar-email/page.tsx` → `supabase.auth.resend({ type: "signup" })` |
| Email Change / Invite / Magic Link / Reauthentication | *(no existen)* | No | No hay ningún flujo en el código que dispare estos emails. No se crearon templates para evitar archivos muertos. Si en el futuro se habilita alguno de estos flujos, crear el template en ese momento siguiendo el mismo lenguaje visual. |

## Cómo aplicar un template (manual, en Supabase Dashboard)

**Esto NO se ejecuta remotamente ni por CLI/migración — es un paso manual en el Dashboard.**

### Reset Password

1. Ir a **Authentication > Emails > Reset Password**.
2. **Subject**: `Restablecer contraseña – BEYONIX`.
3. **Message body (HTML)**: reemplazar TODO el contenido por el archivo
   completo `reset-password.html`, desde la primera línea (`<!-- Template de
   Supabase Auth...`) hasta la última (`</html>`) — incluido `<!DOCTYPE
   html>` y el `<head>`.
4. Guardar.

### Confirm signup

1. Ir a **Authentication > Emails > Confirm signup**.
2. **Subject**: `Confirmá tu cuenta – BEYONIX`.
3. **Message body (HTML)**: reemplazar TODO el contenido por el archivo
   completo `confirm-signup.html`, desde la primera línea hasta la última
   (`</html>`) — incluido `<!DOCTYPE html>` y el `<head>`.
4. Guardar.

## Por qué el Subject sólo se puede cambiar en el Dashboard

Verificado en el código, no supuesto:

- `lib/auth/forgot-password.ts` es el único lugar del repo que dispara el
  email de Reset Password, con una sola llamada:
  `admin.auth.resetPasswordForEmail(email, { redirectTo })`.
- `context/auth-context.tsx` (`signUp()`), `lib/auth/resend-confirmation.ts`
  y `app/verificar-email/page.tsx` (`auth.resend({ type: "signup" })`) son
  los únicos lugares que disparan el email de Confirm signup.
- Ninguna de esas firmas reales (`node_modules/@supabase/auth-js`) acepta un
  parámetro de subject, de HTML, ni de "from". **No existe un parámetro de
  subject** en ninguna de ellas — el Subject y el HTML de cada tipo de email
  son 100% propiedad de la configuración del proyecto en Supabase, no del
  código de la app ni de este repositorio.

**Conclusión: mientras no entres a Authentication > Emails > Reset Password
(o > Confirm signup) y cambies el campo Subject vos mismo, el correo real va
a seguir diciendo el subject que esté guardado ahí, sin importar qué se
cambie en el repo.** No hay ningún workaround de código para esto.

## ⚠️ NO reemplazar `token_hash` / variables a mano

Los `{{ .SiteURL }}`, `{{ .TokenHash }}`, etc. son variables que Supabase
interpola automáticamente al enviar el email. **Nunca** pegar un valor fijo,
un link de ejemplo, ni "completar" la variable a mano en el Dashboard — el
link dejaría de funcionar para todos los usuarios (token compartido/estático
en vez de uno único por email). Copiar el HTML tal cual está en el repo.

## Por qué ambos templates usan `{{ .SiteURL }}/<ruta>?token_hash=...` en vez de `{{ .ConfirmationURL }}`

`{{ .ConfirmationURL }}` apunta al endpoint de Supabase
(`<proyecto>.supabase.co/auth/v1/verify?token=...&type=...`), que consume el
token de un solo uso con un simple `GET`. Cualquier escaneo automático de
enlaces del lado del destinatario (Outlook Safe Links, gateways antispam
corporativos, algunos proxies de email) sigue ese link apenas llega el
correo — típicamente en segundos — y lo invalida antes de que la persona lo
abra, sin importar el TTL configurado.

Construyendo el link manualmente con `{{ .SiteURL }}` + `{{ .TokenHash }}`
apuntando directo a nuestro dominio, un rastreador que sólo hace `GET` sobre
esa URL descarga HTML/JS pero no ejecuta React ni llama a `verifyOtp()` — el
token recién se consume cuando un navegador real carga la página y corre
nuestro código:

- **Reset Password** → `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery`
  Consumido por `app/reset-password/page.tsx` (vía `lib/auth/recovery-link.ts`),
  ya soporta este formato sin cambios.
- **Confirm signup** → `{{ .SiteURL }}/confirmar-email?token_hash={{ .TokenHash }}&type=signup`
  Consumido por `app/confirmar-email/page.tsx`, ya soporta `token_hash` +
  `type=signup` sin cambios (`CONFIRMATION_OTP_TYPES` incluye `"signup"`).

Esta tarea **no modificó ninguna de esas dos rutas** — sólo se preparó el
HTML del email para apuntar al formato que esas rutas ya sabían recibir.

## Variables de Supabase que usa cada template (oficiales, no inventadas)

Ambos templates usan únicamente:

- `{{ .SiteURL }}` — la Site URL configurada en
  **Authentication > URL Configuration > Site URL** del proyecto. NO es
  `NEXT_PUBLIC_SITE_URL` del repo ni el `redirectTo`/`emailRedirectTo` que
  arma el servidor — es un campo aparte del Dashboard, hay que confirmarlo
  ahí.
- `{{ .TokenHash }}` — el OTP hasheado, específico de cada tipo de email
  (Supabase genera un `TokenHash` distinto para `recovery` y para `signup`).

`type=recovery` y `type=signup` están hardcodeados como texto en cada
template (no son variables) porque cada template sólo se envía para su
propio flujo — no hace falta ni existe una variable de Supabase para eso.

No se usa `{{ .Token }}` (OTP numérico de 6 dígitos, para flujos de código
manual) ni `{{ .Data }}` (metadata cruda del usuario) en ninguno de los dos,
porque ninguno los necesita.

## Redirect a verificar (importante para que el link no quede roto)

Aunque no se usa `{{ .ConfirmationURL }}`, Supabase igual valida que
`{{ .SiteURL }}` esté en la lista blanca de
**Authentication > URL Configuration > Redirect URLs** antes de considerar
válido el flujo. Confirmar que esa lista incluya:

```
https://<tu-dominio-de-producción>/reset-password
https://<tu-dominio-de-producción>/confirmar-email
```

**Sobre el `localhost` que puede aparecer al probar en desarrollo**:
`resolveTrustedSiteUrl` (`lib/site-url.ts`) usa `NEXT_PUBLIC_SITE_URL`
siempre que esté configurada, sin importar el entorno. El header `Origin`
del navegador sólo se usa como último recurso, y únicamente cuando
`NODE_ENV !== "production"` y esa variable no está configurada. En
producción, si `NEXT_PUBLIC_SITE_URL` falta, no es HTTPS, o apunta a
`localhost`/`127.0.0.1`, la función devuelve `null` y el llamador corta la
operación (falla cerrado). Cubierto por tests en `lib/site-url.test.ts`.

También confirmar **Authentication > Providers > Email > Email OTP
Expiration** (segundos) según la política que se quiera para cada flujo.

## Consistencia visual entre ambos templates

`confirm-signup.html` reutiliza exactamente la misma estructura, paleta,
tipografía y bloques de `reset-password.html` (wordmark BEYONIX, tarjeta
`#0A0A0A` con borde `rgba(140,200,242,0.16)`, ícono en caja `#112A43`,
botón "bulletproof" de tabla, texto de seguridad y footer) — sólo cambian
ícono, título, cuerpo, texto del botón y el footer específico del flujo.
Cualquier ajuste de estética futuro debería aplicarse a los dos para que no
se perciban como emails de empresas distintas.

## Notas de compatibilidad (Gmail / Outlook / clientes de email)

- Sin CSS externo, sin JavaScript, sin imágenes externas — todo el layout
  crítico está en tablas con estilos inline; el único `<style>` del
  `<head>` es una mejora progresiva (ajuste de padding en mobile vía media
  query) que no rompe nada si el cliente lo ignora.
- `meta name="color-scheme"` + `meta name="supported-color-schemes"`
  (`content="dark"` en ambos) le indican a Gmail/Outlook/Apple Mail que el
  diseño ya es dark-mode-aware, evitando que esos clientes reinviertan
  colores automáticamente.
- La tabla principal usa el patrón "fluid-hybrid" (`width="100%"` +
  `max-width:480px` en vez de un ancho fijo) para evitar overflow horizontal
  en pantallas angostas (~375px) en clientes que sí respetan el media query.
- Botón con celda de tabla de color sólido (no imagen, no `<button>`):
  100% funcional incluso en Outlook de escritorio, donde el `border-radius`
  se ignora (esquinas cuadradas) pero el link sigue funcionando.
