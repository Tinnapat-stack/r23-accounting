import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, root = document) => root.querySelector(s);

const ROLE_TH = { member: 'สมาชิก', treasurer: 'เหรัญญิก', president: 'ประธาน', auditor: 'ผู้ตรวจสอบ', admin: 'แอดมิน' };
const EXTRA_ROLES = ['treasurer', 'president', 'auditor', 'admin'];
const STATUS = {
  pending: ['รอตรวจสอบ', 'wait'], confirmed: ['ยืนยันแล้ว', 'ok'],
  rejected: ['ไม่ผ่านการตรวจสอบ', 'bad'], cancelled: ['ยกเลิกแล้ว', 'muted'],
};
const KIND_TH = { action: 'ต้องดำเนินการ', pending: 'รอตรวจสอบ', success: 'สำเร็จ', info: 'ข้อมูล' };
const REJECT_REASONS = ['ยอดเงินไม่ตรง', 'สลิปไม่ชัด', 'ไม่พบรายการเงินเข้า', 'โอนผิดบัญชี', 'พบรายการซ้ำ', 'ข้อมูลไม่ตรง', 'อื่น ๆ'];
const SLIP_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// ─── ตัวช่วย ────────────────────────────────────────────────────

// สร้าง element แบบปลอดภัย (ข้อความทั้งหมดเป็น textContent ไม่ใช่ HTML)
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

