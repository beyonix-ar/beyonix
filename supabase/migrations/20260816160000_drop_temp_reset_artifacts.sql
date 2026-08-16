-- Elimina los artefactos temporales usados para inspeccionar el esquema y
-- diagnosticar el reset de datos comerciales de prueba. Ninguno de ellos
-- forma parte del modelo permanente; no quedan tablas, columnas ni datos
-- afectados por esta limpieza.

drop function if exists public.__beyonix_temp_reset_dry_run();
drop function if exists public.__beyonix_temp_table_counts();
drop function if exists public.__beyonix_temp_fk_graph();
