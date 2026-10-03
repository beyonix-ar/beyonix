# Cron de conciliación de transferencias (VPS DonWeb / systemd)

## Hallazgo de la auditoría original

BEYONIX no corre en Vercel: producción es una VPS DonWeb (`~/apps/beyonix`, proceso
PM2 `beyonix`, `npm start`). El repo **no contiene** ningún archivo `.service`/`.timer`,
script de deploy, ni documentación de un cron real ya funcionando. Lo único que existe
en el código es `app/api/cron/reconcile-mercadopago-refunds/route.ts`, cuyo propio
comentario dice: *"Todavía sin programar (ni Vercel cron ni systemd timer) a
propósito"*. Si ese cron ya corre hoy en la VPS, esa configuración vive **fuera de
este repositorio** -- no la encontré, no la inventé.

## Hallazgo de esta auditoría (corregido en esta misma tarea)

La primera versión de `beyonix-verify-transfer-orders.service` pasaba el secreto así:

```
ExecStart=/usr/bin/curl -H "Authorization: Bearer ${CRON_SECRET}" ...
```

`systemd` expande `${CRON_SECRET}` **antes** de ejecutar `curl`: el valor real queda
en el argv del proceso mientras corre, visible por `ps aux` o `/proc/<pid>/cmdline`
para cualquier usuario del sistema con permiso de lectura sobre ese proceso. Se
corrigió: el secreto ahora vive **exclusivamente** en un archivo de configuración de
curl fuera del repo, con permisos `600`, que curl lee internamente vía `--config`
-- nunca aparece en argv, nunca en journalctl, nunca en git.

## Archivos preparados en este commit (no instalados, no ejecutados)

- `deploy/systemd/beyonix-verify-transfer-orders.service`
- `deploy/systemd/beyonix-verify-transfer-orders.timer`

Ninguno de los dos contiene el secreto ni ninguna otra credencial.

## Requisito previo en la VPS: archivo de configuración de curl

Crear (una sola vez, manualmente, **nunca commiteado**)
`/etc/beyonix/curl-verify-transfer-orders.conf` con el **mismo** `CRON_SECRET` que ya
usa el proceso PM2 de la app:

```bash
sudo install -d -m 700 -o root -g root /etc/beyonix
sudo tee /etc/beyonix/curl-verify-transfer-orders.conf > /dev/null <<'EOF'
header = "Authorization: Bearer REEMPLAZAR_CON_EL_CRON_SECRET_REAL"
EOF
sudo chmod 600 /etc/beyonix/curl-verify-transfer-orders.conf
sudo chown root:root /etc/beyonix/curl-verify-transfer-orders.conf
```

Reemplazá `REEMPLAZAR_CON_EL_CRON_SECRET_REAL` por el valor real de `CRON_SECRET` del
entorno de producción de la app (el mismo que usa PM2, no uno nuevo). El comando de
arriba nunca queda en el historial de la shell con el secreto real si lo editás con
`sudoedit` en vez de pegarlo en la terminal; cualquiera de las dos formas es válida,
`sudoedit` es simplemente más prolija.

## Por qué este mecanismo y no variables de entorno en el `.service`

`EnvironmentFile=` + `${VAR}` dentro de `ExecStart=` sigue el mismo problema: aunque
el archivo de entorno esté protegido, `systemd` igual expande la variable en el
argv del proceso hijo antes de ejecutarlo. El archivo de configuración de curl
(`--config`) es la alternativa estándar documentada por curl para este caso
exacto: el valor sensible se queda dentro del proceso `curl`, nunca en su línea de
comandos.

## Comandos para instalar el timer (ejecutar vos en la VPS, después de aprobar)

```bash
sudo cp deploy/systemd/beyonix-verify-transfer-orders.service /etc/systemd/system/
sudo cp deploy/systemd/beyonix-verify-transfer-orders.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beyonix-verify-transfer-orders.timer
```

## Verificación posterior

Estado del timer y próxima corrida programada:

```bash
systemctl list-timers | grep beyonix-verify-transfer-orders
sudo systemctl status beyonix-verify-transfer-orders.timer
```

Resultado SUCCESS/FAILURE de la última corrida (sin secretos: el cuerpo de la
respuesta se descarta con `-o /dev/null`, y `--silent` evita el progress meter de
curl; sólo se ve el resultado y, si falló, el mensaje corto de `--show-error`):

```bash
sudo systemctl status beyonix-verify-transfer-orders.service
journalctl -u beyonix-verify-transfer-orders.service -n 50 --no-pager
```

## Confirmar que el secreto NO es visible en el proceso en ejecución

Mientras el servicio está corriendo (podés lanzarlo manualmente en otra terminal
con el comando de la sección siguiente y correr esto en paralelo):

```bash
ps -eo pid,cmd | grep -i curl
cat /proc/$(pgrep -f 'curl.*verify-transfer-orders')/cmdline | tr '\0' ' '; echo
```

