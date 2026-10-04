import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, root = document) => root.querySelector(s);

const ROLE_TH = { member: 'สมาชิก', treasurer: 'เหรัญญิก', president: 'ประธาน', auditor: 'ผู้ตรวจสอบ', admin: 'แอดมิน' };
const EXTRA_ROLES = ['treasurer', 'president', 'auditor', 'admin'];
const STATUS = {
  pending: ['รอตรวจสอบ', 'wait'], confirmed: ['ยืนยันแล้ว', 'ok'],
  rejected: ['ไม่ผ่านการตรวจสอบ', 'bad'], cancelled: ['ยกเลิกแล้ว', 'muted'], voided: ['ยกเลิกหลังยืนยัน', 'bad'],
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
        h('input', { id: 'd-' + f.name, name: f.name, type: f.type ?? 'text', accept: f.accept,
                     value: f.type === 'file' ? null : (f.value ?? ''), required: f.required !== false }),
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

// ดาวน์โหลดตารางเป็น CSV ที่ Excel เปิดภาษาไทยได้ (BOM นำหน้า)
// ช่องที่ขึ้นต้นด้วย = + @ หรือ - (ที่ไม่ใช่ตัวเลขติดลบ) ใส่ ' นำหน้า กัน Excel ตีความเป็นสูตร
function downloadCsv(filename, rows) {
  const cell = v => {
    let t = String(v ?? '');
    if (/^[=+@\t\r]/.test(t) || /^-(?!\d)/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const text = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ไฟล์ตัวอย่างมีแค่หัวตาราง (ไม่มีแถวตัวอย่าง กันลืมลบแล้วนำเข้าคนปลอม)
const downloadTemplate = () => downloadCsv('รายชื่อสมาชิก-ตัวอย่าง.csv', [['รหัสนิสิต', 'ชื่อ-นามสกุล', 'อีเมล']]);

async function openFile(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 600);
  if (error) return toast(thai(error));
  open(data.signedUrl, '_blank', 'noopener');
}
const openSlip = path => openFile('slips', path);
const fileLink = (path, label) => path ? h('button', { className: 'link', onclick: () => openFile('evidence', path) }, label) : '-';

// สลิปโอนเงิน: รูปเท่านั้น ไม่เกิน 5 MB เก็บในโฟลเดอร์ของผู้อัปโหลด (bucket slips ไม่เปิดให้สมาชิกคนอื่นเห็น)
async function uploadSlip(file) {
  if (!file || !SLIP_TYPES[file.type]) throw new Error('สลิปต้องเป็นรูป JPG, PNG หรือ WEBP');
  if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์สลิปใหญ่เกิน 5 MB');
  const path = `${me.id}/${crypto.randomUUID()}.${SLIP_TYPES[file.type]}`;
  must(await sb.storage.from('slips').upload(path, file, { contentType: file.type }));
  return path;
}

// ใบเสนอราคา/ใบเสร็จ: รูปหรือ PDF ไม่เกิน 10 MB เก็บในโฟลเดอร์ของผู้อัปโหลด
const EVIDENCE_TYPES = { ...SLIP_TYPES, 'application/pdf': 'pdf' };
async function uploadEvidence(file) {
  if (!EVIDENCE_TYPES[file.type]) throw new Error('ไฟล์หลักฐานต้องเป็นรูป JPG, PNG, WEBP หรือ PDF');
  if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์หลักฐานใหญ่เกิน 10 MB');
  const path = `${me.id}/${crypto.randomUUID()}.${EVIDENCE_TYPES[file.type]}`;
  must(await sb.storage.from('evidence').upload(path, file, { contentType: file.type }));
  return path;
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

async function expenseCount(status) {
  const { count } = await sb.from('expense_requests').select('id', { count: 'exact', head: true }).eq('status', status);
  return count ?? 0;
}

// ─── หน้าต่าง ๆ ─────────────────────────────────────────────────

// ไอคอนเส้น (SVG คงที่ ไม่มีข้อมูลผู้ใช้ปน)
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  pay: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>'),
  receipt: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  check: svg('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>'),
  money: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  budget: svg('<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  report: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  history: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  refund: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.3-2.4 3.8M12 17h.01"/>'),
  users: svg('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-5-6"/>'),
};

const active = () => !!member?.active;
const PAGES = {
  home: { group: 'เมนูหลัก', icon: 'home', label: 'หน้าหลัก', allowed: () => true, render: renderHome },
  summary: { group: 'เมนูหลัก', icon: 'chart', label: 'สรุปการเงิน', allowed: active, render: renderSummary },
  pay: { group: 'เมนูหลัก', icon: 'pay', label: 'แจ้งชำระ', allowed: active, render: renderPay },
  'my-payments': { group: 'เมนูหลัก', icon: 'receipt', label: 'การชำระของฉัน', allowed: active, render: renderMyPayments },
  expenses: { group: 'เมนูหลัก', icon: 'money', label: 'เบิกจ่าย', allowed: active, render: renderExpenses },
  review: { group: 'การเงิน', icon: 'check', label: 'ตรวจสลิป', allowed: () => can('treasurer'), render: renderReview },
  charges: { group: 'การเงิน', icon: 'list', label: 'รายการเรียกเก็บ', allowed: () => can('treasurer', 'president', 'auditor', 'admin'), render: renderCharges },
  refunds: { group: 'การเงิน', icon: 'refund', label: 'คืนเงิน', allowed: () => can('treasurer', 'auditor'), render: renderRefunds },
  budget: { group: 'การเงิน', icon: 'budget', label: 'งบประมาณ', allowed: active, render: renderBudget },
  reports: { group: 'การเงิน', icon: 'report', label: 'รายงาน', allowed: active, render: renderReports },
  members: { group: 'ระบบ', icon: 'users', label: 'สมาชิกและตั้งค่า', allowed: () => can('admin'), render: renderMembers },
  audit: { group: 'ระบบ', icon: 'history', label: 'ประวัติการกระทำ', allowed: () => can('auditor', 'admin'), render: renderAudit },
  'manual-member': { group: 'ช่วยเหลือ', icon: 'help', label: 'คู่มือสมาชิก', allowed: () => true, render: () => renderManual('member') },
  'manual-staff': { group: 'ช่วยเหลือ', icon: 'help', label: 'คู่มือผู้ดูแล', allowed: () => can('treasurer', 'president', 'auditor', 'admin'), render: () => renderManual('staff') },
};

// เมนูด้านซ้าย จัดกลุ่มตาม group และแสดงเฉพาะหน้าที่บทบาทนี้เข้าได้
async function renderNav() {
  const [current] = location.hash.slice(1).split('/');
  // ตัวเลขงานค้างของเหรัญญิก: สลิปรอตรวจ และคำขอเบิกรออนุมัติ
  const [slips, expenses] = can('treasurer') ? await Promise.all([pendingCount(), expenseCount('pending')]) : [0, 0];
  const badge = { review: slips, expenses };
  const items = [];
  let group;
  for (const [key, p] of Object.entries(PAGES)) {
    if (!p.allowed()) continue;
    if (p.group !== group) items.push(h('div', { className: 'group' }, group = p.group));
    items.push(h('a', { href: '#' + key, className: (current || 'home') === key ? 'on' : null },
      h('span', { className: 'ico', innerHTML: ICONS[p.icon] }), p.label,
      badge[key] ? h('span', { className: 'count' }, badge[key]) : null));
  }
  $('#nav').replaceChildren(...items);
}

// ปุ่ม ☰: จอกว้างซ่อน/แสดงเมนู (จำไว้) จอแคบเปิดลิ้นชัก
const wide = matchMedia('(min-width: 1024px)');
try { if (localStorage.getItem('navCollapsed') === '1') document.body.classList.add('nav-collapsed'); } catch {}
function setDrawer(open) {
  document.body.classList.toggle('nav-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').onclick = () => {
  if (!wide.matches) return setDrawer(!document.body.classList.contains('nav-open'));
  const collapsed = document.body.classList.toggle('nav-collapsed');
  $('#menu-btn').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('navCollapsed', collapsed ? '1' : '0'); } catch {}
};
$('#scrim').onclick = () => setDrawer(false);
$('#nav').addEventListener('click', e => { if (e.target.closest('a')) setDrawer(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false); });

// หน้าหลัก: ฉันต้องทำอะไร มีอะไรค้าง
async function renderHome() {
  const hello = h('div', { className: 'card' },
    h('h1', {}, 'สวัสดี ', member?.full_name ?? me.email),
    member ? h('p', { className: 'muted' }, 'รหัสนิสิต ' + member.student_id) : null,
    h('div', { className: 'row' }, [...roles].map(r => h('span', { className: 'chip' }, ROLE_TH[r]))));
  if (!member?.active) {
    return h('div', {}, hello, empty('บัญชีนี้ถูกระงับหรือยังไม่ได้ผูกกับรายชื่อสมาชิก กรุณาติดต่อแอดมิน'));
  }

  // ยอดเงินกองกลางเป็นข้อมูลเสริม ถ้าดึงไม่ได้หน้าหลักยังต้องใช้งานได้
  const [rows, credit, mine, toReview, fund, toApprove, toPay] = await Promise.all([
    sb.from('charge_balances').select('*').eq('member_id', member.id).order('due_date', { nullsFirst: false }).then(must),
    sb.from('member_credit').select('credit_satang').eq('member_id', member.id).maybeSingle().then(must),
    sb.from('payment_submissions').select('id', { count: 'exact', head: true }).eq('member_id', member.id).eq('status', 'pending'),
    can('treasurer') ? pendingCount() : 0,
    sb.rpc('fund_summary').then(r => r.data?.[0] ?? null),
    can('treasurer') ? expenseCount('pending') : 0,
    can('treasurer') ? expenseCount('approved') : 0,
  ]);
  const owed = rows.reduce((s, r) => s + Number(r.outstanding_satang), 0);
  const creditLeft = Number(credit?.credit_satang ?? 0);

  const todo = h('div', { className: 'card' }, h('h2', {}, 'งานที่ต้องทำ'),
    h('ul', {},
      owed ? h('li', {}, 'ยอดค้างชำระรวม ', money(owed), ' ', h('a', { href: '#pay' }, 'แจ้งชำระ →')) : h('li', {}, 'ไม่มียอดค้างชำระ ✓'),
      mine.count ? h('li', {}, `สลิปของคุณรอตรวจสอบ ${mine.count} รายการ `, h('a', { href: '#my-payments' }, 'ดู →')) : null,
      toReview ? h('li', {}, `สลิปรอตรวจ ${toReview} รายการ `, h('a', { href: '#review' }, 'ตรวจสลิป →')) : null,
      creditLeft ? h('li', {}, 'เครดิตจากการจ่ายเกินคงเหลือ ', money(creditLeft)) : null,
      toApprove ? h('li', {}, `คำขอเบิกรออนุมัติ ${toApprove} รายการ `, h('a', { href: '#expenses' }, 'ดู →')) : null,
      toPay ? h('li', {}, `อนุมัติแล้วรอจ่าย ${toPay} รายการ `, h('a', { href: '#expenses' }, 'ดู →')) : null),
    fund ? h('p', { className: 'muted', style: 'margin-bottom:0' }, 'เงินกองกลางของรุ่นคงเหลือ ', money(fund.balance_satang), ' ',
      h('a', { href: '#summary' }, 'ดูสรุปการเงิน →')) : null);

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
    const path = await uploadSlip(file);
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
  const [rows, credit, refunds] = await Promise.all([
    sb.from('payment_submissions')
      .select('*, submission_allocations(amount_satang, member_charges(charges(title)))')
      .eq('member_id', member.id).order('created_at', { ascending: false }).then(must),
    sb.from('member_credit').select('credit_satang').eq('member_id', member.id).maybeSingle().then(must),
    sb.from('refunds').select('*, member_charges(charges(title))').eq('member_id', member.id).order('created_at', { ascending: false }).then(must),
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
      ['สถานะ', r => h('div', {}, chip(r.status), (r.reject_reason ?? r.void_reason) ? h('div', { className: 'muted' }, 'เหตุผล: ' + (r.reject_reason ?? r.void_reason)) : null)],
      ['', r => h('div', { className: 'row' },
        h('button', { className: 'link', onclick: () => openSlip(r.slip_path) }, 'ดูสลิป'),
        r.status === 'pending' ? h('button', { className: 'link', onclick: () => cancel(r) }, 'ยกเลิก') : null)],
    ], rows),
    refunds.length ? [h('h2', { style: 'margin-top:24px' }, 'เงินที่ได้รับคืน'), table([
      ['วันที่', r => when(r.created_at)],
      ['คืนค่า', r => r.member_charges?.charges?.title ?? 'เครดิตจ่ายเกิน'],
      ['จำนวน', r => money(r.amount_satang)],
      ['เหตุผล', r => r.reason],
    ], refunds)] : null);
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

  // ยืนยันผิด (เช่น เงินไม่เข้าจริง) → ยกเลิกรายรับ ยอดค้างกลับมาเหมือนเดิม รายรับเดิมยังอยู่ในประวัติ
  const voidBtn = s.status === 'confirmed' && can('treasurer') ? h('div', { style: 'margin-top:16px' },
    h('button', { className: 'danger', onclick: async () => {
      const v = await dialogForm('ยกเลิกรายรับนี้', [{ name: 'reason', label: 'เหตุผล (สมาชิกจะเห็น) เช่น เงินไม่เข้าบัญชีจริง' }], 'ยกเลิกรายรับ', true);
      if (v) act(() => sb.rpc('void_payment', { p_id: id, p_reason: v.reason }).then(must), 'ยกเลิกรายรับแล้ว ยอดค้างของสมาชิกกลับมาเหมือนเดิม');
    } }, 'ยกเลิกรายรับนี้ (ยืนยันผิด)'),
    h('p', { className: 'muted' }, 'ใช้เมื่อยืนยันผิด เช่น เงินไม่เข้าจริง ถ้าต้องการคืนเงินที่ได้รับจริง ให้ใช้เมนูคืนเงิน')) : null;

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
          s.reject_reason ? [h('dt', {}, 'เหตุผล'), h('dd', {}, s.reject_reason)] : null,
          s.voided_at ? [h('dt', {}, 'ยกเลิกเมื่อ'), h('dd', {}, when(s.voided_at)), h('dt', {}, 'เหตุผลที่ยกเลิก'), h('dd', {}, s.void_reason)] : null),
        review, voidBtn)));
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
    h('p', { className: 'muted', style: 'margin:6px 0 0' }, 'ถ้าใส่วันครบกำหนด ระบบจะเตือนคนที่ยังค้างอัตโนมัติ 3 วันก่อนครบกำหนด และสัปดาห์ละครั้งหลังเลยกำหนด'),
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
      ...(can('treasurer') ? [['', r => Number(r.paid_satang) > 0
        ? h('button', { className: 'link', onclick: () => refundDialog(r.member_id, r.full_name, r.paid_satang, r.member_charge_id, c.title) }, 'คืนเงิน')
        : null]] : []),
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
  const remind = can('treasurer', 'president') && c.status === 'open' && owed > 0 ? h('button', { className: 'ghost', onclick: async e => {
    if (!confirm('ส่งแจ้งเตือนในเว็บถึงทุกคนที่ยังค้างรายการนี้? (ส่งถึงคนเดิมได้วันละครั้ง)')) return;
    e.target.disabled = true;
    try {
      const n = must(await sb.rpc('remind_charge', { p_charge_id: id }));
      toast(n ? `ส่งเตือนแล้ว ${n} คน` : 'วันนี้เตือนครบทุกคนแล้ว (หรือคนที่ค้างยังไม่ได้สมัครใช้งาน)');
    } catch (err) { toast(thai(err)); }
    e.target.disabled = false;
  } }, 'ส่งเตือนคนที่ยังค้าง') : null;
  draw();
  return h('div', {},
    h('p', {}, h('a', { href: '#charges' }, '← กลับไปรายการ')),
    h('div', { className: 'card' },
      h('div', { className: 'row' }, h('h1', {}, c.title), h('div', { className: 'row', style: 'margin-left:auto' }, remind, toggle)),
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
    h('div', { className: 'row', style: 'margin-top:8px' },
      h('button', { type: 'submit' }, 'นำเข้า'),
      h('button', { type: 'button', className: 'ghost', onclick: downloadTemplate }, 'ดาวน์โหลดไฟล์ตัวอย่าง (.csv)')),
    msgBox(),
    h('details', { className: 'help' },
      h('summary', {}, 'วิธีกรอก'),
      h('ol', {},
        h('li', {}, 'กรอกใน Google Sheets หรือ Excel ให้มี 3 คอลัมน์ตามลำดับ: รหัสนิสิต → ชื่อ-นามสกุล → อีเมล (1 แถว = 1 คน)'),
        h('li', {}, 'ลากเลือกทั้งตาราง (เลือกแถวหัวตารางมาด้วยก็ได้ ระบบข้ามให้) แล้วกด Ctrl + C'),
        h('li', {}, 'คลิกช่องด้านบน กด Ctrl + V แล้วกด "นำเข้า" ระบบจะถามจำนวนคนให้ตรวจก่อน'),
        h('li', {}, 'บอกเพื่อนให้สมัครด้วยรหัสนิสิตและอีเมลเดียวกับที่กรอก')),
      h('p', {}, h('b', {}, 'ระบบจัดการให้: '), 'ข้ามแถวว่างและแถวหัวตาราง ตัดช่องว่างหน้า-หลัง แปลงอีเมลเป็นตัวพิมพ์เล็ก'),
      h('p', {}, h('b', {}, 'แถวที่ไม่ถูกเพิ่ม: '), 'ข้อมูลไม่ครบ อีเมลผิดรูปแบบ หรือรหัสนิสิต/อีเมลมีในระบบแล้ว ',
        'แถวอื่นยังถูกบันทึกตามปกติ แก้เฉพาะแถวที่ผิดแล้ววางใหม่ได้ (วางคนเดิมซ้ำจะไม่เกิดข้อมูลซ้ำ)'),
      h('p', {}, h('b', {}, '⚠ ลบรายชื่อไม่ได้: '), 'ถ้ากรอกผิดให้กด "แก้ไข" ในตารางด้านล่าง ถ้าเพิ่มคนที่ไม่ควรเพิ่มให้กด "ระงับ"'),
      h('p', {}, h('b', {}, '⚠ Excel: '), 'ตั้งคอลัมน์รหัสนิสิตเป็น "ข้อความ (Text)" ก่อนกรอก ไม่อย่างนั้น Excel อาจตัดเลข 0 ข้างหน้า หรือแสดงเป็น 6.5E+10'),
      h('p', {}, h('b', {}, 'อีเมล: '), 'ต้องเป็นอีเมลที่เพื่อนจะใช้สมัครจริง ไม่อย่างนั้นจะสมัครไม่ได้'))), async f => {
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

// ─── ระยะ 4: สรุปการเงิน เบิกจ่าย งบประมาณ รายงาน ประวัติการกระทำ ─────────

const EXP_STATUS = {
  pending: ['รออนุมัติ', 'wait'], approved: ['อนุมัติแล้ว รอจ่าย', ''], paid: ['จ่ายแล้ว', 'ok'],
  rejected: ['ไม่อนุมัติ', 'bad'], cancelled: ['ยกเลิกแล้ว', 'muted'],
};
const expChip = s => h('span', { className: 'chip ' + EXP_STATUS[s][1] }, EXP_STATUS[s][0]);
const stat = (label, value, note) => h('div', { className: 'stat' }, h('span', {}, label), h('b', {}, value), note ? h('small', {}, note) : null);
const monthTh = m => new Date(m + 'T00:00').toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });
const isoDay = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// กราฟแท่งรายรับ (น้ำเงิน) เทียบรายจ่าย (ส้ม) รายเดือน แกนเดียว เริ่มที่ 0 ชี้ดูยอดได้ และมีตารางให้ดูแทนกราฟ
function cashflowChart(rows) {
  if (!rows.length) return h('p', { className: 'muted' }, 'ยังไม่มีรายรับหรือรายจ่าย');
  rows = rows.slice(-12);
  const max = Math.max(1, ...rows.flatMap(r => [Number(r.income_satang), Number(r.expense_satang)]));
  const tip = h('div', { className: 'tip', hidden: true });
  const chart = h('div', { className: 'chart' });
  const bar = (v, cls, label) => {
    const el = h('div', { className: 'bar ' + cls, tabIndex: 0, 'aria-label': label, style: `height:${(Number(v) / max) * 100}%` });
    const showTip = () => {
      const b = el.getBoundingClientRect(), c = chart.getBoundingClientRect();
      tip.textContent = label; tip.hidden = false;
      tip.style.left = `${b.left - c.left + b.width / 2}px`; tip.style.top = `${b.top - c.top}px`;
    };
    el.addEventListener('pointerenter', showTip); el.addEventListener('focus', showTip);
    el.addEventListener('pointerleave', () => tip.hidden = true); el.addEventListener('blur', () => tip.hidden = true);
    return el;
  };
  chart.append(
    h('div', { className: 'legend' }, h('span', {}, h('i', { className: 'sw inc' }), 'รายรับ'), h('span', {}, h('i', { className: 'sw exp' }), 'รายจ่าย'),
      h('span', { style: 'margin-left:auto' }, 'สูงสุด ', money(max))),
    h('div', { className: 'plot' }, rows.map(r => h('div', { className: 'col' },
      h('div', { className: 'bars' },
        bar(r.income_satang, 'inc', `${monthTh(r.month)} รายรับ ${baht(r.income_satang)} บาท`),
        bar(r.expense_satang, 'exp', `${monthTh(r.month)} รายจ่าย ${baht(r.expense_satang)} บาท`)),
      h('span', { className: 'x' }, monthTh(r.month))))),
    tip);
  return h('div', {}, chart,
    h('details', { className: 'help' }, h('summary', {}, 'ดูเป็นตาราง'),
      table([['เดือน', r => monthTh(r.month)], ['รายรับ', r => money(r.income_satang)], ['รายจ่าย', r => money(r.expense_satang)]], rows)));
}

