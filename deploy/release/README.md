# Despliegue de BEYONIX

Actualiza producción (VPS DonWeb, PM2 `beyonix`) con el commit de `main` ya publicado en GitHub.
Se compila en la PC (el VPS no tiene memoria para `next build`), se arma una **release nueva**
en `~/apps/beyonix-releases/`, se verifica en paralelo a la tienda y recién entonces se activa
moviendo el enlace `~/apps/beyonix-current` y reiniciando PM2 (corte de menos de 4 s).

## Uso

Desde PowerShell, en la carpeta del repositorio:

```powershell
.\deploy-beyonix.ps1                 # actualización (validación estándar: ESLint + TypeScript, sin npm test)
.\deploy-beyonix.ps1 -SoloPreparar   # todo menos activar: prepara y verifica la versión nueva
.\deploy-beyonix.ps1 -Estado         # versión activa y resultado del último cambio (sólo lectura)
.\deploy-beyonix.ps1 -Limpiar -Simular   # qué releases viejas se borrarían (no borra nada)
.\deploy-beyonix.ps1 -Limpiar            # borra releases viejas con la política segura
.\deploy-beyonix.ps1 -Rollback       # vuelve a la versión anterior al último despliegue
.\deploy-beyonix.ps1 -ValidacionCompleta                # además ejecuta npm test completo (siempre)
.\deploy-beyonix.ps1 -SoloPreparar -ValidacionCompleta
```

Antes de ejecutar: los cambios tienen que estar commiteados en `main` y pusheados (`git push`).
El deploy normal **no ejecuta `npm test`**: valida con ESLint y TypeScript y siempre compila con
`next build`. Para correr además la suite completa (~21 min en esta PC, varios GB de RAM: conviene
cerrar otros programas pesados) usar `-ValidacionCompleta`. Si ese mismo commit ya fue aprobado (por
ejemplo, `-SoloPreparar` y después el despliegue), las validaciones estándar se reutilizan. Al terminar,
la consola indica qué validación se hizo (`Validación: estándar ... (npm test NO ejecutado)` o
`completa ... + npm test`), y el resumen de tiempos muestra `Tests  NO ejecutados` cuando corresponde. **No cierres la ventana durante
"Actualizando BEYONIX"** (si igual se corta, el VPS termina solo la activación o la reversión).

| Mensaje | Significado |
|---|---|
| Preparando actualización. | Controles previos (Git, VPS, variables públicas, migraciones). |
| Compilando. | lint, typecheck (y `npm test` sólo con `-ValidacionCompleta`) y `next build` en un directorio limpio. |
| Transfiriendo. | Copia del build al VPS por SSH. |
| Verificando. | Arma la release nueva y la prueba en `127.0.0.1:3001` sin tocar la tienda. |
| Actualizando BEYONIX. | Activa la versión nueva y la verifica. |
| Actualización completada. | Listo. |
| Error: se conservó la versión anterior. | Se detuvo antes de tocar la tienda. |
| Error: se recuperó la versión anterior. | La versión nueva falló y se volvió sola a la anterior. |
| ALERTA CRÍTICA … | Ni la versión nueva ni la anterior responden: revisar el VPS YA (`pm2 list`, `pm2 logs beyonix`). |
| Error: se perdió la conexión … | El VPS sigue solo; consultar el resultado con `-Estado`. |

Al terminar (o al detenerse) muestra el **tiempo de cada etapa**: Git, VPS, variables, migraciones,
ESLint, TypeScript, tests, entorno, dependencias, `next build`, empaquetado, transferencia, cada paso
del VPS, activación y verificación. Las mismas mediciones quedan en el log como `tiempo <etapa>=<ms>`.

