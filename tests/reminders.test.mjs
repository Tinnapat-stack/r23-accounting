// ตรวจการยกเลิกการจ่ายที่บันทึกผิด และการเตือนยอดค้าง
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'president', 't1', 'alice', 'bob']);

await as(null, `insert into members (student_id, full_name, email) values
  ('1', 'แอดมิน', 'admin@x.th'), ('2', 'ประธาน', 'president@x.th'), ('3', 'เหรัญญิก', 't1@x.th'),
  ('5', 'อลิซ', 'alice@x.th'), ('6', 'บ๊อบ', 'bob@x.th'), ('7', 'ยังไม่สมัคร', 'x@x.th')`);
for (const [who, sid] of [['admin', '1'], ['president', '2'], ['t1', '3'], ['alice', '5'], ['bob', '6']]) {
  await signup(who, sid, `${who}@x.th`);
}
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin'), ($2, 'president'), ($3, 'treasurer')`,
  [ids.admin, ids.president, ids.t1]);
const one = async (...a) => (await as(...a))[0];

// ── ยกเลิกการจ่ายที่บันทึกผิด
async function evidence(who) {
  const path = `${ids[who]}/${crypto.randomUUID()}.jpg`;
  await as(who, `insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [path]);
  return path;
}
const e = (await one('alice', `select request_expense('ลูกบอล', 100000, 'อุปกรณ์') as id`)).id;
await as('t1', `select approve_expense($1)`, [e]);
await as('t1', `select pay_expense($1, 10000, $2)`, [e, await evidence('t1')]); // ใส่ยอดผิด 100 แทน 1,000
const expense = async () => (await one('alice', `select expense_satang from fund_summary()`)).expense_satang;
assert.equal(await expense(), 10000);

await assert.rejects(as('alice', `select void_expense_payment($1, 'x')`, [e]), /เฉพาะเหรัญญิก/);
await assert.rejects(as('t1', `select void_expense_payment($1, ' ')`, [e]), /ระบุเหตุผล/);
await as('t1', `select void_expense_payment($1, 'พิมพ์ยอดผิด')`, [e]);
const r = await one('alice', `select status, paid_satang, receipt_path, payment_void_note from expense_requests where id = $1`, [e]);
assert.equal(r.status, 'approved');
assert.equal(r.paid_satang, null);
assert.match((await one('bob', `select payment_void_note from expense_feed where id = $1`, [e])).payment_void_note, /พิมพ์ยอดผิด/,
  'ทุกคนเห็นว่าการจ่ายเคยถูกยกเลิกเพราะอะไร');
assert.match(r.payment_void_note, /ยกเลิกการจ่าย 100 บาท .*: พิมพ์ยอดผิด/);
assert.equal(await expense(), 0, 'เงินกองกลางกลับมาเท่าเดิม');
assert.deepEqual(await as('t1', `select void_reason from ledger_entries where kind = 'expense'`), [{ void_reason: 'พิมพ์ยอดผิด' }]);
await assert.rejects(as('t1', `select void_expense_payment($1, 'ซ้ำ')`, [e]), /สถานะ: อนุมัติแล้ว รอจ่าย/);

// บันทึกจ่ายใหม่ให้ถูกได้ และงบกลับมานับถูก
await as('t1', `select pay_expense($1, 100000, $2)`, [e, await evidence('t1')]);
assert.equal(await expense(), 100000);
assert.equal((await as('t1', `select * from ledger_entries where kind = 'expense' and voided_at is null`)).length, 1);
assert.match((await one('alice', `select title from notifications where title like '%ถูกยกเลิกเพื่อแก้ไข%'`)).title, /พิมพ์ยอดผิด/);
assert.deepEqual((await as('alice', `select title from notifications where title like 'จ่ายเงินตามคำขอเบิก%' order by id`)).map(n => n.title),
  ['จ่ายเงินตามคำขอเบิก "ลูกบอล" 100 บาทแล้ว', 'จ่ายเงินตามคำขอเบิก "ลูกบอล" 1,000 บาทแล้ว'], 'จ่ายใหม่ต้องแจ้งรอบใหม่');

// ── เตือนยอดค้าง
const fee = (await one('president', `select create_charge('ค่ากิจกรรม', 50000, '2026-11-10') as id`)).id;
await as(null, `update member_charges set paid_satang = 50000 where member_id = (select id from members where student_id = '6')`); // บ๊อบจ่ายครบแล้ว
const remind = d => one(null, `select remind_due($1::date) as n`, [d]).then(x => x.n);
const notes = who => as(who, `select title from notifications where link = '#pay' and title not like 'รายการเรียกเก็บใหม่%' order by id`);

await assert.rejects(as('alice', `select remind_due()`), /permission denied/, 'สมาชิกเรียกเตือนอัตโนมัติเองไม่ได้');
assert.equal(await remind('2026-11-01'), 0, 'ยังไม่ถึง 3 วันก่อนครบกำหนด');
const soon = await remind('2026-11-07'); // อีก 3 วัน
assert.ok(soon >= 1);
assert.deepEqual((await notes('alice')).map(n => n.title), ['อีก 3 วันครบกำหนดชำระ ค่ากิจกรรม (ค้าง 500 บาท)']);
assert.equal((await notes('bob')).length, 0, 'คนที่จ่ายครบแล้วไม่ถูกเตือน');
assert.equal(await remind('2026-11-08'), 0, 'ก่อนครบกำหนดเตือนครั้งเดียว');
assert.equal(await remind('2026-11-10'), 0);

await remind('2026-11-11'); // เลยกำหนดวันแรก
await remind('2026-11-12');
await remind('2026-11-17');
assert.equal((await notes('alice')).length, 2, 'เลยกำหนด: ไม่เกินสัปดาห์ละครั้ง');
await remind('2026-11-18'); // ครบ 8 วัน → สัปดาห์ที่สอง
assert.deepEqual((await notes('alice')).map(n => n.title).slice(1),
  ['เลยกำหนดชำระ ค่ากิจกรรม มาแล้ว 1 วัน (ค้าง 500 บาท)', 'เลยกำหนดชำระ ค่ากิจกรรม มาแล้ว 8 วัน (ค้าง 500 บาท)']);

// ปิดรับชำระแล้วหยุดเตือน
await as('president', `update charges set status = 'closed' where id = $1`, [fee]);
assert.equal(await remind('2026-11-30'), 0);
await as('president', `update charges set status = 'open' where id = $1`, [fee]);

// ── กดเตือนเอง: เหรัญญิก/ประธาน วันละครั้งต่อคน
await assert.rejects(as('alice', `select remind_charge($1)`, [fee]), /เฉพาะเหรัญญิกหรือประธาน/);
await assert.rejects(as('admin', `select remind_charge($1)`, [fee]), /เฉพาะเหรัญญิกหรือประธาน/);
const sent = (await one('t1', `select remind_charge($1) as n`, [fee])).n;
assert.equal(sent, 4, 'ค้าง: แอดมิน ประธาน เหรัญญิก อลิซ (บ๊อบจ่ายแล้ว คนยังไม่สมัครไม่มีบัญชีให้แจ้ง)');
assert.equal((await one('president', `select remind_charge($1) as n`, [fee])).n, 0, 'วันเดียวกันส่งซ้ำไม่ได้');
assert.match((await notes('alice')).at(-1).title, /เตือนจากเหรัญญิก: ยังค้างชำระ ค่ากิจกรรม 500 บาท \(ครบกำหนด 10\/11\/2026\)/);