// แถบแนวนอนตามสัดส่วน (ใช้กับรายจ่ายตามหมวด)
const hbars = (rows, total) => h('div', {}, rows.map(([label, v]) => h('div', { className: 'hrow' },
  h('div', { className: 'row' }, h('span', {}, label), h('b', { style: 'margin-left:auto' }, money(v))),
  h('div', { className: 'track' }, h('div', { className: 'fill', style: `width:${total ? (v / total) * 100 : 0}%` })))));

// สรุปการเงิน: สมาชิกทุกคนเห็น (ตัวเลขรวม ไม่มีรายชื่อว่าใครจ่าย/ค้าง)
async function renderSummary() {
  const [[f], months, charges, paid] = await Promise.all([
    sb.rpc('fund_summary').then(must),
    sb.rpc('monthly_cashflow').then(must),
    sb.rpc('charge_summary').then(must),
    sb.from('expense_feed').select('id, title, category, activity_name, paid_satang, paid_at, receipt_path')
      .eq('status', 'paid').order('paid_at', { ascending: false }).then(must),
  ]);

  const setOpening = async () => {
    const v = await dialogForm('ตั้งยอดยกมา', [
      { name: 'amount', label: 'เงินที่มีอยู่ก่อนเริ่มใช้ระบบ (บาท)', value: f.opening_satang ? baht(f.opening_satang).replace(/,/g, '') : '' },
      { name: 'note', label: 'ที่มาของยอด เช่น ยอดในสมุดบัญชี ณ วันที่ ... รับรองโดย ...' },
    ], 'บันทึกยอดยกมา');
    if (!v) return;
    try {
      const amount = toSatang(v.amount);
      if (amount == null) throw new Error('กรอกยอดเป็นตัวเลข เช่น 5000 หรือ 5000.50');
      must(await sb.rpc('set_opening_balance', { p_amount_satang: amount, p_note: v.note }));
      toast('บันทึกยอดยกมาแล้ว'); route();
    } catch (err) { toast(thai(err)); }
  };

  const byCategory = new Map();
  for (const e of paid) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + Number(e.paid_satang));
  const catRows = [...byCategory].sort((a, b) => b[1] - a[1]);

  return h('div', {},
    h('div', { className: 'row', style: 'margin-bottom:16px' },
      h('div', {}, h('h1', {}, 'สรุปการเงิน'), h('p', { className: 'muted', style: 'margin:0' }, 'เงินกองกลางของรุ่น สมาชิกทุกคนเห็นข้อมูลชุดเดียวกัน')),
      can('treasurer') ? h('button', { className: 'ghost', style: 'margin-left:auto', onclick: setOpening },
        f.opening_satang ? 'แก้ยอดยกมา' : 'ตั้งยอดยกมา') : null),
    h('div', { className: 'stats' },
      stat('เงินคงเหลือ', money(f.balance_satang),
        f.approved_unpaid_satang > 0 ? ['อนุมัติแล้วรอจ่าย ', money(f.approved_unpaid_satang)] : (f.opening_satang ? ['รวมยอดยกมา ', money(f.opening_satang)] : 'ยังไม่ได้ตั้งยอดยกมา')),
      stat('รายรับที่ยืนยันแล้ว', money(f.income_satang)),
      stat('รายจ่ายที่จ่ายแล้ว', money(f.expense_satang), Number(f.refund_satang) ? ['คืนเงินสมาชิกอีก ', money(f.refund_satang)] : null),
      stat('รอดำเนินการ', `${f.pending_slips + f.pending_expenses} รายการ`,
        `สลิปรอตรวจ ${f.pending_slips} · คำขอเบิกรออนุมัติ ${f.pending_expenses}`)),
    h('div', { className: 'split' },
      h('div', { className: 'card' }, h('h2', {}, 'รายรับ–รายจ่ายรายเดือน'), cashflowChart(months)),
      h('div', { className: 'card' }, h('h2', {}, 'รายจ่ายตามหมวด'),
        catRows.length ? hbars(catRows, f.expense_satang) : h('p', { className: 'muted' }, 'ยังไม่มีรายจ่าย'))),
    h('div', { className: 'card' }, h('h2', {}, 'รายรับแยกตามรายการเรียกเก็บ'),
      charges.length ? table([
        ['รายการ', c => c.title],
        ['ยอดต่อคน', c => money(c.amount_satang)],
        ['ชำระครบ', c => `${c.paid_members}/${c.members} คน`],
        ['เก็บได้', c => money(c.collected_satang)],
        ['ยังค้าง', c => money(c.outstanding_satang)],
      ], charges) : h('p', { className: 'muted' }, 'ยังไม่มีรายการเรียกเก็บ')),
    h('div', { className: 'card' }, h('div', { className: 'row' }, h('h2', {}, 'รายจ่ายทั้งหมด'),
        h('a', { href: '#expenses', style: 'margin-left:auto' }, 'ดูคำขอเบิกทั้งหมด →')),
      paid.length ? table([
        ['วันที่จ่าย', e => when(e.paid_at)],
        ['รายการ', e => e.title],
        ['กิจกรรม', e => e.activity_name ?? '-'],
        ['หมวด', e => e.category],
        ['จำนวน', e => money(e.paid_satang)],
        ['ใบเสร็จ', e => h('span', { onclick: ev => ev.stopPropagation() }, fileLink(e.receipt_path, 'เปิดดู'))],
      ], paid, e => location.hash = 'expenses/' + e.id) : h('p', { className: 'muted' }, 'ยังไม่มีรายจ่าย')));
}

