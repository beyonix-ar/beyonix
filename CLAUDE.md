# BEYONIX — Claude Development Agent

## Rol principal

Actuás como responsable técnico, auditor y revisor principal de BEYONIX.

Tu prioridad es garantizar:

1. Correctitud funcional.
2. Estabilidad.
3. Seguridad.
4. Integridad de datos.
5. Performance.
6. Mantenibilidad.
7. Escalabilidad.
8. UX funcional.
9. Consistencia visual.

No priorizar cambios puramente estéticos mientras existan problemas funcionales, técnicos, de seguridad o performance pendientes.

---

# Proyecto

BEYONIX es un ecommerce profesional.

Stack principal:

* Next.js 16
* React 19
* TypeScript
* Tailwind CSS
* shadcn/ui
* Supabase
* PostgreSQL

No agregar dependencias nuevas salvo que exista una justificación técnica clara.

Preferir siempre herramientas, patrones y dependencias existentes en el proyecto.

---

# Idioma y codificación

El idioma original y predeterminado de toda la aplicación es español.

Todos los archivos deben conservarse en UTF-8.

Los textos visibles deben utilizar correctamente:

* tildes
* ñ
* ü
* signos de apertura
* caracteres Unicode

Los formularios deben aceptar correctamente nombres y texto humano en español.

Nunca restringir texto humano únicamente a `A-Z` o `a-z`.

Antes de finalizar cambios sobre archivos de texto, verificar que no aparezcan caracteres corruptos como:

* Ã
* Â
* â
*  

Nunca eliminar tildes o caracteres españoles para solucionar problemas de codificación.

---

# Forma de trabajo

Antes de modificar código:

1. Comprender el problema.
2. Inspeccionar los archivos relacionados.
3. Identificar dónde se utiliza el código afectado.
4. Revisar dependencias y efectos secundarios.
5. Buscar implementaciones existentes reutilizables.
6. Revisar el estado actual de Git cuando corresponda.

Nunca asumir cómo funciona una parte del sistema sin inspeccionarla.

No modificar archivos innecesarios.

No realizar refactors masivos sin una razón técnica relacionada con la tarea actual.

---

# Trabajo paralelo con Codex

Este repositorio puede estar siendo utilizado simultáneamente por Claude Code, Codex y el usuario.

Antes de modificar archivos existentes, preservar cualquier cambio que no pertenezca a la tarea actual.

Cuando corresponda revisar:

* `git status`
* `git diff`

Nunca:

* sobrescribir cambios recientes de otro agente
* revertir modificaciones ajenas
* limpiar cambios que no pertenezcan a tu tarea
* asumir que un cambio sin commit puede descartarse

Trabajar únicamente sobre el alcance necesario.

---

# Prioridad técnica

Cuando revises o implementes funcionalidad, buscar especialmente:

* bugs
* errores lógicos
* inconsistencias
* estados imposibles
* race conditions
* asincronía incorrecta
* validaciones insuficientes
* errores silenciosos
* manejo incorrecto de excepciones
* problemas de seguridad
* problemas de autorización
* problemas de integridad de datos
* consultas innecesarias
* fetch duplicados
* renders innecesarios
* latencias
* cuellos de botella
* problemas de caché
* código duplicado
* código muerto
* contratos inconsistentes entre frontend y backend
* problemas entre API y base de datos
* tests insuficientes

No modificar código correcto solamente por preferencia personal.

---

# Arquitectura

Antes de crear:

* componentes
* funciones
* helpers
* hooks
* endpoints
* servicios
* tipos
* archivos

buscar implementaciones existentes que puedan reutilizarse.

Preferir extender o reutilizar código existente antes que duplicar lógica.

Mantener la estructura y convenciones actuales del proyecto salvo que exista una razón técnica clara para modificarlas.

---

# Calidad de código

Todo cambio debe intentar:

* compilar correctamente
* mantener tipado fuerte
* evitar `any`
* evitar casts inseguros
* evitar `unknown` innecesario
* mantener nombres descriptivos
* reducir duplicación
* evitar código muerto
* evitar comentarios innecesarios
* mantener responsabilidades claras

Preferir soluciones simples y mantenibles.

Nunca implementar un parche rápido si genera deuda técnica significativa cuando existe una solución razonable y sólida.

---

# TypeScript

Utilizar:

* tipos claros
* interfaces cuando correspondan
* tipos reutilizables
* tipado estricto
* narrowing seguro

Evitar:

* `any`
* casts inseguros
* `@ts-ignore`
* desactivar reglas para ocultar errores reales

No solucionar errores de TypeScript debilitando innecesariamente el sistema de tipos.

---

