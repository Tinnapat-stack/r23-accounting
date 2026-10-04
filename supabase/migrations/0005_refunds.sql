-- ระบบบัญชีรุ่นที่ 23 — ยกเลิกรายรับที่ยืนยันผิด และคืนเงินสมาชิก
-- ไม่ลบอะไร: สลิปเปลี่ยนสถานะเป็น voided, รายรับในสมุดบัญชีถูกยกเลิกพร้อมเหตุผล, การคืนเงินเป็นรายการเงินออกใหม่

-- ─── ยกเลิกรายรับ ─────────────────────────────────────────────────

alter table public.payment_submissions drop constraint payment_submissions_status_check;
alter table public.payment_submissions
  add constraint payment_submissions_status_check
    check (status in ('pending', 'confirmed', 'rejected', 'cancelled', 'voided')),
  add column voided_by uuid references auth.users(id),
  add column voided_at timestamptz,
  add column void_reason text,
  add constraint voided_needs_reason check (status <> 'voided' or void_reason is not null);

create or replace function public.status_th(s text) returns text
language sql immutable as $$
  select case s when 'pending' then 'รอตรวจสอบ' when 'confirmed' then 'ยืนยันแล้ว'
                when 'rejected' then 'ไม่ผ่านการตรวจสอบ' when 'cancelled' then 'ยกเลิกแล้ว'
                when 'voided' then 'ยกเลิกหลังยืนยัน' else s end
$$;

-- ─── คืนเงิน ──────────────────────────────────────────────────────

-- คืนค่ารายการ (เช่น กิจกรรมยกเลิก) ลดทั้งยอดที่ต้องจ่ายและที่จ่ายแล้ว จึงอาจเหลือ 0
alter table public.member_charges drop constraint member_charges_amount_satang_check;
alter table public.member_charges add constraint member_charges_amount_satang_check check (amount_satang >= 0);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id),
  member_charge_id uuid references public.member_charges(id), -- null = คืนเครดิตจ่ายเกิน
  amount_satang bigint not null check (amount_satang > 0),
  reason text not null,
  slip_path text not null, -- สลิปโอนคืน ใน bucket "slips" (มีชื่อผู้รับ จึงไม่เปิดให้ทุกคนเห็น)
  ledger_entry_id bigint not null references public.ledger_entries(id),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create trigger audit after insert or update or delete on public.refunds
  for each row execute function public.audit_row();
create trigger no_delete before delete on public.refunds
  for each row execute function public.forbid_change();

alter table public.refunds enable row level security;
create policy refunds_read on public.refunds for select to authenticated
  using (member_id = public.my_member_id() or public.has_role('treasurer', 'president', 'auditor'));

-- เครดิต = ยอดที่ยืนยันแล้วแต่ยังไม่ได้ตัดรายการ − เครดิตที่คืนไปแล้ว
create or replace view public.member_credit with (security_invoker = true) as
with c as (
  select s.member_id,
         s.amount_satang - coalesce((select sum(a.amount_satang) from public.submission_allocations a
                                     where a.submission_id = s.id), 0) as amt
  from public.payment_submissions s where s.status = 'confirmed'
  union all
  select member_id, -amount_satang from public.refunds where member_charge_id is null
)
select member_id, sum(amt)::bigint as credit_satang from c group by member_id;

-- เครดิตของสมาชิกคนเดียว (ใช้ภายในฟังก์ชัน ไม่ขึ้นกับสิทธิ์ผู้เรียก)
create function public.member_credit_satang(p_member uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amt), 0)::bigint from (
    select s.amount_satang - coalesce((select sum(a.amount_satang) from submission_allocations a
                                       where a.submission_id = s.id), 0) as amt
    from payment_submissions s where s.member_id = p_member and s.status = 'confirmed'
    union all
    select -amount_satang from refunds where member_id = p_member and member_charge_id is null
  ) c
$$;
revoke execute on function public.member_credit_satang(uuid) from public, anon, authenticated;

-- ─── ยกเลิกรายรับที่ยืนยันผิด (เหรัญญิก) ───────────────────────────────

