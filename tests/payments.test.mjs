// ตรวจระยะ 2: เรียกเก็บ แจ้งชำระ ตรวจสลิป เครดิต จ่ายแทน และแจ้งเตือน
// รัน: npm test
import assert from 'node:assert/strict';
import { createDb } from './setup.mjs';

const { as, ids, signup } = await createDb(['admin', 'president', 't1', 't2', 'alice', 'bob']);

await as(null, `insert into members (student_id, full_name, email) values
  ('1', 'แอดมิน', 'admin@x.th'), ('2', 'ประธาน', 'president@x.th'), ('3', 'เหรัญญิก1', 't1@x.th'),
  ('4', 'เหรัญญิก2', 't2@x.th'), ('5', 'อลิซ', 'alice@x.th'), ('6', 'บ๊อบ', 'bob@x.th'), ('7', 'ยังไม่สมัคร', 'x@x.th')`);
for (const [who, sid] of [['admin', '1'], ['president', '2'], ['t1', '3'], ['t2', '4'], ['alice', '5'], ['bob', '6']]) {
  await signup(who, sid, `${who}@x.th`);
}
await as(null, `insert into user_roles (user_id, role) values ($1, 'admin'), ($2, 'president'), ($3, 'treasurer'), ($4, 'treasurer')`,
  [ids.admin, ids.president, ids.t1, ids.t2]);

const one = async (...a) => (await as(...a))[0];
const balance = (who, title) => one(who, `select paid_satang, outstanding_satang from charge_balances
  where title = $1 and member_id = my_member_id()`, [title]);
const credit = async who => (await one(who, `select credit_satang from member_credit where member_id = my_member_id()`))?.credit_satang ?? 0;
const notes = (who, kind) => as(who, `select title, link from notifications where kind = $1 order by id`, [kind]);