// เบิกจ่าย: ทุกคนเห็นทุกคำขอ ขอเบิกได้ เหรัญญิกอนุมัติและบันทึกจ่าย
let expenseFilter = 'all';
async function renderExpenses(id) {
  if (id === 'new') return renderExpenseForm();
  if (id) return renderExpenseDetail(id);
  let q = sb.from('expense_feed').select('*').order('created_at', { ascending: false }).limit(300);
  if (expenseFilter !== 'all') q = q.eq('status', expenseFilter);
  const rows = await q.then(must);
  const filter = h('select', { 'aria-label': 'สถานะ', style: 'width:auto', onchange: e => { expenseFilter = e.target.value; route(); } },
    [['all', 'ทั้งหมด'], ...Object.entries(EXP_STATUS).map(([k, [t]]) => [k, t])].map(([v, t]) => h('option', { value: v, selected: v === expenseFilter }, t)));
  return h('div', { className: 'card' },
    h('div', { className: 'row', style: 'margin-bottom:8px' }, h('h1', {}, 'เบิกจ่าย'),
      h('div', { className: 'row', style: 'margin-left:auto' }, filter, h('a', { className: 'btn', href: '#expenses/new' }, '+ ขอเบิกเงิน'))),
    rows.length ? table([
      ['วันที่ขอ', e => when(e.created_at)],
      ['รายการ', e => e.title],
      ['ผู้ขอ', e => e.requester_name],
      ['กิจกรรม', e => e.activity_name ?? '-'],
      ['จำนวน', e => money(e.paid_satang ?? e.amount_satang)],
      ['สถานะ', e => expChip(e.status)],
    ], rows, e => location.hash = 'expenses/' + e.id) : h('p', { className: 'muted' }, 'ยังไม่มีคำขอเบิก'));
}

