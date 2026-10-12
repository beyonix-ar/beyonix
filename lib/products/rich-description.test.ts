import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  normalizeProductDescriptionInput,
  parseRichDescription,
  RICH_TEXT_COLORS,
  RICH_DESCRIPTION_MAX_LENGTH,
  RichDescriptionInputError,
  richDescriptionToPlainText,
  sanitizeRichDescription,
} from "./rich-description.ts"

test("texto plano legacy: párrafos por línea en blanco y saltos simples", () => {
  assert.equal(
    sanitizeRichDescription("Encendedor recargable.\nIncluye cable USB.\n\nGarantía: 3 meses"),
    "<p>Encendedor recargable.<br>Incluye cable USB.</p><p>Garantía: 3 meses</p>",
  )
  assert.equal(sanitizeRichDescription("  "), "")
  assert.equal(sanitizeRichDescription(null), "")
})

test("texto plano con < y & se escapa, no se interpreta", () => {
  assert.equal(sanitizeRichDescription("Medida < 5 cm & liviano"), "<p>Medida &lt; 5 cm &amp; liviano</p>")
})

test("allowlist: título, subtítulo, negrita, cursiva, subrayado y tamaños", () => {
  const html = "<h2>Título</h2><h3>Sub</h3><p><b>B</b> <i>I</i> <u>U</u> <strong>S</strong> <em>E</em></p>"
  assert.equal(
    sanitizeRichDescription(html),
    "<h2>Título</h2><h3>Sub</h3><p><strong>B</strong> <em>I</em> <u>U</u> <strong>S</strong> <em>E</em></p>",
  )
  assert.equal(
    sanitizeRichDescription('<p><span class="rt-size-lg">grande</span> <font size="2">chico</font> <span style="font-size: x-large">xl</span></p>'),
    '<p><span class="rt-size-18">grande</span> <span class="rt-size-14">chico</span> <span class="rt-size-20">xl</span></p>',
  )
  // Un tamaño fuera de los niveles discretos no se conserva.
  assert.equal(sanitizeRichDescription('<p><span style="font-size: 93px">x</span></p>'), "<p>x</p>")
})

test("Enter = párrafo, Shift+Enter = <br> (salida del editor)", () => {
  assert.equal(
    sanitizeRichDescription("<p>uno<br>dos</p><p>tres</p><div>cuatro</div>"),
    "<p>uno<br>dos</p><p>tres</p><p>cuatro</p>",
  )
  assert.equal(sanitizeRichDescription("<p><br></p><p>   </p>"), "")
})

test("los párrafos vacíos entre bloques sobreviven al guardado y la recarga", () => {
  const html = "<h2>TÍTULO</h2><p><br></p><p>Párrafo</p><p><br></p><h3>CARACTERÍSTICAS</h3><p>✅ una<br>✅ dos</p>"
  assert.equal(sanitizeRichDescription(html), html)
  assert.equal(sanitizeRichDescription(sanitizeRichDescription(html)), html)
  assert.equal(sanitizeRichDescription("<p>Antes</p><p></p><p>Después</p>"), "<p>Antes</p><p><br></p><p>Después</p>")
  assert.equal(sanitizeRichDescription("<p><br>Antes<br></p>"), "<p><br>Antes<br></p>")
})

test("listas, alineación y tamaños permitidos sobreviven al guardado y recarga", async () => {
  const html = '<h2 class="rt-align-center"><span class="rt-size-32">Título</span></h2><p><br></p><p><span class="rt-size-16">Párrafo <strong>importante</strong></span></p><ul><li>Uno</li><li><em>Dos</em></li></ul><ol class="rt-align-right"><li>Tres</li></ol>'
  assert.equal(sanitizeRichDescription(html), html)
  assert.equal(sanitizeRichDescription('<p><span class="rt-size-173">x</span><span style="font-size:173px">y</span></p>'), "<p>xy</p>")
  const { PGlite } = await import("@electric-sql/pglite")
  const db = new PGlite()
  try {
    await db.exec("create table public.productos (id bigint primary key, descripcion text); create role anon; create role authenticated;")
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261009110000_product_description_guard.sql"), "utf8"))
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261010113000_product_description_editor_formats.sql"), "utf8"))
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261011120000_product_description_font_color_formats.sql"), "utf8"))
    await db.query("insert into productos values (1, $1)", [normalizeProductDescriptionInput(html)])
    const saved = (await db.query<{ descripcion: string }>("select descripcion from productos where id = 1")).rows[0].descripcion
    assert.equal(sanitizeRichDescription(saved), html)
  } finally {
    await db.close()
  }
})