Ambos comandos deben mostrar únicamente:
`curl --fail --silent --show-error --max-time 120 --config /etc/beyonix/curl-verify-transfer-orders.conf -o /dev/null http://127.0.0.1:3000/api/cron/verify-transfer-orders`
-- sin ningún rastro del valor de `CRON_SECRET`.

## Una corrida manual de prueba (sin esperar al timer)

```bash
sudo systemctl start beyonix-verify-transfer-orders.service
journalctl -u beyonix-verify-transfer-orders.service -n 20 --no-pager
```

## Comportamiento ante ejecuciones solapadas / caídas

- **Ejecuciones simultáneas del mismo `.service`**: systemd no permite dos
  instancias concurrentes de una misma unidad no templada -- un `start` sobre una
  unidad ya `activating` se fusiona con el job existente, nunca lanza un segundo
  proceso.
- **La corrida anterior sigue activa cuando el timer vuelve a disparar** (lote
  grande, Mercado Pago lento): `OnUnitActiveSec=15min` se cuenta desde que el
  servicio se activó la última vez, no desde que terminó -- si una corrida tarda
  más de 15 minutos, el próximo disparo podría intentar arrancar mientras la
  anterior sigue viva. Por eso `ExecStart=` usa `flock -n` sobre
  `/run/lock/beyonix-verify-transfer-orders.lock`: si el lock ya está tomado, esa
  corrida se cancela de inmediato (queda como "failed" en journalctl, sin
  reintento agresivo) en vez de superponerse. La próxima corrida útil llega con el
  siguiente tick.
- **VPS apagada durante el horario de una corrida**: `Persistent=true` hace que,
  al reiniciar, se ejecute una única corrida de recuperación (no una por cada
  intervalo perdido) y luego el timer sigue su cadencia normal.
- **Reintentos**: `curl` no usa `--retry` -- una falla (401, 500, timeout) no
  reintenta agresivamente; el siguiente tick del timer (~15 min) es el único
  reintento. La app misma también reintenta de forma acotada por pedido
  (`transfer_verification_attempts`, ver la migración).

## Por qué loopback y no el dominio público

El endpoint corre en el mismo proceso Next.js (`npm start` vía PM2) escuchando en
`127.0.0.1:3000`. Usar `http://127.0.0.1:3000/...` evita depender de DNS, TLS, el
reverse proxy público y cualquier firewall/WAF externo para una llamada que de
todos modos sólo debe originarse desde la propia VPS. El secreto sigue siendo
obligatorio (header `Authorization: Bearer`) aunque el tráfico sea local: la app no
distingue loopback de tráfico externo, así que sin el header sigue respondiendo 401
(`GET`, el único método que expone `/api/cron/verify-transfer-orders`).

## Nada de esto se ejecutó

Esta tarea sólo dejó los archivos preparados y los comandos documentados. No se
instaló ningún timer, no se conectó a la VPS, no se llamó al endpoint contra
producción.

---

# Sincronización de cuotas sin interés de Mercado Pago (systemd)

`/api/cron/sync-mercadopago-installments` consulta a Mercado Pago (sin caché) desde
qué total confirma 2, 3 y 6 cuotas sin interés y guarda la referencia que usa la
comunicación pública ("Hasta N cuotas sin interés a partir de $X") y Admin →
Financiación. La comunicación pública se apaga sola si la última sincronización
exitosa tiene más de 2 horas o si el último intento falló, así que **sin este timer
la tienda deja de comunicar la promoción** ~2 h después del último "Comprobar ahora"
manual. El checkout no depende de esto: consulta a Mercado Pago en vivo y la
preferencia revalida fresco.

Es el **único** scheduler de esta tarea: no hay cron de Vercel (producción no corre
en Vercel; la entrada se quitó de `vercel.json`).

Archivos (no instalados, no ejecutados):

- `deploy/systemd/beyonix-sync-mercadopago-installments.service`
- `deploy/systemd/beyonix-sync-mercadopago-installments.timer` (cada ~15 min,
  `Persistent=true`)

Reutiliza el **mismo** archivo de curl con el secreto
(`/etc/beyonix/curl-verify-transfer-orders.conf`). Si todavía no existe, crearlo
primero con el comando de la sección "Requisito previo en la VPS" de arriba.

## Instalación (ejecutar en la VPS, desde `~/apps/beyonix`, después del deploy del código)

```bash
sudo cp deploy/systemd/beyonix-sync-mercadopago-installments.service /etc/systemd/system/
sudo cp deploy/systemd/beyonix-sync-mercadopago-installments.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beyonix-sync-mercadopago-installments.timer
```

## Verificación

```bash
# Primera corrida manual (no espera al timer)
sudo systemctl start beyonix-sync-mercadopago-installments.service
sudo systemctl status beyonix-sync-mercadopago-installments.service --no-pager
journalctl -u beyonix-sync-mercadopago-installments.service -n 20 --no-pager

# Próxima corrida programada
systemctl list-timers | grep beyonix-sync-mercadopago-installments
```

