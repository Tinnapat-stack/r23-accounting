// สำรอง / กู้คืนไฟล์สลิปและใบเสร็จใน Supabase Storage
//   node scripts/storage-backup.mjs backup  <โฟลเดอร์ปลายทาง>
//   node scripts/storage-backup.mjs restore <โฟลเดอร์ที่สำรองไว้>
// ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY (secret key) ใน environment
// คีย์นี้ข้ามสิทธิ์ได้ทั้งหมด ใช้ใน GitHub Secrets หรือเครื่องตัวเองเท่านั้น ห้ามใส่ในหน้าเว็บหรือ commit
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const BUCKETS = ['slips', 'evidence'];
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
const [mode, dir] = process.argv.slice(2);
if (!SUPABASE_URL || !KEY || !['backup', 'restore'].includes(mode) || !dir) {
  console.error('ใช้: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/storage-backup.mjs backup|restore <โฟลเดอร์>');
  process.exit(1);
}

// คีย์แบบใหม่ (sb_secret_...) ส่งใน apikey อย่างเดียว คีย์แบบเก่า (JWT) ต้องส่ง Authorization ด้วย
const auth = { apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}) };
const api = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1`;
const objectUrl = (bucket, path) => `${api}/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${await res.text()}`);
  return res;
}

// รายชื่อไฟล์ทั้งหมดใน bucket (ไล่เข้าโฟลเดอร์ย่อย: รายการที่ id เป็น null คือโฟลเดอร์)
async function listAll(bucket, prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await (await call(`${api}/object/list/${bucket}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })).json();
    for (const item of page) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) files.push(...await listAll(bucket, path));
      else files.push({ path, type: item.metadata?.mimetype });
    }
    if (page.length < 1000) return files;
  }
}

async function walk(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

for (const bucket of BUCKETS) {
  if (mode === 'backup') {
    const files = await listAll(bucket);
    for (const f of files) {
      const target = join(dir, bucket, ...f.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await (await call(objectUrl(bucket, f.path))).arrayBuffer()));
    }
    console.log(`${bucket}: สำรอง ${files.length} ไฟล์`);
  } else {
    const files = await walk(join(dir, bucket));
    for (const full of files) {
      const path = relative(join(dir, bucket), full).split(/[\\/]/).join('/');
      await call(objectUrl(bucket, path), {
        method: 'POST', body: await readFile(full),
        headers: { 'Content-Type': TYPES[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'x-upsert': 'true' },
      });
    }
    console.log(`${bucket}: กู้คืน ${files.length} ไฟล์`);
  }
}
