-- ระบบบัญชีรุ่นที่ 23 — ระยะ 4: เบิกจ่าย งบประมาณ ยอดยกมา และสรุปการเงินที่สมาชิกทุกคนเห็น
-- หลักความโปร่งใส: สมาชิกทุกคนเห็นยอดรวม รายจ่ายทุกรายการ และใบเสร็จ
-- ส่วนรายชื่อว่าใครจ่ายแล้ว/ค้าง และสลิปของคนอื่น ยังจำกัดเฉพาะผู้มีหน้าที่

-- ─── หมวดค่าใช้จ่ายและงบกิจกรรม ──────────────────────────────────────

create table public.expense_categories (
  name text primary key,
  sort int not null default 0,
  active boolean not null default true
);
insert into public.expense_categories (name, sort) values
  ('อาหารและเครื่องดื่ม', 1), ('อุปกรณ์', 2), ('เดินทาง', 3), ('สถานที่', 4),
  ('ประชาสัมพันธ์', 5), ('ของที่ระลึกและสวัสดิการ', 6), ('อื่น ๆ', 99);

alter table public.activities add column budget_satang bigint check (budget_satang >= 0);

-- ─── คำขอเบิก ─────────────────────────────────────────────────────
-- pending → approved → paid  (หรือ rejected / cancelled)
-- อนุมัติแล้วยังไม่หักเงิน หักเงินตอนบันทึกจ่ายจริงพร้อมใบเสร็จเท่านั้น

create table public.expense_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.members(id),
  activity_id uuid references public.activities(id),
  category text not null references public.expense_categories(name),
  title text not null,
  reason text,
  amount_satang bigint not null check (amount_satang > 0),
  quote_path text, -- ใบเสนอราคา/หลักฐานก่อนจ่าย (ไม่บังคับ) ใน bucket "evidence"
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paid', 'cancelled')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text, -- เหตุผลที่ไม่อนุมัติ/ยกเลิก
  paid_satang bigint check (paid_satang > 0),
  paid_by uuid references auth.users(id),
  paid_at timestamptz,
  receipt_path text, -- ใบเสร็จ/สลิปโอนจ่ายจริง ใน bucket "evidence"
  ledger_entry_id bigint references public.ledger_entries(id),
  created_at timestamptz not null default now(),
  check (paid_satang is null or paid_satang <= amount_satang),
  check (status <> 'paid' or (paid_satang is not null and receipt_path is not null and ledger_entry_id is not null)),
  check (status not in ('rejected', 'cancelled') or review_note is not null)
);
create index on public.expense_requests (status, created_at);
create index on public.expense_requests (activity_id);

create trigger audit after insert or update or delete on public.expense_requests
  for each row execute function public.audit_row();
create trigger audit after insert or update or delete on public.expense_categories
  for each row execute function public.audit_row();
create trigger no_delete before delete on public.expense_requests
  for each row execute function public.forbid_change();
create trigger no_delete before delete on public.expense_categories
  for each row execute function public.forbid_change();

alter table public.expense_categories enable row level security;
alter table public.expense_requests enable row level security;

create policy categories_read on public.expense_categories for select to authenticated using (true);
create policy categories_add on public.expense_categories for insert to authenticated with check (public.has_role('admin'));
create policy categories_edit on public.expense_categories for update to authenticated using (public.has_role('admin'));

-- สมาชิกทุกคนเห็นคำขอเบิกทุกรายการ (ความโปร่งใส) การเขียนทำผ่านฟังก์ชันเท่านั้น
create policy expenses_read on public.expense_requests for select to authenticated
  using (public.my_member_id() is not null);

-- ─── ที่เก็บหลักฐานรายจ่าย (สมาชิกทุกคนเปิดดูได้) ─────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

create policy evidence_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.my_member_id() is not null);
create policy evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and public.my_member_id() is not null);

-- ─── ตัวช่วยภายใน ─────────────────────────────────────────────────

create function public.expense_status_th(s text) returns text
language sql immutable as $$
  select case s when 'pending' then 'รออนุมัติ' when 'approved' then 'อนุมัติแล้ว รอจ่าย'
                when 'rejected' then 'ไม่อนุมัติ' when 'paid' then 'จ่ายแล้ว' when 'cancelled' then 'ยกเลิกแล้ว' else s end