test("fuentes y colores permitidos: HTML canónico estable, defaults sin color fijo", () => {
  const html = '<p>Montserrat <span class="rt-font-arial">Arial</span> <span class="rt-font-calibri">Calibri</span> <span class="rt-font-verdana">Verdana</span> <span class="rt-font-comic-sans">Comic</span></p>'
  assert.equal(sanitizeRichDescription(html), html)
  for (const { id, hex } of RICH_TEXT_COLORS) {
    const canonical = `<p><span class="rt-color-${id}">Texto</span></p>`
    assert.equal(sanitizeRichDescription(canonical), canonical)
    assert.equal(sanitizeRichDescription(`<p><font color="${hex}">Texto</font></p>`), canonical)
  }
  assert.equal(sanitizeRichDescription("<p>Automático</p>"), "<p>Automático</p>")
  assert.equal(sanitizeRichDescription('<p><font face="Montserrat" color="inherit">Automático</font></p>'), "<p>Automático</p>")
  assert.equal(sanitizeRichDescription('<p><span style="font-family: Papyrus; color: #123456">No permitido</span></p>'), "<p>No permitido</p>")
  assert.equal(sanitizeRichDescription('<p><span class="rt-font-script rt-color-purple" onclick="bad()">No permitido</span></p>'), "<p>No permitido</p>")
  assert.equal(sanitizeRichDescription('<p><font face="Comic Sans MS" color="rgb(239, 68, 68)">Rojo</font></p>'), '<p><span class="rt-color-red"><span class="rt-font-comic-sans">Rojo</span></span></p>')
})

test("base acepta fuentes/colores canónicos y rechaza clases o estilos no permitidos", async () => {
  const { PGlite } = await import("@electric-sql/pglite")
  const db = new PGlite()
  try {
    await db.exec("create table public.productos (id bigint primary key, descripcion text); create role anon; create role authenticated;")
    for (const name of ["20261009110000_product_description_guard.sql", "20261010113000_product_description_editor_formats.sql", "20261011120000_product_description_font_color_formats.sql"]) {
      await db.exec(readFileSync(join(process.cwd(), "supabase/migrations", name), "utf8"))
    }
    const valid = '<p><span class="rt-color-sky"><span class="rt-font-calibri">Color</span></span></p>'
    await db.query("insert into productos values (1, $1)", [valid])
    assert.equal((await db.query<{ descripcion: string }>("select descripcion from productos where id = 1")).rows[0].descripcion, valid)
    for (const invalid of ['<p><span class="rt-color-purple">x</span></p>', '<p><span style="color:red">x</span></p>', '<p><span class="rt-font-papyrus">x</span></p>']) {
      await assert.rejects(db.query("insert into productos values (2, $1)", [invalid]), /PRODUCT_DESCRIPTION_UNSAFE/)
    }
  } finally { await db.close() }
})

test("XSS: script, iframe, style, on*, javascript: y atributos se eliminan", () => {
  const attacks = [
    "<script>alert(1)</script><p>ok</p>",
    "<p onclick=\"alert(1)\">ok</p>",
    "<p>ok<img src=x onerror=alert(1)></p>",
    "<iframe src=\"javascript:alert(1)\"></iframe><p>ok</p>",
    "<style>p{color:red}</style><p>ok</p>",
    "<p><a href=\"javascript:alert(1)\">ok</a></p>",
    "<p><svg onload=alert(1)><circle/></svg>ok</p>",
    "<p style=\"background:url(javascript:alert(1))\">ok</p>",
    "<SCRIPT>alert(1)</SCRIPT ><p>ok</p>",
    "<p>ok</p><script>document.write('<p>x</p>')</script>",
    "<p>ok<!-- <script>alert(1)</script> --></p>",
  ]
  for (const attack of attacks) {
    const clean = sanitizeRichDescription(attack)
    assert.equal(clean, "<p>ok</p>", attack)
    assert.doesNotMatch(clean, /script|onerror|onclick|onload|javascript:|iframe|style|<a|<img|<svg/i, attack)
  }
})