const must = ({ error, data }) => { if (error) throw error; return data; };
const baht = s => (Number(s) / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const money = s => h('span', { className: 'money' }, baht(s) + ' บาท');
const when = iso => iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
const day = d => d ? new Date(d + 'T00:00').toLocaleDateString('th-TH', { dateStyle: 'medium' }) : '-';
const chip = status => h('span', { className: 'chip ' + STATUS[status][1] }, STATUS[status][0]);

// "1,234.50" → 123450 สตางค์ ไม่ใช้ทศนิยมลอยตัว
function toSatang(text) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(text).replace(/[,\s]/g, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

// ข้อความ error → ภาษาไทยที่คนทั่วไปเข้าใจ (ข้อความจากฐานข้อมูลเป็นภาษาไทยอยู่แล้ว)
function thai(error) {
  const m = error?.message ?? String(error ?? '');
  if (/[฀-๿]/.test(m)) return m;
  if (/Invalid login credentials/i.test(m)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  if (/Email not confirmed/i.test(m)) return 'ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ในอีเมลก่อน';
  if (/Database error saving new user/i.test(m)) return 'ไม่พบรหัสนิสิตและอีเมลนี้ในรายชื่อ หรือถูกใช้สมัครไปแล้ว กรุณาติดต่อแอดมิน';
  if (/already registered/i.test(m)) return 'อีเมลนี้สมัครแล้ว ลองเข้าสู่ระบบหรือกดลืมรหัสผ่าน';
  if (/duplicate key/i.test(m)) return 'ข้อมูลนี้มีอยู่แล้ว';
  if (/row-level security|permission denied/i.test(m)) return 'คุณไม่มีสิทธิ์ทำรายการนี้';
  if (/rate limit/i.test(m)) return 'ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
  if (/Password should be/i.test(m)) return 'รหัสผ่านสั้นหรือง่ายเกินไป';
  if (/mime type|payload too large|exceeded the maximum/i.test(m)) return 'ไฟล์ต้องเป็นรูป JPG, PNG หรือ WEBP ขนาดไม่เกิน 5 MB';
  return 'ไม่สามารถทำรายการได้ กรุณาลองใหม่อีกครั้ง';
}

function say(box, text, ok = false) {
  box.textContent = text;
  box.className = 'msg ' + (ok ? 'ok' : 'err');
  box.hidden = !text;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 4000);
}

// ผูกฟอร์ม: ปิดปุ่มระหว่างส่ง (กันกดซ้ำ) แสดงผลในกล่อง .msg ของฟอร์ม
function onSubmit(form, handler) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form), box = $('.msg', form);
    btn.disabled = true; say(box, '');
    try {
      const ok = await handler(Object.fromEntries(new FormData(form)), form);
      if (ok) say(box, ok, true);
    } catch (err) {
      say(box, thai(err));
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

// ตาราง: บนมือถือแต่ละแถวเป็นการ์ด (ใช้ data-label เป็นหัวข้อ)
function table(cols, rows, onRow) {
  return h('table', { className: 'rt' },
    h('thead', {}, h('tr', {}, cols.map(([label]) => h('th', {}, label)))),
    h('tbody', {}, rows.map(r => h('tr', onRow ? { className: 'click', onclick: () => onRow(r) } : {},
      cols.map(([label, cell]) => h('td', { 'data-label': label }, cell(r)))))));
}

const empty = (text, action) => h('div', { className: 'card' }, h('p', { className: 'muted' }, text), action);
const msgBox = () => h('div', { className: 'msg', role: 'status', hidden: true });

// หน้าต่างฟอร์มเล็ก ๆ (ใช้ <dialog> ของเบราว์เซอร์) คืนค่าที่กรอก หรือ null ถ้ากดยกเลิก
function dialogForm(title, fields, okLabel, danger = false) {
  return new Promise(resolve => {
    const done = value => { dlg.remove(); resolve(value); };
    const form = h('form', { onsubmit: e => { e.preventDefault(); done(Object.fromEntries(new FormData(form))); } },
      h('h2', {}, title),
      fields.map(f => [
        h('label', { htmlFor: 'd-' + f.name }, f.label),
        h('input', { id: 'd-' + f.name, name: f.name, value: f.value ?? '', type: f.type ?? 'text', required: f.required !== false }),
      ]),
      h('div', { className: 'row', style: 'margin-top:16px; justify-content:flex-end' },
        h('button', { type: 'button', className: 'ghost', onclick: () => done(null) }, 'ยกเลิก'),
        h('button', { type: 'submit', className: danger ? 'danger' : null }, okLabel)));
    const dlg = h('dialog', { oncancel: () => done(null) }, form); // กด Esc
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ตารางที่คัดลอกจาก Excel / Google Sheets (คั่นด้วย Tab) หรือ CSV → [{student_id, full_name, email}]
// ข้ามแถวหัวตารางที่มีคำว่า "รหัส" หรือ "student"
function parseMemberRows(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split(l.includes('\t') ? '\t' : ',').map(c => c.trim().replace(/^"|"$/g, '')))
    .filter(([first]) => !/รหัส|student/i.test(first))
    .map(([student_id = '', full_name = '', email = '']) => ({ student_id, full_name, email }));
}

async function openSlip(path) {
  const { data, error } = await sb.storage.from('slips').createSignedUrl(path, 600);
  if (error) return toast(thai(error));
  open(data.signedUrl, '_blank', 'noopener');
}

// ─── สถานะผู้ใช้ ─────────────────────────────────────────────────

let me = null, member = null, roles = new Set();
const can = (...r) => r.some(x => roles.has(x));

async function loadProfile() {
  const [m, rs] = await Promise.all([
    sb.from('members').select('*').eq('user_id', me.id).maybeSingle().then(must),
    sb.from('user_roles').select('role').eq('user_id', me.id).then(must),
  ]);
  member = m;
  roles = new Set(member?.active ? rs.map(r => r.role) : []);

  // ชื่อและตำแหน่งที่หัวเว็บ เรียงตามลำดับใน ROLE_TH
  $('#whoami-name').textContent = member ? `${member.full_name} (รหัสนิสิต ${member.student_id})` : me.email;
  $('#whoami-roles').replaceChildren(...(member?.active
    ? Object.keys(ROLE_TH).filter(r => roles.has(r)).map(r => h('span', { className: 'chip' }, ROLE_TH[r]))
    : [h('span', { className: 'chip bad' }, 'บัญชีถูกระงับ')]));
}

async function pendingCount() {
  const { count } = await sb.from('payment_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return count ?? 0;
}

// ─── หน้าต่าง ๆ ─────────────────────────────────────────────────

const PAGES = {
  home: { label: 'หน้าหลัก', allowed: () => true, render: renderHome },
  pay: { label: 'แจ้งชำระ', allowed: () => !!member?.active, render: renderPay },
  'my-payments': { label: 'การชำระของฉัน', allowed: () => !!member?.active, render: renderMyPayments },
  review: { label: 'ตรวจสลิป', allowed: () => can('treasurer'), render: renderReview },
  charges: { label: 'รายการเรียกเก็บ', allowed: () => can('treasurer', 'president', 'auditor', 'admin'), render: renderCharges },
  members: { label: 'สมาชิกและตั้งค่า', allowed: () => can('admin'), render: renderMembers },
};

async function renderTabs() {
  const [current] = location.hash.slice(1).split('/');
  const pending = can('treasurer') ? await pendingCount() : 0;
  $('#tabs').replaceChildren(...Object.entries(PAGES).filter(([, p]) => p.allowed()).map(([key, p]) =>
    h('a', { href: '#' + key, className: (current || 'home') === key ? 'on' : '' },
      p.label, key === 'review' && pending ? h('span', { className: 'count' }, pending) : null)));
}

// หน้าหลัก: ฉันต้องทำอะไร มีอะไรค้าง
async function renderHome() {
  const hello = h('div', { className: 'card' },
    h('h1', {}, 'สวัสดี ', member?.full_name ?? me.email),
    member ? h('p', { className: 'muted' }, 'รหัสนิสิต ' + member.student_id) : null,
    h('div', { className: 'row' }, [...roles].map(r => h('span', { className: 'chip' }, ROLE_TH[r]))));
  if (!member?.active) {
    return h('div', {}, hello, empty('บัญชีนี้ถูกระงับหรือยังไม่ได้ผูกกับรายชื่อสมาชิก กรุณาติดต่อแอดมิน'));
  }

  const [rows, credit, mine, toReview] = await Promise.all([
    sb.from('charge_balances').select('*').eq('member_id', member.id).order('due_date', { nullsFirst: false }).then(must),
    sb.from('member_credit').select('credit_satang').eq('member_id', member.id).maybeSingle().then(must),
    sb.from('payment_submissions').select('id', { count: 'exact', head: true }).eq('member_id', member.id).eq('status', 'pending'),
    can('treasurer') ? pendingCount() : 0,
  ]);
  const owed = rows.reduce((s, r) => s + Number(r.outstanding_satang), 0);
  const creditLeft = Number(credit?.credit_satang ?? 0);

  const todo = h('div', { className: 'card' }, h('h2', {}, 'งานที่ต้องทำ'),
    h('ul', {},
      owed ? h('li', {}, 'ยอดค้างชำระรวม ', money(owed), ' ', h('a', { href: '#pay' }, 'แจ้งชำระ →')) : h('li', {}, 'ไม่มียอดค้างชำระ ✓'),
      mine.count ? h('li', {}, `สลิปของคุณรอตรวจสอบ ${mine.count} รายการ `, h('a', { href: '#my-payments' }, 'ดู →')) : null,
      toReview ? h('li', {}, `สลิปรอตรวจ ${toReview} รายการ `, h('a', { href: '#review' }, 'ตรวจสลิป →')) : null,
      creditLeft ? h('li', {}, 'เครดิตจากการจ่ายเกินคงเหลือ ', money(creditLeft)) : null));

  const useCredit = async r => {
    if (!confirm(`ใช้เครดิตตัดยอด "${r.title}"?`)) return;
    try {
      const used = must(await sb.rpc('apply_credit', { p_member_charge_id: r.member_charge_id }));
      toast(`ตัดยอดด้วยเครดิต ${baht(used)} บาทแล้ว`);
      route();
    } catch (err) { toast(thai(err)); }
  };

  const list = rows.length
    ? h('div', { className: 'card' }, h('h2', {}, 'รายการเรียกเก็บของฉัน'), table([
        ['รายการ', r => r.title],
        ['ครบกำหนด', r => day(r.due_date)],
        ['ยอด', r => money(r.amount_satang)],
        ['ชำระแล้ว', r => money(r.paid_satang)],
        ['คงค้าง', r => money(r.outstanding_satang)],
        ['สถานะ', r => Number(r.outstanding_satang) === 0
          ? h('span', { className: 'chip ok' }, 'ชำระครบ')
          : creditLeft
            ? h('button', { className: 'link', onclick: () => useCredit(r) }, 'ใช้เครดิตตัดยอด')
            : h('span', { className: 'chip wait' }, 'ค้างชำระ')],
      ], rows))
    : empty('ยังไม่มีรายการเรียกเก็บ เมื่อประธานสร้างรายการ ยอดที่ต้องชำระจะแสดงที่นี่');

  return h('div', {}, hello, todo, list);
}

// แจ้งชำระ: อัปโหลดสลิปให้สำเร็จก่อน แล้วจึงบันทึกการแจ้งชำระ
async function renderPay() {
  const [mine, accounts, open] = await Promise.all([
    sb.from('charge_balances').select('*').eq('member_id', member.id).eq('charge_status', 'open')
      .gt('outstanding_satang', 0).order('due_date', { nullsFirst: false }).then(must),
    sb.from('bank_accounts').select('*').eq('active', true).then(must),
    sb.from('charges').select('id, title').eq('status', 'open').order('created_at', { ascending: false }).then(must),
  ]);

  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const summary = h('p', { className: 'muted' });
  const others = h('div');

  const picks = mine.map(r => {
    const cb = h('input', { type: 'checkbox', checked: mine.length === 1, 'aria-label': r.title });
    const amt = h('input', { type: 'text', inputMode: 'decimal', value: baht(r.outstanding_satang).replace(/,/g, ''),
                             'aria-label': 'ยอดที่ชำระ ' + r.title });
    cb.onchange = amt.oninput = update;
    return { r, cb, amt, el: h('div', { className: 'pick' }, cb,
      h('span', {}, r.title, h('small', { className: 'muted' }, ' ค้าง ', money(r.outstanding_satang))), amt) };
  });

  function addOther() {
    const row = h('div', { className: 'other' },
      h('input', { name: 'o_sid', placeholder: 'รหัสนิสิตเพื่อน', 'aria-label': 'รหัสนิสิตเพื่อน' }),
      h('select', { name: 'o_charge', 'aria-label': 'รายการ' }, open.map(c => h('option', { value: c.id }, c.title))),
      h('input', { name: 'o_amt', inputMode: 'decimal', placeholder: 'บาท', 'aria-label': 'ยอดที่จ่ายแทน', oninput: update }),
      h('button', { type: 'button', className: 'ghost', onclick: () => { row.remove(); update(); } }, 'ลบ'));
    others.append(row);
  }

  // รวมรายการที่เลือก → [{charge_id, student_id, amount_satang}]
  function items() {
    const list = picks.filter(p => p.cb.checked).map(p => ({ charge_id: p.r.charge_id, amount_satang: toSatang(p.amt.value), title: p.r.title }));
    for (const row of others.children) {
      list.push({ charge_id: $('[name=o_charge]', row).value, student_id: $('[name=o_sid]', row).value.trim(),
                  amount_satang: toSatang($('[name=o_amt]', row).value), title: 'จ่ายแทน ' + $('[name=o_sid]', row).value });
    }
    return list;
  }

  function update() {
    const total = toSatang(form.amount.value) ?? 0;
    const used = items().reduce((s, i) => s + (i.amount_satang ?? 0), 0);
    summary.textContent = `ตัดรายการรวม ${baht(used)} บาท` +
      (total > used ? ` · ส่วนที่เกิน ${baht(total - used)} บาท จะเก็บเป็นเครดิต` : '') +
      (used > total ? ' · ⚠ ยอดที่เลือกเกินยอดโอน' : '');
  }

  const form = h('form', { className: 'card' },
    h('h1', {}, 'แจ้งชำระเงิน'),
    accounts.length
      ? h('div', {}, h('label', { htmlFor: 'p-acc' }, 'โอนเข้าบัญชี'),
          h('select', { id: 'p-acc', name: 'account' }, accounts.map(a =>
            h('option', { value: a.id }, `${a.bank_name} ${a.account_no} (${a.account_name})${a.promptpay ? ' พร้อมเพย์ ' + a.promptpay : ''}`))))
      : h('div', { className: 'warn' }, 'ยังไม่ได้ตั้งบัญชีรับเงิน กรุณาสอบถามเหรัญญิกก่อนโอน'),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'p-amt' }, 'ยอดที่โอน (บาท)'),
        h('input', { id: 'p-amt', name: 'amount', inputMode: 'decimal', required: true, oninput: update })),
      h('div', {}, h('label', { htmlFor: 'p-at' }, 'วันเวลาที่โอน'),
        h('input', { id: 'p-at', name: 'transferred_at', type: 'datetime-local', required: true, value: nowLocal, max: nowLocal }))),
    h('label', { htmlFor: 'p-slip' }, 'สลิป (รูป JPG, PNG หรือ WEBP ไม่เกิน 5 MB)'),
    h('input', { id: 'p-slip', name: 'slip', type: 'file', accept: Object.keys(SLIP_TYPES).join(','), required: true }),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'p-bank' }, 'ธนาคารที่โอน (ไม่บังคับ)'), h('input', { id: 'p-bank', name: 'payer_bank' })),
      h('div', {}, h('label', { htmlFor: 'p-ref' }, 'เลขอ้างอิงในสลิป (ไม่บังคับ)'), h('input', { id: 'p-ref', name: 'reference_no' }))),
    h('label', {}, 'ชำระรายการไหน'),
    picks.length ? picks.map(p => p.el) : h('p', { className: 'muted' }, 'คุณไม่มียอดค้าง ยอดที่โอนจะเก็บเป็นเครดิต หรือจ่ายแทนเพื่อนด้านล่าง'),
    others,
    open.length ? h('button', { type: 'button', className: 'link', style: 'margin-top:8px', onclick: addOther }, '+ จ่ายแทนเพื่อน') : null,
    summary,
    h('label', { htmlFor: 'p-note' }, 'หมายเหตุ (ไม่บังคับ)'),
    h('textarea', { id: 'p-note', name: 'note', rows: 2 }),
    h('div', { className: 'row', style: 'margin-top:16px' }, h('button', { type: 'submit' }, 'ส่งข้อมูล')),
    msgBox());

  onSubmit(form, async f => {
    const amount = toSatang(f.amount);
    if (!amount) throw new Error('กรอกยอดที่โอนเป็นตัวเลข เช่น 500 หรือ 500.50');
    const file = form.slip.files[0];
    if (!file || !SLIP_TYPES[file.type]) throw new Error('สลิปต้องเป็นรูป JPG, PNG หรือ WEBP');
    if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์สลิปใหญ่เกิน 5 MB');
    const list = items();
    if (list.some(i => !i.amount_satang)) throw new Error('กรอกยอดของแต่ละรายการที่เลือกให้ถูกต้อง');
    if (list.some(i => i.student_id === '')) throw new Error('กรอกรหัสนิสิตของเพื่อนที่จ่ายแทน');
    if (list.reduce((s, i) => s + i.amount_satang, 0) > amount) throw new Error('ยอดที่เลือกรวมกันเกินยอดที่โอน');

    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const path = `${me.id}/${crypto.randomUUID()}.${SLIP_TYPES[file.type]}`;
    must(await sb.storage.from('slips').upload(path, file, { contentType: file.type }));
    must(await sb.rpc('submit_payment', {
      p_amount_satang: amount,
      p_transferred_at: new Date(f.transferred_at).toISOString(),
      p_slip_path: path,
      p_items: list.map(({ title, ...i }) => i),
      p_bank_account_id: f.account || null,
      p_payer_bank: f.payer_bank, p_reference_no: f.reference_no, p_note: f.note,
      p_slip_sha256: hash,
    }));
    toast('ส่งข้อมูลแล้ว รอเหรัญญิกตรวจสอบ');
    location.hash = 'my-payments';
  });
  update();
  return form;
}