async function renderExpenseForm() {
  const [cats, acts] = await Promise.all([
    sb.from('expense_categories').select('name').eq('active', true).order('sort').then(must),
    sb.from('activity_budgets').select('*').eq('active', true).order('name').then(must),
  ]);
  const hint = h('p', { className: 'muted' });
  const form = h('form', { className: 'card' },
    h('p', {}, h('a', { href: '#expenses' }, '← กลับไปรายการ')),
    h('h1', {}, 'ขอเบิกเงิน'),
    h('label', { htmlFor: 'x-title' }, 'ซื้อ/จ่ายอะไร'), h('input', { id: 'x-title', name: 'title', required: true, placeholder: 'เช่น ลูกฟุตบอล 2 ลูก' }),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'x-amt' }, 'จำนวนเงิน (บาท)'), h('input', { id: 'x-amt', name: 'amount', inputMode: 'decimal', required: true })),
      h('div', {}, h('label', { htmlFor: 'x-cat' }, 'หมวด'), h('select', { id: 'x-cat', name: 'category' }, cats.map(c => h('option', {}, c.name)))),
      h('div', {}, h('label', { htmlFor: 'x-act' }, 'กิจกรรม'),
        h('select', { id: 'x-act', name: 'activity', onchange: e => {
          const a = acts.find(x => x.id === e.target.value);
          hint.textContent = a?.budget_satang != null
            ? `งบ ${baht(a.budget_satang)} บาท · ใช้/กันไว้แล้ว ${baht(Number(a.paid_satang) + Number(a.committed_satang))} บาท · คงเหลือ ${baht(a.budget_satang - a.paid_satang - a.committed_satang)} บาท`
            : '';
        } }, h('option', { value: '' }, 'ไม่ระบุ (ค่าใช้จ่ายทั่วไป)'), acts.map(a => h('option', { value: a.id }, a.name))))),
    hint,
    h('label', { htmlFor: 'x-reason' }, 'เหตุผล / รายละเอียด'), h('textarea', { id: 'x-reason', name: 'reason', rows: 3 }),
    h('label', { htmlFor: 'x-quote' }, 'ใบเสนอราคาหรือหลักฐาน (ไม่บังคับ · รูปหรือ PDF ไม่เกิน 10 MB)'),
    h('input', { id: 'x-quote', name: 'quote', type: 'file', accept: Object.keys(EVIDENCE_TYPES).join(',') }),
    h('p', { className: 'muted' }, 'สมาชิกทุกคนเห็นคำขอเบิกและไฟล์หลักฐาน'),
    h('div', { className: 'row', style: 'margin-top:12px' }, h('button', { type: 'submit' }, 'ส่งคำขอเบิก')),
    msgBox());
  onSubmit(form, async f => {
    const amount = toSatang(f.amount);
    if (!amount) throw new Error('กรอกจำนวนเงินเป็นตัวเลข เช่น 800 หรือ 800.50');
    const file = form.quote.files[0];
    const quote = file ? await uploadEvidence(file) : null;
    const id = must(await sb.rpc('request_expense', {
      p_title: f.title, p_amount_satang: amount, p_category: f.category,
      p_activity_id: f.activity || null, p_reason: f.reason, p_quote_path: quote,
    }));
    toast('ส่งคำขอเบิกแล้ว รอเหรัญญิกอนุมัติ');
    location.hash = 'expenses/' + id;
  });
  return form;
}

