// ตรวจการยกเลิกรายรับที่ยืนยันผิด และการคืนเงิน (คืนเครดิต / คืนค่ารายการ)
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 't1', 't2', 'alice', 'bob']);

await as(null, `insert into members (student_id, full_name, email) values
  ('1', 'แอดมิน', 'admin@x.th'), ('3', 'เหรัญญิก1', 't1@x.th'), ('4', 'เหรัญญิก2', 't2@x.th'),
  ('5', 'อลิซ', 'alice@x.th'), ('6', 'บ๊อบ', 'bob@x.th')`);
for (const [who, sid] of [['admin', '1'], ['t1', '3'], ['t2', '4'], ['alice', '5'], ['bob', '6']]) {
  await signup(who, sid, `${who}@x.th`);
}
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin'), ($2, 'treasurer'), ($3, 'treasurer')`,
  [ids.admin, ids.t1, ids.t2]);

const one = async (...a) => (await as(...a))[0];
let n = 0;
async function upload(who) {
  const path = `${ids[who]}/f-${++n}.jpg`;
  await as(who, `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [path]);
  return path;
}
const fee = (await one('admin', `select create_charge('ค่ากิจกรรม', 50000) as id`)).id;
async function pay(who, amount, allocate = amount) {
  const sid = (await one(who, `select submit_payment($1, now() - interval '1 hour', $2, $3::jsonb) as id`,
    [amount, await upload(who), JSON.stringify(allocate ? [{ charge_id: fee, amount_satang: allocate }] : [])])).id;
  await as('t1', `select confirm_payment($1)`, [sid]);
  return sid;
}
const balance = who => one(who, `select amount_satang, paid_satang, outstanding_satang from charge_balances
  where member_id = my_member_id() and charge_id = $1`, [fee]);
const credit = async who => (await one(who, `select credit_satang from member_credit where member_id = my_member_id()`))?.credit_satang ?? 0;
const fund = () => one('alice', `select income_satang, expense_satang, refund_satang, balance_satang from fund_summary()`);

// ── ยกเลิกรายรับ: เฉพาะเหรัญญิก ต้องมีเหตุผล ยอดกลับเป็นเหมือนก่อนยืนยัน
const s1 = await pay('alice', 70000, 50000); // จ่ายเกิน 200 บาท
assert.deepEqual(await balance('alice'), { amount_satang: 50000, paid_satang: 50000, outstanding_satang: 0 });
assert.equal(await credit('alice'), 20000);
assert.equal((await fund()).balance_satang, 70000);

await assert.rejects(as('alice', `select void_payment($1, 'x')`, [s1]), /เฉพาะเหรัญญิก/);
await assert.rejects(as('admin', `select void_payment($1, 'x')`, [s1]), /เฉพาะเหรัญญิก/);
await assert.rejects(as('t2', `select void_payment($1, ' ')`, [s1]), /ระบุเหตุผล/);
await as('t2', `select void_payment($1, 'เงินไม่เข้าบัญชีจริง')`, [s1]);
assert.equal((await one('alice', `select status, void_reason from payment_submissions where id = $1`, [s1])).status, 'voided');
assert.deepEqual(await balance('alice'), { amount_satang: 50000, paid_satang: 0, outstanding_satang: 50000 });
assert.equal(await credit('alice'), 0);
assert.deepEqual(await fund(), { income_satang: 0, expense_satang: 0, refund_satang: 0, balance_satang: 0 });
assert.deepEqual(await as('t1', `select voided_at is not null as voided, void_reason from ledger_entries`),
  [{ voided: true, void_reason: 'เงินไม่เข้าบัญชีจริง' }], 'รายรับเดิมยังอยู่ แค่ถูกยกเลิก');
assert.match((await as('alice', `select title from notifications where link = '#my-payments' and kind = 'action'`))[0].title,
  /ถูกยกเลิกโดยเหรัญญิก: เงินไม่เข้าบัญชีจริง/);
await assert.rejects(as('t1', `select void_payment($1, 'ซ้ำ')`, [s1]), /สถานะ: ยกเลิกหลังยืนยัน/);
assert.deepEqual(await as('admin', `select reason from audit_log where table_name = 'payment_submissions'
  and new_data ->> 'status' = 'voided'`), [{ reason: 'เงินไม่เข้าบัญชีจริง' }]);

// ส่งใหม่และยืนยันใหม่ได้
await pay('alice', 70000, 50000);
assert.equal(await credit('alice'), 20000);

// ── คืนเครดิตจ่ายเกิน: ไม่เกินเครดิต ต้องมีสลิปโอนคืนของเหรัญญิก
const back = await upload('t1');
await assert.rejects(as('alice', `select refund_member(my_member_id(), 100, 'x', $1)`, [back]), /เฉพาะเหรัญญิก/);
const alice = (await one(null, `select id from members where student_id = '5'`)).id;
await assert.rejects(as('t1', `select refund_member($1, 30000, 'คืนส่วนเกิน', $2)`, [alice, back]), /เกินเครดิตคงเหลือ \(200 บาท\)/);
await assert.rejects(as('t1', `select refund_member($1, 20000, 'คืนส่วนเกิน', $2)`, [alice, await upload('alice')]), /ไม่พบไฟล์สลิปโอนคืน/);
await assert.rejects(as('t1', `select refund_member($1, 20000, ' ', $2)`, [alice, back]), /ระบุเหตุผล/);
await as('t1', `select refund_member($1, 20000, 'คืนส่วนเกิน', $2)`, [alice, back]);
assert.equal(await credit('alice'), 0);
await assert.rejects(as('t2', `select refund_member($1, 1, 'ซ้ำ', $2)`, [alice, await upload('t2')]), /เกินเครดิตคงเหลือ \(0 บาท\)/);
assert.deepEqual(await fund(), { income_satang: 70000, expense_satang: 0, refund_satang: 20000, balance_satang: 50000 });

// ใช้เครดิตที่คืนไปแล้วไม่ได้
await as('admin', `select create_charge('ค่าเสื้อ', 15000)`);
const shirt = (await one('alice', `select member_charge_id from charge_balances where title = 'ค่าเสื้อ'`)).member_charge_id;
await assert.rejects(as('alice', `select apply_credit($1)`, [shirt]), /ไม่มีเครดิตคงเหลือ/);

// ── คืนค่ารายการ (กิจกรรมยกเลิก): ยอดที่ต้องจ่ายและที่จ่ายแล้วลดพร้อมกัน
const feeMc = (await one('alice', `select member_charge_id from charge_balances where charge_id = $1`, [fee])).member_charge_id;
await assert.rejects(as('t1', `select refund_member($1, 60000, 'กิจกรรมยกเลิก', $2, $3)`, [alice, await upload('t1'), feeMc]),
  /เกินยอดที่ชำระแล้วของรายการนี้ \(500 บาท\)/);
await as('t1', `select refund_member($1, 50000, 'กิจกรรมยกเลิก', $2, $3)`, [alice, await upload('t1'), feeMc]);
assert.deepEqual(await balance('alice'), { amount_satang: 0, paid_satang: 0, outstanding_satang: 0 });
assert.equal(await credit('alice'), 0, 'คืนค่ารายการไม่สร้างเครดิต');
assert.deepEqual(await fund(), { income_satang: 70000, expense_satang: 0, refund_satang: 70000, balance_satang: 0 });

// ── หลังคืนเงินแล้ว ยกเลิกสลิปที่เกี่ยวข้องไม่ได้ (ยอดจะติดลบ)
const s2 = (await one('alice', `select id from payment_submissions where status = 'confirmed'`)).id;
await assert.rejects(as('t1', `select void_payment($1, 'x')`, [s2]), /มีการคืนเงินจากรายการที่สลิปนี้ตัดยอดไปแล้ว/);

const bob = (await one(null, `select id from members where student_id = '6'`)).id;
const s3 = await pay('bob', 60000, 50000);
await as('t1', `select refund_member($1, 10000, 'คืนส่วนเกิน', $2)`, [bob, await upload('t1')]);
await assert.rejects(as('t1', `select void_payment($1, 'x')`, [s3]), /ได้รับเครดิตส่วนนี้คืนไปแล้ว/);

// ── ใครเห็นการคืนเงิน: เจ้าตัวและผู้มีหน้าที่ ไม่ใช่สมาชิกคนอื่น
assert.equal((await as('alice', `select * from refunds`)).length, 2);
assert.equal((await as('bob', `select * from refunds`)).length, 1);
assert.equal((await as('t2', `select * from refunds`)).length, 3);
assert.equal((await as('bob', `select * from storage.objects where name = $1`, [back])).length, 0, 'สลิปโอนคืนไม่เปิดให้คนอื่นเห็น');
assert.equal((await as('t1', `delete from refunds returning id`)).length, 0, 'ไม่มีสิทธิ์ลบ');
await assert.rejects(as(null, `delete from refunds`), /ลบหรือแก้ไขไม่ได้/, 'แม้ superuser ก็ลบไม่ได้');
