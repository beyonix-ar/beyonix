# Descripción enriquecida de producto

## Datos y seguridad

`lib/products/rich-description.ts` define la allowlist. Se guardan `p`, `br`,
`h2`, `h3`, `strong`, `em`, `u`, `ul`, `ol`, `li`; tamaños mediante
`span class="rt-size-N"` con N en `12,14,16,18,20,22,24,28,32,36,40`;
y alineación mediante `class="rt-align-center|right"` en bloques.
Los tamaños antiguos `rt-size-sm|lg|xl` se leen como `14|18|20`.
Se descartan scripts, iframes, imágenes, links, fuentes, colores, clases
arbitrarias y atributos de evento. El renderer convierte el árbol seguro
en elementos React, sin `innerHTML`.

Al crear y editar, las rutas API ejecutan `normalizeProductDescriptionInput`
server-side. El límite de entrada sigue siendo de 50.000 caracteres; vacío se
guarda como `null`. La migración `20261009110000` instaló la guarda SQL
y `20261009120000` amplía su allowlist. El trigger sólo valida cuando cambia
la descripción, por lo que los datos legacy no se reescriben.

## Editor

El toolbar no tiene selector Párrafo/Título/Subtítulo: la jerarquía se maneja
con tamaño, fuente, color, negrita y alineación. Los `h2`/`h3` ya guardados se
siguen leyendo y renderizando; "Limpiar" los convierte en párrafo.

Fuente, tamaño, color, negrita, cursiva y subrayado no usan `execCommand`: el
editor aplana cada tramo de texto a su formato efectivo (`RichMarks`, el
elemento más interno gana), aplica la elección del usuario al rango y reescribe
el HTML canónico (`richRunsToInline`, orden fijo color › fuente › tamaño ›
peso › cursiva › subrayado). Así nunca quedan spans del mismo tipo anidados ni
estilos viejos ganando por especificidad. El sanitizer usa el mismo modelo.
Sin selección, el formato se aplica a una marca invisible (U+200B) en el
cursor que el texto nuevo hereda. La marca vive sólo mientras el formato está
pendiente: se quita al escribir (o al terminar una composición IME), antes de
Backspace/Delete/flechas/Inicio/Fin y cuando el cursor se va a otro lugar, así
que nunca cuesta una pulsación extra; el sanitizer igual la descarta al guardar.
Al elegir tamaño, fuente o color en un menú, el foco vuelve al texto.
Como el DOM se reescribe, deshacer/rehacer (botones, Ctrl+Z/Y, menú del
navegador) usa un historial propio: escribir seguido o borrar seguido es un
paso; mover el cursor, alternar escribir/borrar o aplicar formato abre otro.
Listas, alineación y Enter siguen con `execCommand`. Enter inserta un párrafo
y Shift+Enter inserta `br`.

Pegar inserta sólo texto (`richPasteToPlainText`): nunca entran fuente,
tamaño, peso, color, fondo ni clases externas. Se conservan párrafos, saltos
y listas simples como líneas con `•`/`1.`; el texto toma el formato del cursor.
Sin fuente explícita, editor y tienda heredan Montserrat (`--font-body`).

La prueba de navegador `lib/products/rich-description-editor.browser.test.tsx`
cubre edición, selección parcial y tamaños, mientras que
`lib/products/rich-description.test.ts` cubre sanitizer, XSS y la guarda SQL
en PostgreSQL embebido.