async function renderExpenseDetail(id) {
  const e = await sb.from('expense_feed').select('*').eq('id', id).single().then(must);
  const b = e.activity_id ? await sb.from('activity_budgets').select('*').eq('id', e.activity_id).maybeSingle().then(must) : null;
  const mine = e.requested_by === member.id;
  const t = can('treasurer');

  const act = async (fn, ok) => {
    try { await fn(); toast(ok); } catch (err) { toast(thai(err)); }
    route(); // โหลดสถานะล่าสุดเสมอ เผื่อเหรัญญิกคนอื่นทำไปแล้ว
  };
  const withReason = async (title, label, okLabel, rpc, ok) => {
    const v = await dialogForm(title, [{ name: 'reason', label }], okLabel, true);
    if (v) act(() => sb.rpc(rpc, { p_id: id, p_reason: v.reason }).then(must), ok);
  };

  // งบหลังอนุมัติรายการนี้ (เตือนเมื่อเกิน 80% หรือเกินงบ)
  let budgetWarn = null;
  if (b?.budget_satang != null && e.status === 'pending') {
    const after = Number(b.paid_satang) + Number(b.committed_satang) + Number(e.amount_satang);
    const pct = b.budget_satang > 0 ? after / b.budget_satang : Infinity;
    if (pct >= 0.8) budgetWarn = h('div', { className: 'warn' },
      pct > 1 ? '⚠ ถ้าอนุมัติ จะเกินงบกิจกรรม ' : '⚠ ถ้าอนุมัติ จะใช้งบกิจกรรมเกิน 80% ',
      `(${baht(after)} จาก ${baht(b.budget_satang)} บาท)`);
  }

  const payForm = t && e.status === 'approved' ? onSubmit(h('form', { className: 'card' },
    h('h2', {}, 'บันทึกการจ่ายเงินจริง'),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'p-paid' }, 'ยอดที่จ่ายจริง (บาท)'),
        h('input', { id: 'p-paid', name: 'paid', inputMode: 'decimal', required: true, value: baht(e.amount_satang).replace(/,/g, '') })),
      h('div', {}, h('label', { htmlFor: 'p-receipt' }, 'ใบเสร็จหรือสลิปโอนจ่าย (บังคับ)'),
        h('input', { id: 'p-receipt', name: 'receipt', type: 'file', required: true, accept: Object.keys(EVIDENCE_TYPES).join(',') }))),
    h('p', { className: 'muted' }, 'บันทึกแล้วยอดเงินกองกลางจะลดลงทันที และแก้ยอดภายหลังไม่ได้'),
    h('button', { type: 'submit', className: 'ok' }, 'บันทึกการจ่าย'),
    msgBox()), async (f, form) => {
      const paid = toSatang(f.paid);
      if (!paid) throw new Error('กรอกยอดที่จ่ายจริงเป็นตัวเลข');
      if (!confirm(`ยืนยันว่าจ่ายเงิน ${baht(paid)} บาท สำหรับ "${e.title}" แล้ว?`)) return;
      const path = await uploadEvidence(form.receipt.files[0]);
      await act(() => sb.rpc('pay_expense', { p_id: id, p_paid_satang: paid, p_receipt_path: path }).then(must), 'บันทึกการจ่ายแล้ว');
    }) : null;

  const canCancel = (mine && e.status === 'pending') || (t && ['pending', 'approved'].includes(e.status));
  const actions = h('div', { className: 'row' },
    t && e.status === 'pending' ? [
      h('button', { className: 'ok', onclick: ev => {
        if (!confirm(`อนุมัติคำขอเบิก ${baht(e.amount_satang)} บาท "${e.title}"?` + (mine ? '\n(คุณเป็นผู้ขอเอง ระบบจะบันทึกไว้ในประวัติ)' : ''))) return;
        ev.target.disabled = true;
        act(() => sb.rpc('approve_expense', { p_id: id }).then(must), 'อนุมัติแล้ว');
      } }, 'อนุมัติ'),
      h('button', { className: 'danger', onclick: () => withReason('ไม่อนุมัติคำขอเบิก', 'เหตุผล (ผู้ขอจะเห็น)', 'ไม่อนุมัติ', 'reject_expense', 'บันทึกว่าไม่อนุมัติแล้ว') }, 'ไม่อนุมัติ'),
    ] : null,
    canCancel ? h('button', { className: 'ghost', onclick: () => withReason('ยกเลิกคำขอเบิก', 'เหตุผลที่ยกเลิก', 'ยกเลิกคำขอ', 'cancel_expense', 'ยกเลิกแล้ว') }, 'ยกเลิกคำขอ') : null,
    // บันทึกจ่ายผิด (ยอดหรือใบเสร็จผิด) → กลับเป็นรอจ่าย แล้วบันทึกใหม่
    t && e.status === 'paid' ? h('button', { className: 'danger', onclick: () => withReason('ยกเลิกการจ่าย (บันทึกผิด)',
      'เหตุผล เช่น พิมพ์ยอดผิด แนบใบเสร็จผิด', 'ยกเลิกการจ่าย', 'void_expense_payment', 'ยกเลิกการจ่ายแล้ว บันทึกจ่ายใหม่ได้เลย') }, 'ยกเลิกการจ่าย (บันทึกผิด)') : null);

  return h('div', {},
    h('p', {}, h('a', { href: '#expenses' }, '← กลับไปรายการ')),
    h('div', { className: 'card' },
      h('div', { className: 'row' }, h('h1', {}, e.title), h('div', { style: 'margin-left:auto' }, expChip(e.status))),
      h('p', { style: 'font-size:1.4rem; margin:4px 0 16px' }, money(e.paid_satang ?? e.amount_satang),
        e.paid_satang && e.paid_satang !== e.amount_satang ? h('small', { className: 'muted' }, ` (ขอเบิก ${baht(e.amount_satang)} บาท)`) : null),
      budgetWarn,
      e.payment_void_note ? h('div', { className: 'warn' }, '⚠ ', e.payment_void_note) : null,
      h('dl', {},
        h('dt', {}, 'ผู้ขอ'), h('dd', {}, e.requester_name),
        h('dt', {}, 'กิจกรรม'), h('dd', {}, e.activity_name ?? 'ไม่ระบุ (ค่าใช้จ่ายทั่วไป)'),
        h('dt', {}, 'หมวด'), h('dd', {}, e.category),
        h('dt', {}, 'เหตุผล'), h('dd', {}, e.reason ?? '-'),
        h('dt', {}, 'ใบเสนอราคา'), h('dd', {}, fileLink(e.quote_path, 'เปิดดู')),
        h('dt', {}, 'ส่งคำขอเมื่อ'), h('dd', {}, when(e.created_at)),
        e.reviewed_at ? [h('dt', {}, e.status === 'cancelled' ? 'ยกเลิกโดย' : 'ตรวจโดย'), h('dd', {}, `${e.reviewer_name ?? '-'} · ${when(e.reviewed_at)}`)] : null,
        e.review_note ? [h('dt', {}, 'เหตุผล'), h('dd', {}, e.review_note)] : null,
        e.paid_at ? [h('dt', {}, 'จ่ายโดย'), h('dd', {}, `${e.payer_name ?? '-'} · ${when(e.paid_at)}`)] : null,
        e.receipt_path ? [h('dt', {}, 'ใบเสร็จ'), h('dd', {}, fileLink(e.receipt_path, 'เปิดดู'))] : null),
      actions.childNodes.length ? h('div', { style: 'margin-top:16px' }, actions) : null),
    payForm);
}

