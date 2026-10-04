-- ระบบบัญชีรุ่นที่ 23 — ระยะ 1: ตารางหลัก สิทธิ์ ที่เก็บสลิป และประวัติการกระทำ
-- รันครั้งเดียวใน Supabase SQL Editor (หรือ `supabase db push`)
-- จำนวนเงินทุกช่องเก็บเป็น "สตางค์" (bigint) เช่น 500 บาท = 50000

create type public.app_role as enum ('member', 'treasurer', 'president', 'auditor', 'admin');

-- ─── สมาชิกและบทบาท ─────────────────────────────────────────────

-- แอดมินลงทะเบียนสมาชิกไว้ก่อน แล้วสมาชิกสมัครด้วยรหัสนิสิต + อีเมลที่ตรงกัน
create table public.members (
  id uuid primary key default gen_random_uuid(),
  student_id text not null unique,
  full_name text not null,
  email text not null unique check (email = lower(email)),
  user_id uuid unique references auth.users(id) on delete set null,
  active boolean not null default true, -- ระงับบัญชี = false (ไม่ลบแถว)
  created_at timestamptz not null default now()
);

-- คนหนึ่งมีได้หลายบทบาท เช่น สมาชิก + เหรัญญิก
create table public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  granted_by uuid default auth.uid(),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- ผู้ใช้ปัจจุบันมีบทบาทใดบทบาทหนึ่งนี้ และบัญชียังไม่ถูกระงับ
create function public.has_role(variadic roles public.app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles r join members m on m.user_id = r.user_id
    where r.user_id = auth.uid() and m.active and r.role = any(roles)
  )
$$;

create function public.my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from members where user_id = auth.uid() and active
$$;

-- ผูกบัญชีที่สมัครใหม่กับรายชื่อสมาชิก ถ้าไม่ตรงจะสมัครไม่สำเร็จ
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  mid uuid;
begin
  update members set user_id = new.id
   where student_id = trim(new.raw_user_meta_data ->> 'student_id')
     and email = lower(new.email)
     and user_id is null
     and active
  returning id into mid;

  if mid is null then
    raise exception 'ไม่พบรหัสนิสิตและอีเมลนี้ในรายชื่อ หรือถูกใช้สมัครไปแล้ว';
  end if;

  insert into user_roles (user_id, role, granted_by) values (new.id, 'member', null);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── กิจกรรมและการเรียกเก็บ ───────────────────────────────────────

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- รายการเรียกเก็บที่ประธาน/แอดมินสร้าง เช่น "ค่ากิจกรรมรุ่น 2569"
create table public.charges (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid references public.activities(id),
  title text not null,
  description text,
  amount_satang bigint not null check (amount_satang > 0), -- ยอดตั้งต้นต่อคน
  due_date date,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ยอดที่สมาชิกแต่ละคนต้องจ่ายในแต่ละรายการ (ยอดค้าง = ยอดนี้ − ยอดที่ยืนยันแล้ว)
create table public.member_charges (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.charges(id),
  member_id uuid not null references public.members(id),
  amount_satang bigint not null check (amount_satang > 0),
  created_at timestamptz not null default now(),
  unique (charge_id, member_id)
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_name text not null,
  account_name text not null,
  account_no text not null,
  promptpay text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── การแจ้งชำระ (สลิป) ───────────────────────────────────────────

create table public.payment_submissions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id), -- ผู้ส่งสลิป
  bank_account_id uuid references public.bank_accounts(id),
  amount_satang bigint not null check (amount_satang > 0),
  transferred_at timestamptz not null,
  payer_bank text,
  reference_no text,
  note text,
  slip_path text not null, -- ไฟล์ใน bucket "slips"
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected', 'cancelled')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  check (status <> 'rejected' or reject_reason is not null)
);

-- สลิปหนึ่งใบตัดยอดได้หลายรายการ/หลายคน (จ่ายบางส่วน จ่ายแทน)
-- ส่วนที่เหลือจากการจัดสรร = เครดิตจ่ายเกินของผู้ส่ง
create table public.submission_allocations (
  submission_id uuid not null references public.payment_submissions(id),
  member_charge_id uuid not null references public.member_charges(id),
  amount_satang bigint not null check (amount_satang > 0),
  primary key (submission_id, member_charge_id)
);