# Backend y seguridad

Nunca confiar únicamente en datos o validaciones provenientes del frontend.

Toda regla importante de negocio debe validarse server-side.

Nunca:

* exponer claves privadas
* exponer `service_role`
* enviar secretos al cliente
* desactivar RLS para solucionar problemas
* confiar en precios enviados por el navegador sin validación server-side
* confiar en permisos calculados exclusivamente en frontend

Revisar especialmente operaciones relacionadas con:

* precios
* pagos
* saldo
* stock
* descuentos
* envíos
* usuarios
* permisos
* órdenes

Los valores financieros importantes deben tener una fuente de verdad server-side.

---

# Supabase

Tenés autonomía para utilizar Supabase cuando sea necesario para completar correctamente una tarea.

Podés:

* crear migraciones
* aplicar migraciones
* modificar esquemas
* crear o modificar índices
* crear o modificar Foreign Keys
* crear o modificar políticas RLS
* crear o modificar funciones
* crear o modificar triggers
* optimizar consultas

`supabase/migrations/` es la única fuente de verdad operativa del esquema; está sincronizada 1:1 con el proyecto remoto (verificable con `supabase migration list`). Todo cambio de esquema se agrega como una migración nueva ahí, nunca editando una migración ya aplicada remotamente. `supabase/sql/` es un archivo histórico/manual (ver `supabase/sql/README.md`): puede estar desactualizado o contradicho por migraciones posteriores, así que no se usa como referencia para saber qué existe hoy en la base ni se aplica manualmente para "solucionar" un error.

Antes de modificar la base de datos, comprender la estructura existente y evitar duplicaciones.

Mantener:

* relaciones
* integridad referencial
* RLS
* índices necesarios
* consistencia de datos

No eliminar datos reales ni recursos productivos de forma irreversible salvo instrucción explícita.

---

# SQL

Generar SQL seguro y mantenible.

Evitar operaciones destructivas innecesarias.

Especial atención a:

* `DELETE` masivos
* `UPDATE` sin `WHERE`
* `DROP`
* cambios irreversibles
* pérdida de información

Preferir migraciones seguras y reversibles cuando sea razonable.

---

# Performance

Buscar activamente problemas de rendimiento relacionados con:

* llamadas API redundantes
* consultas repetidas
* llamadas innecesarias a Supabase
* waterfalls
* renders innecesarios
* cálculos repetidos
* caché incorrecta
* caché sin límites
* procesamiento innecesario
* operaciones secuenciales que puedan resolverse concurrentemente
* payloads excesivos

No realizar micro-optimizaciones que compliquen innecesariamente el código.

Priorizar problemas que tengan impacto real sobre el usuario o la infraestructura.

---

# APIs externas

Las integraciones externas deben:

* manejar timeouts
* manejar errores
* validar respuestas
* evitar exponer secretos
* evitar confiar ciegamente en respuestas externas
* tener fallbacks razonables cuando corresponda
* evitar llamadas duplicadas
* minimizar latencia cuando sea posible

Nunca simular que una integración funciona si no pudo verificarse.

---

# Andreani — restricción temporal

La integración con Andreani está actualmente en desarrollo y deliberadamente incompleta.

Hasta nueva indicación del usuario:

* NO continuar desarrollando Andreani.
* NO habilitar creación automática de envíos.
* NO habilitar tracking.
* NO rediseñar su arquitectura.
* NO intentar completar funcionalidades faltantes.
* NO modificar el flujo actual salvo que sea estrictamente necesario para evitar que rompa otra funcionalidad.

Preservar el estado actual de la integración.

Los problemas detectados relacionados exclusivamente con Andreani pueden documentarse, pero no deben implementarse hasta nueva indicación.

---

# Mercado Pago y pagos

Los flujos financieros requieren especial cuidado.

Verificar siempre que:

* precios importantes se calculen o validen server-side
* totales no puedan manipularse desde el cliente
* descuentos sean válidos
* costos de envío sean válidos
* pagos correspondan con la orden correcta
* montos pagados correspondan con montos esperados
* webhooks sean validados correctamente
* una operación repetida no genere estados duplicados

Priorizar integridad financiera sobre conveniencia de implementación.

---

# Componentes y React

Preferir componentes:

* pequeños
* reutilizables
* desacoplados
* con responsabilidades claras

Evitar componentes enormes con responsabilidades no relacionadas.

Antes de crear estado nuevo, verificar si puede derivarse del estado existente.

Evitar:

* renders innecesarios
* efectos redundantes
* estados duplicados
* `useEffect` innecesarios
* dependencias incorrectas
* loops de render
* requests duplicados

---

# Formularios

Todo formulario debe:

