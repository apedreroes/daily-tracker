# Hábitos — PWA de registro de hábitos

App web instalable (PWA) en HTML, CSS y JavaScript sin dependencias de compilación.
Funciona sin conexión y, con Supabase, sincroniza los datos entre dispositivos sin login.

## Archivos

| Archivo | Contenido |
|---|---|
| `index.html` | Estructura y vistas: Día, Semana, Mes, Ajustes y diálogos |
| `style.css` | Estilos mobile-first, variables CSS, modo claro y oscuro |
| `app.js` | Lógica: fechas, estado local, sincronización, vistas y notificaciones |
| `config.js` | **Lo único que hay que editar**: URL y clave de Supabase, clave VAPID |
| `kv.js` | Mini almacén IndexedDB compartido entre la página y el service worker |
| `manifest.json` | Manifiesto de la PWA |
| `service-worker.js` | Caché offline, push, comprobación en segundo plano, clic en notificación |
| `supabase/schema.sql` | Tablas y funciones de la base de datos |
| `supabase/functions/morning-reminder/` | Edge Function que envía el push matutino |

## 1. Probar en local (sin nube)

```bash
python3 -m http.server 8935
```

Abre `http://localhost:8935`. Con `config.js` vacío la app funciona en modo local:
los datos se guardan solo en ese navegador.

## 2. Conectar Supabase (sincronización entre dispositivos)

1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: pega el contenido de `supabase/schema.sql` y pulsa **Run**.
3. **Project Settings → API**: copia la *Project URL* y la clave *anon / publishable* en `config.js`.
4. Publica la carpeta en un alojamiento estático **con HTTPS** (GitHub Pages, Netlify,
   Cloudflare Pages…). Sin HTTPS no hay service worker, ni instalación, ni notificaciones.

### Cómo funciona sin login

- La primera vez, la app pregunta si empiezas de cero o conectas con otro dispositivo.
  Al empezar de cero se genera un **código de espacio** aleatorio de 24 caracteres.
- En el segundo dispositivo: **Ajustes → Sincronización → pega el código** (o abre el
  enlace de «Copiar enlace»). Desde ese momento comparten los mismos datos.
- Cada guardado se sube a Supabase y se avisa al resto de dispositivos por Supabase
  Realtime (canal *broadcast*), que se actualizan al instante.
- Sin conexión, los cambios quedan en cola y se suben al volver la red.

**Seguridad:** las tablas tienen RLS activado y ninguna política, así que no son
accesibles con la clave pública. Todo pasa por funciones que exigen el código del
espacio. El código hace de contraseña: quien lo tenga puede ver y editar los datos,
y no se puede cambiar ni revocar. No lo publiques.

## 3. Notificación matutina

En **Ajustes → Recordatorio matutino** se pide el permiso y se elige la hora.
El aviso llega solo si el día anterior no tiene registro. Hay tres vías:

| Vía | Requisitos | Con la app cerrada |
|---|---|---|
| Push del servidor | Pasos de abajo | Sí, a la hora elegida |
| Comprobación periódica del navegador | Chrome/Edge en Android o escritorio, PWA instalada | Sí, hora aproximada |
| Aviso dentro de la app | Ninguno | No: se ve al abrirla |

Un navegador no puede programar por sí solo una notificación a una hora fija con la
app cerrada: para eso hace falta el push del servidor.

### Activar el push del servidor

Necesitas la [CLI de Supabase](https://supabase.com/docs/guides/cli) y Node.

1. Genera las claves VAPID:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Pon la clave **pública** en `VAPID_PUBLIC_KEY` de `config.js`.
3. Guarda los secretos (inventa un valor largo para `CRON_SECRET`):
   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tu@correo.com CRON_SECRET=...
   ```
4. Despliega la función:
   ```bash
   supabase functions deploy morning-reminder --no-verify-jwt
   ```
5. En Supabase activa las extensiones **pg_cron** y **pg_net** (Database → Extensions)
   y ejecuta el bloque comentado del final de `schema.sql`, con tu *project ref* y tu
   `CRON_SECRET`. El cron llama a la función cada hora y esta avisa a los dispositivos
   cuya hora local coincide con la elegida.
6. En cada dispositivo: **Ajustes → Activar recordatorio**.

Para probar el envío sin esperar a la hora:

```bash
curl -X POST https://<PROJECT-REF>.supabase.co/functions/v1/morning-reminder -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" -d '{"force": true}'
```

**iPhone / iPad:** las notificaciones solo funcionan con iOS 16.4 o posterior y con la
app añadida a la pantalla de inicio (Compartir → Añadir a pantalla de inicio).

## Notas

- Al publicar cambios, sube la versión de `CACHE` en `service-worker.js`.
- Un día cuenta como «registrado» cuando se pulsa **Guardar día** con al menos una opción.
- Al eliminar un hábito deja de mostrarse, pero los registros de los días se conservan.
# Registro hábitos
# daily-tracker
