// Conector local para a Consulta GTIN da SEFAZ (CCG — NT 2022.001).
// A página estática não consegue apresentar o certificado A1 (TLS mútuo);
// este processo recebe o certificado, guarda só na memória e faz a chamada SOAP.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import tls from 'node:tls';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SEFAZ_BRIDGE_TOKEN || crypto.randomBytes(24).toString('hex');
// Origens autorizadas. Para abrir o index.html direto do disco (file://) inclua "null".
const allowed = new Set((process.env.SEFAZ_ALLOWED_ORIGINS || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean));
const endpoint = 'https://dfe-servico.svrs.rs.gov.br/ws/ccgConsGTIN/ccgConsGTIN.asmx';
const SOAP_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/ccgConsGtin/ccgConsGTIN';

// Retornos da NT 2022.001
const COM_DADOS = new Set(['9490', '9497', '9498']);            // sucesso / NCM não informado / NCM inválido
const SEM_DADOS = new Set(['9491', '9492', '9494', '9495', '9496']); // problema do GTIN: segue para o próximo
// Demais (9493 certificado não é emitente, 108/109 serviço paralisado, consumo indevido…) interrompem o lote.

let certificate = null;
let agent = null;
let lastRequestAt = 0;

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function readBody(req, limit = 18 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('Requisição muito grande')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function decodeXml(s) { return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function tag(xml, name) {
  const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}\\s*>`, 'i'));
  return m ? decodeXml(m[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function soapCall(gtin) {
  const requestXml = `<consGTIN xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><GTIN>${gtin}</GTIN></consGTIN>`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><ccgConsGTIN xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/ccgConsGtin"><nfeDadosMsg>${requestXml}</nfeDadosMsg></ccgConsGTIN></soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST', agent, timeout: 25000,
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`, 'Content-Length': Buffer.byteLength(envelope) }
    }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // O retorno pode vir como XML normal ou escapado dentro do resultado SOAP
        const xml = /&lt;\s*(?:\w+:)?cStat/.test(data) ? decodeXml(data) : data;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const fault = tag(xml, 'Text') || tag(xml, 'faultstring') || tag(xml, 'xMotivo');
          return reject(new Error(`SEFAZ respondeu HTTP ${res.statusCode}${fault ? ' — ' + fault : ''}`));
        }
        const cStat = tag(xml, 'cStat'), motivo = tag(xml, 'xMotivo');
        if (!cStat) return reject(new Error('Resposta da SEFAZ sem cStat'));
        if (!COM_DADOS.has(cStat) && !SEM_DADOS.has(cStat)) return reject(new Error(`${cStat} — ${motivo || 'consulta recusada'}`));
        const found = COM_DADOS.has(cStat);
        resolve({ found, gtin: tag(xml, 'GTIN') || gtin, desc: found ? tag(xml, 'xProd') : '', ncm: found ? tag(xml, 'NCM') : '',
                  cest: found ? tag(xml, 'CEST') : '', cStat, motivo });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado na SEFAZ')));
    req.on('error', reject);
    req.end(envelope);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!allowed.has(origin)) return reply(res, 403, { error: `Origem ${origin} não autorizada. Inclua-a em SEFAZ_ALLOWED_ORIGINS.` });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!authorized(req)) return reply(res, 401, { error: 'Token do conector inválido.' });
  if (req.method === 'GET' && req.url === '/api/status') return reply(res, 200, { ok: true, certificate: !!certificate });
  if (req.method === 'POST' && req.url === '/api/certificate') {
    try {
      const body = JSON.parse(await readBody(req));
      const pfx = Buffer.from(body.pfx || '', 'base64');
      if (!pfx.length || pfx.length > 12 * 1024 * 1024 || typeof body.passphrase !== 'string') throw new Error('Arquivo ou senha inválidos.');
      // Valida arquivo e senha; o PFX e a senha ficam apenas na memória do processo.
      tls.createSecureContext({ pfx, passphrase: body.passphrase, minVersion: 'TLSv1.2' });
      if (agent) agent.destroy();
      certificate = { loadedAt: new Date() };
      agent = new https.Agent({ pfx, passphrase: body.passphrase, minVersion: 'TLSv1.2', keepAlive: true, maxSockets: 1 });
      return reply(res, 200, { ok: true });
    } catch (e) {
      certificate = null; if (agent) { agent.destroy(); agent = null; }
      return reply(res, 400, { error: 'Não foi possível abrir o certificado. Confira o arquivo PFX/P12 e a senha.' });
    }
  }
  const match = req.method === 'GET' && req.url.match(/^\/api\/gtin\/(\d{8}|\d{12}|\d{13}|\d{14})$/);
  if (match) {
    if (!certificate) return reply(res, 400, { error: 'Carregue um certificado A1 primeiro (botão Conectar).' });
    if (Date.now() - lastRequestAt < 1000) return reply(res, 429, { error: 'Aguarde pelo menos 1 segundo entre consultas.' });
    lastRequestAt = Date.now();
    try { return reply(res, 200, await soapCall(match[1])); }
    catch (e) { return reply(res, 502, { error: `SEFAZ: ${e.message}` }); }
  }
  reply(res, 404, { error: 'Rota não encontrada.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Conector SEFAZ em http://${HOST}:${PORT}`);
  console.log(`Token desta execução: ${TOKEN}`);
  console.log(allowed.size ? `Origens autorizadas: ${[...allowed].join(', ')}`
    : 'ATENÇÃO: SEFAZ_ALLOWED_ORIGINS vazio — o navegador será recusado. Ex.: https://seu-usuario.github.io (ou null para file://).');
  console.log('O certificado fica apenas na memória. Ctrl+C encerra e apaga os dados.');
});
