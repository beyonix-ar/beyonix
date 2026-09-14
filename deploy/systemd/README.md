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
