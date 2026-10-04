// ตรวจระยะ 4: ขอเบิก อนุมัติ จ่ายจริง งบกิจกรรม ยอดยกมา และสรุปที่ทุกคนเห็น
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'president', 't1', 't2', 'alice', 'bob']);

await as(null, `insert into members (student_id, full_name, email) values
  ('1', 'แอดมิน', 'admin@x.th'), ('2', 'ประธาน', 'president@x.th'), ('3', 'เหรัญญิก1', 't1@x.th'),
  ('4', 'เหรัญญิก2', 't2@x.th'), ('5', 'อลิซ', 'alice@x.th'), ('6', 'บ๊อบ', 'bob@x.th')`);
for (const [who, sid] of [['admin', '1'], ['president', '2'], ['t1', '3'], ['t2', '4'], ['alice', '5'], ['bob', '6']]) {
  await signup(who, sid, `${who}@x.th`);
}
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin'), ($2, 'president'), ($3, 'treasurer'), ($4, 'treasurer')`,
  [ids.admin, ids.president, ids.t1, ids.t2]);

const one = async (...a) => (await as(...a))[0];
let n = 0;
async function upload(who) {
  const path = `${ids[who]}/doc-${++n}.jpg`;
  await as(who, `insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [path]);
  return path;
}
const request = (who, amount, extra = {}) => one(who,
  `select request_expense($1, $2, $3, $4, $5, $6) as id`,
  [extra.title ?? 'ซื้อลูกฟุตบอล', amount, 'อุปกรณ์', extra.activity ?? null, 'แข่งกีฬารุ่น', extra.quote ?? null]).then(r => r.id);
const status = id => one(null, `select status from expense_requests where id = $1`, [id]).then(r => r.status);
const budget = () => one('bob', `select budget_satang, committed_satang, paid_satang from activity_budgets where name = 'กีฬารุ่น'`);
const summary = who => one(who, `select * from fund_summary()`);

// ── กิจกรรมและงบ: ประธานตั้งได้ สมาชิกทั่วไปตั้งไม่ได้
await assert.rejects(as('alice', `insert into activities (name, budget_satang) values ('x', 1)`), /row-level security/);
const sport = (await one('president', `insert into activities (name, budget_satang) values ('กีฬารุ่น', 1000000) returning id`)).id;

// ── ขอเบิก: ทุกคนขอได้ ใบเสนอราคาต้องเป็นไฟล์ของตัวเอง เขียนตารางตรงไม่ได้
await assert.rejects(as('alice', `insert into expense_requests (requested_by, category, title, amount_satang)
  values (my_member_id(), 'อุปกรณ์', 'x', 1)`), /row-level security|permission denied/);
await assert.rejects(request('alice', 200000, { quote: await upload('bob') }), /ไม่พบไฟล์หลักฐาน/);
const e1 = await request('alice', 200000, { activity: sport, quote: await upload('alice') });
assert.equal(await status(e1), 'pending');
for (const t of ['t1', 't2']) {
  assert.deepEqual(await as(t, `select title, link from notifications where kind = 'pending'`),
    [{ title: 'อลิซ ขอเบิก 2,000 บาท: ซื้อลูกฟุตบอล', link: `#expenses/${e1}` }]);
}
assert.equal((await as('bob', `select * from expense_requests`)).length, 1, 'สมาชิกทุกคนเห็นคำขอเบิก');

// ── อนุมัติ: เฉพาะเหรัญญิก ครั้งเดียว ยังไม่หักเงิน แต่กันงบไว้
await assert.rejects(as('alice', `select approve_expense($1)`, [e1]), /เฉพาะเหรัญญิก/);
await assert.rejects(as('admin', `select approve_expense($1)`, [e1]), /เฉพาะเหรัญญิก/);
await as('t1', `select approve_expense($1)`, [e1]);
await assert.rejects(as('t2', `select approve_expense($1)`, [e1]), /สถานะ: อนุมัติแล้ว รอจ่าย/);
assert.deepEqual(await budget(), { budget_satang: 1000000, committed_satang: 200000, paid_satang: 0 });
assert.equal((await summary('bob')).expense_satang, 0, 'อนุมัติอย่างเดียวยังไม่หักเงิน');
assert.match((await one('alice', `select title from notifications where kind = 'success'`)).title, /ได้รับการอนุมัติแล้ว/);

// ── จ่ายจริง: ต้องมีใบเสร็จ ไม่เกินยอดอนุมัติ หักครั้งเดียว
const receipt = await upload('t1');
await assert.rejects(as('t1', `select pay_expense($1, 250000, $2)`, [e1, receipt]), /ไม่เกินยอดที่อนุมัติ/);
await assert.rejects(as('t1', `select pay_expense($1, 180000, $2)`, [e1, `${ids.t1}/ไม่มี.jpg`]), /ไม่พบไฟล์หลักฐาน/);
await assert.rejects(as('alice', `select pay_expense($1, 180000, $2)`, [e1, receipt]), /เฉพาะเหรัญญิก/);
await as('t1', `select pay_expense($1, 180000, $2)`, [e1, receipt]);
await assert.rejects(as('t2', `select pay_expense($1, 180000, $2)`, [e1, receipt]), /สถานะ: จ่ายแล้ว/);
assert.equal(await status(e1), 'paid');
assert.deepEqual(await budget(), { budget_satang: 1000000, committed_satang: 0, paid_satang: 180000 });
assert.deepEqual(await as('t1', `select kind, amount_satang from ledger_entries`), [{ kind: 'expense', amount_satang: -180000 }]);
assert.equal((await as('bob', `select * from storage.objects where name = $1`, [receipt])).length, 1, 'ใบเสร็จทุกคนเปิดดูได้');
assert.equal((await as('bob', `select * from ledger_entries`)).length, 0, 'สมุดบัญชีรายตัวยังจำกัดสิทธิ์');

// ทุกคนเห็นชื่อผู้ขอ ผู้อนุมัติ ผู้จ่าย (แต่ไม่เห็นอีเมล/รหัสนิสิต) แม้อ่านตารางสมาชิกไม่ได้
const feed = await one('bob', `select * from expense_feed where id = $1`, [e1]);
assert.deepEqual([feed.requester_name, feed.reviewer_name, feed.payer_name, feed.activity_name], ['อลิซ', 'เหรัญญิก1', 'เหรัญญิก1', 'กีฬารุ่น']);
assert.equal(Object.keys(feed).some(k => /email|student/.test(k)), false);
assert.equal((await as('bob', `select * from members where student_id = '5'`)).length, 0);

// ── ไม่อนุมัติ / ยกเลิก: ต้องมีเหตุผล
const e2 = await request('bob', 50000);
await assert.rejects(as('t1', `select reject_expense($1, ' ')`, [e2]), /ระบุเหตุผล/);
await as('t1', `select reject_expense($1, 'ซ้ำกับรายการเดิม')`, [e2]);
assert.equal(await status(e2), 'rejected');

const e3 = await request('bob', 30000);
await assert.rejects(as('alice', `select cancel_expense($1, 'x')`, [e3]), /ยกเลิกไม่ได้/, 'ยกเลิกคำขอคนอื่นไม่ได้');
await as('bob', `select cancel_expense($1, 'ซื้อเองแล้ว')`, [e3]);
assert.equal(await status(e3), 'cancelled');

const e4 = await request('bob', 30000);
await as('t2', `select approve_expense($1)`, [e4]);
await assert.rejects(as('bob', `select cancel_expense($1, 'x')`, [e4]), /ยกเลิกไม่ได้/, 'อนุมัติแล้วผู้ขอยกเลิกเองไม่ได้');
await as('t2', `select cancel_expense($1, 'ร้านปิด')`, [e4]);
await assert.rejects(as('t1', `select pay_expense($1, 30000, $2)`, [e4, receipt]), /สถานะ: ยกเลิกแล้ว/);

// เหรัญญิกขอเบิกเองแล้วอนุมัติเองได้ (ตามข้อตกลง) แต่มีบันทึกว่าใครกด
const e5 = await request('t1', 10000);
await as('t1', `select approve_expense($1)`, [e5]);
assert.equal((await one('admin', `select actor from audit_log where table_name = 'expense_requests'
  and new_data ->> 'id' = $1 and new_data ->> 'status' = 'approved'`, [e5])).actor, ids.t1);

// ── ยอดยกมา: เฉพาะเหรัญญิก ต้องมีที่มา ตั้งใหม่ได้โดยของเดิมถูกยกเลิก (ไม่หาย)
await assert.rejects(as('alice', `select set_opening_balance(100, 'x')`), /เฉพาะเหรัญญิก/);
await assert.rejects(as('t1', `select set_opening_balance(100, ' ')`), /ระบุที่มา/);
await as('t1', `select set_opening_balance(500000, 'สมุดบัญชี ณ 1 ต.ค. รับรองโดยประธาน')`);
await as('t2', `select set_opening_balance(600000, 'แก้ยอด: สมุดบัญชีหน้าล่าสุด')`);
assert.deepEqual(await as('t1', `select amount_satang, voided_at is not null as voided from ledger_entries
  where kind = 'opening_balance' order by id`), [{ amount_satang: 500000, voided: true }, { amount_satang: 600000, voided: false }]);

// ── สรุปที่สมาชิกทุกคนเห็น: ยอดถูกต้อง ไม่มีชื่อรายคน
await as(null, `insert into ledger_entries (kind, amount_satang, description) values ('income', 300000, 'รับชำระ')`);
await as(null, `insert into charges (title, amount_satang) values ('ค่ากิจกรรม', 50000)`);
await as(null, `insert into member_charges (charge_id, member_id, amount_satang, paid_satang)
  select c.id, m.id, 50000, case when m.student_id = '5' then 50000 else 0 end from charges c, members m`);
assert.deepEqual(await summary('bob'), {
  opening_satang: 600000, income_satang: 300000, expense_satang: 180000, refund_satang: 0, balance_satang: 720000,
  pending_slips: 0, pending_expenses: 0, approved_unpaid_satang: 10000,
});
const cs = await one('bob', `select * from charge_summary()`);
assert.deepEqual({ members: cs.members, paid: cs.paid_members, collected: cs.collected_satang, owed: cs.outstanding_satang },
  { members: 6, paid: 1, collected: 50000, owed: 250000 });
assert.equal(Object.keys(cs).some(k => /name|student/.test(k)), false);
assert.deepEqual(await as('bob', `select income_satang, expense_satang from monthly_cashflow()`),
  [{ income_satang: 300000, expense_satang: 180000 }], 'ยอดยกมาไม่นับเป็นรายรับรายเดือน');

// ── ส่งออกรายงานถูกบันทึกในประวัติ
await as('bob', `select log_export('รายจ่าย', '2026-10-01', '2026-10-31')`);
assert.deepEqual(await as('admin', `select actor, action, table_name from audit_log where action = 'export'`),
  [{ actor: ids.bob, action: 'export', table_name: 'รายจ่าย' }]);

// สมาชิกที่ถูกระงับดูสรุปไม่ได้
await as('admin', `select set_member_active(id, false, 'ทดสอบ') from members where student_id = '6'`);
await assert.rejects(summary('bob'), /เฉพาะสมาชิกที่ใช้งานอยู่/);
