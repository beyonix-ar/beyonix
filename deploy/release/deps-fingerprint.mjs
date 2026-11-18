// Huella de integridad de un node_modules por CONTENIDO (PC, Node). Uso: node deps-fingerprint.mjs <dir>
// Recorre el árbol sin seguir enlaces y arma un manifiesto ordenado:
//   d <ruta>                                  directorio
//   f <ruta> <tamaño> <ejecutable> <sha256>   archivo normal (contenido completo)
//   l <ruta> <destino> <estado>               enlace simbólico / junction (destino literal + si resuelve dentro)
// Imprime SÓLO al final, si todo se pudo leer: "<sha256 del manifiesto> archivos=N enlaces=N bytes=N".
// Cualquier duda (archivo ilegible, tipo especial, enlace hacia afuera, archivo que cambia mientras se
// lee) => sin salida por stdout y código != 0: quien llama debe tratarlo como integridad no comprobada.
import { createHash } from "node:crypto"
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { join, resolve, sep } from "node:path"

const fail = (msg) => { process.stderr.write(`huella: ${msg}\n`); process.exit(3) }
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => fail(`interrumpido (${s})`))

const arg = process.argv[2]
if (!arg) fail("falta el directorio")
const root = resolve(arg)
let rootReal
try {
  if (!lstatSync(root).isDirectory()) fail("la raíz no es un directorio real")
  rootReal = realpathSync.native(root)
} catch (e) { fail(`raíz ilegible: ${e.code || e.message}`) }

const inside = (p) => p === rootReal || p.startsWith(rootReal + sep)
const buf = Buffer.allocUnsafe(1 << 20)
const manifest = createHash("sha256")
let files = 0, links = 0, bytes = 0

function hashFile(abs, st) {
  const fd = openSync(abs, "r")
  try {
    const before = fstatSync(fd)
    if (before.size !== st.size || before.mtimeMs !== st.mtimeMs) fail(`cambió mientras se leía: ${abs}`)
    const h = createHash("sha256")
    let total = 0, n
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); total += n }
    const after = fstatSync(fd)
    if (total !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) fail(`cambió mientras se leía: ${abs}`)
    return h.digest("hex")
  } finally { closeSync(fd) }
}

const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const stack = [""]
try {
  while (stack.length) {
    const rel = stack.pop()
    const dir = rel ? join(root, rel) : root
    const names = readdirSync(dir).sort(compare)
    const subdirs = []
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name
      const abs = join(dir, name)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs)
        let state
        try { state = inside(realpathSync.native(abs)) ? "interno" : null } catch { state = "colgante" }
        if (state === null) fail(`enlace hacia fuera del directorio verificado: ${r}`)
        manifest.update(`l\t${r}\t${target}\t${state}\n`)
        links++
      } else if (st.isDirectory()) {
        manifest.update(`d\t${r}\n`)
        subdirs.push(r)
      } else if (st.isFile()) {
        manifest.update(`f\t${r}\t${st.size}\t${st.mode & 0o111 ? "x" : "-"}\t${hashFile(abs, st)}\n`)
        files++; bytes += st.size
      } else {
        fail(`tipo de archivo no soportado: ${r}`)
      }
    }
    // Orden determinista: cada directorio se procesa completo antes que sus hijos, en orden de nombre.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i])
  }
} catch (e) { fail(`lectura fallida: ${e.code || e.message}`) }

process.stdout.write(`${manifest.digest("hex")} archivos=${files} enlaces=${links} bytes=${bytes}\n`)