// งบประมาณ: ทุกคนเห็น ประธาน/แอดมินตั้งกิจกรรมและงบ
async function renderBudget() {
  const rows = await sb.from('activity_budgets').select('*').order('name').then(must);
  const manage = can('president', 'admin');
  const budgeted = rows.filter(r => r.budget_satang != null);
  const sum = k => budgeted.reduce((s, r) => s + Number(r[k]), 0);
  const total = sum('budget_satang'), committed = sum('committed_satang'), paid = sum('paid_satang');

  const usage = r => {
    if (r.budget_satang == null) return h('span', { className: 'muted' }, 'ไม่ได้ตั้งงบ');
    const used = Number(r.paid_satang) + Number(r.committed_satang);
    const pct = r.budget_satang > 0 ? used / r.budget_satang : (used ? Infinity : 0);
    const level = pct > 1 ? 'bad' : pct >= 0.8 ? 'wait' : 'ok';
    return h('div', { style: 'min-width:140px' },
      h('div', { className: 'track' }, h('div', { className: 'fill ' + level, style: `width:${Math.min(pct, 1) * 100}%` })),
      h('small', {}, Number.isFinite(pct) ? `${Math.round(pct * 100)}%` : 'เกินงบ', ' ',
        pct > 1 ? h('span', { className: 'chip bad' }, '⚠ เกินงบ') : pct >= 0.8 ? h('span', { className: 'chip wait' }, '⚠ ใกล้เต็ม') : null));
  };

  const editBudget = async r => {
    const v = await dialogForm(`แก้ไขกิจกรรม "${r.name}"`, [
      { name: 'name', label: 'ชื่อกิจกรรม', value: r.name },
      { name: 'budget', label: 'งบประมาณ (บาท) เว้นว่าง = ไม่ตั้งงบ', value: r.budget_satang != null ? baht(r.budget_satang).replace(/,/g, '') : '', required: false },
    ], 'บันทึก');
    if (!v) return;
    try {
      const budget = v.budget.trim() ? toSatang(v.budget) : null;
      if (v.budget.trim() && budget == null) throw new Error('กรอกงบเป็นตัวเลข');
      must(await sb.from('activities').update({ name: v.name.trim(), budget_satang: budget }).eq('id', r.id));
      toast('บันทึกแล้ว'); route();
    } catch (err) { toast(thai(err)); }
  };

  const add = manage ? onSubmit(h('form', { className: 'card' },
    h('h2', {}, 'เพิ่มกิจกรรม'),
    h('div', { className: 'grid' },
      h('div', {}, h('label', { htmlFor: 'b-name' }, 'ชื่อกิจกรรม'), h('input', { id: 'b-name', name: 'name', required: true, placeholder: 'เช่น กีฬารุ่น 23' })),
      h('div', {}, h('label', { htmlFor: 'b-budget' }, 'งบประมาณ (บาท · ไม่บังคับ)'), h('input', { id: 'b-budget', name: 'budget', inputMode: 'decimal' })),
      h('div', {}, h('label', { htmlFor: 'b-desc' }, 'รายละเอียด (ไม่บังคับ)'), h('input', { id: 'b-desc', name: 'description' })),
      h('button', { type: 'submit' }, 'เพิ่มกิจกรรม')),
    msgBox()), async f => {
      const budget = f.budget.trim() ? toSatang(f.budget) : null;
      if (f.budget.trim() && budget == null) throw new Error('กรอกงบเป็นตัวเลข');
      must(await sb.from('activities').insert({ name: f.name.trim(), budget_satang: budget, description: f.description.trim() || null }));
      toast('เพิ่มกิจกรรมแล้ว'); route();
    }) : null;

  return h('div', {},
    h('h1', {}, 'งบประมาณ'),
    h('p', { className: 'muted' }, 'กันไว้ = อนุมัติแล้วแต่ยังไม่จ่าย · คงเหลือ = งบ − กันไว้ − จ่ายแล้ว'),
    h('div', { className: 'stats' },
      stat('งบทั้งหมด', money(total)), stat('กันไว้', money(committed)),
      stat('จ่ายแล้ว', money(paid)), stat('คงเหลือ', money(total - committed - paid))),
    add,
    rows.length ? h('div', { className: 'card' }, table([
      ['กิจกรรม', r => h('div', {}, r.name, r.description ? h('div', { className: 'muted' }, r.description) : null)],
      ['งบประมาณ', r => r.budget_satang != null ? money(r.budget_satang) : '-'],
      ['กันไว้', r => money(r.committed_satang)],
      ['จ่ายแล้ว', r => money(r.paid_satang)],
      ['คงเหลือ', r => r.budget_satang != null ? money(r.budget_satang - r.committed_satang - r.paid_satang) : '-'],
      ['ใช้ไป', usage],
      ...(manage ? [['', r => h('button', { className: 'link', onclick: () => editBudget(r) }, 'แก้ไข')]] : []),
    ], rows)) : empty('ยังไม่มีกิจกรรม' + (manage ? ' เพิ่มกิจกรรมด้านบนเพื่อเริ่มตั้งงบ' : '')));
}

