/*
 * Configuración de la nube. Mientras estos valores estén vacíos, la app funciona
 * en modo local (los datos se quedan solo en este dispositivo).
 *
 * La clave "anon" / "publishable" de Supabase está pensada para ir en el cliente:
 * las tablas no son accesibles directamente, solo a través de las funciones de
 * supabase/schema.sql, que exigen el código del espacio.
 */
window.HABITOS_CONFIG = {
  SUPABASE_URL: 'https://ayqfmpjwysfcewpwebbt.supabase.co',        // p. ej. 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: 'sb_publishable_Wz1EmypYXIsLZzjKGugMvQ__yF1obnV',   // Project Settings → API → anon / publishable key
  VAPID_PUBLIC_KEY: ''     // Opcional: clave pública VAPID para el push matutino
};
