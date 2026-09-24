# Auditoría final de estilos de pedidos — 2026-09-23

## Resultado

23 sitios JSX auditados: **12** coincidencias con rounded-full + border, **3** puntos sin borde y **8** etiquetas/badges semánticos equivalentes. Son sitios de código, no cantidad de instancias de pedidos ni cantidad de estados posibles.

- 11 sitios seguros frente al selector: 1069, 1293, 1392, 1502, 1539, 3319, 4707, 4779, 6095, 8686, 8767. Sin modificaciones.
- 12 afectados: 1991, 5656, 5783, 6041, 6543, 6637, 6710, 6729, 8641, 8648, 8734, 8738.
- 11 corregidos. **6543 permanece afectado**: el usuario prohibió tocar el contador de acciones pendientes. No se modificó su JSX, su lógica ni sus reglas CSS.
- No hubo texto ilegible en las muestras iniciales de estos badges: el defecto comprobado era el aplanamiento del color semántico.

## Cascada y causa exacta

El selector citado en el pedido sólo aparece literalmente en comentarios. El selector **activo** es:

```css
.beyonix-admin-main :where(span, button):not([style*="background"])[class*="rounded-full"][class*="border"]
```

Especificidad **(0,4,0)**: main, los dos atributos de clase y el atributo dentro de :not. :where aporta cero. La forma citada con span tendría (0,3,1). El selector activo pisa border-radius, border-color, background-color y color con !important. Dark: fondo rgba(17,42,67,.22), texto #d7ecff y borde var(--admin-border). Su variante Light agrega html[data-admin-theme="light"], queda en **(0,5,1)** y fija fondo #f1f4f8, texto var(--admin-text), borde var(--admin-border). Son las causas comunes de los 12 problemas.

Las familias de color border-emerald/amber/red/beyonix-blue-light de globals.css (zona 6357) tienen (0,2,0); sus variantes Light border-sky/cyan/blue/violet/fuchsia/purple/emerald/green/amber/red (zona final 11200) tienen (0,3,1). Aunque aparecen después, pierden contra la heurística de forma. Los tonos admin-ds-tone-* también pierden. Las reglas repetidas del design system redefinen colores varias veces; no son duplicados textuales idénticos, sino capas amplias que compiten por las mismas propiedades. No se alteraron globalmente.

Las excepciones de reclamo pendiente alcanzan como máximo (0,3,0), insuficiente contra (0,4,0). Las excepciones Light del contador (clase repetida + bg-red-500/bg-amber-400) tienen (0,4,1), insuficiente contra (0,5,1). El contador tampoco tiene protección equivalente en Dark.

Otras reglas relacionadas revisadas: superficies :where(section,article,aside,details,form,div)[class*="rounded"][class*="border"], botones/enlaces redondeados, tracking-widest, las familias admin-order-tone-*, admin-order-semantic-badge, admin-order-status-badge y admin-order-bl-*. Las superficies no seleccionan span; tracking-widest no coincide con tracking-wide. El selector de botones genérico puede afectar botones pequeños, pero ninguno de los 12 es button. Los input radio/checkbox están excluidos de las reglas generales de controles; los círculos inventariados son spans, no radios. No se encontraron otros archivos CSS del proyecto: el tema se concentra en app/globals.css.

## Corrección mínima

Se sustituyó la forma rounded-full + border por **admin-order-pill** en 11 sitios. La clase declara únicamente borde sólido de 1px y radio 9999px. Se reutilizaron admin-order-tone-* en historial, pago, conciliación, garantía, progreso de envío, recordatorio de factura y Nuevo pedido. Reclamo pendiente conserva su clase existente, ahora libre de la heurística. Despacho pendiente usa una clase turquesa propia, con hover de borde, sobre las filas oscuras en ambos temas. No se agregó ningún !important.

La comparación AST antes/después, omitiendo exclusivamente atributos JSX className y propiedades de presentación className/dotClass, dio igualdad. No se cambiaron reglas de negocio, handlers, estados, notificaciones ni condiciones. Los cambios previos en status-presentation, rechazo, RESUMEN y DESPACHO se preservaron.

## Verificación Light/Dark