Cada ejecución deja un log en `Documentos\BEYONIX-backups\deploy-logs\` (credenciales
enmascaradas) y otro en el VPS en `~/apps/beyonix-releases/.deploy-logs/`.

## Qué controla antes de tocar nada

- Rama `main`, sin cambios sin commit, commit local igual a `origin/main`. Un solo despliegue a la
  vez por PC.
- BEYONIX online, usando el sistema de releases, sin otro cambio de versión en curso, con disco
  (≥ 4 GB) y memoria suficientes. Si el commit ya está activo, avisa y termina.
- `NEXT_PUBLIC_*` del `.env.local` local idénticas a las de producción (por hash).
- **Migraciones** (sólo lectura): consulta `supabase db query --agent no -o json` y exige un array
  JSON válido. Si la respuesta no tiene ese formato, si el commit trae migraciones que producción no
  tiene, o si producción tiene migraciones que el commit no conoce, se detiene. **Nunca aplica
  migraciones**: aplicarlas manualmente (con backup) y volver a ejecutar.
- lint y typecheck; con `-ValidacionCompleta`, además la suite completa (`npm test`, máx. 90 min). Si se pasa del tiempo, se termina
  **todo el árbol de procesos** de los tests (cierre normal → forzado, incluidos huérfanos) sin
  tocar procesos ajenos, y el despliegue se detiene.

### Reutilización de validaciones (aprobación por commit)

Hay dos niveles, con archivos separados en `Documentos\BEYONIX-backups\deploy-approvals\`:
- `<sha>.estandar.aprobacion`: pasaron lint y typecheck (npm test **no** se ejecutó);
- `<sha>.completa.aprobacion`: pasaron lint, typecheck y `npm test`.

Cada uno guarda la identidad de lo validado:
- SHA y árbol del commit, y su `package-lock`;
- dependencias instaladas en el repo: `node_modules/.package-lock.json` y la **huella por contenido**
  de todo `node_modules` (sha256 de cada archivo, enlaces y sus destinos, directorios);
- versiones de node y npm, y la plataforma;
- hash del `.env.local` (nunca su contenido);
- `NODE_OPTIONS`, `NODE_ENV`, `TZ` y `CI`;
- el nivel y la lista exacta de validaciones ejecutadas.

Una línea `control=` (sha256 del resto) detecta ediciones o archivos truncados.

Se reutiliza **sólo** si el archivo está íntegro, dice `resultado=aprobado` y coincide TODA la
identidad. Ante cualquier diferencia o duda se vuelve a validar, y el log dice qué cambió.
- Deploy normal: reutiliza una aprobación completa o estándar válida; si no hay, ejecuta la estándar.
  Nunca informa tests aprobados si sólo se reutilizó o ejecutó la estándar.
- `-ValidacionCompleta`: ejecuta siempre lint, typecheck y `npm test` (no reutiliza) y guarda la completa.
  Si el commit ya está activo en producción, sólo valida y termina: no compila, no transfiere ni activa.
- Una aprobación estándar nunca se acepta como completa (archivo, nivel y validaciones distintos).
- Antes de validar (en cualquier nivel) se borran **las dos** aprobaciones del commit: ambas dependen de
  lint y typecheck, así que un fallo o una interrupción no deja ninguna reutilizable.
- Al terminar se guarda sólo lo que esa ejecución demostró, si la identidad (incluido el contenido de
  `node_modules`) no cambió mientras tanto: estándar si pasaron lint y typecheck (también cuando en la
  completa fallaron o se cortaron sólo los tests); completa sólo si además pasó `npm test`.
- Si la integridad de `node_modules` no se puede comprobar (archivo ilegible, enlace hacia fuera de
  `node_modules`, cálculo interrumpido), la identidad queda indeterminada y se vuelve a validar.
- La reutilización queda registrada en el log.

Siempre se ejecutan: `next build`, migraciones, variables, humo en el VPS y los controles de activación.

### Entorno de compilación

`next build` corre en `Documentos\BEYONIX-backups\build-env\work`. Es exclusivo de los despliegues:
tiene su propio bloqueo, y uno abandonado por un cierre forzado se recupera. En cada compilación:

1. Se borra todo menos `node_modules` (y su `.cache`): no quedan fuentes, `.next` ni `.env.local` previos.
2. Se extrae el árbol exacto del commit (`git archive`).
3. Dependencias: se reutilizan si `deps.stamp` coincide con el `package-lock` y el `package.json`
   **del commit** (npm ci exige que coincidan y ejecuta sus scripts de instalación), node, npm y
   plataforma, y la huella por contenido de `node_modules` es idéntica a la registrada al instalar
   (`deps-fingerprint.mjs`: sha256 de cada archivo, enlaces con su destino, directorios; detecta
   archivos modificados aunque conserven tamaño y fecha, agregados, borrados y enlaces cambiados).
   Si no coincide, el sello está incompleto o la integridad no se puede comprobar, se corre `npm ci`
   limpio desde ese lock (máx. 30 min). El sello se borra antes y se escribe sólo si termina bien y
   la huella se calculó completa. Costo medido de la verificación: ~9-15 s en caliente (37 mil
   archivos, 890 MB); más la primera vez tras reiniciar la PC.
4. `.env.local` se copia sólo durante el build y se borra siempre, también si se interrumpe. Se
   rechaza un `.next` que contenga archivos `.env`.
5. Se empaqueta `.next` con su manifest y se vuelve a limpiar el entorno.

El build ya no usa las dependencias del repo de trabajo. Para forzar una reinstalación, borrar
`build-env\deps.stamp`.

## Activación (todo bajo un bloqueo en el VPS)

1. Comprueba que la versión activa siga siendo la que vio al empezar (si otro desplegó, se detiene).
2. Respalda la configuración de PM2, mueve el enlace y ejecuta `pm2 restart`.
3. Exige salud (HTTP 200 con el BUILD_ID nuevo y PM2 online), 60 s de estabilidad (sin reinicios ni
   errores críticos en logs) y que el sitio público sirva la versión nueva.
4. Si `pm2 restart` falla o cualquier control falla: vuelve el enlace, recupera el servicio (si PM2
   perdió el proceso, lo recrea) y verifica la salud de la anterior. Si tampoco responde:
   **ALERTA CRÍTICA**; nunca informa éxito con PM2 caído.
5. Un fallo de `pm2 save` se informa aparte (la versión queda activa y sana).
6. Desde la PC se confirma el sitio público; si falla, rollback **sólo si la versión activa sigue
   siendo la desplegada** (nunca revierte tarde sobre el despliegue de otro).

Si se corta la conexión, el VPS completa (o revierte) solo y deja el resultado en
`~/apps/beyonix-releases/.last-switch`; la PC reintenta leerlo durante ~10 minutos.

Nunca: aplica migraciones, modifica variables de entorno, envía emails, toca datos, timers ni
backups. Las releases viejas se borran sólo con la política de limpieza (ver Mantenimiento).

## Rollback manual

```powershell
.\deploy-beyonix.ps1 -Rollback                                   # a la previa al último despliegue
.\deploy-beyonix.ps1 -Rollback -Version ac1fe04-20261116-132041  # a una release concreta
```

Sólo acepta releases **completas y verificadas**: `.release-info` válido, BUILD_ID coincidente,
código igual al commit registrado, dependencias (`next`, `sharp`), `.env.local` y todos los archivos
del build iguales a su manifest. Las releases creadas antes de este sistema se validan con el
manifest de su `incoming-*`. Si la versión destino no responde, vuelve a la que estaba.

El rollback es **sólo de código**: si entre las dos versiones se aplicó una migración que la
anterior no tolera, hay que evaluar el caso.

**Versión original del VPS** (`~/apps/beyonix`, 5313422, sin `.release-info`): no se acepta con
`-Rollback`. Se recupera con el mecanismo previo, que además devuelve PM2 a su directorio original:
`ssh … 'bash -s -- --restore-original-pm2' < Documentos\BEYONIX-backups\_tools\vps-release\release-rollback.sh`.
Ojo: ese código es anterior a migraciones ya aplicadas.

Sin la PC, desde el VPS:

```bash
tail -n 3 ~/apps/beyonix-releases/.deploy-history
ln -sfn /home/beyonix/apps/beyonix-releases/<release-anterior> ~/apps/beyonix-current.tmp \
  && mv -T ~/apps/beyonix-current.tmp ~/apps/beyonix-current && pm2 restart beyonix && pm2 save
