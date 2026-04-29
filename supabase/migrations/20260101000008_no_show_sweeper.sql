-- =============================================================================
-- No-show sweeper
--
-- Atomic SQL function called every 5 minutes by Vercel Cron. Flips bookings
-- whose scheduled time + duration + grace period has passed from
-- 'scheduled' → 'no_show', and emits the corresponding `booking_no_show`
-- event in the same transaction so the funnel views pick it up.
--
-- `for update skip locked` makes concurrent invocations safe.
-- =============================================================================

create or replace function sweep_bookings_to_no_show(
  p_grace_minutes int default 15,
  p_limit int default 200
)
  returns table (booking_id uuid, lead_id uuid, company_id uuid, scheduled_at timestamptz)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r record;
begin
  for r in
    select b.id, b.lead_id, b.company_id, b.scheduled_at, coalesce(b.duration_minutes, 30) as dur
    from bookings b
    where b.status = 'scheduled'
      and b.scheduled_at + (coalesce(b.duration_minutes, 30) || ' minutes')::interval
                        + (p_grace_minutes || ' minutes')::interval < now()
    order by b.scheduled_at asc
    limit p_limit
    for update of b skip locked
  loop
    update bookings
       set status        = 'no_show',
           status_set_at = now(),
           status_source = 'auto:sweeper'
     where id = r.id and status = 'scheduled';

    if found then
      insert into lead_events (
        company_id, lead_id, event_type, booking_id, occurred_at, source
      ) values (
        r.company_id, r.lead_id, 'booking_no_show', r.id,
        r.scheduled_at + (r.dur || ' minutes')::interval,
        'auto:sweeper'
      );

      booking_id := r.id;
      lead_id := r.lead_id;
      company_id := r.company_id;
      scheduled_at := r.scheduled_at;
      return next;
    end if;
  end loop;
end;
$$;

-- Service role calls this directly; no other role needs it.
revoke execute on function sweep_bookings_to_no_show(int, int) from public, authenticated, anon;
grant execute on function sweep_bookings_to_no_show(int, int) to service_role;
