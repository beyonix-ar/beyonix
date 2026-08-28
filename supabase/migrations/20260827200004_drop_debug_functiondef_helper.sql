-- Elimina definitivamente el helper de diagnóstico temporal usado para
-- verificar (de forma read-only) el cuerpo real de las funciones corregidas
-- en 20260827200001/20260827200002. No forma parte del esquema permanente.
drop function if exists public.__debug_get_functiondef(text);
