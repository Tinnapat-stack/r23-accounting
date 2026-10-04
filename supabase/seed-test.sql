-- ข้อมูลทดสอบ — ใช้กับ "โปรเจ็กต์ทดสอบ" เท่านั้น ห้ามรันในโปรเจ็กต์ที่ใช้เงินจริง
-- (ตารางการเงินลบแถวไม่ได้ ทดสอบเสร็จให้ลบทั้งโปรเจ็กต์ทดสอบทิ้ง แล้วสร้างโปรเจ็กต์ใหม่สำหรับใช้จริง)
--
-- Gmail ส่งอีเมลถึง ชื่อ+อะไรก็ได้@gmail.com เข้ากล่องเดียวกัน จึงใช้ Gmail เดียวทดสอบได้ทั้ง 5 บทบาท
--
-- ขั้นที่ 1: แก้ YOUR_GMAIL ด้านล่างเป็นชื่อ Gmail ของคุณ (เฉพาะส่วนหน้า @gmail.com) แล้วรัน "ขั้นที่ 1" ใน SQL Editor
-- ขั้นที่ 2: สมัครผ่านหน้าเว็บทีละบัญชีตามตาราง (ใช้รหัสผ่านอะไรก็ได้ อย่างน้อย 8 ตัว)
--   รหัสนิสิต   อีเมล                         บทบาทหลังขั้นที่ 3
--   T001       YOUR_GMAIL+admin@gmail.com     แอดมิน
--   T002       YOUR_GMAIL+treasurer@gmail.com เหรัญญิก
--   T003       YOUR_GMAIL+president@gmail.com ประธาน
--   T004       YOUR_GMAIL+auditor@gmail.com   ผู้ตรวจสอบ
--   T005       YOUR_GMAIL+member@gmail.com    สมาชิกทั่วไป
-- ขั้นที่ 3: รัน "ขั้นที่ 3" ใน SQL Editor เพื่อให้บทบาท

-- ═══ ขั้นที่ 1 ═══════════════════════════════════════════════════════
do $$
declare
  g text := lower('YOUR_GMAIL');
  charge uuid;
begin
  if g = 'your_gmail' then
    raise exception 'แก้ YOUR_GMAIL เป็นชื่อ Gmail ของคุณก่อน';
  end if;

  insert into members (student_id, full_name, email) values
    ('T001', 'ทดสอบ แอดมิน',      g || '+admin@gmail.com'),
    ('T002', 'ทดสอบ เหรัญญิก',    g || '+treasurer@gmail.com'),
    ('T003', 'ทดสอบ ประธาน',      g || '+president@gmail.com'),
    ('T004', 'ทดสอบ ผู้ตรวจสอบ',  g || '+auditor@gmail.com'),
    ('T005', 'ทดสอบ สมาชิก',      g || '+member@gmail.com'),
    -- สมาชิกที่ยังไม่สมัคร ไว้ดูรายชื่อและยอดค้าง (example.com รับอีเมลไม่ได้)
    ('T006', 'สมชาย ใจดี',        't006@example.com'),
    ('T007', 'สมหญิง รักเรียน',   't007@example.com'),
    ('T008', 'พิชญ์ มีสุข',        't008@example.com');

  insert into bank_accounts (bank_name, account_name, account_no, promptpay)
  values ('ธนาคารทดสอบ', 'บัญชีทดสอบ รุ่น 23 (ห้ามโอนจริง)', '000-0-00000-0', null);

  insert into activities (name, description) values ('กิจกรรมรุ่น 2569 (ทดสอบ)', 'ข้อมูลทดสอบ');

  insert into charges (activity_id, title, description, amount_satang, due_date)
  select id, 'ค่ากิจกรรมรุ่น (ทดสอบ)', 'ข้อมูลทดสอบ', 50000, current_date + 30 from activities
  returning id into charge;

  insert into member_charges (charge_id, member_id, amount_satang)
  select charge, id, 50000 from members where student_id like 'T%';
end $$;

-- ═══ ขั้นที่ 3 (รันหลังสมัครครบแล้ว รันซ้ำได้) ══════════════════════════
insert into user_roles (user_id, role)
select m.user_id, r.role::public.app_role
from members m
join (values ('T001', 'admin'), ('T002', 'treasurer'), ('T003', 'president'), ('T004', 'auditor')) r (sid, role)
  on r.sid = m.student_id
where m.user_id is not null
on conflict do nothing;

-- ดูว่าใครสมัครแล้วและมีบทบาทอะไร
select m.student_id, m.full_name, m.user_id is not null as registered, array_agg(ur.role) as roles
from members m left join user_roles ur on ur.user_id = m.user_id
where m.student_id like 'T%'
group by 1, 2, 3 order by 1;
