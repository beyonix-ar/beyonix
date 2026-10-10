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

El editor conserva el historial nativo del navegador. Usa `execCommand`
para formato, listas, alineación, inserción y undo/redo: sigue soportado en
los navegadores objetivo, aunque está obsoleto. Los botones evitan robar el
foco y los selectores restauran un `Range` guardado dentro del editor.
El tamaño se aplica con un marcador temporal `fontName`; al emitir el valor
se transforma en la clase permitida. Enter inserta un párrafo y Shift+Enter
inserta `br`. El HTML pegado se sanea antes de entrar al editor.

La prueba de navegador `lib/products/rich-description-editor.browser.test.tsx`
cubre edición, selección parcial y tamaños, mientras que
`lib/products/rich-description.test.ts` cubre sanitizer, XSS y la guarda SQL
en PostgreSQL embebido.