Se compiló app/globals.css con el PostCSS/Tailwind instalado y se evaluó getComputedStyle en Edge headless. Se usaron scopes de detalle, facturación y filas de listado (oscuras también en Light). **154 muestras finales** entre ambos temas, incluyendo variantes y tamaños. Fondo, borde, texto y forma fueron inspeccionados; el contraste calculado con composición alfa y el extremo claro del degradado de la fila superó 4,5:1 en todas las muestras de texto. Los puntos puramente gráficos no tienen ratio de texto aplicable.

Esto verifica la cascada en DOM aislado con clases reales; no equivale a una sesión autenticada ni a una revisión visual de pedidos reales. Los 12 elementos son spans sin foco propio. El hover del recordatorio de despacho se verificó en los dos tests de navegador; los demás no tienen interacción propia. El recordatorio de factura tenía una utilidad hover de borde que ya era anulada por !important: ahora usa la presentación estática del tono existente. No se modificaron botones contenedores, foco ni eventos.

## Inventario exacto

Las líneas TSX se mantuvieron estables. Cada bloque muestra las clases originales completas y, si cambian, las finales. Las expresiones interpoladas conservan su lógica. En las tablas, cada combinación distinta representa una variante visual, no un nuevo elemento.

### 1069 — Punto de notificación de pestaña

Componente: **OrderSectionNotificationDot**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`absolute right-2 top-1/2 size-2.5 -translate-y-1/2 rounded-full ${ORDER_SECTION_NOTIFICATION_DOT_STYLES[state.type]} ${
        state.critical ? "animate-pulse" : ""
      }`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | oklch(0.707 0.165 254.624) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklch(0.879 0.169 91.605) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklch(0.845 0.143 164.978) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklch(0.865 0.127 207.078) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklch(0.704 0.191 22.216) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| light | oklch(0.707 0.165 254.624) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklch(0.879 0.169 91.605) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklch(0.845 0.143 164.978) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklch(0.865 0.127 207.078) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklch(0.704 0.191 22.216) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |

### 1293 — Estado general del listado

