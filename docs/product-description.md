# Descripción enriquecida de producto

## Fuente única de saneado

`lib/products/rich-description.ts` → `sanitizeRichDescription` (allowlist) y
`normalizeProductDescriptionInput` (entrada server-side: string → HTML canónico,
vacío → `null`, otro tipo o > 50.000 caracteres → error, nunca truncado silencioso).

Etiquetas permitidas en lo persistido: `p`, `br`, `strong`, `em`, `u`, `h2`, `h3` y
`span class="rt-size-sm|lg|xl"`. `b`/`i`/`h1`/`h4-6`/`font size` se traducen; todo lo
demás (script, iframe, object, embed, svg, img, a, style, `on*`, `javascript:`,
`data:`, clases, `data-*`, colores, fuentes) se descarta. El texto se escapa.

## Capas

| Capa | Rol |
|---|---|
| Editor (`rich-description-editor.tsx`) | Primera barrera/UX: sanea lo emitido y lo pegado. |
| `POST /api/admin/products` (alta) | Re-sanea y llama `create_producto_completo_v2` con la sesión del Admin. |
| `PATCH /api/admin/products/[id]/catalog` (edición) | Re-sanea antes de la RPC atómica. |
| Trigger `guard_product_description` (20261009110000) | Respaldo: rechaza (`PRODUCT_DESCRIPTION_UNSAFE`) cualquier escritura cuya descripción no sea la forma canónica, aunque venga por REST directo o un flujo futuro. No sanea: verifica. |

El alta ya no escribe desde el navegador. `createProducto`/`updateProducto` (escritura
directa a la tabla, sin uso) se eliminaron. No existe flujo de duplicar producto ni
importación de catálogo que escriba descripciones.

## Legacy

Texto plano previo se sigue renderizando igual (párrafos por línea en blanco, `<br>`
por salto). La guarda sólo valida cuando la descripción cambia; no hubo migración de
datos (en producción había una sola descripción y ya era canónica).

## Pegado (Word / Google Docs / web)

El HTML del portapapeles pasa por el mismo sanitizer: negrita/cursiva/subrayado por
estilo inline (`font-weight:700`, `font-style:italic`, `text-decoration:underline`) se
conservan; el `<b style="font-weight:normal">` envolvente de Google Docs no pone todo
en negrita; tamaños en pt, colores, clases `Mso*`, links e imágenes se descartan.

## Editor y `execCommand`

`document.execCommand` está deprecado pero sigue soportado por todos los navegadores
y no tiene reemplazo nativo (Input Events Level 2 no aplica formato por sí solo). Las
alternativas reales (TipTap/ProseMirror, Lexical, Slate) suman una dependencia de
editor completa para cinco comandos (título, subtítulo, negrita, cursiva, subrayado,
tamaño). Como el resultado siempre se re-sanea en cliente, servidor y base, el riesgo
de `execCommand` es de UX (no de seguridad). Decisión: no migrar por ahora; revisar si
un navegador objetivo deja de soportarlo o si se necesitan listas/links.

## Tests

`lib/products/rich-description.test.ts` (XSS, pegado, idempotencia, guarda en PGlite) y
`lib/admin/new-routes-security.test.ts` (alta/edición: vacío, texto simple, rich, XSS,
tipos inválidos, permisos).
