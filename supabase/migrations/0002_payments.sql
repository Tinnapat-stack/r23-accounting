-- ระบบบัญชีรุ่นที่ 23 — ระยะ 2: เรียกเก็บเงิน แจ้งชำระ ตรวจสลิป และแจ้งเตือน
-- การเขียนข้อมูลเงินทั้งหมดผ่านฟังก์ชันด้านล่าง ซึ่งตรวจสิทธิ์และทำทุกขั้นในธุรกรรมเดียว

-- ─── ยอดที่ชำระแล้วต่อรายการ ───────────────────────────────────────
-- เก็บไว้ในแถวเพื่อให้สมาชิกที่ถูกจ่ายแทนเห็นยอดของตัวเอง (มองไม่เห็นสลิปของคนจ่ายแทน)
-- เปลี่ยนได้ผ่าน confirm_payment / apply_credit เท่านั้น
alter table public.member_charges
  add column paid_satang bigint not null default 0,
  add constraint paid_within_amount check (paid_satang between 0 and amount_satang);

revoke insert, update on public.member_charges from anon, authenticated;
grant insert (charge_id, member_id, amount_satang) on public.member_charges to authenticated;
grant update (amount_satang) on public.member_charges to authenticated;

alter table public.payment_submissions
  add column slip_sha256 text, -- ใช้เตือนเมื่อพบไฟล์สลิปเดิม
  add constraint one_submission_per_slip_file unique (slip_path);
create index on public.payment_submissions (slip_sha256);
create index on public.payment_submissions (reference_no);
create index on public.payment_submissions (status, created_at);

-- ─── มุมมองยอดค้างและเครดิต (ใช้สิทธิ์ของผู้เรียก) ────────────────────

create view public.charge_balances with (security_invoker = true) as
select mc.id as member_charge_id, mc.charge_id, c.title, c.due_date, c.status as charge_status,
       mc.member_id, m.student_id, m.full_name,
       mc.amount_satang, mc.paid_satang, mc.amount_satang - mc.paid_satang as outstanding_satang
from public.member_charges mc
join public.charges c on c.id = mc.charge_id
join public.members m on m.id = mc.member_id;

-- เครดิต = เงินที่ยืนยันแล้วแต่ยังไม่ได้ตัดเข้ารายการใด (จ่ายเกิน)
create view public.member_credit with (security_invoker = true) as
select s.member_id, sum(s.amount_satang - coalesce(a.allocated, 0))::bigint as credit_satang
from public.payment_submissions s
left join (select submission_id, sum(amount_satang) as allocated
           from public.submission_allocations group by submission_id) a on a.submission_id = s.id
where s.status = 'confirmed'
group by s.member_id;

-- ─── ตัวช่วยภายใน ─────────────────────────────────────────────────

create function public.baht(satang bigint) returns text
language sql immutable as $$
  select regexp_replace(to_char(satang / 100.0, 'FM999,999,990.00'), '\.00$', '')
$$;

-- ส่งซ้ำด้วย key เดิมจะไม่เกิดข้อความซ้ำ
create function public.notify(p_user uuid, p_kind text, p_title text, p_link text, p_key text) returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, kind, title, link, dedupe_key)
  values (p_user, p_kind, p_title, p_link, p_key)
  on conflict (user_id, dedupe_key) do nothing
$$;

create function public.active_treasurers() returns setof uuid
language sql stable security definer set search_path = public as $$
  select r.user_id from user_roles r join members m on m.user_id = r.user_id and m.active
  where r.role = 'treasurer'
$$;

