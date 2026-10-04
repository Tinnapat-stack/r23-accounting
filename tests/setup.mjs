// สร้างฐานข้อมูล Postgres จริง (PGlite) แล้วรัน migration ทุกไฟล์ตามลำดับ
// จำลองเฉพาะส่วนของ Supabase ที่ migration ใช้: auth.users, auth.uid(), storage
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const migrations = new URL('../supabase/migrations/', import.meta.url);

export async function createDb(people) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql as
      $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema auth, storage to anon, authenticated;
    grant all on storage.objects to authenticated;
    -- ค่าเริ่มต้นของ Supabase: ให้สิทธิ์ตารางใน public ทั้งหมด แล้วคุมด้วย RLS
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
  `);
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, migrations), 'utf8'));
  }

  const ids = Object.fromEntries(people.map(p => [p, crypto.randomUUID()]));

  // รันคำสั่งในฐานะผู้ใช้คนหนึ่ง (null = ระบบ/superuser)
  async function as(who, sql, params) {
    if (!who) return (await db.query(sql, params)).rows;
    await db.exec(`select set_config('request.jwt.claim.sub', '${ids[who]}', false); set role authenticated;`);
    try { return (await db.query(sql, params)).rows; }
    finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
  }

  const signup = (who, studentId, email) => as(null,
    `insert into auth.users values ($1, $2, jsonb_build_object('student_id', $3::text))`, [ids[who], email, studentId]);

  return { db, ids, as, signup };
}
