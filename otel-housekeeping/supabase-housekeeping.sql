-- Run in the customer app's Supabase project after its main schema.sql.
create table if not exists public.housekeeping_records (
  collection text not null,
  record_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, record_id),
  constraint housekeeping_records_collection_valid
    check (collection in ('users', 'settings', 'reservations', 'manual_notification_logs', 'push_send_logs')),
  constraint housekeeping_records_id_valid
    check (length(record_id) between 1 and 180)
);

alter table public.housekeeping_records
  drop constraint if exists housekeeping_records_collection_valid;
alter table public.housekeeping_records
  add constraint housekeeping_records_collection_valid
    check (collection in ('users', 'settings', 'reservations', 'manual_notification_logs', 'push_send_logs'));

alter table public.housekeeping_records enable row level security;
revoke all on public.housekeeping_records from anon, authenticated;
grant all on public.housekeeping_records to service_role;

create or replace function public.import_legacy_housekeeping_export(p_export jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  collection_name text;
  record_item record;
  imported_records integer := 0;
begin
  foreach collection_name in array array['users', 'reservations', 'manual_notification_logs']
  loop
    for record_item in
      select key, value
      from pg_catalog.jsonb_each(coalesce(p_export -> collection_name, '{}'::jsonb))
    loop
      insert into public.housekeeping_records (collection, record_id, data)
      values (collection_name, record_item.key, record_item.value)
      on conflict (collection, record_id) do update
        set data = excluded.data, updated_at = now();
      imported_records := imported_records + 1;
    end loop;
  end loop;

  if jsonb_typeof(p_export -> 'settings') = 'object' then
    insert into public.housekeeping_records (collection, record_id, data)
    values ('settings', 'main', p_export -> 'settings')
    on conflict (collection, record_id) do update
      set data = excluded.data, updated_at = now();
    imported_records := imported_records + 1;
  end if;

  return pg_catalog.jsonb_build_object('records', imported_records);
end;
$$;

revoke all on function public.import_legacy_housekeeping_export(jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_housekeeping_export(jsonb) to service_role;