create function public.void_payment(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s payment_submissions;
  payer members;
  unallocated bigint;
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิกเท่านั้นที่ยกเลิกรายรับได้';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่ยกเลิกรายรับ';
  end if;
  select * into s from payment_submissions where id = p_id for update;
  if not found then
    raise exception 'ไม่พบรายการแจ้งชำระ';
  end if;
  if s.status <> 'confirmed' then
    raise exception 'ยกเลิกได้เฉพาะรายการที่ยืนยันแล้ว (สถานะ: %)', status_th(s.status);
  end if;
  perform 1 from members where id = s.member_id for update;

  -- คืนเงินจากรายการที่สลิปนี้ตัดยอดไปแล้ว → ยกเลิกไม่ได้ ยอดจะติดลบ
  if exists (select 1 from submission_allocations a join member_charges mc on mc.id = a.member_charge_id
             where a.submission_id = p_id and mc.paid_satang < a.amount_satang) then
    raise exception 'ยกเลิกไม่ได้ มีการคืนเงินจากรายการที่สลิปนี้ตัดยอดไปแล้ว';
  end if;
  select s.amount_satang - coalesce(sum(amount_satang), 0) into unallocated
  from submission_allocations where submission_id = p_id;
  if member_credit_satang(s.member_id) - unallocated < 0 then
    raise exception 'ยกเลิกไม่ได้ สมาชิกได้รับเครดิตส่วนนี้คืนไปแล้ว';
  end if;

  perform set_config('app.reason', trim(p_reason), true);
  update member_charges mc set paid_satang = mc.paid_satang - a.amount_satang
  from submission_allocations a where a.submission_id = p_id and mc.id = a.member_charge_id;
  update ledger_entries set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
  where submission_id = p_id and voided_at is null;
  update payment_submissions set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = trim(p_reason)
  where id = p_id;

  select * into payer from members where id = s.member_id;
  perform notify(m.user_id, 'action',
                 format('การชำระ %s บาท (%s) ถูกยกเลิกโดยเหรัญญิก: %s', baht(s.amount_satang), payer.full_name, trim(p_reason)),
                 '#my-payments', 'void:' || p_id)
  from members m
  where m.user_id is not null
    and (m.id = s.member_id
         or m.id in (select mc.member_id from submission_allocations a join member_charges mc on mc.id = a.member_charge_id
                     where a.submission_id = p_id));
end $$;

-- ─── คืนเงินสมาชิก (เหรัญญิก) ─────────────────────────────────────────
-- p_member_charge_id = null → คืนเครดิตจ่ายเกิน, มีค่า → คืนค่ารายการนั้น (ลดยอดที่ต้องจ่ายด้วย)
-- ต้องโอนเงินคืนก่อน แล้วอัปโหลดสลิปโอนคืนไว้ในโฟลเดอร์ของเหรัญญิกใน bucket "slips"
create function public.refund_member(
  p_member_id uuid,
  p_amount_satang bigint,
  p_reason text,
  p_slip_path text,
  p_member_charge_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  m members;
  mc member_charges;
  what text;
  entry_id bigint;
  rid uuid;
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิกเท่านั้นที่คืนเงินได้';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่คืนเงิน';
  end if;
  if p_amount_satang is null or p_amount_satang <= 0 then
    raise exception 'ยอดคืนเงินต้องมากกว่า 0';
  end if;
  if split_part(p_slip_path, '/', 1) <> auth.uid()::text
     or not exists (select 1 from storage.objects where bucket_id = 'slips' and name = p_slip_path) then
    raise exception 'ไม่พบไฟล์สลิปโอนคืน กรุณาอัปโหลดใหม่';
  end if;

  select * into m from members where id = p_member_id for update; -- ทีละคน กันคืนเครดิตเดียวกันซ้ำ
  if not found then
    raise exception 'ไม่พบสมาชิก';
  end if;

  if p_member_charge_id is null then
    if p_amount_satang > member_credit_satang(m.id) then
      raise exception 'ยอดคืนเกินเครดิตคงเหลือ (% บาท)', baht(member_credit_satang(m.id));
    end if;
    what := 'เครดิตจ่ายเกิน';
  else
    select * into mc from member_charges where id = p_member_charge_id and member_id = m.id for update;
    if not found then
      raise exception 'ไม่พบรายการเรียกเก็บของสมาชิกคนนี้';
    end if;
    if p_amount_satang > mc.paid_satang then
      raise exception 'ยอดคืนเกินยอดที่ชำระแล้วของรายการนี้ (% บาท)', baht(mc.paid_satang);
    end if;
    update member_charges
    set paid_satang = paid_satang - p_amount_satang, amount_satang = amount_satang - p_amount_satang
    where id = mc.id;
    select title into what from charges where id = mc.charge_id;
  end if;

  insert into ledger_entries (kind, amount_satang, description, evidence_path)
  values ('refund', -p_amount_satang, format('คืนเงิน: %s (%s) — %s', m.full_name, m.student_id, what), p_slip_path)
  returning id into entry_id;

  insert into refunds (member_id, member_charge_id, amount_satang, reason, slip_path, ledger_entry_id)
  values (m.id, p_member_charge_id, p_amount_satang, trim(p_reason), p_slip_path, entry_id)
  returning id into rid;

  perform notify(m.user_id, 'info', format('คืนเงิน %s บาท (%s): %s', baht(p_amount_satang), what, trim(p_reason)),
                 '#my-payments', 'refund:' || rid)
  where m.user_id is not null;
  return rid;
end $$;

-- ใช้เครดิตได้ไม่เกินเครดิตคงเหลือจริง (หักเครดิตที่คืนไปแล้ว)
create or replace function public.apply_credit(p_member_charge_id uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  mc member_charges;
  need bigint;
  s record;
  take bigint;
  used bigint := 0;
begin
  select * into mc from member_charges where id = p_member_charge_id;
  if not found or not (mc.member_id = my_member_id() or has_role('treasurer')) then
    raise exception 'ไม่พบรายการเรียกเก็บ';
  end if;

  perform 1 from members where id = mc.member_id for update;
  select * into mc from member_charges where id = p_member_charge_id for update;
  need := least(mc.amount_satang - mc.paid_satang, member_credit_satang(mc.member_id));

  for s in
    select ps.id, ps.amount_satang - coalesce(
             (select sum(amount_satang) from submission_allocations where submission_id = ps.id), 0) as remaining
    from payment_submissions ps
    where ps.member_id = mc.member_id and ps.status = 'confirmed'
    order by ps.reviewed_at
  loop
    exit when need <= 0;
    take := least(need, s.remaining);
    continue when take <= 0;
    insert into submission_allocations (submission_id, member_charge_id, amount_satang)
    values (s.id, mc.id, take)
    on conflict (submission_id, member_charge_id)
      do update set amount_satang = submission_allocations.amount_satang + excluded.amount_satang;
    need := need - take;
    used := used + take;
  end loop;

  if used = 0 then
    raise exception 'ไม่มีเครดิตคงเหลือ หรือรายการนี้ชำระครบแล้ว';
  end if;

  update member_charges set paid_satang = paid_satang + used where id = mc.id;
  return used;
end $$;

-- สรุปการเงิน: แยกเงินคืนสมาชิกออกจากรายจ่าย
drop function public.fund_summary();
create function public.fund_summary()
returns table (opening_satang bigint, income_satang bigint, expense_satang bigint, refund_satang bigint,
               balance_satang bigint, pending_slips int, pending_expenses int, approved_unpaid_satang bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return query
  select coalesce(sum(amount_satang) filter (where kind = 'opening_balance'), 0)::bigint,
         coalesce(sum(amount_satang) filter (where kind = 'income'), 0)::bigint,
         coalesce(-sum(amount_satang) filter (where kind = 'expense'), 0)::bigint,
         coalesce(-sum(amount_satang) filter (where kind = 'refund'), 0)::bigint,
         coalesce(sum(amount_satang), 0)::bigint,
         (select count(*)::int from payment_submissions where status = 'pending'),
         (select count(*)::int from expense_requests where status = 'pending'),
         (select coalesce(sum(amount_satang), 0)::bigint from expense_requests where status = 'approved')
  from ledger_entries where voided_at is null;
end $$;

revoke execute on function public.void_payment(uuid, text) from public, anon;
revoke execute on function public.refund_member(uuid, bigint, text, text, uuid) from public, anon;
revoke execute on function public.fund_summary() from public, anon;
grant execute on function public.void_payment(uuid, text) to authenticated;
grant execute on function public.refund_member(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.fund_summary() to authenticated;
