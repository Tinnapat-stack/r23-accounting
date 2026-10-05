// ตรวจสลิประดับ 1: อ่าน QR บนสลิป และกันสลิปเดียวกันถูกใช้ซ้ำ
// รัน: npm test
import assert from 'node:assert/strict';
import { parseSlipQr } from '../web/slipqr.js';
import { createDb } from './setup.mjs';

// ── แยก QR สลิป
const ref = '2026100512345678901234567';
const inner = '0006000001' + '0103004' + '0225' + ref;
const qr = `00${inner.length}${inner}5102TH9104ABCD`;
assert.deepEqual(parseSlipQr(qr), { bank: '004', ref, key: '004:' + ref });
assert.equal(parseSlipQr(qr.slice(0, -3)), null, 'ข้อความขาด');
assert.equal(parseSlipQr('00020101021129370016A000000677010111'), null, 'QR พร้อมเพย์สำหรับจ่ายเงิน ไม่ใช่สลิป');
assert.equal(parseSlipQr('https://example.com'), null);
assert.equal(parseSlipQr(null), null);

// ── ฐานข้อมูล: สลิปเดียวกันส่งซ้ำไม่ได้ ยกเว้นรายการเดิมถูกยกเลิก/ไม่ผ่าน
const { as, ids, signup } = await createDb(['t1', 'alice', 'bob']);
await as(null, `insert into members (student_id, full_name, email) values
  ('3', 'เหรัญญิก', 't1@x.th'), ('5', 'อลิซ', 'alice@x.th'), ('6', 'บ๊อบ', 'bob@x.th')`);
for (const [who, sid] of [['t1', '3'], ['alice', '5'], ['bob', '6']]) await signup(who, sid, `${who}@x.th`);
await as(null, `insert into user_roles (user_id, role) values ($1, 'treasurer')`, [ids.t1]);

let n = 0;
async function submit(who, key) {
  const path = `${ids[who]}/slip-${++n}.jpg`;
  await as(who, `insert into storage.objects (bucket_id, name) values ('slips', $1)`, [path]);
  return (await as(who, `select submit_payment(10000, now() - interval '1 hour', $1, p_slip_ref => $2) as id`, [path, key]))[0].id;
}
const status = async id => (await as(null, `select status, slip_ref from payment_submissions where id = $1`, [id]))[0];

const a = await submit('alice', '004:' + ref);
await assert.rejects(submit('alice', '004:' + ref), /สลิปนี้ถูกใช้แจ้งชำระไปแล้ว/);
await assert.rejects(submit('bob', ' 004:' + ref + ' '), /สลิปนี้ถูกใช้แจ้งชำระไปแล้ว/, 'คนอื่นใช้สลิปเดียวกันไม่ได้');
await as('alice', `select cancel_payment($1)`, [a]);
const a2 = await submit('alice', '004:' + ref);
assert.equal((await status(a2)).slip_ref, '004:' + ref, 'ยกเลิกแล้วส่งใหม่ได้');
await as('t1', `select confirm_payment($1)`, [a2]);
await assert.rejects(submit('bob', '004:' + ref), /สลิปนี้ถูกใช้แจ้งชำระไปแล้ว/, 'ยืนยันแล้วก็ยังกัน');

// ไม่มี QR ส่งได้ (อ่านไม่ได้ไม่ขวาง)
const b = await submit('bob', null);
const b2 = await submit('bob', '');
assert.equal((await status(b2)).slip_ref, null);

// เหรัญญิกบันทึกเลขจาก QR ให้ทีหลัง: สมาชิกทำไม่ได้, ทับเลขเดิมไม่ได้, ซ้ำกับรายการที่ใช้อยู่ไม่ได้
await assert.rejects(as('bob', `select set_slip_ref($1, 'x')`, [b]), /เฉพาะเหรัญญิก/);
await as('t1', `select set_slip_ref($1, '014:ABCDEFGHIJ')`, [b]);
assert.equal((await status(b)).slip_ref, '014:ABCDEFGHIJ');
await as('t1', `select set_slip_ref($1, '014:ZZZZZZZZZZ')`, [b]);
assert.equal((await status(b)).slip_ref, '014:ABCDEFGHIJ', 'ทับเลขเดิมไม่ได้');
await assert.rejects(as('t1', `select set_slip_ref($1, '004:' || $2)`, [b2, ref]), /duplicate key/);
await assert.rejects(as('bob', `select submit_payment(1, now(), 'x', p_slip_ref => 'y', p_slip_sha256 => 'z', p_note => 'n', p_reference_no => 'r', p_payer_bank => 'b', p_bank_account_id => null, p_items => '[]')`),
  /ไม่พบไฟล์สลิป/, 'ฟังก์ชันใหม่รับครบทุกพารามิเตอร์');
console.log('slipqr ok');