async function renderMyPayments() {
  const [rows, credit] = await Promise.all([
    sb.from('payment_submissions')
      .select('*, submission_allocations(amount_satang, member_charges(charges(title)))')
      .eq('member_id', member.id).order('created_at', { ascending: false }).then(must),
    sb.from('member_credit').select('credit_satang').eq('member_id', member.id).maybeSingle().then(must),
  ]);
  if (!rows.length) return empty('ยังไม่มีรายการชำระเงิน เมื่อแจ้งชำระแล้ว รายการจะแสดงที่นี่',
    h('a', { className: 'btn', href: '#pay' }, 'แจ้งชำระเงิน'));

  const cancel = async r => {
    if (!confirm(`ยกเลิกการแจ้งชำระ ${baht(r.amount_satang)} บาท?`)) return;
    try { must(await sb.rpc('cancel_payment', { p_id: r.id })); toast('ยกเลิกแล้ว'); route(); }
    catch (err) { toast(thai(err)); }
  };

  return h('div', { className: 'card' },
    h('div', { className: 'row' }, h('h1', {}, 'การชำระของฉัน'),
      h('a', { className: 'btn', href: '#pay', style: 'margin-left:auto' }, 'แจ้งชำระเงิน')),
    Number(credit?.credit_satang) ? h('p', {}, 'เครดิตคงเหลือ ', money(credit.credit_satang), ' ใช้ตัดยอดได้ที่หน้าหลัก') : null,
    table([
      ['ส่งเมื่อ', r => when(r.created_at)],
      ['ยอดโอน', r => money(r.amount_satang)],
      ['รายการ', r => r.submission_allocations.length
        ? r.submission_allocations.map(a => h('div', {}, a.member_charges?.charges?.title ?? 'จ่ายแทนเพื่อน', ' ', money(a.amount_satang)))
        : 'เก็บเป็นเครดิต'],
      ['สถานะ', r => h('div', {}, chip(r.status), r.reject_reason ? h('div', { className: 'muted' }, 'เหตุผล: ' + r.reject_reason) : null)],
      ['', r => h('div', { className: 'row' },
        h('button', { className: 'link', onclick: () => openSlip(r.slip_path) }, 'ดูสลิป'),
        r.status === 'pending' ? h('button', { className: 'link', onclick: () => cancel(r) }, 'ยกเลิก') : null)],
    ], rows));
}

