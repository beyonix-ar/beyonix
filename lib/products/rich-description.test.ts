import assert from "node:assert/strict"
import test from "node:test"

import {
  parseRichDescription,
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
    '<p><span class="rt-size-lg">grande</span> <span class="rt-size-sm">chico</span> <span class="rt-size-xl">xl</span></p>',
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

test("bloques anidados se aplanan sin perder texto", () => {
  assert.equal(
    sanitizeRichDescription("<div><p>uno</p><ul><li>a</li><li>b</li></ul></div>"),
    "<p>uno</p><p>a</p><p>b</p>",
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
