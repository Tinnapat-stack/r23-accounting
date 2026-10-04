// ตรวจสิทธิ์และกฎของฐานข้อมูลระยะ 1 บน Postgres จริง (PGlite)
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'treasurer', 'alice', 'bob']);

// ── สมัครสมาชิก: ต้องตรงกับรายชื่อที่ลงทะเบียนไว้
await as(null, `insert into members (student_id, full_name, email) values
  ('6501', 'แอดมิน', 'admin@x.th'), ('6502', 'เหรัญญิก', 'treasurer@x.th'),
  ('6503', 'อลิซ', 'alice@x.th'), ('6504', 'บ๊อบ', 'bob@x.th')`);
await assert.rejects(signup('alice', '9999', 'alice@x.th'), /ไม่พบรหัสนิสิต/);
await assert.rejects(signup('alice', '6503', 'other@x.th'), /ไม่พบรหัสนิสิต/, 'อีเมลต้องตรงกับที่ลงทะเบียน');
await signup('admin', '6501', 'admin@x.th');
await signup('treasurer', '6502', 'Treasurer@X.th'); // ตัวพิมพ์ใหญ่เล็กไม่มีผล
await signup('alice', '6503', 'alice@x.th');
await signup('bob', '6504', 'bob@x.th');
await assert.rejects(signup('admin', '6503', 'alice@x.th'), /ไม่พบรหัสนิสิต|duplicate/, 'สมัครซ้ำไม่ได้');
assert.deepEqual(await as('alice', `select role from user_roles`), [{ role: 'member' }]);
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin')`, [ids.admin]);

// ── แอดมินให้บทบาทคนอื่นได้ แต่ให้ตัวเองไม่ได้ และสมาชิกทั่วไปให้ไม่ได้
await as('admin', `insert into user_roles (user_id, role) values ($1, 'treasurer')`, [ids.treasurer]);
await assert.rejects(as('admin', `insert into user_roles (user_id, role) values ($1, 'treasurer')`, [ids.admin]), /row-level security/);
await assert.rejects(as('alice', `insert into user_roles (user_id, role) values ($1, 'admin')`, [ids.alice]), /row-level security/);

// ── สมาชิกเห็นเฉพาะข้อมูลตัวเอง
assert.deepEqual(await as('alice', `select student_id from members`), [{ student_id: '6503' }]);
assert.equal((await as('treasurer', `select * from members`)).length, 4);
await assert.rejects(as('alice', `insert into members (student_id, full_name, email) values ('7', 'x', 'x@x.th')`), /row-level security/);
await as('admin', `insert into members (student_id, full_name, email) values ('6505', 'ชาลี', 'c@x.th')`);
await assert.rejects(as('admin', `update members set user_id = $1 where student_id = '6505'`, [ids.alice]), /permission denied/,
  'แอดมินแก้การผูกบัญชีไม่ได้');

// ── รายการเรียกเก็บ: ประธาน/แอดมินสร้าง สมาชิกเห็นยอดของตัวเอง
await as('admin', `insert into charges (title, amount_satang) values ('ค่ากิจกรรมรุ่น', 50000)`);
await assert.rejects(as('alice', `insert into charges (title, amount_satang) values ('x', 100)`), /row-level security/);
await as('admin', `insert into member_charges (charge_id, member_id, amount_satang)
  select c.id, m.id, c.amount_satang from charges c, members m`);
assert.equal((await as('alice', `select * from member_charges`)).length, 1);

// ── สลิปและสมุดบัญชี: สมาชิกเห็นเฉพาะของตัวเอง แอดมินไม่เห็นเงินอัตโนมัติ
await as(null, `insert into payment_submissions (member_id, amount_satang, transferred_at, slip_path)
  select id, 50000, now(), user_id || '/a.jpg' from members where user_id is not null`);
assert.equal((await as('alice', `select * from payment_submissions`)).length, 1);
assert.equal((await as('treasurer', `select * from payment_submissions`)).length, 4);
assert.equal((await as('admin', `select * from payment_submissions`)).length, 1, 'แอดมินเห็นแค่ของตัวเอง');
assert.equal((await as('alice', `update payment_submissions set status = 'confirmed' returning id`)).length, 0,
  'สมาชิกยืนยันสลิปตัวเองไม่ได้');