// ตรวจสลิป (เหรัญญิก)
let reviewFilter = 'pending';
async function renderReview(id) {
  if (id) return renderReviewDetail(id);
  const rows = await sb.from('payment_submissions').select('*, members(full_name, student_id)')
    .eq('status', reviewFilter).order('created_at', { ascending: reviewFilter === 'pending' }).limit(200).then(must);
  const filter = h('select', { 'aria-label': 'สถานะ', style: 'width:auto', onchange: e => { reviewFilter = e.target.value; route(); } },
    Object.entries(STATUS).map(([k, [t]]) => h('option', { value: k, selected: k === reviewFilter }, t)));
  return h('div', { className: 'card' },
    h('div', { className: 'row' }, h('h1', {}, 'ตรวจสลิป'), h('div', { style: 'margin-left:auto' }, filter)),
    rows.length
      ? table([
          ['ส่งเมื่อ', r => when(r.created_at)],
          ['ผู้ส่ง', r => `${r.members.full_name} (${r.members.student_id})`],
          ['ยอดโอน', r => money(r.amount_satang)],
          ['เวลาโอน', r => when(r.transferred_at)],
          ['สถานะ', r => chip(r.status)],
        ], rows, r => location.hash = 'review/' + r.id)
      : h('p', { className: 'muted' }, reviewFilter === 'pending' ? 'ไม่มีสลิปรอตรวจ ✓' : 'ไม่มีรายการ'));
}

