-- ระยะตรวจสลิป ระดับ 1: เลขอ้างอิงจาก QR บนสลิป (รหัสธนาคาร:transRef) กันสลิปเดียวกันถูกใช้ซ้ำ
-- เว็บอ่าน QR ในเบราว์เซอร์ตอนแจ้งชำระ และหน้าตรวจสลิปอ่านซ้ำจากรูปจริงอีกรอบ (กันคนส่งค่าว่างตรง ๆ ผ่าน API)
-- QR ไม่มียอดเงิน จึงกันสลิปแก้ยอดไม่ได้ เหรัญญิกยังต้องดูยอดเข้าบัญชีจริงเหมือนเดิม

alter table public.payment_submissions add column slip_ref text;

-- ส่งซ้ำได้เฉพาะเมื่อรายการเดิมถูกยกเลิก/ไม่ผ่าน (เช่น เลือกรายการผิดแล้วส่งใหม่)
create unique index payment_submissions_slip_ref_live on public.payment_submissions (slip_ref)
  where status in ('pending', 'confirmed');
create index on public.payment_submissions (slip_ref);

drop function public.submit_payment(bigint, timestamptz, text, jsonb, uuid, text, text, text, text);

create function public.submit_payment(
  p_amount_satang bigint,
  p_transferred_at timestamptz,
  p_slip_path text,
  p_items jsonb default '[]',
  p_bank_account_id uuid default null,
  p_payer_bank text default null,
  p_reference_no text default null,
  p_note text default null,
  p_slip_sha256 text default null,
  p_slip_ref text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me members;
  sid uuid;
  item jsonb;
  mc member_charges;
  amt bigint;
  total bigint := 0;
begin
  select * into me from members where user_id = auth.uid() and active;
  if not found then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์แจ้งชำระ';
  end if;

  if split_part(p_slip_path, '/', 1) <> auth.uid()::text
     or not exists (select 1 from storage.objects where bucket_id = 'slips' and name = p_slip_path) then
    raise exception 'ไม่พบไฟล์สลิป กรุณาอัปโหลดใหม่';
  end if;

  if p_transferred_at > now() + interval '5 minutes' then
    raise exception 'วันเวลาโอนอยู่ในอนาคต';
  end if;

  if exists (select 1 from payment_submissions
             where slip_ref = nullif(trim(p_slip_ref), '') and status in ('pending', 'confirmed')) then
    raise exception 'สลิปนี้ถูกใช้แจ้งชำระไปแล้ว ถ้าคิดว่าผิดพลาด กรุณาติดต่อเหรัญญิก';
  end if;

  insert into payment_submissions (member_id, bank_account_id, amount_satang, transferred_at,
                                   payer_bank, reference_no, note, slip_path, slip_sha256, slip_ref)
  values (me.id, p_bank_account_id, p_amount_satang, p_transferred_at,
          nullif(trim(p_payer_bank), ''), nullif(trim(p_reference_no), ''), nullif(trim(p_note), ''),
          p_slip_path, p_slip_sha256, nullif(trim(p_slip_ref), ''))
  returning id into sid;

  for item in select * from jsonb_array_elements(p_items) loop
    amt := (item ->> 'amount_satang')::bigint;
    select mc2.* into mc
    from member_charges mc2
    join members m on m.id = mc2.member_id
    join charges c on c.id = mc2.charge_id
    where mc2.charge_id = (item ->> 'charge_id')::uuid
      and m.student_id = coalesce(nullif(trim(item ->> 'student_id'), ''), me.student_id)
      and c.status = 'open';
    if not found then
      raise exception 'ไม่พบรายการเรียกเก็บที่เปิดอยู่ของรหัสนิสิต %',
        coalesce(nullif(trim(item ->> 'student_id'), ''), me.student_id);
    end if;
    if amt > mc.amount_satang - mc.paid_satang then
      raise exception 'ยอดที่ระบุเกินยอดค้างของรายการ (ค้าง % บาท)', baht(mc.amount_satang - mc.paid_satang);
    end if;
    insert into submission_allocations (submission_id, member_charge_id, amount_satang)
    values (sid, mc.id, amt);
    total := total + amt;
  end loop;

  if total > p_amount_satang then
    raise exception 'ยอดที่แบ่งให้แต่ละรายการรวมกันเกินยอดโอน';
  end if;

  perform notify(t, 'pending',
                 format('%s แจ้งชำระ %s บาท รอตรวจสอบ', me.full_name, baht(p_amount_satang)),
                 '#review/' || sid, 'submission:' || sid)
  from active_treasurers() t;

  return sid;
end $$;

revoke execute on function public.submit_payment(bigint, timestamptz, text, jsonb, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.submit_payment(bigint, timestamptz, text, jsonb, uuid, text, text, text, text, text) to authenticated;

-- เหรัญญิกบันทึกเลขจาก QR ให้รายการที่ส่งมาโดยไม่มีเลข (เช่น ส่งก่อนมีระบบนี้ หรือเครื่องสมาชิกอ่าน QR ไม่ได้)
create function public.set_slip_ref(p_id uuid, p_slip_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('treasurer') then
    raise exception 'เฉพาะเหรัญญิก';
  end if;
  update payment_submissions set slip_ref = nullif(trim(p_slip_ref), '')
  where id = p_id and slip_ref is null;
end $$;
revoke execute on function public.set_slip_ref(uuid, text) from public, anon;
grant execute on function public.set_slip_ref(uuid, text) to authenticated;
