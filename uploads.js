'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, 'data', 'private', 'verifications');
const MAX_BYTES = 10 * 1024 * 1024;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function detectKind(buffer) {
  if (!buffer || buffer.length < 8) return null;
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  return null;
}

function saveVerificationFile(buffer) {
  const kind = detectKind(buffer);
  if (!kind) {
    const err = new Error('Please upload a PDF, JPG, or PNG file.');
    err.code = 'INVALID_FILE_TYPE';
    throw err;
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error('File must be 10 MB or smaller.');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  ensureUploadDir();
  const filename = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  const fullPath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(fullPath, buffer);
  return { filename, mime: kind.mime, bytes: buffer.length, path: fullPath };
}

function resolveUpload(filename) {
  if (!filename || typeof filename !== 'string') return null;
  if (!/^[a-f0-9]+\.(pdf|jpg|png)$/i.test(filename)) return null;
  const fullPath = path.resolve(UPLOAD_DIR, filename);
  if (!fullPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

function deleteUpload(filename) {
  const fullPath = resolveUpload(filename);
  if (fullPath) {
    try {
      fs.unlinkSync(fullPath);
    } catch {
      /* ignore */
    }
  }
}

function writeMinimalPdf(textLines) {
  const lines = Array.isArray(textLines) ? textLines : [String(textLines)];
  const escaped = lines.map((line, i) => {
    const safe = String(line).replace(/[()\\]/g, ' ');
    return i === 0 ? `(${safe}) Tj` : `T* (${safe}) Tj`;
  });
  const stream = `BT /F1 12 Tf 14 TL 72 720 Td\n${escaped.join('\n')}\nET`;
  const objs = [];
  const add = (s) => {
    objs.push(s);
    return objs.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  );
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i += 1) {
    table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `${table}trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

module.exports = {
  UPLOAD_DIR,
  MAX_BYTES,
  ensureUploadDir,
  detectKind,
  saveVerificationFile,
  resolveUpload,
  deleteUpload,
  writeMinimalPdf,
};