async function renderReviewDetail(id) {
  const s = await sb.from('payment_submissions')
    .select(`*, members(full_name, student_id), bank_accounts(bank_name, account_no, account_name),
             submission_allocations(amount_satang, member_charges(charges(title), members(full_name, student_id)))`)
    .eq('id', id).single().then(must);
  const [url, sameFile, sameRef, reviewer] = await Promise.all([
    sb.storage.from('slips').createSignedUrl(s.slip_path, 600).then(r => r.data?.signedUrl),
    s.slip_sha256 ? sb.from('payment_submissions').select('id, status, created_at').eq('slip_sha256', s.slip_sha256).neq('id', id).then(must) : [],
    s.reference_no ? sb.from('payment_submissions').select('id, status, created_at').eq('reference_no', s.reference_no).neq('id', id).then(must) : [],
    s.reviewed_by ? sb.from('members').select('full_name').eq('user_id', s.reviewed_by).maybeSingle().then(r => r.data?.full_name ?? '-') : null,
  ]);
  const allocated = s.submission_allocations.reduce((t, a) => t + Number(a.amount_satang), 0);
  const dupLinks = list => list.map(d => h('div', {}, h('a', { href: '#review/' + d.id }, when(d.created_at)), ' ', chip(d.status)));

  const actions = msgBox();
  const act = async (fn, okText) => {
    try { await fn(); toast(okText); }
    catch (err) { toast(thai(err)); }
    route(); // โหลดสถานะล่าสุดเสมอ เผื่อมีคนตรวจไปแล้ว
  };

  const reason = h('select', { name: 'reason', 'aria-label': 'เหตุผลที่ไม่ผ่าน' }, REJECT_REASONS.map(r => h('option', {}, r)));
  const detail = h('input', { name: 'detail', placeholder: 'รายละเอียดเพิ่มเติม', 'aria-label': 'รายละเอียดเพิ่มเติม' });

  const review = s.status !== 'pending' ? null : h('div', {},
    h('div', { className: 'warn' }, 'ตรวจยอดเงินเข้าในบัญชีธนาคารก่อนกดยืนยัน ผลอ่านสลิปไม่ใช่หลักฐานว่าเงินเข้าจริง'),
    h('div', { className: 'row' },
      h('button', { className: 'ok', onclick: e => {
        if (!confirm(`ยืนยันว่าเงิน ${baht(s.amount_satang)} บาท จาก ${s.members.full_name} เข้าบัญชีแล้ว?`)) return;
        e.target.disabled = true;
        act(() => sb.rpc('confirm_payment', { p_id: id }).then(must), 'ยืนยันรับเงินแล้ว');
      } }, 'ยืนยันรับเงิน')),
    h('label', {}, 'ไม่ผ่าน'),
    h('div', { className: 'grid' }, reason, detail,
      h('button', { className: 'danger', onclick: e => {
        const text = [reason.value, detail.value.trim()].filter(Boolean).join(': ');
        if (reason.value === 'อื่น ๆ' && !detail.value.trim()) return say(actions, 'กรุณากรอกรายละเอียดเหตุผล');
        if (!confirm(`ไม่ผ่าน เพราะ "${text}"?`)) return;
        e.target.disabled = true;
        act(() => sb.rpc('reject_payment', { p_id: id, p_reason: text }).then(must), 'บันทึกว่าไม่ผ่านแล้ว');
      } }, 'ไม่ผ่าน')),
    actions);

  return h('div', {},
    h('p', {}, h('a', { href: '#review' }, '← กลับไปรายการ')),
    h('div', { className: 'split' },
      h('div', { className: 'card' }, url ? h('img', { className: 'slip', src: url, alt: 'สลิปการโอน' }) : h('p', {}, 'เปิดสลิปไม่ได้')),
      h('div', { className: 'card' },
        h('h1', {}, money(s.amount_satang)),
        h('p', {}, chip(s.status)),
        (sameFile.length || sameRef.length) ? h('div', { className: 'warn' },
          sameFile.length ? h('div', {}, h('b', {}, 'พบไฟล์สลิปเดียวกันในรายการอื่น'), dupLinks(sameFile)) : null,
          sameRef.length ? h('div', {}, h('b', {}, 'พบเลขอ้างอิงเดียวกันในรายการอื่น'), dupLinks(sameRef)) : null) : null,
        h('dl', {},
          h('dt', {}, 'ผู้ส่ง'), h('dd', {}, `${s.members.full_name} (${s.members.student_id})`),
          h('dt', {}, 'เวลาโอน'), h('dd', {}, when(s.transferred_at)),
          h('dt', {}, 'บัญชีปลายทาง'), h('dd', {}, s.bank_accounts ? `${s.bank_accounts.bank_name} ${s.bank_accounts.account_no}` : '-'),
          h('dt', {}, 'ธนาคารผู้โอน'), h('dd', {}, s.payer_bank ?? '-'),
          h('dt', {}, 'เลขอ้างอิง'), h('dd', {}, s.reference_no ?? '-'),
          h('dt', {}, 'หมายเหตุ'), h('dd', {}, s.note ?? '-'),
          h('dt', {}, 'ตัดรายการ'), h('dd', {}, s.submission_allocations.length
            ? s.submission_allocations.map(a => h('div', {}, a.member_charges.charges.title, ' · ',
                a.member_charges.members.full_name, ' ', money(a.amount_satang)))
            : '-'),
          h('dt', {}, 'เป็นเครดิต'), h('dd', {}, money(Number(s.amount_satang) - allocated)),
          h('dt', {}, 'ส่งเมื่อ'), h('dd', {}, when(s.created_at)),
          s.reviewed_at ? [h('dt', {}, 'ผู้ตรวจ'), h('dd', {}, `${reviewer} · ${when(s.reviewed_at)}`)] : null,
          s.reject_reason ? [h('dt', {}, 'เหตุผล'), h('dd', {}, s.reject_reason)] : null),
        review)));
}

// รายการเรียกเก็บ: สร้าง (ประธาน/แอดมิน) และดูยอดค้างรายคน
async function renderCharges(id) {
  if (id) return renderChargeDetail(id);
  const [charges, balances] = await Promise.all([
    sb.from('charges').select('*').order('created_at', { ascending: false }).then(must),
    sb.from('charge_balances').select('charge_id, outstanding_satang').then(must),
  ]);
  const stats = new Map();
  for (const b of balances) {
    const st = stats.get(b.charge_id) ?? { n: 0, done: 0, owed: 0 };
    st.n++; if (Number(b.outstanding_satang) === 0) st.done++; st.owed += Number(b.outstanding_satang);
    stats.set(b.charge_id, st);
  }

  const create = can('president', 'admin') ? onSubmit(h('form', { className: 'card' },
    h('h2', {}, 'สร้างรายการเรียกเก็บ'),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'c-title' }, 'ชื่อรายการ'), h('input', { id: 'c-title', name: 'title', required: true, placeholder: 'เช่น ค่ากิจกรรมรุ่น 2569' })),
      h('div', {}, h('label', { htmlFor: 'c-amt' }, 'ยอดต่อคน (บาท)'), h('input', { id: 'c-amt', name: 'amount', inputMode: 'decimal', required: true })),
      h('div', {}, h('label', { htmlFor: 'c-due' }, 'ครบกำหนด'), h('input', { id: 'c-due', name: 'due', type: 'date' }))),
    h('label', { htmlFor: 'c-desc' }, 'รายละเอียด (ไม่บังคับ)'), h('input', { id: 'c-desc', name: 'description' }),
    h('label', { htmlFor: 'c-who' }, 'เรียกเก็บใคร'),
    h('textarea', { id: 'c-who', name: 'who', rows: 2, placeholder: 'เว้นว่าง = สมาชิกทุกคน หรือใส่รหัสนิสิตคั่นด้วยเว้นวรรค/จุลภาค' }),
    h('div', { className: 'row', style: 'margin-top:12px' }, h('button', { type: 'submit' }, 'สร้างรายการ')),
    msgBox()), async f => {
      const amount = toSatang(f.amount);
      if (!amount) throw new Error('กรอกยอดต่อคนเป็นตัวเลข');
      const ids = f.who.split(/[\s,]+/).filter(Boolean);
      if (!confirm(`สร้าง "${f.title}" ${baht(amount)} บาท/คน เรียกเก็บ${ids.length ? ` ${ids.length} คน` : 'สมาชิกทุกคน'}?`)) return;
      const cid = must(await sb.rpc('create_charge', {
        p_title: f.title, p_amount_satang: amount, p_due_date: f.due || null,
        p_description: f.description, p_student_ids: ids.length ? ids : null,
      }));
      toast('สร้างรายการแล้ว และแจ้งสมาชิกแล้ว');
      location.hash = 'charges/' + cid;
    }) : null;

  return h('div', {}, create,
    charges.length
      ? h('div', { className: 'card' }, h('h2', {}, 'รายการทั้งหมด'), table([
          ['รายการ', c => c.title],
          ['ครบกำหนด', c => day(c.due_date)],
          ['ยอดต่อคน', c => money(c.amount_satang)],
          ['ชำระครบ', c => { const st = stats.get(c.id); return st ? `${st.done}/${st.n} คน` : '-'; }],
          ['ยอดค้างรวม', c => money(stats.get(c.id)?.owed ?? 0)],
          ['สถานะ', c => h('span', { className: 'chip ' + (c.status === 'open' ? 'ok' : 'muted') }, c.status === 'open' ? 'เปิดรับชำระ' : 'ปิดแล้ว')],
        ], charges, c => location.hash = 'charges/' + c.id))
      : empty('ยังไม่มีรายการเรียกเก็บ'));
}

