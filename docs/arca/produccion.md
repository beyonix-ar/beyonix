# ARCA — paso a producción real

Estado del código: **fail-closed**. Sin una configuración ARCA explícita y
coherente no se autentica contra WSAA, no se llama a WSFE y no se emite nada.
El guard único es `requireArcaConfiguration()` (`lib/arca/configuration.ts`) y
lo atraviesan la emisión manual, el worker automático, las notas de crédito,
las conciliaciones y el diagnóstico.

## Qué valida el guard

| Chequeo | Error si… |
|---|---|
| `ARCA_ENV` | falta, está vacía o no es exactamente `homologation` / `production` |
| Emisor del certificado | no es `CN=Computadores` (producción) ni `CN=Computadores Test` (homologación) |
| Ambiente vs. certificado | `production` con certificado de homologación, o `homologation` con el certificado fiscal |
| Vigencia | el certificado venció o todavía no es válido |
| CUIT | el `serialNumber=CUIT …` del certificado no coincide con `ARCA_CUIT` (11 dígitos) |
| Clave privada | no se puede leer (formato/passphrase) o no es el par del certificado |
| `ARCA_PTO_VTA` | no es un entero mayor que cero |

Los mensajes nunca incluyen PEM, claves, passphrase ni el CUIT.

## Día de la configuración real (VPS, `~/apps/beyonix`)

### En ARCA (con clave fiscal del CUIT emisor)

1. Generar clave privada + CSR **nuevos** para producción (no reutilizar la
   clave de homologación). El CSR con `CN=BEYONIX` y
   `serialNumber=CUIT <CUIT>`.
2. "Administración de Certificados Digitales" (producción): alta del
   computador fiscal y descarga del certificado. Verificar que el emisor sea
   `Computadores` (no `Computadores Test`).
3. "Administrador de Relaciones de Clave Fiscal": asociar ese computador
   fiscal al servicio **Facturación Electrónica (wsfe)**.
4. "Administración de puntos de venta y domicilios": confirmar o crear un
   punto de venta para **Web Services** (Factura Electrónica – Monotributo –
   Web Services). Un punto usado para "Comprobantes en línea" no sirve para
   Web Services. Anotar su número.

### En el VPS

1. Editar `.env.local` (permisos 600):
   - `ARCA_ENV=production`
   - `ARCA_CERT` y `ARCA_PRIVATE_KEY` de producción (y
     `ARCA_PRIVATE_KEY_PASSPHRASE` sólo si la clave está cifrada)
   - `ARCA_CUIT` = CUIT del certificado
   - `ARCA_PTO_VTA` = punto de venta de Web Services del paso 4
   - `ARCA_AUTO_INVOICING_ENABLED` sin definir o `false`
2. `pm2 restart beyonix`.
3. Admin → Facturación: el panel debe mostrar **Ambiente: Producción**,
   el punto de venta, **Certificado: Producción · vence …** y
   **Facturación automática: Inactiva**. Si dice "Configuración inválida",
   el panel lista los motivos y el botón de emitir queda bloqueado.
4. Botón **"Verificar conexión con ARCA (sin emitir)"**
   (`POST /api/admin/arca/diagnostics`). Ejecuta, en orden y sin pedir CAE:
   configuración → FEDummy → WSAA → FEParamGetPtosVenta →
   FECompUltimoAutorizado (Factura C y NC C). Resultado esperado:
   "Listo para emitir la primera Factura C fiscal (manual)" y el número de la
   próxima Factura C.
5. Antes del deploy del código, aplicar la migración
   `20261003120000_arca_auto_invoicing_activation.sql` con `npx supabase db push`.
   Nace apagada y no toca pedidos históricos. Después del deploy, verificar de
   nuevo el diagnóstico PROD.
6. Emitir **una** Factura C manual real desde Admin → Facturación (o el detalle
   del pedido). Comprobar CAE y PDF, y verificarla en ARCA (QR y consulta de
   comprobantes emitidos). Instalar el timer systemd de `deploy/systemd/` mientras
   el flag sigue apagado. Luego configurar `ARCA_AUTO_INVOICING_ENABLED=true` en
   el entorno del VPS y reiniciar PM2. El control persistente sigue apagado.
   Por último, activar desde Admin → Facturación. La base registra el instante
   de activación y sólo toma automáticamente pedidos encolados después de ese
   cutoff. No usar Vercel cron.

## Comprobantes de homologación existentes (NO remediados todavía)

Todo comprobante guardado antes del paso a producción es de homologación:
no tiene validez fiscal y la numeración (p. ej. 0001-00000076) no existe en
producción. La base hoy **impide** refacturarlos: `complete_arca_invoice`
rechaza un pedido que ya tiene CAE (`INVOICE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER`)
y la ruta de Admin responde "La orden ya está facturada".

### Cómo identificarlos (solo lectura)

```sql
select id, estado, payment_status, financial_status, usuario_id, total,
       invoice_status, invoice_point, invoice_number, invoice_cae,
       invoice_cae_due, invoice_created_at, invoice_arca_environment
from public.ordenes
where invoice_arca_environment = 'homologation'
order by id;

select id, order_id, status, total_amount, voucher_point, voucher_number,
       cae, cae_due, authorized_at, arca_environment
from public.order_credit_notes
where arca_environment = 'homologation'
order by order_id, authorized_at;
```

Separar las ventas reales de los pedidos del arnés de pruebas
(`scripts/arca-homologation`: usuario y producto de prueba).

### Qué habría que hacer después (tarea aparte, con migración nueva)

1. Tabla de archivo de comprobantes de homologación + RPC `service_role`
   auditada que, **sólo** si `invoice_arca_environment = 'homologation'`,
   copie el comprobante al archivo, limpie `invoice_*` y vuelva a encolar el
   pedido (`invoice_status = 'pending'`) para facturarlo en producción.
2. Mismo tratamiento para las NC de homologación de esos pedidos, decidiendo
   caso por caso si el pedido requiere Factura C + NC C fiscales (p. ej. una
   venta cancelada o reintegrada después de la factura de prueba).
3. Revisar con el contador la fecha de emisión de las ventas antiguas: el
   comprobante fiscal se emite con la fecha del día de emisión.

### Qué preservar para auditoría

- Todas las columnas `invoice_*` del pedido (punto, número, tipo, CAE,
  vencimiento, fecha, número pedido, total pedido) y `invoice_arca_environment`.
- Las filas de `order_credit_notes` / `order_credit_note_items` de
  homologación con su CAE, número y fechas.
- Los eventos de `order_audit_events` (`arca_invoice_authorized`, NC) y los
  movimientos de saldo asociados a esas NC.
- Quién y cuándo archivó cada comprobante, y el motivo.

Nunca borrar esas filas: se archivan y se reemplazan por comprobantes fiscales.