```

## Mantenimiento: limpieza de releases viejas

Cada release ocupa ~1,1 GB (casi todo `node_modules` + `.next`). La limpieza es automática:

- **Después de un despliegue exitoso** (la versión nueva ya activa y verificada). Si falla, se avisa
  pero el despliegue sigue siendo exitoso.
- **Antes de compilar**, sólo si el VPS tiene menos de 4 GB libres. Después se vuelve a medir; si
  sigue sin alcanzar, el despliegue se detiene con un mensaje claro sin compilar ni transferir.
- **Manual:** `.\deploy-beyonix.ps1 -Limpiar -Simular` (muestra qué se borraría, no borra nada) y
  `.\deploy-beyonix.ps1 -Limpiar`.

Política (`remote-cleanup.sh`). **Se conservan siempre:**
1. la release activa (`readlink -f ~/apps/beyonix-current`; PM2 tiene que usar ese enlace);
2. la de rollback: el `prev=` de la última línea de `.deploy-history` que activó la actual (la misma
   que usa `-Rollback`);
3. las preparadas pendientes (`-SoloPreparar`): verificadas después de activar la actual; de cada
   commit, la más nueva;
4. un respaldo adicional: la release verificada más nueva de otro commit (que además pase la misma
   validación que exige `-Rollback`);
5. lo que se está preparando: directorios sin `.release-info` e `incoming-*` de menos de 6 h, y los
   `incoming-*` que guardan el manifest de una release conservada.

Se borra el resto de lo que tenga nombre de release (`<sha7>-<fecha>-<hora>`), `incoming-*` o
`.trash-*`, siempre que sea un directorio real (no un enlace) dentro de `beyonix-releases`.
**Nunca** se toca `~/apps/beyonix` (versión original y dueña del `.env.local`), `.env.local`,
backups, `~/rollback`, logs, `.deploy-history`, `.last-switch` ni archivos con otros nombres.

Seguridad:
- Se detiene sin borrar nada (tampoco en `-Simular`) si el estado no es confiable: sin enlace
  activo, la activa fuera de `beyonix-releases`, PM2 sin el proceso o con otro directorio, la activa
  sin registro en `.deploy-history`, o el rollback registrado (`prev=`) ausente, inválido (misma
  validación que exige `-Rollback`) o que no es la carpeta real registrada (p. ej. un enlace).
- Toma el bloqueo de cambios de versión y, en modo exclusivo, el de armado (`.prepare.lock`, que
  `remote-assemble.sh` toma compartido mientras arma). Si alguno está tomado: "ocupado", nada borrado.
- Cada eliminación primero renombra el directorio a `.trash-*` (atómico) y después lo borra; si se
  corta o falla, queda apartado (nunca una release a medias con su nombre) y la próxima limpieza
  lo termina de borrar. Antes de cada una se vuelve a comprobar que la activa no cambió.
- Registro: `~/apps/beyonix-releases/.cleanup-history` (cada directorio eliminado con su tamaño y
  motivo, y una línea por ejecución con lo liberado y el espacio libre antes/después) y el log de
  la ejecución en `.deploy-logs/<id>-cleanup.log`.

Lo que **no** es una release y también ocupa espacio (no se limpia automáticamente): `~/apps/beyonix`
(~1,4 GB, versión original; necesaria por el `.env.local` y como último recurso) y la caché de npm
`~/.npm` (~1,5 GB; se puede regenerar, pero acelera `npm ci` cuando cambia el `package-lock`).

## Pruebas de los scripts

```bash
bash deploy/release/tests/run-local-tests.sh       # PC: argumentos, migraciones, timeout, bloqueo, red, entorno, aprobaciones, espacio
bash deploy/release/tests/run-cleanup-tests.sh     # PC o Linux: política de limpieza, bloqueos, fallos (sandbox en /tmp)
# VPS, en un sandbox aislado de /tmp (pm2 y curl falsos; no toca la tienda ni el PM2 real):
tar -C deploy/release -c remote-lib.sh remote-switch.sh remote-rollback.sh remote-status.sh remote-assemble.sh tests/run-vps-sandbox-tests.sh \
  | ssh -i ~/.ssh/beyonix_donweb_trabajo -o IdentitiesOnly=yes -p 5799 beyonix@168.181.186.203 \
    'd=$(mktemp -d /tmp/beyonix-deploy-src.XXXXXX) && tar -x -C "$d" && bash "$d/tests/run-vps-sandbox-tests.sh" "$d"; case "$d" in /tmp/beyonix-deploy-src.*) rm -rf -- "$d";; esac'