let chargeFilter = 'all';
async function renderChargeDetail(id) {
  const [c, rows] = await Promise.all([
    sb.from('charges').select('*').eq('id', id).single().then(must),
    sb.from('charge_balances').select('*').eq('charge_id', id).order('student_id').then(must),
  ]);
  const search = h('input', { placeholder: 'ค้นหาชื่อ หรือรหัสนิสิต...', 'aria-label': 'ค้นหา', oninput: draw });
  const box = h('div');
  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = rows.filter(r =>
      (chargeFilter === 'all' || (chargeFilter === 'owed') === (Number(r.outstanding_satang) > 0)) &&
      (!q || r.full_name.toLowerCase().includes(q) || r.student_id.includes(q)));
    box.replaceChildren(shown.length ? table([
      ['รหัสนิสิต', r => r.student_id], ['ชื่อ', r => r.full_name],
      ['ยอด', r => money(r.amount_satang)], ['ชำระแล้ว', r => money(r.paid_satang)], ['คงค้าง', r => money(r.outstanding_satang)],
      ['สถานะ', r => Number(r.outstanding_satang) === 0 ? h('span', { className: 'chip ok' }, 'ชำระครบ') : h('span', { className: 'chip wait' }, 'ค้างชำระ')],
    ], shown) : h('p', { className: 'muted' }, 'ไม่พบรายการ'));
  }
  const filter = h('select', { style: 'width:auto', 'aria-label': 'กรอง', onchange: e => { chargeFilter = e.target.value; draw(); } },
    [['all', 'ทั้งหมด'], ['owed', 'ค้างชำระ'], ['paid', 'ชำระครบ']].map(([v, t]) => h('option', { value: v, selected: v === chargeFilter }, t)));
  const toggle = can('president', 'admin') ? h('button', { className: 'ghost', onclick: async () => {
    const next = c.status === 'open' ? 'closed' : 'open';
    if (!confirm(next === 'closed' ? 'ปิดรับชำระรายการนี้?' : 'เปิดรับชำระอีกครั้ง?')) return;
    try { must(await sb.from('charges').update({ status: next }).eq('id', id)); route(); } catch (err) { toast(thai(err)); }
  } }, c.status === 'open' ? 'ปิดรับชำระ' : 'เปิดรับชำระอีกครั้ง') : null;
  const owed = rows.reduce((s, r) => s + Number(r.outstanding_satang), 0);
  draw();
  return h('div', {},
    h('p', {}, h('a', { href: '#charges' }, '← กลับไปรายการ')),
    h('div', { className: 'card' },
      h('div', { className: 'row' }, h('h1', {}, c.title), h('div', { style: 'margin-left:auto' }, toggle)),
      h('p', { className: 'muted' }, `${baht(c.amount_satang)} บาท/คน · ครบกำหนด ${day(c.due_date)}`, c.description ? ' · ' + c.description : ''),
      h('p', {}, `ชำระครบ ${rows.filter(r => Number(r.outstanding_satang) === 0).length}/${rows.length} คน · ยอดค้างรวม `, money(owed)),
      h('div', { className: 'grid', style: 'margin-bottom:8px' }, search, filter),
      box));
}

