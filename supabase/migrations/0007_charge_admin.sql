-- ระบบบัญชีรุ่นที่ 23 — เพิ่มคนเข้ารายการเรียกเก็บที่มีอยู่ และเตือนใหม่เมื่อเลื่อนวันครบกำหนด
-- (แก้ชื่อ/วันครบกำหนด และจัดการหมวดค่าใช้จ่าย ใช้สิทธิ์ตารางเดิมที่มีอยู่แล้ว ไม่ต้องเพิ่มฟังก์ชัน)

-- p_student_ids = null คือเพิ่มสมาชิกที่ใช้งานอยู่ทุกคนที่ยังไม่อยู่ในรายการ
-- p_amount_satang = null คือใช้ยอดต่อคนของรายการ คืนจำนวนคนที่เพิ่มจริง (คนที่อยู่แล้วไม่ถูกเพิ่มซ้ำ)
create function public.add_to_charge(p_charge_id uuid, p_student_ids text[] default null, p_amount_satang bigint default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  c charges;
  missing text[];
  added uuid[];
begin
  if not has_role('president', 'admin') then
    raise exception 'เฉพาะประธานหรือแอดมินเท่านั้นที่เพิ่มคนเข้ารายการได้';
  end if;
  select * into c from charges where id = p_charge_id;
  if not found then
    raise exception 'ไม่พบรายการเรียกเก็บ';
  end if;
  if c.status <> 'open' then
    raise exception 'รายการนี้ปิดรับชำระแล้ว ต้องเปิดรับชำระอีกครั้งก่อน';
  end if;
  if p_amount_satang is not null and p_amount_satang <= 0 then
    raise exception 'ยอดต่อคนต้องมากกว่า 0';
  end if;
  if p_student_ids is not null then
    select array_agg(sid) into missing
    from unnest(p_student_ids) sid
    where not exists (select 1 from members where student_id = sid and active);
    if missing is not null then
      raise exception 'ไม่พบรหัสนิสิต: %', array_to_string(missing, ', ');
    end if;
  end if;

  with ins as (
    insert into member_charges (charge_id, member_id, amount_satang)
    select c.id, m.id, coalesce(p_amount_satang, c.amount_satang)
    from members m
    where m.active and (p_student_ids is null or m.student_id = any(p_student_ids))
    on conflict (charge_id, member_id) do nothing
    returning member_id
  )
  select coalesce(array_agg(member_id), '{}') into added from ins;

  perform notify(m.user_id, 'action',
                 format('รายการเรียกเก็บใหม่: %s %s บาท', c.title, baht(coalesce(p_amount_satang, c.amount_satang))),
                 '#home', 'charge:' || c.id)
  from members m where m.id = any(added) and m.user_id is not null;

  return cardinality(added);
end $$;

revoke execute on function public.add_to_charge(uuid, text[], bigint) from public, anon;
grant execute on function public.add_to_charge(uuid, text[], bigint) to authenticated;

-- เตือนก่อนครบกำหนด: key รวมวันครบกำหนดด้วย ถ้าเลื่อนวัน จะเตือนใหม่ตามวันใหม่
create or replace function public.remind_due(p_today date default (now() at time zone 'Asia/Bangkok')::date) returns int
language plpgsql security definer set search_path = public as $$
declare
  soon int;
  late int;
begin
  insert into notifications (user_id, kind, title, link, dedupe_key)
  select user_id, 'action',
         case when due_date = p_today then format('วันนี้ครบกำหนดชำระ %s (ค้าง %s บาท)', title, baht(owed))
              else format('อีก %s วันครบกำหนดชำระ %s (ค้าง %s บาท)', due_date - p_today, title, baht(owed)) end,
         '#pay', 'due-soon:' || member_charge_id || ':' || due_date
  from outstanding_charges() where due_date - p_today between 0 and 3
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics soon = row_count;

  insert into notifications (user_id, kind, title, link, dedupe_key)
  select user_id, 'action', format('เลยกำหนดชำระ %s มาแล้ว %s วัน (ค้าง %s บาท)', title, p_today - due_date, baht(owed)),
         '#pay', 'overdue:' || member_charge_id || ':' || due_date || ':' || (p_today - due_date - 1) / 7
  from outstanding_charges() where p_today > due_date
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics late = row_count;

  return soon + late;
end $$;
revoke execute on function public.remind_due(date) from public, anon, authenticated;
