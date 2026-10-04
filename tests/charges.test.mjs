// ตรวจการจัดการรายการเรียกเก็บ: เพิ่มคนทีหลัง แก้รายการ เลื่อนวันครบกำหนด และหมวดค่าใช้จ่าย
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'president', 't1', 'alice', 'bob']);

await as(null, `insert into members (student_id, full_name, email) values
  ('1', 'แอดมิน', 'admin@x.th'), ('2', 'ประธาน', 'president@x.th'), ('3', 'เหรัญญิก', 't1@x.th'), ('5', 'อลิซ', 'alice@x.th')`);
for (const [who, sid] of [['admin', '1'], ['president', '2'], ['t1', '3'], ['alice', '5']]) await signup(who, sid, `${who}@x.th`);
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin'), ($2, 'president'), ($3, 'treasurer')`,
  [ids.admin, ids.president, ids.t1]);
const one = async (...a) => (await as(...a))[0];

const fee = (await one('president', `select create_charge('ค่ากิจกรรม', 50000, '2026-11-10', p_student_ids => '{5}') as id`)).id;
const count = () => one(null, `select count(*)::int as n from member_charges where charge_id = $1`, [fee]).then(r => r.n);
assert.equal(await count(), 1);

// ── เพิ่มคนทีหลัง: เฉพาะประธาน/แอดมิน ไม่ซ้ำ แจ้งคนที่ถูกเพิ่ม
await as(null, `insert into members (student_id, full_name, email) values ('6', 'บ๊อบ', 'bob@x.th')`);
await signup('bob', '6', 'bob@x.th');
await assert.rejects(as('t1', `select add_to_charge($1, '{6}')`, [fee]), /เฉพาะประธานหรือแอดมิน/);
await assert.rejects(as('president', `select add_to_charge($1, '{6,999}')`, [fee]), /ไม่พบรหัสนิสิต: 999/);
await assert.rejects(as('president', `select add_to_charge($1, '{6}', 0)`, [fee]), /มากกว่า 0/);
assert.equal((await one('president', `select add_to_charge($1, '{6,5}') as n`, [fee])).n, 1, 'อลิซอยู่แล้ว เพิ่มแค่บ๊อบ');
assert.equal((await one('president', `select add_to_charge($1, '{6}') as n`, [fee])).n, 0, 'เพิ่มซ้ำไม่ได้');
assert.deepEqual(await as('bob', `select amount_satang, outstanding_satang from charge_balances where charge_id = $1`, [fee]),
  [{ amount_satang: 50000, outstanding_satang: 50000 }]);
assert.equal((await as('bob', `select * from notifications where title = 'รายการเรียกเก็บใหม่: ค่ากิจกรรม 500 บาท'`)).length, 1);

// เว้นว่าง = ทุกคนที่ยังไม่อยู่ในรายการ (แอดมิน ประธาน เหรัญญิก) ยอดต่อคนกำหนดเองได้
assert.equal((await one('admin', `select add_to_charge($1, null, 30000) as n`, [fee])).n, 3);
assert.equal(await count(), 5);
assert.equal((await one('t1', `select amount_satang from charge_balances where charge_id = $1 and member_id = my_member_id()`, [fee])).amount_satang, 30000);

await as('president', `update charges set status = 'closed' where id = $1`, [fee]);
await assert.rejects(as('president', `select add_to_charge($1, '{6}')`, [fee]), /ปิดรับชำระแล้ว/);
await as('president', `update charges set status = 'open' where id = $1`, [fee]);

// ── แก้รายการ: ประธาน/แอดมินแก้ชื่อและวันครบกำหนดได้ สมาชิกแก้ไม่ได้
assert.equal((await as('alice', `update charges set title = 'x' where id = $1 returning id`, [fee])).length, 0);
await as('president', `update charges set title = 'ค่ากิจกรรมรุ่น', due_date = '2026-11-10' where id = $1`, [fee]);

// ── เลื่อนวันครบกำหนดแล้วต้องเตือนใหม่
const remind = d => one(null, `select remind_due($1::date) as n`, [d]).then(x => x.n);
const soonNotes = () => as('alice', `select title from notifications where title like 'อีก % วันครบกำหนด%' order by id`);
await remind('2026-11-08');
assert.equal((await soonNotes()).length, 1);
await as('president', `update charges set due_date = '2026-11-20' where id = $1`, [fee]);
await remind('2026-11-11');
assert.equal((await as('alice', `select * from notifications where title like 'เลยกำหนด%'`)).length, 0, 'เลื่อนวันแล้วไม่ถือว่าเลยกำหนด');
await remind('2026-11-18');
assert.deepEqual((await soonNotes()).map(n => n.title),
  ['อีก 2 วันครบกำหนดชำระ ค่ากิจกรรมรุ่น (ค้าง 500 บาท)', 'อีก 2 วันครบกำหนดชำระ ค่ากิจกรรมรุ่น (ค้าง 500 บาท)'],
  'เตือนใหม่ตามวันครบกำหนดใหม่');

// ── หมวดค่าใช้จ่าย: แอดมินเพิ่ม/ซ่อนได้ ซ่อนแล้วคำขอเดิมยังอยู่ ลบไม่ได้
await assert.rejects(as('t1', `insert into expense_categories (name) values ('ค่าเช่าชุด')`), /row-level security/);
await as('admin', `insert into expense_categories (name, sort) values ('ค่าเช่าชุด', 50)`);
await as('alice', `select request_expense('เช่าชุดเชียร์', 20000, 'ค่าเช่าชุด')`);
await as('admin', `update expense_categories set active = false where name = 'ค่าเช่าชุด'`);
assert.equal((await as('alice', `select * from expense_requests where category = 'ค่าเช่าชุด'`)).length, 1);
await assert.rejects(as(null, `delete from expense_categories where name = 'ค่าเช่าชุด'`), /ลบหรือแก้ไขไม่ได้/);