-- ─── สมุดบัญชี ───────────────────────────────────────────────────

-- เงินคงเหลือ = ผลรวม amount_satang ของรายการที่ไม่ถูกยกเลิก
-- ห้ามลบหรือแก้ยอด ถ้าผิดให้ยกเลิก (void) แล้วลงรายการใหม่
create table public.ledger_entries (
  id bigint generated always as identity primary key, -- แสดงเป็น TRX-000001
  kind text not null check (kind in ('income', 'expense', 'opening_balance', 'adjustment', 'refund')),
  amount_satang bigint not null, -- บวก = เงินเข้า, ลบ = เงินออก
  description text not null,
  submission_id uuid references public.payment_submissions(id),
  evidence_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  check ((voided_at is null) = (void_reason is null)),
  check (
    (kind = 'income' and amount_satang > 0)
    or (kind = 'opening_balance' and amount_satang >= 0)
    or (kind in ('expense', 'refund') and amount_satang < 0)
    or (kind = 'adjustment' and amount_satang <> 0)
  )
);

-- สลิปหนึ่งใบสร้างรายรับที่ใช้งานอยู่ได้รายการเดียว
create unique index ledger_one_income_per_submission
  on public.ledger_entries (submission_id) where voided_at is null;

-- ─── การแจ้งเตือน ─────────────────────────────────────────────────

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('action', 'pending', 'success', 'info')),
  title text not null,
  link text,
  dedupe_key text, -- ส่งซ้ำด้วย key เดิมจะไม่เกิดข้อความซ้ำ
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

-- ─── ประวัติการกระทำ (แก้/ลบไม่ได้) ───────────────────────────────

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  table_name text not null,
  row_id text,
  old_data jsonb,
  new_data jsonb,
  reason text
);

-- เหตุผลส่งมาได้ด้วย set_config('app.reason', '...', true) ในฟังก์ชันระยะถัดไป
create function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor, action, table_name, row_id, old_data, new_data, reason)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'id',
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    nullif(current_setting('app.reason', true), '')
  );
  return null;
end $$;

create function public.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'ข้อมูลในตาราง % ลบหรือแก้ไขไม่ได้', tg_table_name;
end $$;

-- สมุดบัญชี: แก้ได้อย่างเดียวคือยกเลิกรายการ และยกเลิกได้ครั้งเดียว
create function public.ledger_guard() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null
     or to_jsonb(new) - '{voided_at,voided_by,void_reason}'::text[]
        <> to_jsonb(old) - '{voided_at,voided_by,void_reason}'::text[] then
    raise exception 'รายการบัญชีแก้ไม่ได้ ให้ยกเลิกแล้วลงรายการใหม่';
  end if;
  return new;
end $$;

create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.forbid_change();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.forbid_change();

create trigger ledger_guard before update on public.ledger_entries
  for each row execute function public.ledger_guard();

do $$
declare
  t text;
begin
  -- ทุกตารางสำคัญเก็บประวัติ
  foreach t in array array['members', 'user_roles', 'activities', 'charges', 'member_charges',
                           'bank_accounts', 'payment_submissions', 'submission_allocations', 'ledger_entries']
  loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function public.audit_row()', t);
  end loop;
  -- ตารางการเงินห้ามลบแถว (ใช้ปิด/ระงับ/ยกเลิกแทน)
  foreach t in array array['members', 'activities', 'charges', 'member_charges', 'bank_accounts',
                           'payment_submissions', 'submission_allocations', 'ledger_entries']
  loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function public.forbid_change()', t);
  end loop;
end $$;

-- ─── สิทธิ์ (Row Level Security) ───────────────────────────────────
-- ตรวจที่ฐานข้อมูลทุกครั้ง ไม่พึ่งการซ่อนปุ่มบนหน้าเว็บ
-- แอดมินดูแลระบบ แต่ไม่ได้เห็นสมุดบัญชี/สลิปโดยอัตโนมัติ
-- การเขียนสลิป รายรับ และแจ้งเตือน จะทำผ่านฟังก์ชันในระยะ 2

