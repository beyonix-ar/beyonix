# Despliegue de BEYONIX

Actualiza producción (VPS DonWeb, PM2 `beyonix`) con el commit de `main` ya publicado en GitHub.
Se compila en la PC (el VPS no tiene memoria para `next build`), se arma una **release nueva**
en `~/apps/beyonix-releases/`, se verifica en paralelo a la tienda y recién entonces se activa
moviendo el enlace `~/apps/beyonix-current` y reiniciando PM2 (corte de menos de 4 s).

## Uso

Desde PowerShell, en la carpeta del repositorio:

```powershell
.\deploy-beyonix.ps1                 # actualización completa
.\deploy-beyonix.ps1 -SoloPreparar   # todo menos activar: prepara y verifica la versión nueva
.\deploy-beyonix.ps1 -Estado         # versión activa y resultado del último cambio (sólo lectura)
.\deploy-beyonix.ps1 -Rollback       # vuelve a la versión anterior al último despliegue
.\deploy-beyonix.ps1 -ValidacionCompleta                # repite lint/typecheck/tests aunque el commit ya esté aprobado
.\deploy-beyonix.ps1 -SoloPreparar -ValidacionCompleta
```

Antes de ejecutar: los cambios tienen que estar commiteados en `main` y pusheados (`git push`).
La primera vez que se prepara un commit corre la suite completa (~21 min en esta PC, varios GB de
RAM: conviene cerrar otros programas pesados). Si ese mismo commit ya fue aprobado (por ejemplo,
`-SoloPreparar` y después el despliegue), las validaciones se reutilizan. **No cierres la ventana durante
"Actualizando BEYONIX"** (si igual se corta, el VPS termina solo la activación o la reversión).

| Mensaje | Significado |
|---|---|
| Preparando actualización. | Controles previos (Git, VPS, variables públicas, migraciones). |
| Compilando. | lint, typecheck, `npm test` y `next build` en un directorio limpio. |
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
- lint, typecheck y la suite completa (`npm test`, máx. 90 min). Si se pasa del tiempo, se termina
  **todo el árbol de procesos** de los tests (cierre normal → forzado, incluidos huérfanos) sin
  tocar procesos ajenos, y el despliegue se detiene.

### Reutilización de validaciones (aprobación por commit)

Si lint, typecheck y tests pasan, se guarda `Documentos\BEYONIX-backups\deploy-approvals\<sha>.aprobacion`
con la identidad de lo validado:
- SHA y árbol del commit, y su `package-lock`;
- dependencias instaladas en el repo: `node_modules/.package-lock.json` y la **huella por contenido**
  de todo `node_modules` (sha256 de cada archivo, enlaces y sus destinos, directorios);
- versiones de node y npm, y la plataforma;
- hash del `.env.local` (nunca su contenido);
- `NODE_OPTIONS`, `NODE_ENV`, `TZ` y `CI`;
- la lista de validaciones exigidas.

Una línea `control=` (sha256 del resto) detecta ediciones o archivos truncados.

Se reutiliza **sólo** si el archivo está íntegro, dice `resultado=aprobado` y coincide TODA la
identidad. Ante cualquier diferencia o duda se valida completo, y el log dice qué cambió.
- Antes de validar se borra la aprobación del commit.
- Se escribe sólo si las tres pasan y la identidad (incluido el contenido de `node_modules`) no cambió
  mientras tanto, así que una validación fallida o interrumpida, o dependencias alteradas durante la
  validación, nunca dejan aprobación.
- Si la integridad de `node_modules` no se puede comprobar (archivo ilegible, enlace hacia fuera de
  `node_modules`, cálculo interrumpido), la identidad queda indeterminada y se valida completo.
- `-ValidacionCompleta` ignora la aprobación existente.
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
backups, ni borra releases anteriores.

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

## Mantenimiento

Cada release ocupa ~1,1 GB y no se borra sola. Cuando el control de disco lo pida, borrar
manualmente releases viejas de `~/apps/beyonix-releases/` (nunca la activa ni la anterior:
`readlink ~/apps/beyonix-current` y la última línea de `.deploy-history`) y sus `incoming-*`.

## Pruebas de los scripts

```bash
bash deploy/release/tests/run-local-tests.sh       # PC: argumentos, migraciones, timeout, bloqueo, red, entorno, aprobaciones
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

Los scripts del VPS se envían por SSH en cada ejecución (con `remote-lib.sh` delante): no se
instala nada en el servidor.