// สมาชิก สิทธิ์ และบัญชีรับเงิน (แอดมิน)
async function renderMembers() {
  const [members, roleRows, accounts] = await Promise.all([
    sb.from('members').select('*').order('student_id').then(must),
    sb.from('user_roles').select('user_id, role').then(must),
    sb.from('bank_accounts').select('*').order('created_at').then(must),
  ]);
  const byUser = new Map();
  for (const r of roleRows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? new Set()).add(r.role));

  const roleBoxes = m => EXTRA_ROLES.map(r => {
    const has = byUser.get(m.user_id)?.has(r) ?? false;
    const cb = h('input', { type: 'checkbox', checked: has, disabled: !m.user_id || !m.active || m.user_id === me.id });
    cb.onchange = async () => {
      if (!confirm(`ยืนยัน${cb.checked ? 'ให้' : 'ถอน'}บทบาท "${ROLE_TH[r]}" ของ ${m.full_name}?`)) { cb.checked = !cb.checked; return; }
      const { error } = cb.checked
        ? await sb.from('user_roles').insert({ user_id: m.user_id, role: r })
        : await sb.from('user_roles').delete().eq('user_id', m.user_id).eq('role', r);
      if (error) { cb.checked = !cb.checked; toast(thai(error)); }
    };
    return h('label', {}, cb, ROLE_TH[r]);
  });

  const addMember = onSubmit(h('form', { className: 'grid' },
    h('div', {}, h('label', { htmlFor: 'am-sid' }, 'รหัสนิสิต'), h('input', { id: 'am-sid', name: 'student_id', required: true })),
    h('div', {}, h('label', { htmlFor: 'am-name' }, 'ชื่อ-นามสกุล'), h('input', { id: 'am-name', name: 'full_name', required: true })),
    h('div', {}, h('label', { htmlFor: 'am-email' }, 'อีเมล'), h('input', { id: 'am-email', name: 'email', type: 'email', required: true })),
    h('button', { type: 'submit' }, 'เพิ่มสมาชิก'), msgBox()), async f => {
      must(await sb.from('members').insert({ student_id: f.student_id.trim(), full_name: f.full_name.trim(), email: f.email.trim().toLowerCase() }));
      toast('เพิ่มสมาชิกแล้ว แจ้งให้สมาชิกสมัครด้วยรหัสนิสิตและอีเมลนี้');
      route();
    });

  const importResult = h('div');
  const importForm = onSubmit(h('form', {},
    h('label', { htmlFor: 'im-rows' }, 'นำเข้าหลายคน: คัดลอก 3 คอลัมน์ (รหัสนิสิต, ชื่อ-นามสกุล, อีเมล) จาก Excel หรือ Google Sheets มาวาง'),
    h('textarea', { id: 'im-rows', name: 'rows', rows: 5, required: true,
                    placeholder: '65010001\tสมชาย ใจดี\tsomchai@gmail.com\n65010002\tสมหญิง รักเรียน\tsomying@gmail.com' }),
    h('div', { className: 'row', style: 'margin-top:8px' }, h('button', { type: 'submit' }, 'นำเข้า')),
    msgBox()), async f => {
      const rows = parseMemberRows(f.rows);
      if (!rows.length) throw new Error('ไม่พบรายชื่อ ตรวจว่าวางข้อมูลครบ 3 คอลัมน์');
      if (!confirm(`นำเข้า ${rows.length} คน?`)) return;
      const res = must(await sb.rpc('import_members', { p_rows: rows }));
      const added = res.filter(r => r.result === 'เพิ่มแล้ว').length;
      const failed = res.filter(r => r.result !== 'เพิ่มแล้ว');
      importResult.replaceChildren(failed.length
        ? h('div', { className: 'warn' }, h('b', {}, `ไม่ได้เพิ่ม ${failed.length} แถว (แก้แล้ววางเฉพาะแถวเหล่านี้ใหม่ได้)`),
            table([['รหัสนิสิต', r => r.student_id ?? '-'], ['ชื่อ', r => r.full_name ?? '-'], ['อีเมล', r => r.email ?? '-'], ['เหตุผล', r => r.result]], failed))
        : '');
      if (added) {
        $('#page').replaceChildren(await renderMembers()); // โหลดตารางใหม่ แต่คงผลนำเข้าไว้ให้เห็น
        toast(`เพิ่มสมาชิกแล้ว ${added} คน`);
      }
      $('#im-result').replaceChildren(importResult);
      return failed.length ? '' : `เพิ่มครบ ${added} คน`;
    });

  const edit = async m => {
    const v = await dialogForm('แก้ไขข้อมูลสมาชิก', [
      { name: 'student_id', label: 'รหัสนิสิต', value: m.student_id },
      { name: 'full_name', label: 'ชื่อ-นามสกุล', value: m.full_name },
      { name: 'email', label: m.user_id ? 'อีเมล (สมัครแล้ว แก้ตรงนี้ไม่เปลี่ยนอีเมลที่ใช้ล็อกอิน)' : 'อีเมล (ต้องตรงกับที่จะใช้สมัคร)', value: m.email, type: 'email' },
    ], 'บันทึก');
    if (!v) return;
    try {
      must(await sb.from('members').update({ student_id: v.student_id.trim(), full_name: v.full_name.trim(), email: v.email.trim().toLowerCase() }).eq('id', m.id));
      toast('บันทึกแล้ว'); route();
    } catch (err) { toast(thai(err)); }
  };

  const setActive = async m => {
    const v = await dialogForm(m.active ? `ระงับบัญชี ${m.full_name}` : `เปิดใช้บัญชี ${m.full_name}`,
      [{ name: 'reason', label: m.active ? 'เหตุผลที่ระงับ (จะถูกบันทึกในประวัติ)' : 'เหตุผลที่เปิดใช้อีกครั้ง' }],
      m.active ? 'ระงับบัญชี' : 'เปิดใช้บัญชี', m.active);
    if (!v) return;
    try {
      must(await sb.rpc('set_member_active', { p_member_id: m.id, p_active: !m.active, p_reason: v.reason }));
      toast(m.active ? 'ระงับบัญชีแล้ว สิทธิ์ทั้งหมดหยุดใช้ทันที' : 'เปิดใช้บัญชีแล้ว'); route();
    } catch (err) { toast(thai(err)); }
  };

  const addAccount = onSubmit(h('form', { className: 'grid' },
    h('div', {}, h('label', { htmlFor: 'ba-bank' }, 'ธนาคาร'), h('input', { id: 'ba-bank', name: 'bank_name', required: true })),
    h('div', {}, h('label', { htmlFor: 'ba-name' }, 'ชื่อบัญชี'), h('input', { id: 'ba-name', name: 'account_name', required: true })),
    h('div', {}, h('label', { htmlFor: 'ba-no' }, 'เลขบัญชี'), h('input', { id: 'ba-no', name: 'account_no', required: true })),
    h('div', {}, h('label', { htmlFor: 'ba-pp' }, 'พร้อมเพย์ (ไม่บังคับ)'), h('input', { id: 'ba-pp', name: 'promptpay' })),
    h('button', { type: 'submit' }, 'เพิ่มบัญชี'), msgBox()), async f => {
      must(await sb.from('bank_accounts').insert({ ...f, promptpay: f.promptpay || null }));
      toast('เพิ่มบัญชีรับเงินแล้ว');
      route();
    });

  const toggleAccount = async a => {
    if (!confirm(`${a.active ? 'ปิด' : 'เปิด'}ใช้บัญชี ${a.bank_name} ${a.account_no}?`)) return;
    try { must(await sb.from('bank_accounts').update({ active: !a.active }).eq('id', a.id)); route(); } catch (err) { toast(thai(err)); }
  };

  return h('div', {},
    h('div', { className: 'card' }, h('h2', {}, 'เพิ่มสมาชิก'), addMember,
      h('hr', { style: 'border:0; border-top:1px solid var(--line); margin:20px 0 8px' }),
      importForm, h('div', { id: 'im-result' })),
    h('div', { className: 'card' }, h('h2', {}, `สมาชิกและสิทธิ์ (${members.length} คน)`),
      table([
        ['รหัสนิสิต', m => m.student_id],
        ['ชื่อ', m => h('div', {}, m.full_name, h('div', { className: 'muted' }, m.email))],
        ['สถานะ', m => h('span', { className: 'chip ' + (!m.active ? 'bad' : m.user_id ? 'ok' : 'wait') },
          !m.active ? 'ระงับ' : m.user_id ? 'สมัครแล้ว' : 'ยังไม่สมัคร')],
        ['บทบาทเพิ่มเติม', roleBoxes],
        ['จัดการ', m => h('div', { className: 'row' },
          h('button', { className: 'link', onclick: () => edit(m) }, 'แก้ไข'),
          m.user_id === me.id ? null
            : h('button', { className: 'link', style: m.active ? 'color:var(--red)' : null, onclick: () => setActive(m) },
                m.active ? 'ระงับ' : 'เปิดใช้')),
        ],
      ], members),
      h('p', { className: 'muted' }, 'ให้บทบาทหรือระงับบัญชีตัวเองไม่ได้ ทุกการเปลี่ยนแปลงถูกบันทึกในประวัติการกระทำ')),
    h('div', { className: 'card' }, h('h2', {}, 'บัญชีรับเงิน'), addAccount,
      accounts.length ? table([
        ['ธนาคาร', a => a.bank_name], ['ชื่อบัญชี', a => a.account_name], ['เลขบัญชี', a => a.account_no],
        ['พร้อมเพย์', a => a.promptpay ?? '-'],
        ['', a => h('button', { className: 'link', onclick: () => toggleAccount(a) }, a.active ? 'ใช้งานอยู่ · ปิด' : 'ปิดอยู่ · เปิด')],
      ], accounts) : h('p', { className: 'muted' }, 'ยังไม่มีบัญชีรับเงิน')));
}

