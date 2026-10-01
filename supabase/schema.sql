-- ==========================================================================
-- Hábitos — esquema de Supabase
-- Pégalo completo en SQL Editor → New query → Run. Se puede ejecutar más de una vez.
--
-- Modelo sin autenticación: cada conjunto de dispositivos comparte un "espacio"
-- identificado por un código aleatorio largo. Las tablas tienen RLS activado y
-- NINGUNA política, así que no se pueden leer ni escribir directamente con la
-- clave pública. Todo pasa por las funciones de abajo, que exigen el código.
-- ==========================================================================

create table if not exists public.habits (
  id          uuid primary key,
  space_id    text not null,
  name        text not null,
  multi       boolean not null default false,
  options     jsonb not null default '[]'::jsonb,   -- [{ "id": "...", "label": "..." }]
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists habits_space_idx on public.habits (space_id);

create table if not exists public.entries (
  space_id    text not null,
  day         date not null,
  data        jsonb not null default '{}'::jsonb,   -- { "<habit id>": ["<option id>", ...] }
  updated_at  timestamptz not null default now(),
  primary key (space_id, day)
);

create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  space_id    text not null,
  p256dh      text not null,
  auth        text not null,
  tz          text not null default 'Europe/Madrid',
  hour        smallint not null default 8,
  updated_at  timestamptz not null default now()
);

alter table public.habits             enable row level security;
alter table public.entries            enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.habits, public.entries, public.push_subscriptions from anon, authenticated;

-- --------------------------------------------------------------------------
-- Funciones (security definer: se ejecutan con permisos del propietario)
-- --------------------------------------------------------------------------

create or replace function public.habitos_check_space(p_space text)
returns void language plpgsql as $$
begin
  if p_space is null or length(p_space) < 20 then
    raise exception 'Código de espacio no válido';
  end if;
end $$;

-- Todo el contenido de un espacio en una sola llamada.
create or replace function public.habitos_pull(p_space text)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  return json_build_object(
    'habits', coalesce((
      select json_agg(json_build_object(
               'id', h.id, 'name', h.name, 'multi', h.multi,
               'options', h.options, 'position', h.position)
             order by h.position, h.created_at)
      from habits h where h.space_id = p_space), '[]'::json),
    'entries', coalesce((
      select json_agg(json_build_object('day', e.day, 'data', e.data, 'updated_at', e.updated_at))
      from entries e where e.space_id = p_space), '[]'::json)
  );
end $$;

create or replace function public.habitos_save_habit(
  p_space text, p_id uuid, p_name text, p_multi boolean, p_options jsonb, p_position integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  insert into habits (id, space_id, name, multi, options, position)
  values (p_id, p_space, p_name, p_multi, p_options, p_position)
  on conflict (id) do update
    set name = excluded.name, multi = excluded.multi, options = excluded.options,
        position = excluded.position, updated_at = now()
    where habits.space_id = p_space;
end $$;

create or replace function public.habitos_delete_habit(p_space text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  delete from habits where id = p_id and space_id = p_space;
end $$;

create or replace function public.habitos_save_entry(p_space text, p_day date, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  insert into entries (space_id, day, data)
  values (p_space, p_day, p_data)
  on conflict (space_id, day) do update set data = excluded.data, updated_at = now();
end $$;

-- ¿Tiene registro ese día? (lo usa el service worker)
create or replace function public.habitos_day_done(p_space text, p_day date)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  return exists (select 1 from entries where space_id = p_space and day = p_day);
end $$;

create or replace function public.habitos_save_push(
  p_space text, p_endpoint text, p_p256dh text, p_auth text, p_tz text, p_hour integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform habitos_check_space(p_space);
  insert into push_subscriptions (endpoint, space_id, p256dh, auth, tz, hour)
  values (p_endpoint, p_space, p_p256dh, p_auth, p_tz, p_hour)
  on conflict (endpoint) do update
    set space_id = excluded.space_id, p256dh = excluded.p256dh, auth = excluded.auth,
        tz = excluded.tz, hour = excluded.hour, updated_at = now();
end $$;

create or replace function public.habitos_delete_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint;
$$;

grant execute on function
  public.habitos_check_space(text),
  public.habitos_pull(text),
  public.habitos_save_habit(text, uuid, text, boolean, jsonb, integer),
  public.habitos_delete_habit(text, uuid),
  public.habitos_save_entry(text, date, jsonb),
  public.habitos_day_done(text, date),
  public.habitos_save_push(text, text, text, text, text, integer),
  public.habitos_delete_push(text)
to anon, authenticated;

-- --------------------------------------------------------------------------
-- OPCIONAL — push matutino: ejecuta la Edge Function cada hora en punto.
-- Activa antes las extensiones pg_cron y pg_net (Database → Extensions),
-- sustituye <PROJECT-REF> y <CRON_SECRET>, y quita los guiones de comentario.
-- --------------------------------------------------------------------------
-- select cron.schedule(
--   'habitos-recordatorio-matutino',
--   '0 * * * *',
--   $$
--   select net.http_post(
--     url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/morning-reminder',
--     headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
--     body    := '{}'::jsonb
--   );
--   $$
-- );
