import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import tls from 'node:tls';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SEFAZ_BRIDGE_TOKEN || crypto.randomBytes(24).toString('hex');
const allowed = new Set((process.env.SEFAZ_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const endpoint = 'https://dfe-servico.svrs.rs.gov.br/ws/ccgConsGTIN/ccgConsGTIN.asmx';
let certificate = null;
let lastRequestAt = 0;

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function authorized(req) { return req.headers.authorization === `Bearer ${TOKEN}`; }
function readBody(req, limit = 18 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('Requisição muito grande')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function decodeXml(s) { return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function tag(xml, name) {
  const m = String(xml).match(new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${name}\\s*>`, 'i'));
  return m ? decodeXml(m[1].replace(/<[^>]+>/g, '').trim()) : '';
}
function soapCall(gtin, pfx, passphrase) {
  const requestXml = `<consGTIN xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><GTIN>${gtin}</GTIN></consGTIN>`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><ccgConsGTIN xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/ccgConsGtin"><nfeDadosMsg>${requestXml}</nfeDadosMsg></ccgConsGTIN></soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST', pfx, passphrase, minVersion: 'TLSv1.2', timeout: 25000,
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(envelope) }
    }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`SEFAZ respondeu HTTP ${res.statusCode}`));
        const nested = tag(data, 'nfeResultMsg');
        const xml = nested || data;
        const cStat = tag(xml, 'cStat');
        if (cStat !== '9490') return resolve({ found: false, cStat, error: tag(xml, 'xMotivo') || 'GTIN não localizado na CCG' });
        resolve({ found: true, gtin: tag(xml, 'GTIN') || gtin, desc: tag(xml, 'xProd'), ncm: tag(xml, 'NCM'), cest: tag(xml, 'CEST'), cStat, motivo: tag(xml, 'xMotivo') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado na SEFAZ')));
    req.on('error', reject); req.end(envelope);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  } else if (origin) return reply(res, 403, { error: 'Origem não autorizada. Configure SEFAZ_ALLOWED_ORIGINS.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!authorized(req)) return reply(res, 401, { error: 'Token do conector inválido.' });
  if (req.method === 'GET' && req.url === '/api/status') return reply(res, 200, { ok: true, certificate: !!certificate });
  if (req.method === 'POST' && req.url === '/api/certificate') {
    try {
      const body = JSON.parse(await readBody(req));
      const pfx = Buffer.from(body.pfx || '', 'base64');
      if (!pfx.length || pfx.length > 12 * 1024 * 1024 || typeof body.passphrase !== 'string') throw new Error('Arquivo ou senha inválidos.');
      // A senha e o PFX são retidos apenas na memória do processo.
      tls.createSecureContext({ pfx, passphrase: body.passphrase, minVersion: 'TLSv1.2' });
      certificate = { pfx, passphrase: body.passphrase };
      return reply(res, 200, { ok: true });
    } catch (e) { certificate = null; return reply(res, 400, { error: 'Não foi possível abrir o certificado. Confira arquivo PFX/P12 e senha.' }); }
  }
  const match = req.method === 'GET' && req.url.match(/^\/api\/gtin\/(\d{8}|\d{12}|\d{13}|\d{14})$/);
  if (match) {
    if (!certificate) return reply(res, 400, { error: 'Carregue um certificado A1 primeiro.' });
    const gtin = match[1];
    if (Date.now() - lastRequestAt < 1000) return reply(res, 429, { error: 'Aguarde pelo menos 1 segundo entre consultas.' });
    lastRequestAt = Date.now();
    try { return reply(res, 200, await soapCall(gtin, certificate.pfx, certificate.passphrase)); }
    catch (e) { return reply(res, 502, { error: `Falha na comunicação com a SEFAZ: ${e.message}` }); }
  }
  reply(res, 404, { error: 'Rota não encontrada.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Conector SEFAZ em http://${HOST}:${PORT}`);
  console.log(`Token desta execução: ${TOKEN}`);
  console.log('O certificado será mantido apenas na memória. Ctrl+C encerra e apaga os dados.');
  if (!allowed.size) console.log('Configure SEFAZ_ALLOWED_ORIGINS com a origem do GitHub Pages antes de usar pelo site publicado.');
});