alter table public.members enable row level security;
alter table public.user_roles enable row level security;
alter table public.activities enable row level security;
alter table public.charges enable row level security;
alter table public.member_charges enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.payment_submissions enable row level security;
alter table public.submission_allocations enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

create policy members_read on public.members for select to authenticated
  using (user_id = auth.uid() or public.has_role('treasurer', 'president', 'auditor', 'admin'));
create policy members_add on public.members for insert to authenticated
  with check (public.has_role('admin') and user_id is null);
create policy members_edit on public.members for update to authenticated
  using (public.has_role('admin'));

-- แอดมินให้/ถอนบทบาทคนอื่นได้ แต่ให้ตัวเองไม่ได้
create policy roles_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin', 'auditor'));
create policy roles_grant on public.user_roles for insert to authenticated
  with check (public.has_role('admin') and user_id <> auth.uid());
create policy roles_revoke on public.user_roles for delete to authenticated
  using (public.has_role('admin') and user_id <> auth.uid());

create policy activities_read on public.activities for select to authenticated using (true);
create policy activities_add on public.activities for insert to authenticated
  with check (public.has_role('president', 'admin'));
create policy activities_edit on public.activities for update to authenticated
  using (public.has_role('president', 'admin'));

create policy charges_read on public.charges for select to authenticated using (true);
create policy charges_add on public.charges for insert to authenticated
  with check (public.has_role('president', 'admin'));
create policy charges_edit on public.charges for update to authenticated
  using (public.has_role('president', 'admin'));

create policy member_charges_read on public.member_charges for select to authenticated
  using (member_id = public.my_member_id()
         or public.has_role('treasurer', 'president', 'auditor', 'admin'));
create policy member_charges_add on public.member_charges for insert to authenticated
  with check (public.has_role('president', 'admin'));
create policy member_charges_edit on public.member_charges for update to authenticated
  using (public.has_role('president', 'admin'));

create policy bank_accounts_read on public.bank_accounts for select to authenticated using (true);
create policy bank_accounts_add on public.bank_accounts for insert to authenticated
  with check (public.has_role('admin'));
create policy bank_accounts_edit on public.bank_accounts for update to authenticated
  using (public.has_role('admin'));

create policy submissions_read on public.payment_submissions for select to authenticated
  using (member_id = public.my_member_id() or public.has_role('treasurer', 'auditor'));

create policy allocations_read on public.submission_allocations for select to authenticated
  using (exists (select 1 from public.payment_submissions s where s.id = submission_id));

create policy ledger_read on public.ledger_entries for select to authenticated
  using (public.has_role('treasurer', 'president', 'auditor'));

create policy notifications_read on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = auth.uid());

create policy audit_read on public.audit_log for select to authenticated
  using (public.has_role('auditor', 'admin'));

-- จำกัดคอลัมน์ที่แก้ได้: ห้ามแก้การผูกบัญชีของสมาชิก, แจ้งเตือนแก้ได้แค่ "อ่านแล้ว"
revoke update on public.members, public.notifications from anon, authenticated;
grant update (student_id, full_name, email, active) on public.members to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ─── ที่เก็บสลิป (ไม่เปิดสาธารณะ) ──────────────────────────────────
-- ไฟล์อยู่ที่ slips/<user id>/<ชื่อไฟล์ที่ระบบสุ่ม> ขนาดไม่เกิน 5 MB เฉพาะรูปภาพ
-- ไม่มีนโยบายแก้/ลบ = อัปโหลดแล้วเปลี่ยนไม่ได้

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slips', 'slips', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy slips_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'slips'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.my_member_id() is not null);
create policy slips_read on storage.objects for select to authenticated
  using (bucket_id = 'slips'
         and ((storage.foldername(name))[1] = auth.uid()::text
              or public.has_role('treasurer', 'auditor')));
