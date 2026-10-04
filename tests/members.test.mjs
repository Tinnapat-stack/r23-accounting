// ตรวจการจัดการสมาชิก: นำเข้ารายชื่อ แก้ข้อมูล ระงับ/เปิดบัญชีพร้อมเหตุผล
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'alice']);

await as(null, `insert into members (student_id, full_name, email) values ('1', 'แอดมิน', 'admin@x.th'), ('2', 'อลิซ', 'alice@x.th')`);
await signup('admin', '1', 'admin@x.th');
await signup('alice', '2', 'alice@x.th');
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin')`, [ids.admin]);

// ── นำเข้า: แถวที่ผิดหรือซ้ำไม่ทำให้แถวอื่นล้ม
const rows = [
  { student_id: '10', full_name: 'สมชาย', email: 'Somchai@X.th' },
  { student_id: '11', full_name: 'สมหญิง', email: 'not-an-email' },
  { student_id: '2', full_name: 'ซ้ำรหัส', email: 'dup@x.th' },
  { student_id: '12', full_name: 'ซ้ำอีเมล', email: 'alice@x.th' },
  { student_id: '', full_name: 'ไม่มีรหัส', email: 'a@x.th' },
  { student_id: '13', full_name: 'พิชญ์', email: 'pich@x.th' },
];
await assert.rejects(as('alice', `select * from import_members($1::jsonb)`, [JSON.stringify(rows)]), /เฉพาะแอดมิน/);
const res = await as('admin', `select student_id, result from import_members($1::jsonb)`, [JSON.stringify(rows)]);
assert.deepEqual(res.map(r => r.result), [
  'เพิ่มแล้ว', 'ข้อมูลไม่ครบหรืออีเมลไม่ถูกต้อง', 'มีรหัสนิสิตหรืออีเมลนี้อยู่แล้ว',
  'มีรหัสนิสิตหรืออีเมลนี้อยู่แล้ว', 'ข้อมูลไม่ครบหรืออีเมลไม่ถูกต้อง', 'เพิ่มแล้ว',
]);
assert.equal((await as(null, `select email from members where student_id = '10'`))[0].email, 'somchai@x.th');
assert.equal((await as(null, `select count(*)::int as n from members`))[0].n, 4);

// ── แก้ชื่อ/อีเมลได้ แต่เปลี่ยนสถานะตรง ๆ ไม่ได้ ต้องผ่านฟังก์ชันที่บังคับเหตุผล
await as('admin', `update members set full_name = 'สมชาย ใจดี' where student_id = '10'`);
assert.equal((await as('alice', `update members set full_name = 'x' where student_id = '2' returning id`)).length, 0,
  'สมาชิกแก้ชื่อตัวเองไม่ได้');
await assert.rejects(as('admin', `update members set active = false where student_id = '2'`), /permission denied/);

const alice = (await as(null, `select id from members where student_id = '2'`))[0].id;
const admin = (await as(null, `select id from members where student_id = '1'`))[0].id;
await assert.rejects(as('admin', `select set_member_active($1, false, '  ')`, [alice]), /ระบุเหตุผล/);
await assert.rejects(as('alice', `select set_member_active($1, false, 'x')`, [alice]), /เฉพาะแอดมิน/);
await assert.rejects(as('admin', `select set_member_active($1, false, 'x')`, [admin]), /ระงับบัญชีตัวเองไม่ได้/);
await as('admin', `select set_member_active($1, false, 'ลาออกจากรุ่น')`, [alice]);
await assert.rejects(as('admin', `select set_member_active($1, false, 'ซ้ำ')`, [alice]), /เป็นแบบนั้นอยู่แล้ว/);

// ระงับแล้วเหตุผลอยู่ในประวัติ และสิทธิ์หาย (แจ้งชำระไม่ได้)
const log = await as('admin', `select reason, actor from audit_log
  where table_name = 'members' and row_id = $1 and new_data ->> 'active' = 'false'`, [alice]);
assert.deepEqual(log, [{ reason: 'ลาออกจากรุ่น', actor: ids.admin }]);
assert.equal((await as('alice', `select my_member_id() as id`))[0].id, null);

await as('admin', `select set_member_active($1, true, 'กลับเข้ารุ่น')`, [alice]);
assert.equal((await as('alice', `select my_member_id() as id`))[0].id, alice);
