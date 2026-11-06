// Cadeia de certificados ICP-Brasil para o conector SEFAZ.
// Os servidores da SEFAZ usam certificados SSL da ICP-Brasil, que não estão na
// lista de autoridades do Node ("unable to get local issuer certificate").
// Carrega .crt/.cer/.pem/.der e o ACcompactado.zip do ITI da pasta ca/, e
// também as autoridades do sistema operacional quando o Node permite.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

export const ITI_ZIP = 'http://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip';
export const ITI_HASH = 'http://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/hashsha512.txt';

// Leitor mínimo de .zip (sem dependências)
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('arquivo .zip inválido');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('arquivo .zip inválido');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('latin1', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
  }
  return out;
}

// Um arquivo pode ter vários certificados PEM ou um único DER
function certsFrom(buf) {
  const pems = buf.toString('latin1').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const out = [];
  for (const item of pems || [buf]) {
    try { out.push(new crypto.X509Certificate(item).toString()); } catch (e) { /* não é certificado */ }
  }
  return out;
}

const CERT_EXT = /\.(crt|cer|pem|der|p7b)$/i;
export function loadDir(dir) {
  const certs = new Set();
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f));
    try {
      if (/\.zip$/i.test(f)) { for (const e of unzip(buf)) if (CERT_EXT.test(e.name)) certsFrom(e.data).forEach(c => certs.add(c)); }
      else if (CERT_EXT.test(f)) certsFrom(buf).forEach(c => certs.add(c));
    } catch (e) { console.log(`  (ignorado ${f}: ${e.message})`); }
  }
  return [...certs];
}

export function systemCAs() {
  try { return typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : []; } catch (e) { return []; }
}

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume(); return get(new URL(res.headers.location, url).toString(), hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}

// Baixa o arquivo único do ITI e confere o SHA-512 publicado ao lado
export async function downloadIti(dir) {
  const [zip, hashTxt] = await Promise.all([get(ITI_ZIP), get(ITI_HASH)]);
  const esperado = (hashTxt.toString('latin1').match(/[0-9a-f]{128}/i) || [''])[0].toLowerCase();
  const obtido = crypto.createHash('sha512').update(zip).digest('hex');
  if (!esperado || esperado !== obtido) throw new Error('hash SHA-512 do arquivo do ITI não confere');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ACcompactado.zip'), zip);
}

// Testa se a cadeia do servidor é reconhecida (só o aperto de mão TLS; nada é enviado)
export function checkTrust(host, ca) {
  return new Promise(resolve => {
    const sock = tls.connect({ host, port: 443, servername: host, ca, rejectUnauthorized: false, timeout: 15000 }, () => {
      const r = { ok: sock.authorized, err: sock.authorizationError ? String(sock.authorizationError) : '' };
      sock.destroy(); resolve(r);
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, err: 'tempo esgotado', rede: true }); });
    sock.on('error', e => resolve({ ok: false, err: e.message, rede: true }));
  });
}