await as(null, `insert into ledger_entries (kind, amount_satang, description, submission_id)
  select 'income', 50000, 'ค่ากิจกรรมรุ่น', id from payment_submissions limit 1`);
assert.equal((await as('alice', `select * from ledger_entries`)).length, 0);
assert.equal((await as('admin', `select * from ledger_entries`)).length, 0);
assert.equal((await as('treasurer', `select * from ledger_entries`)).length, 1);
await assert.rejects(as(null, `insert into ledger_entries (kind, amount_satang, description, submission_id)
  select 'income', 50000, 'ซ้ำ', submission_id from ledger_entries`), /duplicate key/, 'สลิปเดียวรายรับเดียว');
await assert.rejects(as(null, `insert into ledger_entries (kind, amount_satang, description) values ('expense', 100, 'x')`), /check constraint/);

// สมุดบัญชีแก้ยอด/ลบไม่ได้ แม้เป็น superuser ยกเลิกได้ครั้งเดียว
await assert.rejects(as(null, `update ledger_entries set amount_satang = 1`), /แก้ไม่ได้/);
await assert.rejects(as(null, `delete from ledger_entries`), /ลบหรือแก้ไขไม่ได้/);
await as(null, `update ledger_entries set voided_at = now(), void_reason = 'บันทึกซ้ำ'`);
await assert.rejects(as(null, `update ledger_entries set void_reason = 'เปลี่ยน'`), /แก้ไม่ได้/);
await as(null, `insert into ledger_entries (kind, amount_satang, description, submission_id)
  select 'income', 50000, 'ลงใหม่', submission_id from ledger_entries`); // ยกเลิกแล้วลงใหม่ได้

// ── แจ้งเตือน: เห็นของตัวเอง แก้ได้แค่ "อ่านแล้ว"
await as(null, `insert into notifications (user_id, kind, title) values ($1, 'pending', 'มีสลิปใหม่รอตรวจสอบ')`, [ids.treasurer]);
assert.equal((await as('alice', `select * from notifications`)).length, 0);
assert.equal((await as('treasurer', `update notifications set read_at = now() returning id`)).length, 1);
await assert.rejects(as('treasurer', `update notifications set title = 'x'`), /permission denied/);

// ── ประวัติการกระทำ: บันทึกอัตโนมัติ แก้/ลบไม่ได้ สมาชิกทั่วไปอ่านไม่ได้
const log = await as('admin', `select actor, table_name from audit_log where table_name = 'user_roles' and actor is not null`);
assert.deepEqual(log, [{ actor: ids.admin, table_name: 'user_roles' }]);
assert.equal((await as('alice', `select * from audit_log`)).length, 0);
await assert.rejects(as(null, `delete from audit_log`), /ลบหรือแก้ไขไม่ได้/);
await assert.rejects(as(null, `truncate audit_log`), /ลบหรือแก้ไขไม่ได้/);
await assert.rejects(as(null, `delete from members where student_id = '6505'`), /ลบหรือแก้ไขไม่ได้/);

// ── ที่เก็บสลิป: อัปโหลดได้แค่โฟลเดอร์ตัวเอง เหรัญญิกอ่านได้ทุกใบ
await as('alice', `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [`${ids.alice}/s1.jpg`]);
await assert.rejects(as('alice', `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [`${ids.bob}/x.jpg`]), /row-level security/);
await as('bob', `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [`${ids.bob}/s2.jpg`]);
assert.equal((await as('alice', `select * from storage.objects`)).length, 1);
assert.equal((await as('treasurer', `select * from storage.objects`)).length, 2);
assert.equal((await as('admin', `select * from storage.objects`)).length, 0);

// ── ระงับบัญชีแล้วสิทธิ์หายทันที
await as('admin', `select set_member_active(id, false, 'ทดสอบ') from members where user_id = $1`, [ids.treasurer]);
assert.equal((await as('treasurer', `select * from ledger_entries`)).length, 0);

console.log('ผ่านทุกข้อ ✓');