// ─── กระดิ่งแจ้งเตือน ─────────────────────────────────────────────

const panel = $('#bell-panel');

async function refreshBell() {
  if (!me) return;
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  $('#bell-count').textContent = count || '';
  $('#bell-count').hidden = !count;
  $('#bell').setAttribute('aria-label', count ? `การแจ้งเตือน ยังไม่อ่าน ${count} รายการ` : 'การแจ้งเตือน');
  if (!panel.hidden) renderBellPanel();
}

async function markRead(query) {
  await query.is('read_at', null);
  refreshBell();
}

async function renderBellPanel() {
  const { data: rows = [] } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30);
  panel.replaceChildren(
    h('div', { className: 'bell-head' }, h('b', {}, 'การแจ้งเตือน'),
      h('button', { className: 'link', onclick: () => markRead(sb.from('notifications').update({ read_at: new Date().toISOString() })) }, 'อ่านทั้งหมด')),
    ...rows.length ? rows.map(n => h('a', {
      href: n.link || '#home', className: 'note' + (n.read_at ? '' : ' unread'),
      onclick: () => { panel.hidden = true; markRead(sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id)); },
    }, h('span', { className: 'dot ' + n.kind, title: KIND_TH[n.kind] }),
       h('span', {}, n.title, h('small', {}, KIND_TH[n.kind], ' · ', when(n.created_at)))))
    : [h('p', { className: 'muted', style: 'padding:0 14px' }, 'ยังไม่มีการแจ้งเตือน')]);
}

$('#bell').onclick = e => {
  e.stopPropagation();
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderBellPanel();
};
document.addEventListener('click', e => { if (!panel.contains(e.target)) panel.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') panel.hidden = true; });

// ─── อัปเดตทันที: Realtime + ดึงซ้ำทุก 60 วินาทีเผื่อหลุด ────────────────

let channel = null, poll = null;

function startLive() {
  stopLive();
  channel = sb.channel('live-' + me.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me.id}` }, () => {
      refreshBell(); renderTabs();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_submissions' }, p => {
      renderTabs();
      const [name, param] = location.hash.slice(1).split('/');
      // ไม่รีเฟรชหน้ารายละเอียดของรายการอื่น เพื่อไม่ให้ข้อความที่พิมพ์อยู่หาย
      if ((name === 'review' && (!param || param === p.new?.id)) || name === 'my-payments' || name === 'home' || !name) route();
    })
    .subscribe();
  poll = setInterval(() => { refreshBell(); renderTabs(); }, 60000);
  refreshBell();
}

function stopLive() {
  if (channel) sb.removeChannel(channel);
  clearInterval(poll);
  channel = null;
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshBell(); renderTabs(); } });

// ─── เข้าสู่ระบบ ─────────────────────────────────────────────────

onSubmit($('[data-view=login]'), async ({ email, password }) => {
  must(await sb.auth.signInWithPassword({ email, password }));
});

onSubmit($('[data-view=signup]'), async ({ student_id, email, password }) => {
  const data = must(await sb.auth.signUp({
    email, password,
    options: { data: { student_id: student_id.trim() }, emailRedirectTo: location.origin + location.pathname },
  }));
  if (!data.session) return 'สมัครสำเร็จ กรุณาเปิดอีเมลแล้วกดลิงก์ยืนยันก่อนเข้าสู่ระบบ';
});

onSubmit($('[data-view=forgot]'), async ({ email }) => {
  must(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
  return 'ถ้าอีเมลนี้มีในระบบ จะได้รับลิงก์ตั้งรหัสผ่านใหม่ภายในไม่กี่นาที';
});

onSubmit($('[data-view=reset]'), async ({ password }) => {
  must(await sb.auth.updateUser({ password }));
  recovering = false;
  history.replaceState(null, '', location.pathname);
  route();
});

$('#logout').onclick = () => sb.auth.signOut();

// ─── เลือกหน้าตามสถานะการเข้าสู่ระบบและ #hash ─────────────────────────

function show(view) {
  $('#boot').hidden = true;
  document.querySelectorAll('[data-view]').forEach(el => el.hidden = el.dataset.view !== view);
  $('#user-bar').hidden = $('#whoami').hidden = view !== 'app';
}

let recovering = false, seq = 0, profileReady = null;

async function route() {
  if (recovering) return show('reset');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    me = member = null; roles = new Set(); stopLive(); panel.hidden = true;
    const view = location.hash.slice(1);
    return show(['signup', 'forgot'].includes(view) ? view : 'login');
  }

  const run = ++seq;
  const page = $('#page');
  try {
    // ตอนเปิดเว็บ Supabase ส่ง event เข้าสู่ระบบมาติดกันหลายครั้ง ทุกรอบต้องรอโหลดโปรไฟล์ชุดเดียวกัน
    if (me?.id !== session.user.id) {
      me = session.user;
      profileReady = loadProfile();
      startLive();
    }
    await profileReady;
    show('app');
    renderTabs();
    const [name, param] = location.hash.slice(1).split('/');
    const p = PAGES[name]?.allowed() ? PAGES[name] : PAGES.home;
    if (!page.firstChild) page.append(h('p', { className: 'muted' }, 'กำลังโหลด…'));
    const el = await p.render(param);
    if (run === seq) page.replaceChildren(el);
  } catch (err) {
    if (run !== seq) return;
    show('app');
    page.replaceChildren(h('div', { className: 'card' },
      h('h2', {}, 'ไม่สามารถโหลดข้อมูลได้'), h('p', { className: 'muted' }, thai(err) + ' กรุณาลองใหม่อีกครั้ง'),
      h('button', { onclick: () => { me = null; route(); } }, 'ลองใหม่')));
  }
}

sb.auth.onAuthStateChange(event => {
  if (event === 'PASSWORD_RECOVERY') recovering = true;
  if (event === 'SIGNED_OUT') me = null;
  // เรียก Supabase ต่อใน callback ตรง ๆ อาจค้าง จึงเลื่อนออกไปหนึ่งจังหวะ
  if (event !== 'TOKEN_REFRESHED') setTimeout(route, 0);
});
addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
