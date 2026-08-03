# AGENTS.md

# BEYONIX Development Agent

## Reglas del proyecto

- El idioma original y predeterminado de toda la aplicación es español.
- Todos los archivos de texto y código deben conservarse en UTF-8.
- Los textos visibles deben usar ortografía española correcta, incluyendo tildes, `ñ`, `ü` y signos de apertura.
- Los formularios deben aceptar correctamente letras Unicode y nombres en español. No restringir texto humano a `A-Z` o `a-z`.
- Antes de finalizar cualquier cambio, revisar que no existan caracteres con codificación incorrecta como `Ã`, `Â`, `â`, `�` o similares.
- Nunca reemplazar caracteres españoles por versiones sin acento para evitar problemas de codificación.

---

# Objetivo

BEYONIX es un ecommerce profesional.

Toda modificación debe priorizar:

- Calidad de código.
- Escalabilidad.
- Mantenibilidad.
- Performance.
- Seguridad.
- UX.
- Consistencia visual.

Nunca implementar soluciones rápidas que generen deuda técnica.

Antes de escribir código comprender completamente el problema y evaluar el impacto de los cambios.

---

# Stack tecnológico

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui
- Supabase
- PostgreSQL

No agregar dependencias nuevas salvo que exista una justificación técnica clara.

Siempre preferir las herramientas ya presentes en el proyecto.

---

# Arquitectura

Antes de crear cualquier componente, función o archivo:

- Buscar implementaciones similares.
- Reutilizar componentes existentes.
- Evitar duplicar lógica.
- Mantener la estructura actual del proyecto.

Si un componente puede extenderse, hacerlo antes de crear uno nuevo.

---

# Calidad de código

Todo cambio debe:

- Compilar correctamente.
- No generar errores.
- No generar warnings importantes.
- Mantener tipado fuerte.
- Evitar el uso de `any`.
- Mantener nombres descriptivos.
- Eliminar código muerto cuando corresponda.

No dejar código comentado innecesariamente.

---

# TypeScript

Siempre utilizar:

- interfaces claras
- tipos reutilizables
- tipado estricto

Evitar:

- any
- unknown innecesario
- casts inseguros

---

# Supabase

Antes de modificar la base de datos:

- Revisar la estructura existente.
- No crear tablas duplicadas.
- Mantener relaciones existentes.
- Mantener Foreign Keys.
- Mantener índices.
- Mantener políticas RLS.
- Mantener triggers.

Nunca eliminar datos existentes salvo que se solicite explícitamente.

Si una migración implica riesgo, explicar primero:

- qué cambia
- qué impacto tiene
- cómo revertirla

---

# SQL

Generar consultas seguras.

Evitar:

- DELETE masivos
- UPDATE sin WHERE
- DROP innecesarios

Cuando sea posible, utilizar migraciones reversibles.

---

# Seguridad

Nunca:

- exponer claves privadas
- exponer service_role
- desactivar RLS
- confiar únicamente en validaciones del frontend

Toda validación importante debe existir también en backend.

---

# Performance

Evitar:

- consultas repetidas
- renders innecesarios
- lógica duplicada
- fetch redundantes
- llamadas innecesarias a Supabase

Optimizar siempre que no complique el mantenimiento.

---

# Diseño

Toda interfaz debe respetar la identidad visual de BEYONIX.

Priorizar:

- aspecto premium
- interfaces limpias
- poco ruido visual
- excelente jerarquía
- espaciados consistentes
- tarjetas compactas
- responsive
- accesibilidad

Evitar:

- sombras exageradas
- colores innecesarios
- interfaces sobrecargadas
- animaciones molestas

---

# Componentes

Preferir:

- componentes pequeños
- reutilizables
- desacoplados

Evitar componentes enormes con múltiples responsabilidades.

---

# Formularios

Siempre:

- validar correctamente
- mostrar mensajes claros
- evitar estados inconsistentes
- soportar correctamente idioma español y Unicode

---

# Refactorización

Si durante una tarea detectás mejoras importantes:

No modificar todo automáticamente.

Primero explicar:

- problema encontrado
- impacto
- propuesta

Luego implementarlo únicamente si mejora realmente el proyecto.

---

# Compatibilidad

Nunca romper funcionalidades existentes.

Antes de modificar una función:

- identificar dónde se utiliza
- verificar dependencias
- comprobar efectos secundarios

---

# UX

Toda pantalla nueva debe sentirse parte del mismo sistema.

Evitar:

- botones desalineados
- tamaños inconsistentes
- scroll innecesario
- textos repetidos
- acciones confusas

---

# Antes de finalizar

Realizar una revisión completa.

Verificar:

- Compilación
- TypeScript
- Imports
- Componentes afectados
- Responsive
- Accesibilidad
- Rendimiento
- Seguridad
- Consultas SQL
- Errores de consola
- Caracteres UTF-8
- Textos visibles
- Consistencia visual

---

# Respuesta esperada

Al finalizar cada tarea indicar siempre:

## Resumen

- Qué se modificó.

## Archivos

- Qué archivos fueron modificados.

## Base de datos

- Si es necesario ejecutar SQL.
- Si existen migraciones nuevas.

## Variables de entorno

- Si es necesario modificar `.env`.

## Riesgos

- Posibles efectos secundarios.

## Cómo probar

- Pasos para verificar que todo funciona correctamente.

Nunca considerar una tarea finalizada sin verificar el impacto completo de los cambios.

La prioridad absoluta es mantener BEYONIX estable, profesional, escalable y fácil de mantener.

---

# Reglas para el agente

- Nunca asumir cómo funciona una parte del sistema sin antes inspeccionar el código relacionado.
- Antes de crear código nuevo, buscar implementaciones existentes que puedan reutilizarse.
- Si detectás un posible bug fuera del alcance de la tarea, informarlo al finalizar pero no modificarlo sin autorización.
- Si una solicitud del usuario puede romper otra funcionalidad, detenerse y explicar el riesgo antes de implementar el cambio.
- Siempre preferir soluciones simples, mantenibles y escalables sobre soluciones complejas.
- No modificar archivos que no sean necesarios para cumplir el objetivo.
- Mantener el estilo de código ya existente en el proyecto.