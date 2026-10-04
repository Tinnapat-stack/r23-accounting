-- ระบบบัญชีรุ่นที่ 23 — ยกเลิกการจ่ายที่บันทึกผิด และเตือนยอดค้าง

-- ─── ยกเลิกการจ่ายที่บันทึกผิด ──────────────────────────────────────
-- คำขอกลับเป็น "อนุมัติแล้ว รอจ่าย" รายจ่ายเดิมถูกยกเลิกพร้อมเหตุผล (ไม่ลบ) แล้วบันทึกจ่ายใหม่หรือยกเลิกคำขอได้
-- ค่าเดิม (ยอด ใบเสร็จ ผู้จ่าย) ยังดูได้ในประวัติการกระทำ

alter table public.expense_requests add column payment_void_note text;

-- view เดิมขยาย e.* ไว้ตอนสร้าง ต้องสร้างใหม่ให้เห็นคอลัมน์ใหม่ (นิยามเหมือนเดิมใน 0004)
drop view public.expense_feed;
create view public.expense_feed as
select e.*, rq.full_name as requester_name, rv.full_name as reviewer_name, pb.full_name as payer_name,
       a.name as activity_name
from public.expense_requests e
join public.members rq on rq.id = e.requested_by
left join public.members rv on rv.user_id = e.reviewed_by
left join public.members pb on pb.user_id = e.paid_by
left join public.activities a on a.id = e.activity_id
where public.my_member_id() is not null;
revoke all on public.expense_feed from anon;
grant select on public.expense_feed to authenticated;

create function public.void_expense_payment(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests;
  old_entry bigint;
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่ยกเลิกการจ่าย';
  end if;
  e := lock_expense(p_id, '{paid}');
  old_entry := e.ledger_entry_id;

  perform set_config('app.reason', trim(p_reason), true);
  update ledger_entries set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
  where id = e.ledger_entry_id and voided_at is null;
  update expense_requests
  set status = 'approved', paid_satang = null, paid_by = null, paid_at = null, receipt_path = null, ledger_entry_id = null,
      payment_void_note = format('ยกเลิกการจ่าย %s บาท เมื่อ %s: %s', baht(e.paid_satang),
                                 to_char(now() at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI'), trim(p_reason))
  where id = p_id returning * into e;

  -- ใช้ key ของรายการจ่ายที่ถูกยกเลิก (สถานะกลับเป็น approved ซ้ำกับตอนอนุมัติ ถ้าใช้ notify_requester จะถูกมองว่าซ้ำ)
  perform notify(m.user_id, 'info', format('การจ่ายเงินของคำขอ "%s" ถูกยกเลิกเพื่อแก้ไข: %s', e.title, trim(p_reason)),
                 '#expenses/' || e.id, 'expense-void:' || old_entry)
  from members m where m.id = e.requested_by and m.user_id is not null;
end $$;

-- key แจ้งผู้ขอรวมเลขรายการจ่ายด้วย: ยกเลิกการจ่ายแล้วจ่ายใหม่ ผู้ขอต้องได้รับแจ้งรอบใหม่
create or replace function public.notify_requester(e public.expense_requests, p_kind text, p_title text) returns void
language sql security definer set search_path = public as $$
  select notify(m.user_id, p_kind, p_title, '#expenses/' || e.id,
                'expense-' || e.status || ':' || e.id || coalesce(':' || e.ledger_entry_id, ''))
  from members m where m.id = e.requested_by and m.user_id is not null
$$;

-- ─── เตือนยอดค้าง ──────────────────────────────────────────────────
-- ส่งเป็นแจ้งเตือนในเว็บ dedupe_key กันส่งซ้ำ: ก่อนครบกำหนด 1 ครั้ง, เลยกำหนดสัปดาห์ละครั้ง, กดเองวันละครั้ง

create function public.outstanding_charges()
returns table (member_charge_id uuid, user_id uuid, title text, due_date date, owed bigint)
language sql stable security definer set search_path = public as $$
  select mc.id, m.user_id, c.title, c.due_date, mc.amount_satang - mc.paid_satang
  from member_charges mc
  join charges c on c.id = mc.charge_id
  join members m on m.id = mc.member_id
  where c.status = 'open' and m.active and m.user_id is not null and mc.paid_satang < mc.amount_satang
$$;
revoke execute on function public.outstanding_charges() from public, anon, authenticated;

-- ทำงานอัตโนมัติทุกวัน (pg_cron) ไม่ให้ผู้ใช้เรียกเอง คืนจำนวนแจ้งเตือนที่ส่งจริง
create function public.remind_due(p_today date default (now() at time zone 'Asia/Bangkok')::date) returns int
language plpgsql security definer set search_path = public as $$
declare
  soon int;
  late int;
begin
  insert into notifications (user_id, kind, title, link, dedupe_key)
  select user_id, 'action',
         case when due_date = p_today then format('วันนี้ครบกำหนดชำระ %s (ค้าง %s บาท)', title, baht(owed))
              else format('อีก %s วันครบกำหนดชำระ %s (ค้าง %s บาท)', due_date - p_today, title, baht(owed)) end,
         '#pay', 'due-soon:' || member_charge_id
  from outstanding_charges() where due_date - p_today between 0 and 3
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics soon = row_count;

  insert into notifications (user_id, kind, title, link, dedupe_key)
  select user_id, 'action', format('เลยกำหนดชำระ %s มาแล้ว %s วัน (ค้าง %s บาท)', title, p_today - due_date, baht(owed)),
         '#pay', 'overdue:' || member_charge_id || ':' || (p_today - due_date - 1) / 7
  from outstanding_charges() where p_today > due_date
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics late = row_count;

  return soon + late;
end $$;
revoke execute on function public.remind_due(date) from public, anon, authenticated;

-- เหรัญญิก/ประธานกดเตือนคนที่ยังค้างของรายการเดียว ส่งถึงคนเดิมได้วันละครั้ง
create function public.remind_charge(p_charge_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  sent int;
  today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  if not has_role('treasurer', 'president') then
    raise exception 'เฉพาะเหรัญญิกหรือประธานเท่านั้นที่ส่งเตือนได้';
  end if;
  insert into notifications (user_id, kind, title, link, dedupe_key)
  select o.user_id, 'action',
         format('เตือนจากเหรัญญิก: ยังค้างชำระ %s %s บาท%s', o.title, baht(o.owed),
                coalesce(' (ครบกำหนด ' || to_char(o.due_date, 'DD/MM/YYYY') || ')', '')),
         '#pay', 'remind:' || o.member_charge_id || ':' || today
  from outstanding_charges() o
  join member_charges mc on mc.id = o.member_charge_id
  where mc.charge_id = p_charge_id
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics sent = row_count;
  return sent;
end $$;

revoke execute on function public.void_expense_payment(uuid, text) from public, anon;
revoke execute on function public.remind_charge(uuid) from public, anon;
grant execute on function public.void_expense_payment(uuid, text) to authenticated;
grant execute on function public.remind_charge(uuid) to authenticated;

-- เปิดงานตั้งเวลาทุกวัน 08:00 เวลาไทย (01:00 UTC) ถ้าฐานข้อมูลมี pg_cron (Supabase มี)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('remind-due', '0 1 * * *', 'select public.remind_due()');
  end if;
end $$;
