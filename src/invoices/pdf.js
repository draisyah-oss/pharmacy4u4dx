// 6 Nov: a tiny PDF writer – one page per JPEG photo, the JPEG embedded as-is (DCTDecode), so no
// PDF library is needed. Each page is A4 width (595 pt) and as tall as the photo's shape.

// Width, height and colour components from a JPEG's SOF marker; null when it isn't a JPEG.
function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

function jpegsToPdf(jpegs) {
  const objs = []; // index 0 = object 1
  const add = (parts) => { objs.push(parts); return objs.length; };
  const catalog = add(null); const pages = add(null);
  const kids = [];
  for (const jpg of jpegs) {
    const info = jpegInfo(jpg);
    if (!info || !info.width || !info.height) throw new Error('A page isn’t a JPEG photo.');
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const w = 595; const h = Math.max(1, Math.round((595 * info.height) / info.width));
    const img = add([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    const content = add([Buffer.from(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)]);
    kids.push(add([Buffer.from(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`)]));
  }
  if (!kids.length) throw new Error('No pages.');
  objs[catalog - 1] = [Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`)];
  objs[pages - 1] = [Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)];

  const out = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = out[0].length; const offsets = [];
  objs.forEach((parts, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), ...parts, Buffer.from('\nendobj\n')]);
    out.push(chunk); pos += chunk.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  out.push(Buffer.from(xref));
  return Buffer.concat(out);
}

module.exports = { jpegInfo, jpegsToPdf };
