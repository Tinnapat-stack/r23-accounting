// อ่าน QR บนสลิปธนาคารไทย: ได้รหัสธนาคารผู้โอน + เลขอ้างอิงรายการ (transRef) ซึ่งไม่ซ้ำกันในแต่ละการโอน
// QR นี้ไม่มียอดเงิน จึงใช้กันสลิปซ้ำได้ แต่กันสลิปแก้ยอดไม่ได้

export const BANKS = {
  '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทหารไทยธนชาต', '014': 'ไทยพาณิชย์',
  '022': 'ซีไอเอ็มบี', '024': 'ยูโอบี', '025': 'กรุงศรีอยุธยา', '030': 'ออมสิน', '033': 'อาคารสงเคราะห์',
  '034': 'ธ.ก.ส.', '066': 'อิสลามแห่งประเทศไทย', '067': 'ทิสโก้', '069': 'เกียรตินาคินภัทร', '073': 'แลนด์ แอนด์ เฮ้าส์',
};

// ข้อความ TLV แบบ EMV: แท็ก 2 หลัก + ความยาว 2 หลัก + ค่า
function tlv(s) {
  const out = {};
  for (let i = 0; i < s.length;) {
    const len = /^\d\d$/.test(s.slice(i + 2, i + 4)) ? Number(s.slice(i + 2, i + 4)) : -1;
    if (len < 0 || i + 4 + len > s.length) return null;
    out[s.slice(i, i + 2)] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

// "0041000600000101030040225...5102TH9104xxxx" → { bank: '004', ref: '...', key: '004:...' } หรือ null ถ้าไม่ใช่ QR สลิป
export function parseSlipQr(text) {
  const inner = tlv(String(text ?? '').trim())?.['00'];
  const f = inner && tlv(inner);
  if (!f || !/^\d{3}$/.test(f['01'] ?? '') || !/^[0-9A-Za-z]{10,}$/.test(f['02'] ?? '')) return null;
  return { bank: f['01'], ref: f['02'], key: `${f['01']}:${f['02']}` };
}

// รูป (File/Blob) → ผล parseSlipQr หรือ null; ใช้ BarcodeDetector ของเบราว์เซอร์ถ้ามี ไม่งั้นโหลด jsQR
export async function readSlipQr(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    if ('BarcodeDetector' in globalThis) {
      for (const c of await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp)) {
        const r = parseSlipQr(c.rawValue);
        if (r) return r;
      }
    }
    const { default: jsQR } = await import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm');
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height)); // ponytail: รูปใหญ่ย่อเหลือ 2000px พอสำหรับ QR บนสลิป
    const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
    const ctx = Object.assign(document.createElement('canvas'), { width: w, height: hgt }).getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, hgt);
    const code = jsQR(ctx.getImageData(0, 0, w, hgt).data, w, hgt);
    return code ? parseSlipQr(code.data) : null;
  } catch {
    return null; // อ่านไม่ได้ก็ไม่ขวางการแจ้งชำระ เหรัญญิกตรวจเองเหมือนเดิม
  }
}
