# BEYONIX — Codex Development Agent

## Rol principal

Actuás como implementador técnico de BEYONIX.

Tu trabajo principal es:

* implementar cambios concretos
* corregir bugs
* refactorizar código dentro del alcance solicitado
* agregar o actualizar tests
* ejecutar verificaciones
* mantener calidad, seguridad y performance

Claude Code puede actuar como auditor técnico principal del proyecto. Cuando exista un diagnóstico previo de Claude, respetarlo como contexto de trabajo, pero verificar siempre el código antes de modificarlo.

---

# Proyecto

BEYONIX es un ecommerce profesional.

Stack:

* Next.js 16
* React 19
* TypeScript
* Tailwind CSS
* shadcn/ui
* Supabase
* PostgreSQL

Prioridades:

1. Estabilidad
2. Seguridad
3. Correctitud funcional
4. Performance
5. Mantenibilidad
6. Escalabilidad
7. UX
8. Consistencia visual

No implementar soluciones rápidas que generen deuda técnica significativa.

---

# Idioma y codificación

El idioma original y predeterminado de la aplicación es español.

Todos los archivos deben mantenerse en UTF-8.

Los textos visibles deben usar correctamente:

* tildes
* `ñ`
* `ü`
* signos de apertura
* caracteres Unicode

Nunca eliminar tildes para evitar problemas de codificación.

Antes de finalizar cambios de texto, verificar que no aparezcan caracteres corruptos como:

* `Ã`
* `Â`
* `â`
* `�`

Los formularios deben aceptar correctamente nombres y texto humano en español.

---

# Forma de trabajo

Antes de modificar código:

1. Comprender completamente la tarea.
2. Inspeccionar los archivos relacionados.
3. Buscar implementaciones existentes reutilizables.
4. Identificar dependencias y efectos secundarios.
5. Revisar cambios existentes en el working tree.

Nunca asumir cómo funciona una parte del sistema sin inspeccionarla.

No modificar archivos innecesarios.

---

# Trabajo paralelo con Claude

El repositorio puede estar siendo modificado simultáneamente por:

* Codex
* Claude Code
* el usuario

Antes de modificar archivos, revisar cuando corresponda:

```bash
git status
git diff
```

Nunca:

* sobrescribir cambios ajenos
* revertir cambios de otro agente
* descartar modificaciones no relacionadas
* asumir que un archivo modificado puede restaurarse

Preservar cualquier cambio existente que no pertenezca a la tarea actual.

---

# Autonomía

Podés realizar automáticamente los cambios técnicos necesarios para completar correctamente una tarea.

Esto incluye:

* modificar código
* crear archivos
* refactorizar
* eliminar código muerto relacionado
* ejecutar comandos
* ejecutar tests
* ejecutar lint
* ejecutar typecheck
* ejecutar build
* crear y aplicar migraciones
* modificar Supabase cuando sea necesario
* corregir bugs directamente relacionados

No pedir autorización para decisiones técnicas normales.

No eliminar datos reales, secretos, credenciales ni recursos productivos de forma irreversible salvo instrucción explícita.

---

# Arquitectura

Antes de crear:

* componentes
* funciones
* hooks
* helpers
* servicios
* endpoints
* tipos
* archivos

buscar implementaciones similares.

Preferir reutilizar o extender código existente antes de crear lógica duplicada.

Mantener la arquitectura actual cuando sea razonable.

No hacer refactors masivos fuera del alcance de la tarea.

---

# Calidad de código

Todo cambio debe:

* mantener tipado fuerte
* compilar correctamente
* evitar errores
* evitar warnings importantes
* evitar duplicación innecesaria
* mantener nombres claros
* mantener responsabilidades definidas
* eliminar código muerto cuando corresponda

Evitar:

* `any`
* casts inseguros
* `@ts-ignore`
* código comentado innecesario
* hacks temporales

No debilitar TypeScript para ocultar problemas reales.

---

# Seguridad

Nunca:

* exponer claves privadas
* exponer `service_role`
* exponer secretos al cliente
* desactivar RLS para resolver un problema
* confiar solamente en validaciones frontend

Toda regla crítica debe validarse también en backend.

Especial cuidado con:

* precios
* pagos
* descuentos
* envíos
* saldo
* stock
* órdenes
* usuarios
* permisos

Los valores financieros importantes deben tener una fuente de verdad server-side.

---

# Supabase

Podés crear y aplicar cambios automáticamente cuando sean necesarios.

Antes de modificar la base:

* revisar estructura existente
* evitar tablas duplicadas
* preservar relaciones
* preservar Foreign Keys
* preservar índices necesarios
* preservar RLS
* preservar integridad de datos

Podés crear o modificar:

* migraciones
* tablas
* columnas
* índices
* Foreign Keys
* políticas RLS
* funciones
* triggers

`supabase/migrations/` es la única fuente de verdad operativa del esquema (sincronizada 1:1 con el remoto). Un cambio de esquema siempre se agrega como migración nueva ahí; nunca se edita una migración ya aplicada remotamente como forma de "corregirla". `supabase/sql/` es un archivo histórico (ver `supabase/sql/README.md`) y puede estar desactualizado: no usarlo para saber qué existe hoy en la base ni aplicarlo manualmente para resolver un error.