test("entidades: se decodifican y se vuelven a escapar", () => {
  assert.equal(sanitizeRichDescription("<p>&lt;script&gt;alert(1)&lt;/script&gt; &aacute;&ntilde;</p>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt; áñ</p>")
  assert.equal(sanitizeRichDescription('<p class="x" data-a="1">texto</p>'), "<p>texto</p>")
})

test("bloques anidados conservan listas sin perder texto", () => {
  assert.equal(
    sanitizeRichDescription("<div><p>uno</p><ul><li>a</li><li>b</li></ul></div>"),
    "<p>uno</p><ul><li>a</li><li>b</li></ul>",
  )
  assert.equal(sanitizeRichDescription("<h1>Grande</h1><h4>Chico</h4>"), "<h2>Grande</h2><h3>Chico</h3>")
})

test("idempotente: sanear dos veces da lo mismo", () => {
  const once = sanitizeRichDescription("<h2>A</h2><p><b>x</b><br>y <span class=\"rt-size-sm\">z</span></p>")
  assert.equal(sanitizeRichDescription(once), once)
})

test("texto plano para activación y metadatos", () => {
  assert.equal(richDescriptionToPlainText("<h2>Título</h2><p>uno<br>dos</p>"), "Título\n\nuno\ndos")
  assert.equal(richDescriptionToPlainText("<p><br></p>"), "")
  assert.deepEqual(parseRichDescription("Hola"), [{ type: "p", children: [{ type: "text", text: "Hola" }] }])
})

test("XSS: vectores adicionales nunca producen marcado ejecutable", () => {
  const attacks = [
    "<p>ok</p><object data=\"x.swf\"></object>",
    "<p>ok</p><embed src=\"x.swf\">",
    "<p>ok<img src=\"data:image/svg+xml;base64,PHN2Zz4=\" onerror=alert(1)></p>",
    "<p><a href=\"data:text/html,<script>alert(1)</script>\">ok</a></p>",
    "<p/onclick=alert(1)>ok</p>",
    "<p><strong onmouseover=\"alert(1)\">ok</strong></p>",
    "<p><span class=\"rt-size-lg\" onclick=\"alert(1)\" style=\"color:red\">ok</span></p>",
    "<p>ok<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math></p>",
    "<p>ok</p><form action=\"javascript:alert(1)\"><button>x</button></form>",
    "<p>ok<video><source onerror=\"alert(1)\"></video></p>",
    "<p>ok</p><iframe srcdoc=\"<script>alert(1)</script>\">",
    "<p>ok</p><template><script>alert(1)</script></template>",
    "<p>ok<!--",
    "<p>ok</p><![CDATA[<script>alert(1)</script>]]>",
    "<p>ok</p><style>@import 'javascript:alert(1)'",
  ]
  for (const attack of attacks) {
    const clean = sanitizeRichDescription(attack)
    assert.match(clean, /^<p>(<strong>|<span class="rt-size-18">)?ok(<\/strong>|<\/span>)?<\/p>$/, attack)
    assert.doesNotMatch(clean, /on[a-z]+=|javascript:|data:|<script|<iframe|<object|<embed|<img|<svg|<math|<form|style=/i, attack)
  }
  // Etiqueta partida: el resto queda como texto escapado, nunca como etiqueta.
  assert.equal(sanitizeRichDescription("<p><scr<script>ipt>alert(1)</script>ok</p>"), "<p>ipt&gt;alert(1)ok</p>")
  // HTML malformado y etiquetas anidadas sin cerrar: texto conservado, sin marcado extra.
  assert.equal(sanitizeRichDescription("<p><b><i>uno</b> dos</i></p><p>tres"), "<p><strong><em>uno</em></strong> dos</p><p>tres</p>")
  assert.equal(sanitizeRichDescription("<p>a < b > c</p>"), "<p>a &lt; b &gt; c</p>")
  assert.equal(sanitizeRichDescription("<<p>>x"), "<p>&lt;</p><p>&gt;x</p>")
})

test("pegado desde Word: conserva sólo tipografía permitida y descarta otros estilos", () => {
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>p.MsoNormal{margin:0}</style></head>
<body><!--StartFragment--><p class="MsoNormal" style="margin:0cm;font-family:Calibri"><b><span style="font-size:14.0pt;color:#C00000" lang="ES-AR">Garantía</span></b><o:p></o:p></p>
<p class="MsoNormal"><span style="font-family:Arial;mso-bidi-font-weight:bold" data-x="1">Incluye <i>cable</i> y <u>caja</u>.</span><o:p>&nbsp;</o:p></p><!--EndFragment--></body></html>`
  assert.equal(sanitizeRichDescription(word), '<p><strong>Garantía</strong></p><p><span class="rt-font-arial">Incluye <em>cable</em> y <u>caja</u>.</span> </p>')
})

test("pegado desde Google Docs: el <b> envolvente de Docs no pone todo en negrita", () => {
  const docs = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr" style="line-height:1.38;margin-top:0pt"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;font-style:normal;">Batería</span><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;font-style:italic;"> de litio</span><span style="font-weight:400;text-decoration:underline;"> recargable</span></p></b>`
  assert.match(sanitizeRichDescription(docs), /rt-font-arial/)
  assert.match(sanitizeRichDescription(docs), /rt-color-black/)
  assert.doesNotMatch(sanitizeRichDescription(docs), /style=|font-weight|line-height/)
})

test("pegado desde web: links, imágenes, colores y data-* desaparecen; el texto queda", () => {
  const web = `<div class="product" data-id="9"><h1 style="color:red">Encendedor <a href="https://x.example/?utm=1" target="_blank">USB</a></h1><p><font color="red" face="Comic Sans">Ñandú</font> <img src="x.png" alt="foto"></p></div>`
  assert.equal(sanitizeRichDescription(web), "<h2>Encendedor USB</h2><p>Ñandú </p>")
})

test("idempotencia: la salida del sanitizer es estable para cualquier entrada", () => {
  const inputs = [
    "Texto plano\ncon salto\n\nY párrafo ¿sí? ¡Sí! ü",
    "<p><b><i>uno</b> dos</i></p>",
    "<b style=\"font-weight:normal\"><span style=\"font-weight:700\">x</span></b>",
    "<p><span class=\"rt-size-xl\"><strong>grande</strong></span><br><br>fin</p>",
    "<p>a < b & c > d \"comillas\"</p>",
  ]
  for (const input of inputs) {
    const once = sanitizeRichDescription(input)
    assert.equal(sanitizeRichDescription(once), once, input)
  }
})

test("entrada server-side: tipos inválidos y textos desmedidos se rechazan; vacío → null", () => {
  assert.equal(normalizeProductDescriptionInput(undefined), null)
  assert.equal(normalizeProductDescriptionInput(null), null)
  assert.equal(normalizeProductDescriptionInput("   "), null)
  assert.equal(normalizeProductDescriptionInput("<p><br></p>"), null)
  assert.equal(normalizeProductDescriptionInput("Hola"), "<p>Hola</p>")
  assert.equal(normalizeProductDescriptionInput("<script>x</script><h2>Hola</h2>"), "<h2>Hola</h2>")
  for (const invalid of [12, true, { html: "<p>x</p>" }, ["<p>x</p>"]]) {
    assert.throws(() => normalizeProductDescriptionInput(invalid), RichDescriptionInputError)
  }
  assert.throws(() => normalizeProductDescriptionInput("x".repeat(RICH_DESCRIPTION_MAX_LENGTH + 1)), RichDescriptionInputError)
})

test("guard en base: acepta exactamente la forma canónica del sanitizer y rechaza el resto", async () => {
  const { PGlite } = await import("@electric-sql/pglite")
  const db = new PGlite()
  try {
    await db.exec("create table public.productos (id bigint primary key, descripcion text); create role anon; create role authenticated;")
    // Un producto legacy con texto no canónico existe antes de la guarda.
    await db.exec("insert into productos values (1, 'Legacy a > b')")
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261009110000_product_description_guard.sql"), "utf8"))
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261010113000_product_description_editor_formats.sql"), "utf8"))
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261011120000_product_description_font_color_formats.sql"), "utf8"))
    const samples = [
      "Texto plano < 5 cm & más",
      "<h1>T</h1><p><b>x</b> <i>y</i> <u>z</u><br><font size=5>grande</font></p>",
      "<script>alert(1)</script><p onclick=x>ok</p>",
      "<b style=\"font-weight:normal\"><span style=\"font-weight:700\">Docs</span></b>",
    ]
    let id = 10
    for (const sample of samples) {
      await db.query("insert into productos values ($1, $2)", [++id, sanitizeRichDescription(sample) || null])
    }
    for (const raw of ["<p onclick=\"x\">ok</p>", "<img src=x>", "<script>x</script>", "<span style=\"color:red\">x</span>", "<a href=\"javascript:x\">x</a>", "a > b"]) {
      await assert.rejects(db.query("insert into productos values ($1, $2)", [++id, raw]), /PRODUCT_DESCRIPTION_UNSAFE/, raw)
      await assert.rejects(db.query("update productos set descripcion = $1 where id = 11", [raw]), /PRODUCT_DESCRIPTION_UNSAFE/, raw)
    }
    // Legacy sin tocar: otras columnas se pueden actualizar.
    await db.exec("alter table productos add column nombre text; update productos set nombre = 'x' where id = 1")
    assert.equal((await db.query<{ d: string }>("select descripcion d from productos where id = 1")).rows[0].d, "Legacy a > b")
  } finally {
    await db.close()
  }
})