Componente: **EstadoBadge**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`admin-order-semantic-badge admin-order-semantic-badge--${tone}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(255, 255, 255) | 16.07:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(255, 255, 255) | 16.35:1 |
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(255, 255, 255) | 16.85:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(255, 255, 255) | 15.88:1 |
| dark | rgba(76, 29, 149, 0.34) | rgba(196, 181, 253, 0.55) | rgb(255, 255, 255) | 16.85:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(255, 255, 255) | 15.47:1 |
| light | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(255, 255, 255) | 15.74:1 |
| light | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(255, 255, 255) | 16.28:1 |
| light | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(255, 255, 255) | 15.28:1 |
| light | rgba(76, 29, 149, 0.34) | rgba(196, 181, 253, 0.55) | rgb(255, 255, 255) | 16.29:1 |

### 1392 — Pago del listado

Componente: **PagoBadge**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`admin-order-semantic-badge admin-order-semantic-badge--${tone} max-w-full`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(255, 255, 255) | 16.07:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(255, 255, 255) | 16.35:1 |
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(255, 255, 255) | 16.85:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(255, 255, 255) | 15.88:1 |
| dark | rgba(76, 29, 149, 0.34) | rgba(196, 181, 253, 0.55) | rgb(255, 255, 255) | 16.85:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(255, 255, 255) | 15.47:1 |
| light | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(255, 255, 255) | 15.74:1 |
| light | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(255, 255, 255) | 16.28:1 |
| light | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(255, 255, 255) | 15.28:1 |
| light | rgba(76, 29, 149, 0.34) | rgba(196, 181, 253, 0.55) | rgb(255, 255, 255) | 16.29:1 |

### 1502 — Punto de la opción de pago seleccionada

Componente: **PaymentStatusDropdown**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`size-1.5 rounded-full ${selected.dot}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | oklab(0.879 -0.00473352 0.168934 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.809 -0.0327725 -0.0997545 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.845 -0.138113 0.0370641 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.808 0.107414 0.0381871 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| light | oklab(0.879 -0.00473352 0.168934 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.809 -0.0327725 -0.0997545 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.845 -0.138113 0.0370641 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.808 0.107414 0.0381871 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |

### 1539 — Punto de cada opción del menú de pago

Componente: **PaymentStatusDropdown**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`size-1.5 rounded-full ${option.dot}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | oklab(0.879 -0.00473352 0.168934 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.809 -0.0327725 -0.0997545 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.845 -0.138113 0.0370641 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| dark | oklab(0.808 0.107414 0.0381871 / 0.7) | oklch(0.22 0 0) | oklch(0.98 0 0) | Sin texto |
| light | oklab(0.879 -0.00473352 0.168934 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.809 -0.0327725 -0.0997545 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.845 -0.138113 0.0370641 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |
| light | oklab(0.808 0.107414 0.0381871 / 0.7) | oklch(0.22 0 0) | rgb(15, 23, 42) | Sin texto |

### 1991 — Ícono circular del historial

Componente: **OrderTimeline**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{`relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${visual.dotClass}`}
```

Clases finales:

```tsx
{`relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center admin-order-pill ${visual.dotClass}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 14.32:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 14.03:1 |
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 9.26:1 |
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 12.31:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 12.11:1 |
| light | rgba(16, 185, 129, 0.1) | rgba(5, 150, 105, 0.4) | rgb(6, 95, 70) | 6.23:1 |
| light | rgba(245, 158, 11, 0.12) | rgba(217, 119, 6, 0.4) | rgb(146, 64, 14) | 5.77:1 |
| light | rgba(100, 116, 139, 0.1) | rgba(100, 116, 139, 0.32) | rgb(38, 43, 51) | 11.19:1 |
| light | rgba(239, 68, 68, 0.1) | rgba(220, 38, 38, 0.4) | rgb(153, 27, 27) | 6.48:1 |
| light | rgba(59, 130, 246, 0.1) | rgba(37, 99, 235, 0.4) | rgb(30, 64, 175) | 6.93:1 |

### 3319 — Factura emitida

Componente: **BillingManagementPanel**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
"admin-order-bl-badge"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 37, 27, 0.75) | rgba(110, 231, 183, 0.4) | rgb(167, 243, 208) | 13.3:1 |
| light | rgba(16, 185, 129, 0.1) | rgba(5, 150, 105, 0.4) | rgb(6, 95, 70) | 6.99:1 |

### 4707 — Estado contable

Componente: **AccountingStatusRow**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
"admin-order-bl-status-badge"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(125, 255, 191) | 15.22:1 |
| dark | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(245, 193, 90) | 11.38:1 |
| dark | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(140, 200, 242) | 10.48:1 |
| dark | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(255, 180, 189) | 11.25:1 |
| dark | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgba(255, 255, 255, 0.5) | 5.33:1 |
| light | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(4, 120, 87) | 5.48:1 |
| light | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(180, 83, 9) | 5.02:1 |
| light | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(29, 78, 216) | 6.7:1 |
| light | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(185, 28, 28) | 6.47:1 |
| light | rgba(0, 0, 0, 0) | oklch(0.22 0 0) | rgb(43, 48, 57) | 13.25:1 |

### 4779 — Estado ejecutivo en RESUMEN

Componente: **AdminOrderSummaryDashboard**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`admin-order-status-badge admin-order-status-badge-${mainStatus.tone} px-2.5 py-0.5 text-10px font-black uppercase tracking-wide`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(89, 24, 34, 0.9) | rgba(248, 113, 113, 0.42) | rgb(255, 180, 189) | 8.45:1 |
| dark | rgba(6, 78, 59, 0.9) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 8.85:1 |
| dark | rgba(92, 45, 10, 0.9) | rgba(245, 158, 11, 0.5) | rgb(253, 230, 138) | 9.97:1 |
| dark | rgba(10, 35, 58, 0.9) | rgba(140, 200, 242, 0.36) | rgb(191, 228, 255) | 12.39:1 |
| dark | rgba(30, 41, 59, 0.9) | rgba(148, 163, 184, 0.42) | rgb(226, 232, 240) | 12.42:1 |
| light | rgb(254, 226, 226) | rgb(248, 113, 113) | rgb(153, 27, 27) | 6.8:1 |
| light | rgb(220, 252, 231) | rgb(74, 222, 128) | rgb(22, 101, 52) | 6.49:1 |
| light | rgb(254, 243, 199) | rgb(245, 158, 11) | rgb(146, 64, 14) | 6.37:1 |
| light | rgb(219, 234, 254) | rgb(96, 165, 250) | rgb(30, 64, 175) | 7.15:1 |
| light | rgb(241, 245, 249) | rgb(148, 163, 184) | rgb(51, 65, 85) | 9.45:1 |

### 5656 — Estado del pago no transferido

Componente: **PedidoDetailModal**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{`inline-flex items-center rounded-full border px-3 py-1.5 text-11px font-black uppercase tracking-wide ${
                            isPaymentStatusMismatch(pedido.payment_status)
                              ? "border-red-400/45 bg-red-500/10 text-red-200"
                              : "admin-ds-tone-info"
                          }`}
```

Clases finales:

```tsx
{`inline-flex items-center admin-order-pill px-3 py-1.5 text-11px font-black uppercase tracking-wide ${
                            isPaymentStatusMismatch(pedido.payment_status)
                              ? "admin-order-tone-danger"
                              : "admin-order-tone-info"
                          }`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 12.31:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 12.11:1 |
| light | rgba(239, 68, 68, 0.1) | rgba(220, 38, 38, 0.4) | rgb(153, 27, 27) | 6.48:1 |
| light | rgba(59, 130, 246, 0.1) | rgba(37, 99, 235, 0.4) | rgb(30, 64, 175) | 6.93:1 |

### 5783 — Conciliación automática de transferencia

Componente: **PedidoDetailModal**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
"inline-flex items-center rounded-full border px-3 py-1.5 text-11px font-black uppercase tracking-wide admin-ds-tone-info"
```

Clases finales:

```tsx
"inline-flex items-center admin-order-pill px-3 py-1.5 text-11px font-black uppercase tracking-wide admin-order-tone-info"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 12.11:1 |
| light | rgba(59, 130, 246, 0.1) | rgba(37, 99, 235, 0.4) | rgb(30, 64, 175) | 6.93:1 |

### 6041 — Vigencia de garantía

Componente: **PedidoDetailModal**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-10px font-black uppercase tracking-wide ${visual.className}`}
```

Clases finales:

```tsx
{`inline-flex w-fit items-center admin-order-pill px-2 py-0.5 text-10px font-black uppercase tracking-wide ${visual.className}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 9.26:1 |
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 12.31:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 14.03:1 |
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 14.32:1 |
| light | rgba(100, 116, 139, 0.1) | rgba(100, 116, 139, 0.32) | rgb(38, 43, 51) | 11.19:1 |
| light | rgba(239, 68, 68, 0.1) | rgba(220, 38, 38, 0.4) | rgb(153, 27, 27) | 6.48:1 |
| light | rgba(245, 158, 11, 0.12) | rgba(217, 119, 6, 0.4) | rgb(146, 64, 14) | 5.77:1 |
| light | rgba(16, 185, 129, 0.1) | rgba(5, 150, 105, 0.4) | rgb(6, 95, 70) | 6.23:1 |

### 6095 — Despacho en detalle de Envío

Componente: **PedidoDetailModal**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{cn(
                    "admin-order-dispatch-badge inline-flex w-fit items-center gap-2 px-3 py-1 text-11px font-black uppercase tracking-wide",
                    dispatch.className,
                  )}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 12.31:1 |
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 14.32:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 14.03:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 12.11:1 |
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 9.26:1 |
| dark | rgb(187, 247, 208) | rgb(134, 239, 172) | rgb(20, 83, 45) | 7.52:1 |
| light | rgba(239, 68, 68, 0.1) | rgba(220, 38, 38, 0.4) | rgb(153, 27, 27) | 6.48:1 |
| light | rgba(16, 185, 129, 0.1) | rgba(5, 150, 105, 0.4) | rgb(6, 95, 70) | 6.23:1 |
| light | rgba(245, 158, 11, 0.12) | rgba(217, 119, 6, 0.4) | rgb(146, 64, 14) | 5.77:1 |
| light | rgba(59, 130, 246, 0.1) | rgba(37, 99, 235, 0.4) | rgb(30, 64, 175) | 6.93:1 |
| light | rgba(100, 116, 139, 0.1) | rgba(100, 116, 139, 0.32) | rgb(38, 43, 51) | 11.19:1 |

### 6543 — Contador de acciones pendientes del ojo

Componente: **OrderEyeAttentionBadge**. Selector inicial: **sí**. Resultado: **afectado, pendiente por restricción**.

Clases originales:

```tsx
{`admin-order-eye-attention-badge absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-9px font-black leading-none ${
        urgent
          ? "border-red-300/60 bg-red-500 text-white shadow-[0_0_8px_rgba(239,68,68,0.55)]"
          : "border-amber-200/60 bg-amber-400 text-[#3a2504] shadow-[0_0_8px_rgba(245,158,11,0.5)]"
      }`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(17, 42, 67, 0.22) | rgba(92, 159, 215, 0.28) | rgb(215, 236, 255) | 15.03:1 |
| light | rgb(241, 244, 248) | rgba(30, 58, 95, 0.24) | rgb(15, 23, 42) | 16.18:1 |

### 6637 — Pasos del progreso del envío

Componente: **ShippingProgressTimeline**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-9px font-black",
                    done
                      ? "border-beyonix-status-success/70 bg-beyonix-blue-900 text-beyonix-status-success"
                      : current
                        ? "border-beyonix-blue-300 bg-beyonix-blue-700 text-white"
                        : "border-beyonix-gray-700 bg-beyonix-gray-900 text-[var(--beyonix-text-primary)]",
                  )}
```

Clases finales:

```tsx
{cn(
                    "flex size-7 shrink-0 items-center justify-center admin-order-pill text-9px font-black",
                    done
                      ? "admin-order-tone-success"
                      : current
                        ? "admin-order-tone-info"
                        : "admin-order-tone-muted",
                  )}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 14.32:1 |
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 9.26:1 |
| light | rgba(16, 185, 129, 0.1) | rgba(5, 150, 105, 0.4) | rgb(6, 95, 70) | 6.23:1 |
| light | rgba(100, 116, 139, 0.1) | rgba(100, 116, 139, 0.32) | rgb(38, 43, 51) | 11.19:1 |

### 6710 — Recordatorio de factura

Componente: **InvoiceReminderBell**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{`inline-flex items-center justify-center rounded-full border border-amber-300/35 bg-amber-400/10 text-amber-100 shadow-[0_0_12px_rgba(245,158,11,0.12)] transition-colors hover:border-amber-300/55 ${
        compact ? "size-4" : "size-7"
      }`}
```

Clases finales:

```tsx
{`inline-flex items-center justify-center admin-order-pill admin-order-tone-warning ${
        compact ? "size-4" : "size-7"
      }`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 13.13:1 |
| light | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 12.64:1 |

### 6729 — Recordatorio de preparar y despachar

Componente: **ShippingReminderBadge**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
{`inline-flex items-center justify-center rounded-full border border-[#77E6E2]/25 bg-[#77E6E2]/5 text-[#77E6E2] transition-colors hover:border-[#77E6E2]/40 ${
        compact ? "size-4" : "size-7"
      }`}
```

Clases finales:

```tsx
{`inline-flex items-center justify-center admin-order-pill admin-order-shipping-reminder ${
        compact ? "size-4" : "size-7"
      }`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(119, 230, 226, 0.05) | rgba(119, 230, 226, 0.25) | rgb(119, 230, 226) | 11.81:1 |
| light | rgba(119, 230, 226, 0.05) | rgba(119, 230, 226, 0.25) | rgb(119, 230, 226) | 11.26:1 |

### 8641 — Nuevo pedido, móvil

Componente: **AdminPedidos**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
"rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-1 text-9px font-black uppercase tracking-wide text-emerald-200"
```

Clases finales:

```tsx
"admin-order-pill admin-order-tone-success px-2 py-1 text-9px font-black uppercase tracking-wide"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 13.26:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 12.77:1 |

### 8648 — Reclamo pendiente, móvil

Componente: **AdminPedidos**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
"admin-order-pending-claim-badge rounded-full border border-red-400/80 bg-red-950/75 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-red-100 shadow-[0_0_14px_rgba(248,113,113,0.22)]"
```

Clases finales:

```tsx
"admin-order-pending-claim-badge admin-order-pill px-2 py-1 text-[10px] font-black uppercase tracking-wide shadow-[0_0_14px_rgba(248,113,113,0.22)]"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.72) | rgba(248, 113, 113, 0.76) | rgb(254, 226, 226) | 10.55:1 |
| light | rgba(127, 29, 29, 0.72) | rgba(248, 113, 113, 0.76) | rgb(254, 226, 226) | 10.37:1 |

### 8686 — Despacho, móvil

Componente: **AdminPedidos**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`admin-order-dispatch-badge inline-flex items-center gap-1 px-2 py-1 text-9px font-black uppercase tracking-wide ${dispatch.className}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 11.64:1 |
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 13.26:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 13.13:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 11.17:1 |
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 8.98:1 |
| dark | rgb(187, 247, 208) | rgb(134, 239, 172) | rgb(20, 83, 45) | 7.52:1 |
| light | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 11.25:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 12.77:1 |
| light | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 12.64:1 |
| light | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 10.75:1 |
| light | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 8.84:1 |

### 8734 — Nuevo pedido, escritorio

Componente: **AdminPedidos**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
"mt-1 inline-flex rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-9px font-black uppercase tracking-wide text-emerald-200"
```

Clases finales:

```tsx
"mt-1 inline-flex admin-order-pill admin-order-tone-success px-2 py-0.5 text-9px font-black uppercase tracking-wide"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 13.26:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 12.77:1 |

### 8738 — Reclamo pendiente, escritorio

Componente: **AdminPedidos**. Selector inicial: **sí**. Resultado: **corregido**.

Clases originales:

```tsx
"admin-order-pending-claim-badge mt-1 inline-flex rounded-full border border-red-400/80 bg-red-950/75 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-red-100 shadow-[0_0_14px_rgba(248,113,113,0.22)]"
```

Clases finales:

```tsx
"admin-order-pending-claim-badge mt-1 inline-flex admin-order-pill px-2 py-0.5 text-[9px] font-black uppercase tracking-wide shadow-[0_0_14px_rgba(248,113,113,0.22)]"
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.72) | rgba(248, 113, 113, 0.76) | rgb(254, 226, 226) | 10.55:1 |
| light | rgba(127, 29, 29, 0.72) | rgba(248, 113, 113, 0.76) | rgb(254, 226, 226) | 10.37:1 |

### 8767 — Despacho, escritorio

Componente: **AdminPedidos**. Selector inicial: **no**. Resultado: **seguro, sin cambios**.

Clases originales:

```tsx
{`admin-order-dispatch-badge inline-flex items-center gap-1 px-2.5 py-1 text-10px font-black uppercase tracking-wide ${dispatch.className}`}
```

| Tema | Fondo computado | Borde computado | Texto computado | Contraste |
|---|---|---|---|---|
| dark | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 11.64:1 |
| dark | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 13.26:1 |
| dark | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 13.13:1 |
| dark | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 11.17:1 |
| dark | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 8.98:1 |
| dark | rgb(187, 247, 208) | rgb(134, 239, 172) | rgb(20, 83, 45) | 7.52:1 |
| light | rgba(127, 29, 29, 0.34) | rgba(248, 113, 113, 0.56) | rgb(254, 202, 202) | 11.25:1 |
| light | rgba(6, 78, 59, 0.34) | rgba(52, 211, 153, 0.5) | rgb(187, 247, 208) | 12.77:1 |
| light | rgba(120, 53, 15, 0.32) | rgba(245, 158, 11, 0.54) | rgb(253, 230, 138) | 12.64:1 |
| light | rgba(30, 64, 175, 0.32) | rgba(96, 165, 250, 0.54) | rgb(191, 219, 254) | 10.75:1 |
| light | rgba(15, 23, 42, 0.42) | rgba(148, 163, 184, 0.32) | rgba(226, 232, 240, 0.76) | 8.84:1 |

## Expansiones originales de clases dinámicas

### Garantías

```tsx
function getWarrantyVisual(item: SupabasePedidoItem) {
  if (item.warranty_status === "voided") {
    return {
      label: "Garantía anulada",
      daysRemaining: null,
      className: "border-white/12 bg-white/5 text-white/48",
    }
  }

  if (!item.warranty_started_at || !item.warranty_expires_at) {
    return {
      label: "Pendiente de entrega",
      daysRemaining: null,
      className: "border-white/12 bg-white/5 text-white/58",
    }
  }

  const daysRemaining = getWarrantyDaysRemaining(item.warranty_expires_at)

  if (daysRemaining !== null && daysRemaining < 0) {
    return {
      label: "Garantía vencida",
      daysRemaining,
      className: "border-red-400/20 bg-red-400/8 text-red-200",
    }
  }

  if (daysRemaining !== null && daysRemaining <= 30) {
    return {
      label: "Próxima a vencer",
      daysRemaining,
      className: "border-amber-300/25 bg-amber-400/10 text-amber-100",
    }
  }

  return {
    label: "Garantía activa",
    daysRemaining,
    className: "border-emerald-400/20 bg-emerald-400/8 text-emerald-200",
  }
}

```

### Historial

```tsx
  const typeStyles = {
    success: {
      Icon: Check,
      dotClass: "border-emerald-300/28 bg-emerald-400/8 text-emerald-100",
      connectorClass: "bg-emerald-300/12",
    },
    pending: {
      Icon: Clock3,
      dotClass: "border-amber-300/24 bg-amber-400/8 text-amber-100",
      connectorClass: "bg-amber-300/12",
    },
    neutral: {
      Icon: Clock3,
      dotClass: "border-white/18 bg-white/5 text-white/58",
      connectorClass: "bg-white/10",
    },
    danger: {
      Icon: X,
      dotClass: ADMIN_SENSITIVE_DANGER.icon,
      connectorClass: "bg-[#9f3546]/28",
    },
    info: {
      Icon: Info,
      dotClass: "border-sky-300/20 bg-sky-400/7 text-sky-100",
      connectorClass: "bg-sky-300/10",
    },
```

### Contador y progreso

```tsx
      className={`admin-order-eye-attention-badge absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-9px font-black leading-none ${
        urgent
          ? "border-red-300/60 bg-red-500 text-white shadow-[0_0_8px_rgba(239,68,68,0.55)]"
          : "border-amber-200/60 bg-amber-400 text-[#3a2504] shadow-[0_0_8px_rgba(245,158,11,0.5)]"
      }`}
```

### Tonos de puntos

```tsx
const PAYMENT_STATUS_OPTIONS: Array<{
  value: PaymentStatusValue
  label: string
  tone: string
  dot: string
}> = [
  {
    value: "pendiente_comprobante",
    label: "Pendiente",
    tone: "text-white/82",
    dot: "bg-amber-300/70",
  },
  {
    value: "en_revision",
    label: "En revisión",
    tone: "text-white/82",
    dot: "bg-blue-300/70",
  },
  {
    value: "confirmado",
    label: "Confirmado",
    tone: "text-white/82",
    dot: "bg-emerald-300/70",
  },
  {
    value: "rechazado",
    label: "Comprobante rechazado",
    tone: "text-white/82",
    dot: "bg-red-300/70",
  },
  {
    // Sólo aparece como estado ACTUAL (nunca es un destino elegible: no se
    // llega acá desde el dropdown, lo fija el backend cuando Mercado Pago
    // aprueba la transferencia pero el stock ya no alcanza -- ver
    // getAllowedAdminTransferPaymentStatuses).
    value: "auto_verified_stock_conflict",
    label: "Verificada · Conflicto de stock",
    tone: "text-white/82",
    dot: "bg-red-300/70",
  },
]

```

### Notificación de pestañas

```tsx
const ORDER_SECTION_NOTIFICATION_DOT_STYLES: Record<
  OrderSectionNotificationType,
  string
> = {
  new: "bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.68)]",
  warning: "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.62)]",
  success: "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.58)]",
  info: "bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.58)]",
  danger: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.68)]",
}

```

El icono danger del historial usaba ADMIN_SENSITIVE_DANGER.icon: border-[#9f3546]/65 bg-[#2a1117] text-[#ffc2c8]. Las cinco ramas actuales usan admin-order-tone-success/warning/muted/danger/info; las garantías usan muted/muted/danger/warning/success.

## Tests y checks

Pendiente de anexar resultados finales de ejecución.