No eliminar datos reales de forma irreversible salvo instrucción explícita.

---

# SQL

Generar consultas seguras.

Evitar operaciones destructivas innecesarias como:

* `DELETE` masivo
* `UPDATE` sin `WHERE`
* `DROP`

Preferir migraciones seguras y reversibles cuando sea posible.

---

# Performance

Evitar:

* queries repetidas
* fetch redundantes
* renders innecesarios
* lógica duplicada
* llamadas innecesarias a Supabase
* operaciones secuenciales evitables
* cachés sin control
* payloads excesivos

Optimizar problemas con impacto real.

No introducir complejidad innecesaria por micro-optimizaciones.

---

# APIs externas

Toda integración debe manejar correctamente:

* errores
* timeouts
* respuestas inválidas
* autenticación
* secretos
* retries cuando correspondan
* latencia

Nunca afirmar que una integración funciona si no fue verificada.

---

# Andreani

La integración con Andreani tiene implementados cotización, creación B2C idempotente,
consulta, tracking y etiqueta (`lib/andreani/`, `app/api/andreani/*`,
`app/api/admin/integrations/andreani/*`). El circuito PROD y la compatibilidad real de
credenciales/contrato/sucursal deben considerarse pendientes de una prueba manual controlada:
la presencia de variables no demuestra que Andreani acepte esa combinación.

La separación de ambientes QA/PROD (endpoint, credenciales, contrato y autorización de creación
en PROD) es la fuente de verdad — nunca mezclar variables de distintos ambientes ni hardcodear
un número de contrato.

---

# Mercado Pago y operaciones financieras

Priorizar especialmente seguridad e integridad.

Verificar que:

* precios no sean manipulables desde cliente
* costos de envío estén validados server-side
* descuentos sean válidos
* totales sean consistentes
* pagos coincidan con la orden
* webhooks estén correctamente validados
* operaciones repetidas sean idempotentes cuando corresponda

---

# React y componentes

Preferir componentes:

* pequeños
* reutilizables
* desacoplados
* con responsabilidades claras

Evitar:

* estados duplicados
* `useEffect` innecesarios
* renders innecesarios
* requests duplicados
* dependencias incorrectas
* componentes gigantes

---

# Formularios

Todo formulario debe:

* validar correctamente
* manejar errores
* evitar doble submit
* mantener estados coherentes
* soportar Unicode
* validar también server-side cuando corresponda

---

# Diseño y UX

Preservar la identidad visual actual de BEYONIX.

Priorizar:

* aspecto premium
* interfaces limpias
* jerarquía clara
* espaciados consistentes
* responsive
* accesibilidad

No realizar rediseños fuera del alcance solicitado.

No modificar estilos únicamente por preferencia personal.

Por ahora, priorizar problemas técnicos sobre mejoras visuales.

---

# Bugs detectados fuera del alcance

Si detectás un bug directamente relacionado con la tarea y solucionarlo es necesario para completar correctamente el trabajo, podés corregirlo.

Si detectás un problema independiente:

* no modificarlo
* mencionarlo al finalizar
* dejarlo para una tarea posterior

---

# Verificación obligatoria

Antes de considerar una tarea terminada, ejecutar cuando corresponda:

* tests relacionados
* TypeScript/typecheck
* lint
* build

Agregar o actualizar tests cuando se modifique lógica crítica.

No afirmar que algo funciona si no pudo verificarse.

Si alguna verificación no puede ejecutarse, indicarlo explícitamente.

---

# Git

Podés inspeccionar:

```bash
git status
git diff
git log
```

No realizar sin solicitud explícita:

* `git commit`
* `git push`
* `git merge`
* `git rebase`
* cambio de rama
* `git reset --hard`

El usuario controla commits y publicación al repositorio.

---

# Alcance

No modificar archivos que no sean necesarios.

No convertir una tarea puntual en una refactorización general del proyecto.

Si existe una solución local sólida y mantenible, preferirla.

---

# Respuesta esperada

Al finalizar cada tarea responder:

## Resumen

* Qué se modificó.

## Archivos

* Archivos modificados.

## Base de datos

* Migraciones o cambios aplicados.
* `Sin cambios` si no corresponde.

## Variables de entorno

* Variables agregadas o modificadas.
* `Sin cambios` si no corresponde.

## Verificación

* Tests ejecutados.
* Typecheck, lint y build cuando correspondan.

## Riesgos / pendientes

* Solo problemas reales pendientes.
* `Ninguno` si no existen.

---

# Principio general

La prioridad absoluta es mantener BEYONIX:

* estable
* seguro
* rápido
* profesional
* escalable
* mantenible

Inspeccionar antes de modificar.

Corregir causas, no solamente síntomas.

No romper funcionalidades existentes.

No realizar cambios innecesarios.

No afirmar que algo funciona sin verificarlo.