revoke execute on function public.notify(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.active_treasurers() from public, anon, authenticated;

-- ─── ประธาน/แอดมิน: สร้างรายการเรียกเก็บ ──────────────────────────

-- p_student_ids = null คือเรียกเก็บสมาชิกที่ยังใช้งานทุกคน
create function public.create_charge(
  p_title text,
  p_amount_satang bigint,
  p_due_date date default null,
  p_description text default null,
  p_student_ids text[] default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
  missing text[];
begin
  if not has_role('president', 'admin') then
    raise exception 'เฉพาะประธานหรือแอดมินเท่านั้นที่สร้างรายการเรียกเก็บได้';
  end if;

  if p_student_ids is not null then
    select array_agg(sid) into missing
    from unnest(p_student_ids) sid
    where not exists (select 1 from members where student_id = sid and active);
    if missing is not null then
      raise exception 'ไม่พบรหัสนิสิต: %', array_to_string(missing, ', ');
    end if;
  end if;

  insert into charges (title, description, amount_satang, due_date)
  values (trim(p_title), nullif(trim(p_description), ''), p_amount_satang, p_due_date)
  returning id into cid;

  insert into member_charges (charge_id, member_id, amount_satang)
  select cid, id, p_amount_satang from members
  where active and (p_student_ids is null or student_id = any(p_student_ids));

  perform notify(m.user_id, 'action',
                 format('รายการเรียกเก็บใหม่: %s %s บาท', trim(p_title), baht(p_amount_satang)),
                 '#home', 'charge:' || cid)
  from member_charges mc join members m on m.id = mc.member_id
  where mc.charge_id = cid and m.user_id is not null;

  return cid;
end $$;

-- ─── สมาชิก: แจ้งชำระ ─────────────────────────────────────────────

-- อัปโหลดสลิปไปที่ slips/<user id>/... ก่อน แล้วจึงเรียกฟังก์ชันนี้
-- p_items = [{"charge_id": "...", "student_id": "...(เว้นว่าง = ตัวเอง)", "amount_satang": 50000}, ...]
-- ยอดโอนที่เกินผลรวม items จะกลายเป็นเครดิตเมื่อยืนยันแล้ว
create function public.submit_payment(
  p_amount_satang bigint,
  p_transferred_at timestamptz,
  p_slip_path text,
  p_items jsonb default '[]',
  p_bank_account_id uuid default null,
  p_payer_bank text default null,
  p_reference_no text default null,
  p_note text default null,
  p_slip_sha256 text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me members;
  sid uuid;
  item jsonb;
  mc member_charges;
  amt bigint;
  total bigint := 0;
begin
  select * into me from members where user_id = auth.uid() and active;
  if not found then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์แจ้งชำระ';
  end if;

  if split_part(p_slip_path, '/', 1) <> auth.uid()::text
     or not exists (select 1 from storage.objects where bucket_id = 'slips' and name = p_slip_path) then
    raise exception 'ไม่พบไฟล์สลิป กรุณาอัปโหลดใหม่';
  end if;

  if p_transferred_at > now() + interval '5 minutes' then
    raise exception 'วันเวลาโอนอยู่ในอนาคต';
  end if;

  insert into payment_submissions (member_id, bank_account_id, amount_satang, transferred_at,
                                   payer_bank, reference_no, note, slip_path, slip_sha256)
  values (me.id, p_bank_account_id, p_amount_satang, p_transferred_at,
          nullif(trim(p_payer_bank), ''), nullif(trim(p_reference_no), ''), nullif(trim(p_note), ''),
          p_slip_path, p_slip_sha256)
  returning id into sid;

  for item in select * from jsonb_array_elements(p_items) loop
    amt := (item ->> 'amount_satang')::bigint;
    select mc2.* into mc
    from member_charges mc2
    join members m on m.id = mc2.member_id
    join charges c on c.id = mc2.charge_id
    where mc2.charge_id = (item ->> 'charge_id')::uuid
      and m.student_id = coalesce(nullif(trim(item ->> 'student_id'), ''), me.student_id)
      and c.status = 'open';
    if not found then
      raise exception 'ไม่พบรายการเรียกเก็บที่เปิดอยู่ของรหัสนิสิต %',
        coalesce(nullif(trim(item ->> 'student_id'), ''), me.student_id);
    end if;
    if amt > mc.amount_satang - mc.paid_satang then
      raise exception 'ยอดที่ระบุเกินยอดค้างของรายการ (ค้าง % บาท)', baht(mc.amount_satang - mc.paid_satang);
    end if;
    insert into submission_allocations (submission_id, member_charge_id, amount_satang)
    values (sid, mc.id, amt);
    total := total + amt;
  end loop;

  if total > p_amount_satang then
    raise exception 'ยอดที่แบ่งให้แต่ละรายการรวมกันเกินยอดโอน';
  end if;

  perform notify(t, 'pending',
                 format('%s แจ้งชำระ %s บาท รอตรวจสอบ', me.full_name, baht(p_amount_satang)),
                 '#review/' || sid, 'submission:' || sid)
  from active_treasurers() t;

  return sid;
end $$;

-- ยกเลิกการแจ้งชำระของตัวเองที่ยังไม่ถูกตรวจ
create function public.cancel_payment(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update payment_submissions set status = 'cancelled'
  where id = p_id and member_id = my_member_id() and status = 'pending';
  if not found then
    raise exception 'ยกเลิกไม่ได้ รายการนี้ถูกตรวจไปแล้วหรือไม่ใช่ของคุณ';
  end if;
end $$;

-- ─── เหรัญญิก: ตรวจสลิป ───────────────────────────────────────────

create function public.status_th(s text) returns text
language sql immutable as $$
  select case s when 'pending' then 'รอตรวจสอบ' when 'confirmed' then 'ยืนยันแล้ว'
                when 'rejected' then 'ไม่ผ่านการตรวจสอบ' when 'cancelled' then 'ยกเลิกแล้ว' else s end
$$;

-- ล็อกแถวก่อนตรวจ ผู้ตรวจสองคนกดพร้อมกัน คนที่สองจะได้ข้อความว่าตรวจไปแล้ว
create function public.lock_pending_submission(p_id uuid) returns public.payment_submissions
language plpgsql security definer set search_path = public as $$
declare
  s payment_submissions;
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิกเท่านั้นที่ตรวจสลิปได้';
  end if;
  select * into s from payment_submissions where id = p_id for update;
  if not found then
    raise exception 'ไม่พบรายการแจ้งชำระ';
  end if;
  if s.status <> 'pending' then
    raise exception 'รายการนี้ถูกตรวจไปแล้ว (สถานะ: %)', status_th(s.status);
  end if;
  return s;
end $$;
revoke execute on function public.lock_pending_submission(uuid) from public, anon, authenticated;

-- ยืนยันรับเงิน: สร้างรายรับหนึ่งรายการ + ตัดยอดค้าง + แจ้งผู้เกี่ยวข้อง
create function public.confirm_payment(p_id uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  s payment_submissions := lock_pending_submission(p_id);
  payer members;
  a record;
  entry_id bigint;
begin
  for a in select * from submission_allocations where submission_id = p_id loop
    update member_charges set paid_satang = paid_satang + a.amount_satang
    where id = a.member_charge_id and paid_satang + a.amount_satang <= amount_satang;
    if not found then
      raise exception 'ยอดชำระเกินยอดค้างของรายการ (อาจมีการชำระไปแล้ว) ให้กด "ไม่ผ่าน" แล้วให้สมาชิกส่งใหม่';
    end if;
  end loop;

  update payment_submissions set status = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;

  select * into payer from members where id = s.member_id;
  insert into ledger_entries (kind, amount_satang, description, submission_id)
  values ('income', s.amount_satang, format('รับชำระจาก %s (%s)', payer.full_name, payer.student_id), p_id)
  returning id into entry_id;

  perform notify(payer.user_id, 'success', format('ยืนยันรับเงิน %s บาทแล้ว', baht(s.amount_satang)),
                 '#my-payments', 'submission-result:' || p_id)
  where payer.user_id is not null;

  -- คนที่ถูกจ่ายแทน
  perform notify(m.user_id, 'success',
                 format('%s ชำระ %s แทนคุณ %s บาท', payer.full_name, c.title, baht(sa.amount_satang)),
                 '#home', 'paid-for:' || p_id)
  from submission_allocations sa
  join member_charges mc on mc.id = sa.member_charge_id
  join charges c on c.id = mc.charge_id
  join members m on m.id = mc.member_id
  where sa.submission_id = p_id and m.id <> payer.id and m.user_id is not null;

  return entry_id;
end $$;

create function public.reject_payment(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s payment_submissions;
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผลที่ไม่ผ่าน';
  end if;
  s := lock_pending_submission(p_id);

  update payment_submissions
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), reject_reason = trim(p_reason)
  where id = p_id;

  perform notify(m.user_id, 'action',
                 format('สลิป %s บาทไม่ผ่านการตรวจสอบ: %s กรุณาส่งใหม่', baht(s.amount_satang), trim(p_reason)),
                 '#my-payments', 'submission-result:' || p_id)
  from members m where m.id = s.member_id and m.user_id is not null;
end $$;

-- ─── ใช้เครดิตจ่ายเกินตัดรายการค้าง ──────────────────────────────────

-- สมาชิกเจ้าของรายการหรือเหรัญญิกเป็นคนกด คืนค่ายอดที่ตัดได้
create function public.apply_credit(p_member_charge_id uuid) returns bigint
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

  -- ทำทีละคน กันกดซ้ำแล้วใช้เครดิตเดียวกันสองครั้ง
  perform 1 from members where id = mc.member_id for update;
  select * into mc from member_charges where id = p_member_charge_id for update;
  need := mc.amount_satang - mc.paid_satang;

  for s in
    select ps.id, ps.amount_satang - coalesce(
             (select sum(amount_satang) from submission_allocations where submission_id = ps.id), 0) as remaining
    from payment_submissions ps
    where ps.member_id = mc.member_id and ps.status = 'confirmed'
    order by ps.reviewed_at
  loop
    exit when need = 0;
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

revoke execute on function public.create_charge(text, bigint, date, text, text[]) from public, anon;
revoke execute on function public.submit_payment(bigint, timestamptz, text, jsonb, uuid, text, text, text, text) from public, anon;
revoke execute on function public.cancel_payment(uuid) from public, anon;
revoke execute on function public.confirm_payment(uuid) from public, anon;
revoke execute on function public.reject_payment(uuid, text) from public, anon;
revoke execute on function public.apply_credit(uuid) from public, anon;
grant execute on function public.create_charge(text, bigint, date, text, text[]) to authenticated;
grant execute on function public.submit_payment(bigint, timestamptz, text, jsonb, uuid, text, text, text, text) to authenticated;
grant execute on function public.cancel_payment(uuid) to authenticated;
grant execute on function public.confirm_payment(uuid) to authenticated;
grant execute on function public.reject_payment(uuid, text) to authenticated;
grant execute on function public.apply_credit(uuid) to authenticated;

-- ─── อัปเดตทันทีบนหน้าเว็บ (Supabase Realtime เคารพ RLS) ─────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.payment_submissions;
  end if;
end $$;
