# Resolución financiera (Etapa 5)

La API `GET /api/admin/orders/:id/financial-resolution` devuelve `financialOptions`,
`amount`, `status`, `requiresReturn` y, si existe, la resolución persistida.
Sólo `admin` y `super_admin` pueden acceder. Ninguna opción ejecuta dinero al
consultarla.

`POST` requiere siempre `confirmed: true` y una de estas acciones:

- `resolve` con `choice: beyonix_credit | mercadopago_refund | manual_refund`.
- `retry` para la única actualización pendiente; consulta el estado fiscal o
  externo antes de continuar.
- `complete_manual` después de que el administrador hizo la transferencia.
  `reference` y `observation` son opcionales. Puede enviarse un comprobante
  opcional mediante `multipart/form-data` (`file`, JPG/PNG/PDF, hasta 5 MB).

Etapa 6 (wizard del Admin) consume la misma API. `GET` agrega `mode`
(`wizard | resolution | advanced | none`), `product`, `reception`,
`receptionOptions` (las opciones que se habilitan al recibir el producto) y
`notice`. `resolve` acepta `receptionExceptionReason` (10+ caracteres): registra
la excepción existente `register_claim_financial_exception` del reclamo activo,
con Admin y motivo auditados, y recién después ejecuta la resolución. `advanced`
deja el caso en el flujo anterior.

Secuencia: validar opciones → reservar una intención única por pedido → tomar
un lease de ejecución → emitir o reutilizar la NC si corresponde → completar
stock y saldo mediante el postproceso fiscal existente → ejecutar el resultado
elegido → auditar y notificar. Una NC con CAE no se revierte si falla un paso
posterior. `retry` finaliza esa misma NC; nunca emite otra a ciegas. Un refund
MP incierto se concilia antes de cualquier otro POST a MP. El saldo usa una
clave de movimiento única. El reintegro manual se registra en una RPC atómica.

La tanda cerrada (`prepared_at`) es el primer corte: no se ofrece refund MP ni
acreditación automática. Sólo puede quedar una gestión manual controlada.
La entrega física (`andreani_handed_over_at`) corta toda resolución hasta que
correspondan devolución, recepción e inspección. Los guardas DB/RPC son la
protección definitiva aunque la vista o Realtime estén desactualizados.

**Límite MP:** el servicio actual sólo reembolsa el componente completo
capturado por MP, con importe máximo de $40.000, pago remoto verificado y
confirmación explícita del administrador; las cuotas no omiten esa confirmación.
Para una NC parcial autorizada, la API no ofrece refund MP total: ofrece
reintegro manual por exactamente el importe externo autorizado y pendiente.
Las NC parciales nuevas que todavía requieren seleccionar artículos y evaluar
recepción quedan para la interfaz guiada posterior; este orquestador sólo emite
automáticamente una NC de cancelación total con reclamo aprobado. No hay
refund parcial MP implementado.
