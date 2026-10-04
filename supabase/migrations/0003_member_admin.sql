-- ระบบบัญชีรุ่นที่ 23 — จัดการสมาชิก: ระงับ/เปิดบัญชีพร้อมเหตุผล และนำเข้ารายชื่อทีละหลายคน

-- การระงับต้องผ่าน set_member_active เท่านั้น (บังคับเหตุผล) แก้ชื่อ/อีเมล/รหัสนิสิตยังทำตรงได้
revoke update on public.members from anon, authenticated;
grant update (student_id, full_name, email) on public.members to authenticated;

-- เหตุผลถูกเก็บใน audit_log.reason ผ่าน app.reason
create function public.set_member_active(p_member_id uuid, p_active boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('admin') then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ระงับหรือเปิดบัญชีได้';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'กรุณาระบุเหตุผล';
  end if;
  if p_member_id = my_member_id() then
    raise exception 'ระงับบัญชีตัวเองไม่ได้';
  end if;

  perform set_config('app.reason', trim(p_reason), true);
  update members set active = p_active where id = p_member_id and active <> p_active;
  if not found then
    raise exception 'ไม่พบสมาชิก หรือสถานะเป็นแบบนั้นอยู่แล้ว';
  end if;
end $$;

-- p_rows = [{"student_id": "...", "full_name": "...", "email": "..."}, ...]
-- คืนผลรายแถว: เพิ่มแล้ว / มีอยู่แล้ว / ข้อมูลไม่ถูกต้อง (แถวที่ผิดไม่ทำให้แถวอื่นล้ม)
create function public.import_members(p_rows jsonb)
returns table (student_id text, full_name text, email text, result text)
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  sid text;
  nm text;
  em text;
begin
  if not has_role('admin') then
    raise exception 'เฉพาะแอดมินเท่านั้นที่นำเข้ารายชื่อได้';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    sid := nullif(trim(r ->> 'student_id'), '');
    nm := nullif(trim(r ->> 'full_name'), '');
    em := lower(nullif(trim(r ->> 'email'), ''));
    student_id := sid; full_name := nm; email := em;

    if sid is null or nm is null or em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      result := 'ข้อมูลไม่ครบหรืออีเมลไม่ถูกต้อง';
    elsif exists (select 1 from members m where m.student_id = sid or m.email = em) then
      result := 'มีรหัสนิสิตหรืออีเมลนี้อยู่แล้ว';
    else
      insert into members (student_id, full_name, email) values (sid, nm, em);
      result := 'เพิ่มแล้ว';
    end if;
    return next;
  end loop;
end $$;

revoke execute on function public.set_member_active(uuid, boolean, text) from public, anon;
revoke execute on function public.import_members(jsonb) from public, anon;
grant execute on function public.set_member_active(uuid, boolean, text) to authenticated;
grant execute on function public.import_members(jsonb) to authenticated;