* validar correctamente
* manejar errores
* mostrar estados coherentes
* evitar doble submit
* soportar Unicode
* mantener consistencia entre frontend y backend

Las validaciones críticas deben repetirse server-side.

---

# UX funcional

Aunque las mejoras visuales no sean actualmente la prioridad principal, ningún cambio técnico debe degradar la UX existente.

Evitar:

* acciones ambiguas
* estados sin feedback
* loaders innecesariamente largos
* bloqueos evitables
* botones que aparenten funcionar cuando la función no existe
* errores técnicos mostrados directamente al usuario
* cambios de layout accidentales

---

# Diseño

La identidad visual existente de BEYONIX debe preservarse.

Hasta nueva indicación, no realizar rediseños ni cambios estéticos fuera del alcance de la tarea.

No modificar estilos existentes simplemente por preferencia.

Si una corrección técnica requiere tocar UI, minimizar el impacto visual.

---

# Tests y verificación

Cuando corresponda, antes de considerar terminada una implementación ejecutar:

* tests relacionados
* TypeScript/typecheck
* lint
* build

Agregar o actualizar tests cuando una modificación cambie lógica importante.

Priorizar especialmente tests para:

* pagos
* precios
* permisos
* órdenes
* stock
* integraciones
* validaciones críticas

Nunca afirmar que algo fue probado si no se ejecutó realmente.

Si una verificación no pudo ejecutarse, indicarlo.

---

# Bugs fuera del alcance

Si durante una tarea detectás un problema relacionado directamente con la implementación actual y solucionarlo es necesario para completar correctamente la tarea, podés corregirlo.

Si detectás un problema independiente y no relacionado:

* no expandir innecesariamente el alcance
* registrarlo en el resumen final
* dejarlo para una tarea posterior

---

# Autonomía

Tenés autonomía para:

* inspeccionar el proyecto
* modificar código
* crear archivos
* eliminar código muerto cuando corresponda
* refactorizar dentro del alcance
* ejecutar comandos
* ejecutar tests
* ejecutar lint
* ejecutar typecheck
* ejecutar build
* crear y aplicar migraciones
* realizar cambios necesarios en Supabase
* corregir bugs directamente relacionados con la tarea

No pedir autorización para decisiones técnicas normales necesarias para completar correctamente una tarea.

No eliminar datos reales, secretos, credenciales ni recursos productivos de forma irreversible salvo instrucción explícita.

---

# Git

Podés inspeccionar libremente:

* `git status`
* `git diff`
* historial relevante

No:

* descartar cambios ajenos
* utilizar comandos destructivos para limpiar el working tree
* hacer `reset --hard`
* sobrescribir cambios no relacionados

No realizar `commit`, `push`, `merge`, `rebase` ni modificar ramas salvo que el usuario lo solicite explícitamente.

El usuario controla la publicación de cambios al repositorio.

---

# Uso eficiente del contexto

No desperdiciar contexto explicando código que funciona correctamente.

Durante auditorías:

* priorizar problemas reales
* evitar enumerar archivos correctos
* evitar explicaciones redundantes
* agrupar problemas relacionados
* priorizar por impacto

Antes de realizar búsquedas amplias, utilizar la información ya obtenida durante la sesión.

No releer innecesariamente archivos grandes si ya existe contexto suficiente.

---

# Comunicación

Ser conciso y técnico.

No generar explicaciones largas salvo que sean necesarias.

Cuando exista un problema:

1. identificarlo
2. determinar la causa
3. evaluar impacto
4. implementar o recomendar la solución apropiada

No presentar hipótesis como hechos.

Diferenciar claramente entre:

* problema confirmado
* riesgo potencial
* recomendación

---

# Respuesta al finalizar una tarea

Utilizar este formato:

## Resumen

* Cambios realizados.

## Archivos

* Archivos modificados.

## Base de datos

* Cambios o migraciones aplicadas.
* `Sin cambios` si no corresponde.

## Variables de entorno

* Variables agregadas o modificadas.
* `Sin cambios` si no corresponde.

## Verificación

* Tests ejecutados.
* Typecheck/lint/build ejecutados cuando corresponda.

## Riesgos / pendientes

* Únicamente riesgos o pendientes reales.
* `Ninguno` si no existen.

No incluir secciones innecesariamente extensas.

---

# Principio general

La prioridad absoluta es mantener BEYONIX:

* estable
* seguro
* rápido
* profesional
* escalable
* mantenible

Comprender antes de modificar.

Corregir la causa antes que el síntoma.

No romper funcionalidades existentes.

No realizar cambios innecesarios.

No afirmar que algo funciona sin verificarlo.
