# Emails de autenticación de BEYONIX — dónde viven y qué falta pegar

## Dónde está esto hoy

Se buscó en todo el repo un HTML propio para el email de confirmación de
cuenta ("Confirm signup") y **no existe ninguno**: no hay `supabase/config.toml`
con `[auth.email.template.*]`, y el envío del correo de confirmación lo
dispara Supabase Auth automáticamente al llamar a `supabase.auth.signUp()`
(ver `context/auth-context.tsx`) usando el template que esté configurado en

    Supabase Dashboard > Authentication > Emails > Confirm signup

Es decir: **el HTML actual del email de confirmación vive únicamente en el
Dashboard remoto de Supabase, no en este repositorio.** No se puede "leer"
ni copiar desde acá, y por lo tanto no se pudo usar como referencia visual
exacta como se pidió. Si ese template ya está personalizado con la marca
BEYONIX, se ve sólo entrando al Dashboard.

Mismo mecanismo para "Reset Password": `supabase.auth.resetPasswordForEmail()`
(ahora llamado únicamente server-side, desde
`lib/auth/forgot-password.ts` vía `app/api/auth/forgot-password/route.ts`)
dispara el email de recuperación con el template que Supabase tenga
configurado para `Reset Password`. Hoy ese template está en el default
genérico de Supabase ("Reset your password") — de ahí el pedido de esta
tarea.

## Qué se preparó

`reset-password.html` en esta misma carpeta: documento HTML **completo**
(con `<!DOCTYPE html>`, `<head>` propio con charset/viewport, y estructura
100% basada en tablas con estilos inline — sin depender de que Supabase
envuelva el contenido en nada) con la identidad visual de BEYONIX (fondo
negro, acento azul de marca `#112A43`, tipografía Montserrat con fallback a
fuentes de sistema — los clientes de email no cargan Google Fonts de forma
confiable) y exactamente el contenido pedido:

- Wordmark: **BEYONIX**
- Título: **RESTABLECER CONTRASEÑA**
- Texto: **Recibimos una solicitud para cambiar la contraseña de tu cuenta.**
- Botón: **Crear nueva contraseña**
- **Este enlace es personal y temporal. No lo compartas con nadie.**
- **Si no solicitaste este cambio, podés ignorar este correo. Tu contraseña actual seguirá funcionando.**
- Footer: **© BEYONIX** + aviso discreto de que es un correo automático.

**Único CTA: el botón.** Deliberadamente NO hay un link de recuperación
visible en texto plano como fallback: mostrarlo expondría el host de
Supabase, el `redirect_to` y el token en la URL a simple vista (capturas de
pantalla, reenvíos, "mirar por encima del hombro"). El `href` del botón
sigue llevando `{{ .ConfirmationURL }}` -- el flujo no cambia, sólo deja de
imprimirse como texto.

No incluye ningún dato sensible (ni email, ni username, ni nada que
identifique la cuenta más allá de lo que Supabase ya agrega por variable).

## Cómo aplicarlo (manual, en Supabase Dashboard)

**Esto NO se ejecutó remotamente.** Pasos exactos:

1. Ir a **Authentication > Emails > Reset Password** en el Dashboard del
   proyecto de Supabase.
2. **Subject**: reemplazar por

   ```
   Restablecer contraseña – BEYONIX
   ```

3. **Message body (HTML)**: reemplazar el contenido completo por **todo**
   `supabase/email-templates/reset-password.html`, desde la primera línea
   (`<!-- Template de Supabase Auth...`) hasta la última (`</html>`) —
   incluido el `<!DOCTYPE html>` y el `<head>`.
4. Guardar.

## Por qué el Subject sigue en inglés hasta que lo cambies vos en el Dashboard

Verificado en el código, no supuesto:

- `lib/auth/forgot-password.ts` es el ÚNICO lugar del repo que dispara este
  email, con una sola llamada:
  `admin.auth.resetPasswordForEmail(email, { redirectTo })`.
- La firma real de ese método (`node_modules/@supabase/auth-js`) es
  `resetPasswordForEmail(email: string, options?: { redirectTo?: string; captchaToken?: string })`.
  **No existe un parámetro de subject, de HTML, ni de "from".** No hay forma
  de que el código de la app influya en el Subject o el cuerpo del correo.
- El Subject y el HTML de cada tipo de email (Confirm signup, Reset
  Password, etc.) son 100% propiedad de la configuración del proyecto en
  Supabase, no del código de la app ni de este repositorio.

**Conclusión: mientras no entres a Authentication > Emails > Reset Password
y cambies el campo Subject vos mismo, el correo real va a seguir diciendo
"Reset your password" sin importar qué se cambie en el repo.** No hay
ningún workaround de código para esto.

## Variables usadas (oficiales de Supabase, no inventadas)

El template usa `{{ .ConfirmationURL }}`, la misma variable que trae el
template default de Supabase para los cuatro tipos de email (Confirm
signup, Invite, Magic Link, Reset Password). Apunta al endpoint de
Supabase que valida el token y redirige a la app.

Otras variables disponibles si en algún momento se necesitan (no usadas acá
para no romper el flujo actual, que ya sabe manejar `?code=` y
`#access_token=&type=recovery`):

- `{{ .SiteURL }}` — la Site URL configurada en el proyecto.
- `{{ .Token }}` / `{{ .TokenHash }}` — el OTP crudo/hasheado, para armar un
  link manual en vez de `ConfirmationURL`.
- `{{ .Email }}` — el email del destinatario (no se usa en el cuerpo a
  propósito: no hace falta mostrarlo).

## Redirect a verificar (importante para que el link no quede roto)

`ConfirmationURL` sólo redirige a una URL que esté en la lista blanca de
**Authentication > URL Configuration > Redirect URLs** del proyecto.
Confirmar que esa lista incluya:

```
https://<tu-dominio-de-producción>/reset-password
```

Esto es además una capa de protección adicional (a nivel Supabase, no sólo
en el código de la app) contra que un `redirectTo` termine apuntando a un
dominio no autorizado: aunque el servidor de BEYONIX ya arma `redirectTo`
con la URL canónica (`NEXT_PUBLIC_SITE_URL`, nunca con el header `Origin` —
ver `lib/site-url.ts`), Supabase igual lo rechaza si no está en esta lista.

**Sobre el `localhost` que puede aparecer en `redirect_to` al probar en
desarrollo**: `resolveTrustedSiteUrl` (`lib/site-url.ts`) usa
`NEXT_PUBLIC_SITE_URL` siempre que esté configurada, sin importar el
entorno. El header `Origin` del navegador (que en dev suele ser
`http://localhost:3000` o similar) sólo se usa como último recurso, y
ÚNICAMENTE cuando `NODE_ENV !== "production"` **y** esa variable no está
configurada. En producción la función jamás toca `Origin`: si
`NEXT_PUBLIC_SITE_URL` falta, no es HTTPS, o apunta a `localhost`/`127.0.0.1`,
devuelve `null` y el llamador corta la operación (falla cerrado, no manda un
link roto ni inventa un dominio). Esto ya está cubierto por tests en
`lib/site-url.test.ts` que fijan ambos comportamientos.

## Si más adelante se quiere alinear "Confirm signup" con el mismo estilo

`reset-password.html` está armado para ser fácil de adaptar: cambiar sólo
el ícono/título/texto/botón (bloque central de la tabla) y dejar el resto
(header BEYONIX, card, footer) igual. No se tocó el template de
confirmación en esta tarea porque no era el alcance pedido y modificar un
flujo de autenticación que ya funciona sin pedido explícito no correspondía.