// รายงาน: เลือกช่วงวันที่ → ดูตัวอย่าง → ดาวน์โหลด CSV (เปิดใน Excel) หรือพิมพ์เป็น PDF ทุกการส่งออกถูกบันทึก
let reportState = null;
async function renderReports() {
  const staff = can('treasurer', 'president', 'auditor');
  const now = new Date();
  reportState ??= { kind: 'expenses', from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) };
  const start = () => new Date(reportState.from + 'T00:00').toISOString();
  const end = () => new Date(reportState.to + 'T23:59:59.999').toISOString();

  const REPORTS = {
    expenses: { label: 'รายจ่าย', note: 'รายจ่ายที่จ่ายแล้วตามวันที่จ่าย', allowed: true, load: async () => {
      const rows = await sb.from('expense_feed').select('*').eq('status', 'paid').gte('paid_at', start()).lte('paid_at', end())
        .order('paid_at').then(must);
      return [['วันที่จ่าย', 'รายการ', 'กิจกรรม', 'หมวด', 'ผู้ขอ', 'ผู้อนุมัติ', 'ผู้จ่าย', 'จำนวน (บาท)'],
        ...rows.map(e => [when(e.paid_at), e.title, e.activity_name ?? '', e.category, e.requester_name, e.reviewer_name ?? '', e.payer_name ?? '', Number(e.paid_satang) / 100])];
    } },
    collections: { label: 'รายรับตามรายการเรียกเก็บ', note: 'ยอดสะสมทั้งหมด (ไม่กรองตามวันที่)', allowed: true, load: async () => {
      const rows = await sb.rpc('charge_summary').then(must);
      return [['รายการ', 'ครบกำหนด', 'ยอดต่อคน (บาท)', 'จำนวนคน', 'ชำระครบ (คน)', 'เก็บได้ (บาท)', 'ยังค้าง (บาท)'],
        ...rows.map(c => [c.title, c.due_date ?? '', Number(c.amount_satang) / 100, c.members, c.paid_members, Number(c.collected_satang) / 100, Number(c.outstanding_satang) / 100])];
    } },
    income: { label: 'รายรับและเงินคืนรายรายการ', note: 'เฉพาะเหรัญญิก ประธาน ผู้ตรวจสอบ · มีชื่อผู้ชำระ', allowed: staff, load: async () => {
      const rows = await sb.from('ledger_entries').select('*').in('kind', ['income', 'opening_balance', 'refund']).is('voided_at', null)
        .gte('created_at', start()).lte('created_at', end()).order('created_at').then(must);
      return [['วันที่', 'เลขที่', 'รายละเอียด', 'จำนวน (บาท)'],
        ...rows.map(l => [when(l.created_at), 'TRX-' + String(l.id).padStart(6, '0'), l.description, Number(l.amount_satang) / 100])];
    } },
    members: { label: 'สถานะการชำระรายคน', note: 'เฉพาะเหรัญญิก ประธาน ผู้ตรวจสอบ แอดมิน · ยอดปัจจุบัน', allowed: staff || can('admin'), load: async () => {
      const rows = await sb.from('charge_balances').select('*').order('title').order('student_id').then(must);
      return [['รายการ', 'รหัสนิสิต', 'ชื่อ', 'ยอด (บาท)', 'ชำระแล้ว (บาท)', 'ค้าง (บาท)', 'สถานะ'],
        ...rows.map(r => [r.title, r.student_id, r.full_name, Number(r.amount_satang) / 100, Number(r.paid_satang) / 100,
          Number(r.outstanding_satang) / 100, Number(r.outstanding_satang) === 0 ? 'ชำระครบ' : 'ค้างชำระ'])];
    } },
  };
  const R = REPORTS[reportState.kind]?.allowed ? REPORTS[reportState.kind] : REPORTS.expenses;
  const [head, ...body] = await R.load();

  const logged = () => sb.rpc('log_export', { p_report: R.label, p_from: reportState.from, p_to: reportState.to }).then(must);
  const download = async () => {
    try { await logged(); downloadCsv(`${R.label} ${reportState.from} ถึง ${reportState.to}.csv`, [head, ...body]); }
    catch (err) { toast(thai(err)); }
  };
  const print = async () => { try { await logged(); window.print(); } catch (err) { toast(thai(err)); } };

  const dates = h('div', { className: 'grid no-print' },
    h('div', {}, h('label', { htmlFor: 'r-from' }, 'ตั้งแต่วันที่'), h('input', { id: 'r-from', type: 'date', value: reportState.from, onchange: e => { reportState.from = e.target.value; route(); } })),
    h('div', {}, h('label', { htmlFor: 'r-to' }, 'ถึงวันที่'), h('input', { id: 'r-to', type: 'date', value: reportState.to, onchange: e => { reportState.to = e.target.value; route(); } })));

  return h('div', {},
    h('h1', { className: 'no-print' }, 'รายงาน'),
    h('div', { className: 'pick-cards no-print' }, Object.entries(REPORTS).filter(([, r]) => r.allowed).map(([k, r]) =>
      h('button', { className: 'pick-card' + (R === r ? ' on' : ''), onclick: () => { reportState.kind = k; route(); } },
        h('b', {}, r.label), h('small', {}, r.note)))),
    h('div', { className: 'card' },
      dates,
      h('div', { className: 'row', style: 'margin:16px 0' },
        h('h2', { style: 'margin:0' }, `${R.label} · ${day(reportState.from)} – ${day(reportState.to)}`),
        h('div', { className: 'row no-print', style: 'margin-left:auto' },
          h('button', { onclick: download }, 'ดาวน์โหลด CSV (เปิดใน Excel)'),
          h('button', { className: 'ghost', onclick: print }, 'พิมพ์ / บันทึก PDF'))),
      body.length
        ? table(head.map((label, i) => [label, row => typeof row[i] === 'number' && /บาท/.test(label) ? money(row[i] * 100) : String(row[i])]), body)
        : h('p', { className: 'muted' }, 'ไม่มีข้อมูลในช่วงนี้'),
      h('p', { className: 'muted no-print' }, 'ทุกการดาวน์โหลดหรือพิมพ์ถูกบันทึกในประวัติการกระทำ')));
}

// ประวัติการกระทำ: ผู้ตรวจสอบและแอดมิน
const TABLE_TH = {
  members: 'สมาชิก', user_roles: 'บทบาท', activities: 'กิจกรรม', charges: 'รายการเรียกเก็บ', member_charges: 'ยอดเรียกเก็บรายคน',
  bank_accounts: 'บัญชีรับเงิน', payment_submissions: 'การแจ้งชำระ', submission_allocations: 'การตัดยอด',
  ledger_entries: 'สมุดบัญชี', expense_requests: 'คำขอเบิก', expense_categories: 'หมวดค่าใช้จ่าย',
};
const ACTION_TH = { insert: 'เพิ่ม', update: 'แก้ไข', delete: 'ลบ', export: 'ส่งออกรายงาน' };
let auditFilter = '';

// สรุปสิ่งที่เปลี่ยน: แก้ไข = ช่องที่ค่าเปลี่ยน, เพิ่ม = ชื่อ/ยอดของรายการ
function auditDetail(l) {
  if (l.action === 'update' && l.old_data && l.new_data) {
    return Object.keys(l.new_data).filter(k => JSON.stringify(l.old_data[k]) !== JSON.stringify(l.new_data[k]))
      .map(k => `${k}: ${l.old_data[k] ?? '–'} → ${l.new_data[k] ?? '–'}`).join(' · ');
  }
  const d = l.new_data ?? l.old_data ?? {};
  return ['title', 'full_name', 'name', 'student_id', 'role', 'description', 'amount_satang', 'status']
    .filter(k => d[k] != null).map(k => k === 'amount_satang' ? `${baht(d[k])} บาท` : d[k]).join(' · ');
}

async function renderAudit() {
  let q = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(300);
  if (auditFilter) q = q.eq('table_name', auditFilter);
  const [rows, people] = await Promise.all([q.then(must), sb.from('members').select('user_id, full_name').then(must)]);
  const name = new Map(people.map(p => [p.user_id, p.full_name]));
  const filter = h('select', { style: 'width:auto', 'aria-label': 'ส่วนของระบบ', onchange: e => { auditFilter = e.target.value; route(); } },
    h('option', { value: '' }, 'ทุกส่วน'), Object.entries(TABLE_TH).map(([k, t]) => h('option', { value: k, selected: k === auditFilter }, t)));
  return h('div', { className: 'card' },
    h('div', { className: 'row', style: 'margin-bottom:8px' }, h('h1', {}, 'ประวัติการกระทำ'), h('div', { style: 'margin-left:auto' }, filter)),
    h('p', { className: 'muted' }, 'บันทึกอัตโนมัติทุกการเพิ่ม แก้ไข และส่งออก แก้ไขหรือลบไม่ได้ (แสดง 300 รายการล่าสุด)'),
    rows.length ? table([
      ['เวลา', l => when(l.at)],
      ['ผู้ทำ', l => l.actor ? (name.get(l.actor) ?? 'ผู้ใช้ที่ไม่อยู่ในรายชื่อ') : 'ระบบ'],
      ['การกระทำ', l => ACTION_TH[l.action] ?? l.action],
      ['ส่วน', l => TABLE_TH[l.table_name] ?? l.table_name],
      ['รายละเอียด', l => h('span', { style: 'word-break:break-word' }, auditDetail(l) || '-')],
      ['เหตุผล', l => l.reason ?? '-'],
    ], rows) : h('p', { className: 'muted' }, 'ยังไม่มีประวัติ'));
}