let n = 0;
async function upload(who) {
  const path = `${ids[who]}/slip-${++n}.jpg`;
  await as(who, `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [path]);
  return path;
}
async function submit(who, amount, items = [], path) {
  path ??= await upload(who);
  return (await one(who, `select submit_payment($1, now() - interval '1 hour', $2, $3::jsonb, p_reference_no => $4) as id`,
    [amount, path, JSON.stringify(items), `REF-${n}`])).id;
}

// ── สร้างรายการเรียกเก็บ: เฉพาะประธาน/แอดมิน และแจ้งสมาชิก
await assert.rejects(as('alice', `select create_charge('x', 100)`), /เฉพาะประธานหรือแอดมิน/);
await assert.rejects(as('president', `select create_charge('x', 100, p_student_ids => '{5,999}')`), /ไม่พบรหัสนิสิต: 999/);
const fee = (await one('president', `select create_charge('ค่ากิจกรรมรุ่น', 50000) as id`)).id;
assert.deepEqual(await balance('alice', 'ค่ากิจกรรมรุ่น'), { paid_satang: 0, outstanding_satang: 50000 });
assert.equal((await as(null, `select * from member_charges where charge_id = $1`, [fee])).length, 7);
assert.match((await notes('alice', 'action'))[0].title, /รายการเรียกเก็บใหม่: ค่ากิจกรรมรุ่น 500 บาท/);
await assert.rejects(as('president', `update member_charges set paid_satang = 50000`), /permission denied/,
  'ยอดชำระแก้ตรงไม่ได้');
await assert.rejects(as('alice', `select notify($1, 'info', 'x', null, null)`, [ids.alice]), /permission denied/);

// ── แจ้งชำระ: ต้องมีไฟล์สลิปของตัวเองจริง ยอดไม่เกินยอดค้าง
await assert.rejects(submit('alice', 50000, [], `${ids.alice}/ไม่มีไฟล์.jpg`), /ไม่พบไฟล์สลิป/);
await assert.rejects(submit('alice', 50000, [], await upload('bob')), /ไม่พบไฟล์สลิป/, 'ใช้สลิปคนอื่นไม่ได้');
await assert.rejects(submit('alice', 60000, [{ charge_id: fee, amount_satang: 60000 }]), /เกินยอดค้าง/);
await assert.rejects(submit('alice', 10000, [{ charge_id: fee, amount_satang: 20000 }]), /รวมกันเกินยอดโอน/);
await assert.rejects(submit('admin', 1, [], await upload('alice')), /ไม่พบไฟล์สลิป/);

// จ่ายเกิน: โอน 700 ตัดค่ากิจกรรม 500 ที่เหลือเป็นเครดิต
const slipPath = await upload('alice');
const s1 = await submit('alice', 70000, [{ charge_id: fee, amount_satang: 50000 }], slipPath);
await assert.rejects(submit('alice', 70000, [], slipPath), /duplicate key/, 'ไฟล์เดียวส่งซ้ำไม่ได้');
assert.equal((await one('alice', `select status from payment_submissions where id = $1`, [s1])).status, 'pending');
assert.equal((await balance('alice', 'ค่ากิจกรรมรุ่น')).paid_satang, 0, 'ก่อนยืนยันยอดไม่เปลี่ยน');
assert.equal((await as('t1', `select * from ledger_entries`)).length, 0);
for (const t of ['t1', 't2']) {
  assert.deepEqual(await notes(t, 'pending'), [{ title: 'อลิซ แจ้งชำระ 700 บาท รอตรวจสอบ', link: `#review/${s1}` }]);
}
assert.equal((await notes('admin', 'pending')).length, 0, 'แอดมินที่ไม่ใช่เหรัญญิกไม่ได้รับแจ้ง');

// ── ยืนยัน: เฉพาะเหรัญญิก ยืนยันครั้งเดียวได้รายรับรายการเดียว
await assert.rejects(as('alice', `select confirm_payment($1)`, [s1]), /เฉพาะเหรัญญิก/);
await assert.rejects(as('admin', `select confirm_payment($1)`, [s1]), /เฉพาะเหรัญญิก/);
await as('t1', `select confirm_payment($1)`, [s1]);
await assert.rejects(as('t2', `select confirm_payment($1)`, [s1]), /ถูกตรวจไปแล้ว \(สถานะ: ยืนยันแล้ว\)/);
await assert.rejects(as('t2', `select reject_payment($1, 'x')`, [s1]), /ถูกตรวจไปแล้ว/);
assert.deepEqual(await as('t1', `select kind, amount_satang from ledger_entries`), [{ kind: 'income', amount_satang: 70000 }]);
assert.deepEqual(await balance('alice', 'ค่ากิจกรรมรุ่น'), { paid_satang: 50000, outstanding_satang: 0 });
assert.equal(await credit('alice'), 20000);
assert.equal((await notes('alice', 'success'))[0].title, 'ยืนยันรับเงิน 700 บาทแล้ว');

// ── ใช้เครดิตตัดรายการใหม่ 150 บาท → เหลือเครดิต 50
await as('president', `select create_charge('ค่าเสื้อรุ่น', 15000)`);
const shirt = (await one('alice', `select member_charge_id from charge_balances where title = 'ค่าเสื้อรุ่น'`)).member_charge_id;
await assert.rejects(as('bob', `select apply_credit($1)`, [shirt]), /ไม่พบรายการ/, 'ใช้เครดิตกับรายการคนอื่นไม่ได้');
assert.equal((await one('alice', `select apply_credit($1) as used`, [shirt])).used, 15000);
assert.equal(await credit('alice'), 5000);
assert.equal((await balance('alice', 'ค่าเสื้อรุ่น')).outstanding_satang, 0);
await assert.rejects(as('alice', `select apply_credit($1)`, [shirt]), /ไม่มีเครดิตคงเหลือ|ชำระครบแล้ว/);
assert.equal((await as('t1', `select * from ledger_entries`)).length, 1, 'ใช้เครดิตไม่สร้างรายรับใหม่');

// ── จ่ายแทน: อลิซจ่ายค่ากิจกรรมให้บ๊อบ บ๊อบเห็นยอดของตัวเองลดแม้ไม่เห็นสลิปของอลิซ
const s2 = await submit('alice', 50000, [{ charge_id: fee, student_id: '6', amount_satang: 50000 }]);
await as('t2', `select confirm_payment($1)`, [s2]);
assert.deepEqual(await balance('bob', 'ค่ากิจกรรมรุ่น'), { paid_satang: 50000, outstanding_satang: 0 });
assert.equal((await as('bob', `select * from payment_submissions`)).length, 0);
assert.match((await notes('bob', 'success'))[0].title, /อลิซ ชำระ ค่ากิจกรรมรุ่น แทนคุณ 500 บาท/);

// ── ไม่ผ่าน: ต้องมีเหตุผล ยอดไม่เปลี่ยน แจ้งผู้ส่ง
const s3 = await submit('bob', 15000, [{ charge_id: (await one('bob', `select charge_id from charge_balances where title = 'ค่าเสื้อรุ่น'`)).charge_id, amount_satang: 15000 }]);
await assert.rejects(as('t1', `select reject_payment($1, '  ')`, [s3]), /ระบุเหตุผล/);
await as('t1', `select reject_payment($1, 'ยอดเงินไม่ตรง')`, [s3]);
assert.equal((await balance('bob', 'ค่าเสื้อรุ่น')).paid_satang, 0);
assert.match((await notes('bob', 'action')).at(-1).title, /ไม่ผ่านการตรวจสอบ: ยอดเงินไม่ตรง/);
assert.equal((await one('bob', `select reject_reason from payment_submissions where id = $1`, [s3])).reject_reason, 'ยอดเงินไม่ตรง');

// ── ยกเลิกเอง: เฉพาะของตัวเองที่ยังรอตรวจ
const s4 = await submit('bob', 100);
await assert.rejects(as('alice', `select cancel_payment($1)`, [s4]), /ยกเลิกไม่ได้/);
await as('bob', `select cancel_payment($1)`, [s4]);
await assert.rejects(as('t1', `select confirm_payment($1)`, [s4]), /สถานะ: ยกเลิกแล้ว/);
await assert.rejects(as('bob', `select cancel_payment($1)`, [s3]), /ยกเลิกไม่ได้/);

// ── สองสลิปตัดรายการเดียวกันเต็มยอด: ยืนยันใบแรกได้ ใบที่สองต้องถูกปฏิเสธ ไม่ตัดเกิน
const bobShirt = (await one('bob', `select charge_id from charge_balances where title = 'ค่าเสื้อรุ่น'`)).charge_id;
const s5 = await submit('bob', 15000, [{ charge_id: bobShirt, amount_satang: 15000 }]);
const s6 = await submit('bob', 15000, [{ charge_id: bobShirt, amount_satang: 15000 }]);
await as('t1', `select confirm_payment($1)`, [s5]);
await assert.rejects(as('t2', `select confirm_payment($1)`, [s6]), /เกินยอดค้าง/);
assert.equal((await one('t1', `select status from payment_submissions where id = $1`, [s6])).status, 'pending',
  'ยืนยันไม่สำเร็จต้องไม่เปลี่ยนอะไร');
assert.equal((await as('t1', `select * from ledger_entries`)).length, 3);

// ── ทุกขั้นถูกบันทึกในประวัติการกระทำ พร้อมผู้ทำ
const log = await as('admin', `select actor from audit_log where table_name = 'payment_submissions'
  and new_data ->> 'id' = $1 and new_data ->> 'status' = 'confirmed'`, [s1]);
assert.deepEqual(log, [{ actor: ids.t1 }]);