Después, en Admin → Financiación el estado "Sincronización MP" debe mostrar la hora
de esa corrida. Un servicio en `failed` con `curl: (22) ... 502` significa que
Mercado Pago no respondió de forma confiable (Admin muestra el motivo resumido);
`401` significa que el secreto del archivo de curl no coincide con `CRON_SECRET`
de PM2.

---

# Eventos comerciales programados (systemd)

`/api/cron/run-commercial-events` ejecuta los eventos de Admin → Eventos que
vencieron: primero restaura los que terminan (precios exactos del snapshot o la
política de financiación anterior) y después aplica los que empiezan ("Cambio
programado de precios" y "Financiación promocional").

Antes de este timer los eventos sólo se activaban a mano: **no existía ningún
scheduler de eventos** (ni Vercel cron ni systemd), así que este es el único.

- Cada minuto, al segundo 0 (`OnCalendar=*-*-* *:*:00`): un evento de las 03:00
  hora Argentina se ejecuta a las 03:00 (los instantes se guardan en UTC).
- Cada fase es una transacción SQL idempotente: si el timer corre dos veces o la
  VPS se reinicia en medio, no se duplica nada.
- Un evento que falla queda en **Error** en Admin con el motivo y **no se
  reintenta solo**: se reintenta desde Admin → Eventos (reintento seguro).
- Requiere aplicar antes la migración
  `supabase/migrations/20261002100000_scheduled_commercial_events.sql`.

Archivos (no instalados, no ejecutados):

- `deploy/systemd/beyonix-run-commercial-events.service`
- `deploy/systemd/beyonix-run-commercial-events.timer`

Reutiliza el mismo archivo de curl con el secreto
(`/etc/beyonix/curl-verify-transfer-orders.conf`).

## Instalación (en la VPS, desde `~/apps/beyonix`, después del deploy y de la migración)

```bash
sudo cp deploy/systemd/beyonix-run-commercial-events.service /etc/systemd/system/
sudo cp deploy/systemd/beyonix-run-commercial-events.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beyonix-run-commercial-events.timer
```

## Verificación

```bash
sudo systemctl start beyonix-run-commercial-events.service
journalctl -u beyonix-run-commercial-events.service -n 20 --no-pager
systemctl list-timers | grep beyonix-run-commercial-events
```

`502` en journalctl = algún evento quedó en Error (ver Admin → Eventos).

---

# Facturación automática ARCA (preparada, todavía apagada)

El scheduler de ARCA en producción es `beyonix-arca-invoices.timer` (cada 10 minutos);
su entrada se retiró de `vercel.json`. El servicio usa loopback, `flock -n`, timeout
y el archivo privado de curl `/etc/beyonix/curl-verify-transfer-orders.conf` descrito
arriba. El secreto no va en argumentos ni en estos archivos del repositorio.

**Orden de activación, después de aprobar el despliegue:**

1. Aplicar `20261003120000_arca_auto_invoicing_activation.sql` mediante el flujo de
   migraciones del proyecto. La tabla nace con `enabled=false`; no cambia pedidos
   existentes ni emite comprobantes.
2. Con `ARCA_AUTO_INVOICING_ENABLED=false`, emitir **una** Factura C real desde Admin
   → Facturación. Comprobar CAE y PDF, y verificarla en ARCA.
3. Instalar los archivos `beyonix-arca-invoices.service` y `.timer` en
   `/etc/systemd/system/`, ejecutar `sudo systemctl daemon-reload` y
   `sudo systemctl enable --now beyonix-arca-invoices.timer`. El servicio corre
   como root para leer el archivo curl privado (600, root:root), con directorio `/`.
   El flag del servidor sigue apagado, por lo que el timer no toma pedidos.

   ```bash
   sudo test -r /etc/beyonix/curl-verify-transfer-orders.conf
   sudo cp deploy/systemd/beyonix-arca-invoices.service /etc/systemd/system/
   sudo cp deploy/systemd/beyonix-arca-invoices.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now beyonix-arca-invoices.timer
   systemctl list-timers | grep beyonix-arca-invoices
   ```
4. Poner `ARCA_AUTO_INVOICING_ENABLED=true` en el entorno de PM2 y reiniciar la app.
   El runner todavía queda bloqueado por el control persistente apagado.
5. En Admin → Facturación, revisar la advertencia y activar. La base guarda la
   hora exacta de activación. Solo se tomarán pedidos con `invoice_queued_at`
   **posterior** a esa hora; el backlog anterior permanece manual.

Al desactivar desde Admin, las nuevas tomas se detienen. Una reactivación crea un
cutoff nuevo; no recupera automáticamente pedidos del período apagado. El control
requiere una Factura C de producción emitida manualmente antes de permitir activar.

Para comprobar el timer sin emitir: primero verificar que el control Admin y el
flag de PM2 siguen apagados; luego consultar `systemctl list-timers | grep
beyonix-arca-invoices` y `journalctl -u beyonix-arca-invoices.service`.