// ─── คืนเงิน ─────────────────────────────────────────────────────

// โอนเงินคืนก่อน แล้วบันทึกพร้อมสลิปโอนคืน memberChargeId = null คือคืนเครดิตจ่ายเกิน
async function refundDialog(memberId, name, max, memberChargeId = null, what = 'เครดิตจ่ายเกิน') {
  const v = await dialogForm(`คืนเงินให้ ${name} (${what})`, [
    { name: 'amount', label: `ยอดที่โอนคืน (บาท · ไม่เกิน ${baht(max)})`, value: baht(max).replace(/,/g, '') },
    { name: 'reason', label: memberChargeId ? 'เหตุผล เช่น กิจกรรมยกเลิก' : 'เหตุผล เช่น คืนเงินที่โอนเกิน' },
    { name: 'slip', label: 'สลิปโอนคืน (รูป JPG, PNG, WEBP)', type: 'file', accept: Object.keys(SLIP_TYPES).join(',') },
  ], 'บันทึกการคืนเงิน', true);
  if (!v) return;
  try {
    const amount = toSatang(v.amount);
    if (!amount) throw new Error('กรอกยอดเป็นตัวเลข');
    if (!confirm(`ยืนยันว่าโอนคืน ${baht(amount)} บาท ให้ ${name} แล้ว?`)) return;
    const path = await uploadSlip(v.slip);
    must(await sb.rpc('refund_member', { p_member_id: memberId, p_amount_satang: amount, p_reason: v.reason, p_slip_path: path, p_member_charge_id: memberChargeId }));
    toast('บันทึกการคืนเงินแล้ว และแจ้งสมาชิกแล้ว');
    route();
  } catch (err) { toast(thai(err)); }
}

// เหรัญญิก/ผู้ตรวจสอบ: สมาชิกที่มีเครดิตจ่ายเกิน และประวัติการคืนเงินทั้งหมด
async function renderRefunds() {
  const [credits, people, history] = await Promise.all([
    sb.from('member_credit').select('*').gt('credit_satang', 0).then(must),
    sb.from('members').select('id, full_name, student_id').then(must),
    sb.from('refunds').select('*, members(full_name, student_id), member_charges(charges(title))').order('created_at', { ascending: false }).then(must),
  ]);
  const who = new Map(people.map(m => [m.id, m]));
  return h('div', {},
    h('h1', {}, 'คืนเงิน'),
    h('p', { className: 'muted' }, 'โอนเงินคืนสมาชิกก่อน แล้วบันทึกพร้อมสลิปโอนคืน · คืนค่ารายการที่ชำระแล้ว (เช่น กิจกรรมยกเลิก) ทำได้ที่หน้ารายการเรียกเก็บ · ยืนยันสลิปผิดให้ใช้ปุ่ม "ยกเลิกรายรับ" ในหน้าตรวจสลิป'),
    h('div', { className: 'card' }, h('h2', {}, 'สมาชิกที่มีเครดิตจ่ายเกิน'),
      credits.length ? table([
        ['รหัสนิสิต', c => who.get(c.member_id)?.student_id ?? '-'],
        ['ชื่อ', c => who.get(c.member_id)?.full_name ?? '-'],
        ['เครดิต', c => money(c.credit_satang)],
        ...(can('treasurer') ? [['', c => h('button', { className: 'link', onclick: () => refundDialog(c.member_id, who.get(c.member_id)?.full_name, c.credit_satang) }, 'คืนเครดิต')]] : []),
      ], credits) : h('p', { className: 'muted' }, 'ไม่มีสมาชิกที่มีเครดิตคงเหลือ')),
    h('div', { className: 'card' }, h('h2', {}, 'ประวัติการคืนเงิน'),
      history.length ? table([
        ['วันที่', r => when(r.created_at)],
        ['สมาชิก', r => `${r.members.full_name} (${r.members.student_id})`],
        ['คืนค่า', r => r.member_charges?.charges?.title ?? 'เครดิตจ่ายเกิน'],
        ['จำนวน', r => money(r.amount_satang)],
        ['เหตุผล', r => r.reason],
        ['สลิป', r => h('button', { className: 'link', onclick: () => openSlip(r.slip_path) }, 'เปิดดู')],
      ], history) : h('p', { className: 'muted' }, 'ยังไม่มีการคืนเงิน')));
}

// ─── คู่มือ ──────────────────────────────────────────────────────

// คู่มือเขียนเป็น Markdown ใน web/manuals/ แปลงเป็นหน้าเว็บด้วย marked (โหลดเฉพาะตอนเปิดคู่มือ)
// เนื้อหามาจากไฟล์ใน repo ของเราเอง ไม่ใช่ข้อมูลที่ผู้ใช้กรอก
async function renderManual(name) {
  const [{ marked }, text] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/marked@15/+esm'),
    fetch(`./manuals/${name}.md`, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('ไม่พบไฟล์คู่มือ'); return r.text(); }),
  ]);
  const body = h('div', { className: 'card manual', innerHTML: marked.parse(text) });
  // ลิงก์ระหว่างคู่มือ (member.md / staff.md) → หน้าในเว็บ, ลิงก์ภายนอกเปิดแท็บใหม่
  for (const a of body.querySelectorAll('a[href]')) {
    const m = /^(member|staff)\.md$/.exec(a.getAttribute('href'));
    if (m) a.href = '#manual-' + m[1];
    else if (/^https?:/.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; }
  }
  // ตารางกว้างเลื่อนแนวนอนได้บนมือถือ
  for (const t of body.querySelectorAll('table')) t.replaceWith(h('div', { className: 'table-wrap' }, t.cloneNode(true)));
  return body;
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
      refreshBell(); renderNav();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_submissions' }, p => {
      renderNav();
      const [name, param] = location.hash.slice(1).split('/');
      // ไม่รีเฟรชหน้ารายละเอียดของรายการอื่น เพื่อไม่ให้ข้อความที่พิมพ์อยู่หาย
      if ((name === 'review' && (!param || param === p.new?.id)) || name === 'my-payments' || name === 'home' || !name) route();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_requests' }, p => {
      renderNav();
      const [name, param] = location.hash.slice(1).split('/');
      if ((name === 'expenses' && (!param || param === p.new?.id)) || ['summary', 'budget', 'home', ''].includes(name)) route();
    })
    .subscribe();
  poll = setInterval(() => { refreshBell(); renderNav(); }, 60000);
  refreshBell();
}

function stopLive() {
  if (channel) sb.removeChannel(channel);
  clearInterval(poll);
  channel = null;
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshBell(); renderNav(); } });

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
  document.body.classList.toggle('authed', view === 'app');
  if (view !== 'app') { setDrawer(false); $('#page-title').textContent = 'ระบบบัญชี รุ่นที่ 23'; }
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
    renderNav();
    const [name, param] = location.hash.slice(1).split('/');
    const p = PAGES[name]?.allowed() ? PAGES[name] : PAGES.home;
    $('#page-title').textContent = p.label;
    if (!page.firstChild) page.append(h('p', { className: 'muted' }, 'กำลังโหลด…'));
    const el = await p.render(param);
    if (run === seq) page.replaceChildren(el);
  } catch (err) {
    if (run !== seq) return;
    show('app');
    page.replaceChildren(h('div', { className: 'card' },
      h('h2', {}, 'ไม่สามารถโหลดข้อมูลได้'), h('p', { className: 'muted' }, thai(err)),
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