```

## Archivos

| Archivo | Dónde corre | Qué hace |
|---|---|---|
| `deploy-beyonix.ps1` | PC | Punto de entrada; llama a `deploy.sh` con Git Bash. |
| `deploy.sh` | PC | Orquesta los pasos, los controles y el log. |
| `lib.sh` | PC | Validación de argumentos, migraciones, timeout con árbol de procesos, espera ante cortes. |
| `kill-process-tree.ps1` | PC | Termina el árbol de procesos de los tests (sólo esa ejecución). |
| `local-build.sh` | PC | Compila el commit en el entorno persistente (dependencias reutilizadas o `npm ci`) y empaqueta `.next`. |
| `deps-fingerprint.mjs` | PC | Huella de integridad por contenido de `node_modules` (entorno de compilación y aprobaciones). |
| `remote-lib.sh` | VPS | Base común: PM2, salud, enlace, bloqueo, validación de releases. |
| `remote-status.sh` | VPS | Estado de producción (sólo lectura). |
| `remote-assemble.sh` | VPS | Arma la release nueva (npm ci con memoria limitada) y la prueba en el 3001. |
| `remote-switch.sh` | VPS | Activa la release bajo bloqueo; rollback automático si algo falla. |
| `remote-rollback.sh` | VPS | Vuelve a una versión ya compilada y verificada. |
| `remote-cleanup.sh` | VPS | Borra releases viejas con la política de retención (simulable). |

Los scripts del VPS se envían por SSH en cada ejecución (con `remote-lib.sh` delante): no se
instala nada en el servidor.