$$;

-- ไฟล์หลักฐานต้องอยู่ในโฟลเดอร์ของผู้อัปโหลดและมีอยู่จริง
create function public.check_evidence(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if split_part(p_path, '/', 1) <> auth.uid()::text
     or not exists (select 1 from storage.objects where bucket_id = 'evidence' and name = p_path) then
    raise exception 'ไม่พบไฟล์หลักฐาน กรุณาอัปโหลดใหม่';
  end if;
end $$;

-- ล็อกคำขอ (กันเหรัญญิกสองคนกดพร้อมกัน) และตรวจว่าสถานะยังถูกต้อง
create function public.lock_expense(p_id uuid, p_allowed text[]) returns public.expense_requests
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests;
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิกเท่านั้นที่ทำรายการนี้ได้';
  end if;
  select * into e from expense_requests where id = p_id for update;
  if not found then
    raise exception 'ไม่พบคำขอเบิก';
  end if;
  if not e.status = any(p_allowed) then
    raise exception 'ทำรายการไม่ได้ คำขอนี้อยู่ในสถานะ: %', expense_status_th(e.status);
  end if;
  return e;
end $$;

revoke execute on function public.check_evidence(text) from public, anon, authenticated;
revoke execute on function public.lock_expense(uuid, text[]) from public, anon, authenticated;

-- ─── ขั้นตอนเบิกจ่าย ───────────────────────────────────────────────

-- สมาชิกที่ใช้งานอยู่ทุกคนส่งคำขอเบิกได้ แจ้งเหรัญญิกทุกคน
create function public.request_expense(
  p_title text,
  p_amount_satang bigint,
  p_category text,
  p_activity_id uuid default null,
  p_reason text default null,
  p_quote_path text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me members;
  eid uuid;
begin
  select * into me from members where user_id = auth.uid() and active;
  if not found then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์ขอเบิก';
  end if;
  if p_quote_path is not null then
    perform check_evidence(p_quote_path);
  end if;

  insert into expense_requests (requested_by, activity_id, category, title, reason, amount_satang, quote_path)
  values (me.id, p_activity_id, p_category, trim(p_title), nullif(trim(p_reason), ''), p_amount_satang, p_quote_path)
  returning id into eid;

  perform notify(t, 'pending', format('%s ขอเบิก %s บาท: %s', me.full_name, baht(p_amount_satang), trim(p_title)),
                 '#expenses/' || eid, 'expense:' || eid)
  from active_treasurers() t;
  return eid;
end $$;

-- แจ้งผู้ขอ (ใช้ร่วมกันหลายขั้นตอน)
create function public.notify_requester(e public.expense_requests, p_kind text, p_title text) returns void
language sql security definer set search_path = public as $$
  select notify(m.user_id, p_kind, p_title, '#expenses/' || e.id, 'expense-' || e.status || ':' || e.id)
  from members m where m.id = e.requested_by and m.user_id is not null
$$;
revoke execute on function public.notify_requester(public.expense_requests, text, text) from public, anon, authenticated;

create function public.approve_expense(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests := lock_expense(p_id, '{pending}');
begin
  update expense_requests set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id returning * into e;
  perform notify_requester(e, 'success', format('คำขอเบิก "%s" %s บาท ได้รับการอนุมัติแล้ว', e.title, baht(e.amount_satang)));
end $$;

create function public.reject_expense(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests;
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติ';
  end if;
  e := lock_expense(p_id, '{pending}');
  update expense_requests set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(p_reason)
  where id = p_id returning * into e;
  perform notify_requester(e, 'action', format('คำขอเบิก "%s" ไม่ได้รับการอนุมัติ: %s', e.title, trim(p_reason)));
end $$;

-- จ่ายจริง: บันทึกรายจ่ายในสมุดบัญชีครั้งเดียว พร้อมใบเสร็จ ยอดจ่ายจริงไม่เกินยอดที่อนุมัติ
create function public.pay_expense(p_id uuid, p_paid_satang bigint, p_receipt_path text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests := lock_expense(p_id, '{approved}');
  act text;
  entry_id bigint;
begin
  if p_paid_satang is null or p_paid_satang <= 0 or p_paid_satang > e.amount_satang then
    raise exception 'ยอดจ่ายจริงต้องมากกว่า 0 และไม่เกินยอดที่อนุมัติ (% บาท)', baht(e.amount_satang);
  end if;
  perform check_evidence(p_receipt_path);
  select name into act from activities where id = e.activity_id;

  insert into ledger_entries (kind, amount_satang, description, evidence_path)
  values ('expense', -p_paid_satang, 'จ่าย: ' || e.title || coalesce(' (' || act || ')', ''), p_receipt_path)
  returning id into entry_id;

  update expense_requests
  set status = 'paid', paid_satang = p_paid_satang, paid_by = auth.uid(), paid_at = now(),
      receipt_path = p_receipt_path, ledger_entry_id = entry_id
  where id = p_id returning * into e;

  perform notify_requester(e, 'success', format('จ่ายเงินตามคำขอเบิก "%s" %s บาทแล้ว', e.title, baht(p_paid_satang)));
  return entry_id;
end $$;

-- ผู้ขอยกเลิกคำขอของตัวเองที่ยังรออนุมัติ หรือเหรัญญิกยกเลิกคำขอที่ยังไม่จ่าย ต้องมีเหตุผล
create function public.cancel_expense(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e expense_requests;
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่ยกเลิก';
  end if;
  select * into e from expense_requests where id = p_id for update;
  if not found
     or not ((e.requested_by = my_member_id() and e.status = 'pending')
             or (has_role('treasurer') and e.status in ('pending', 'approved'))) then
    raise exception 'ยกเลิกไม่ได้ คำขอนี้จ่ายไปแล้ว ถูกตรวจไปแล้ว หรือไม่ใช่ของคุณ';
  end if;
  update expense_requests set status = 'cancelled', review_note = trim(p_reason),
         reviewed_by = coalesce(reviewed_by, auth.uid()), reviewed_at = coalesce(reviewed_at, now())
  where id = p_id returning * into e;
  perform notify_requester(e, 'info', format('คำขอเบิก "%s" ถูกยกเลิก: %s', e.title, trim(p_reason)));
end $$;

-- ─── ยอดยกมา ─────────────────────────────────────────────────────
-- มีได้รายการเดียวที่ใช้งานอยู่ ตั้งใหม่ = ยกเลิกของเดิมพร้อมเหตุผล แล้วลงรายการใหม่ (ประวัติเดิมยังอยู่)
create function public.set_opening_balance(p_amount_satang bigint, p_note text, p_evidence_path text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  entry_id bigint;
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิกเท่านั้นที่ตั้งยอดยกมาได้';
  end if;
  if p_amount_satang is null or p_amount_satang < 0 then
    raise exception 'ยอดยกมาต้องไม่ติดลบ';
  end if;
  if nullif(trim(p_note), '') is null then
    raise exception 'กรุณาระบุที่มาของยอด เช่น ยอดในสมุดบัญชี ณ วันที่ และผู้รับรอง';
  end if;
  if p_evidence_path is not null then
    perform check_evidence(p_evidence_path);
  end if;

  perform pg_advisory_xact_lock(hashtext('opening_balance'));
  update ledger_entries set voided_at = now(), voided_by = auth.uid(), void_reason = 'แทนที่ด้วยยอดยกมาใหม่'
  where kind = 'opening_balance' and voided_at is null;

  insert into ledger_entries (kind, amount_satang, description, evidence_path)
  values ('opening_balance', p_amount_satang, 'ยอดยกมา: ' || trim(p_note), p_evidence_path)
  returning id into entry_id;
  return entry_id;
end $$;

-- ─── สรุปสำหรับสมาชิกทุกคน (ตัวเลขรวม ไม่มีรายชื่อรายคน) ──────────────────

create function public.require_member() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if my_member_id() is null then
    raise exception 'เฉพาะสมาชิกที่ใช้งานอยู่';
  end if;
end $$;
revoke execute on function public.require_member() from public, anon, authenticated;

create function public.fund_summary()
returns table (opening_satang bigint, income_satang bigint, expense_satang bigint, balance_satang bigint,
               pending_slips int, pending_expenses int, approved_unpaid_satang bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return query
  select coalesce(sum(amount_satang) filter (where kind = 'opening_balance'), 0)::bigint,
         coalesce(sum(amount_satang) filter (where kind = 'income'), 0)::bigint,
         coalesce(-sum(amount_satang) filter (where kind in ('expense', 'refund')), 0)::bigint,
         coalesce(sum(amount_satang), 0)::bigint,
         (select count(*)::int from payment_submissions where status = 'pending'),
         (select count(*)::int from expense_requests where status = 'pending'),
         (select coalesce(sum(amount_satang), 0)::bigint from expense_requests where status = 'approved')
  from ledger_entries where voided_at is null;
end $$;

-- รายรับ/รายจ่ายรายเดือน (เวลาไทย)
create function public.monthly_cashflow()
returns table (month date, income_satang bigint, expense_satang bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return query
  select date_trunc('month', created_at at time zone 'Asia/Bangkok')::date,
         coalesce(sum(amount_satang) filter (where kind = 'income'), 0)::bigint,
         coalesce(-sum(amount_satang) filter (where kind in ('expense', 'refund')), 0)::bigint
  from ledger_entries
  where voided_at is null and kind in ('income', 'expense', 'refund')
  group by 1 order by 1;
end $$;

-- รายการเรียกเก็บ: เก็บได้เท่าไร กี่คนจ่ายครบ (ไม่บอกว่าใคร)
create function public.charge_summary()
returns table (charge_id uuid, title text, due_date date, status text, amount_satang bigint,
               members int, paid_members int, collected_satang bigint, outstanding_satang bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return query
  select c.id, c.title, c.due_date, c.status, c.amount_satang,
         count(mc.id)::int,
         count(mc.id) filter (where mc.paid_satang = mc.amount_satang)::int,
         coalesce(sum(mc.paid_satang), 0)::bigint,
         coalesce(sum(mc.amount_satang - mc.paid_satang), 0)::bigint
  from charges c left join member_charges mc on mc.charge_id = c.id
  group by c.id order by c.created_at desc;
end $$;

-- งบแต่ละกิจกรรม: กันไว้ = อนุมัติแล้วยังไม่จ่าย
create view public.activity_budgets with (security_invoker = true) as
select a.id, a.name, a.description, a.active, a.budget_satang,
       coalesce(sum(e.amount_satang) filter (where e.status = 'approved'), 0)::bigint as committed_satang,
       coalesce(sum(e.paid_satang) filter (where e.status = 'paid'), 0)::bigint as paid_satang
from public.activities a
left join public.expense_requests e on e.activity_id = a.id
group by a.id;

-- รายจ่ายพร้อมชื่อผู้ขอ ผู้อนุมัติ ผู้จ่าย สำหรับสมาชิกทุกคน
-- ตั้งใจให้เป็น view ที่ใช้สิทธิ์เจ้าของ (ไม่ใช่ security_invoker) เพราะสมาชิกทั่วไปอ่านตาราง members ไม่ได้
-- เปิดเผยแค่ชื่อ ไม่มีอีเมลหรือรหัสนิสิต และคืนข้อมูลเฉพาะสมาชิกที่ใช้งานอยู่
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

-- บันทึกการส่งออกรายงานลงประวัติการกระทำ
create function public.log_export(p_report text, p_from date, p_to date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_member();
  insert into audit_log (actor, action, table_name, reason)
  values (auth.uid(), 'export', p_report, format('ช่วงวันที่ %s ถึง %s', coalesce(p_from::text, '-'), coalesce(p_to::text, '-')));
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'request_expense(text, bigint, text, uuid, text, text)', 'approve_expense(uuid)', 'reject_expense(uuid, text)',
    'pay_expense(uuid, bigint, text)', 'cancel_expense(uuid, text)', 'set_opening_balance(bigint, text, text)',
    'fund_summary()', 'monthly_cashflow()', 'charge_summary()', 'log_export(text, date, date)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.expense_requests;
  end if;
end $$;
