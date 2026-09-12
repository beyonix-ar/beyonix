/**
 * Sanitiza el `?redirect=` que /login usa para volver a donde el usuario
 * estaba antes de loguearse/registrarse.
 *
 * `redirect.startsWith("/")` NO alcanza: `//evil.com` también empieza con
 * "/" pero el navegador lo resuelve como protocol-relative URL
 * (`https://evil.com`, mismo esquema que la página actual) -- un
 * `window.location.replace(redirect)` con ese valor saca al usuario
 * recién logueado de BEYONIX a un dominio externo. `/\evil.com` es el mismo
 * ataque: algunos navegadores normalizan la barra invertida inicial a "/".
 * Por eso sólo se acepta una ruta interna real: un único "/" inicial que NO
 * esté seguido de otro "/" ni de "\".
 */
export function getSafeRedirect(redirect: string | null): string {
  if (!redirect || redirect.startsWith("/login")) return "/"
  if (!/^\/(?!\/|\\)/.test(redirect)) return "/"
  return redirect
}
