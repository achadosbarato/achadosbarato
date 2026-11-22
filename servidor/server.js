'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- .env mínimo, sem dependências ---
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
} catch (e) {}

const E = process.env;
const PORT = +E.PORT || 3000;
const SO = String(E.LOJA || '').toLowerCase(); // ml | shopee | shein: deixa este servidor atender só uma loja
const TTL = 10 * 60 * 1000;
const cache = new Map();
const hits = new Map();

const sleepTimeout = (ms) => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal; };
const num = v => { const n = parseFloat(v); return n > 0 ? n : 0; };

// --- Mercado Livre ---
let mlTok = { v: null, exp: 0 };
async function mlToken() {
  if (!E.ML_CLIENT_ID || !E.ML_CLIENT_SECRET) return null;
  if (mlTok.v && Date.now() < mlTok.exp) return mlTok.v;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: E.ML_CLIENT_ID, client_secret: E.ML_CLIENT_SECRET }),
    signal: sleepTimeout(8000)
  });
  if (!r.ok) throw new Error('token ML recusado (' + r.status + ')');
  const j = await r.json();
  mlTok = { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return mlTok.v;
}
async function buscarML(q, min, max) {
  const tok = await mlToken();
  const p = new URLSearchParams({ q, limit: '50' });
  if (min || max) p.set('price', (min || '*') + '-' + (max || '*'));
  const r = await fetch('https://api.mercadolibre.com/sites/MLB/search?' + p, {
    headers: Object.assign({ accept: 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}),
    signal: sleepTimeout(9000)
  });
  if (!r.ok) throw new Error('ML respondeu ' + r.status + (tok ? '' : ' (configure ML_CLIENT_ID e ML_CLIENT_SECRET)'));
  const j = await r.json();
  let rs = (j.results || []).filter(x => x && x.price > 0 && x.permalink);
  const novos = rs.filter(x => x.condition === 'new');
  if (novos.length) rs = novos;
  return rs.map(x => ({
    title: x.title, price: x.price, link: x.permalink,
    img: String(x.thumbnail || '').replace(/^http:/, 'https:'),
    free: !!(x.shipping && x.shipping.free_shipping)
  }));
}

// --- Shopee (API oficial de Afiliados, Brasil) ---
async function buscarShopee(q, min, max) {
  if (!E.SHOPEE_APP_ID || !E.SHOPEE_APP_SECRET) throw new Error('sem credenciais (SHOPEE_APP_ID e SHOPEE_APP_SECRET)');
  const query = 'query { productOfferV2(keyword: ' + JSON.stringify(q) + ', sortType: 1, page: 1, limit: 50) { nodes { productName price priceMin imageUrl offerLink productLink shopName } } }';
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256').update(E.SHOPEE_APP_ID + ts + payload + E.SHOPEE_APP_SECRET).digest('hex');
  const r = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'SHA256 Credential=' + E.SHOPEE_APP_ID + ', Timestamp=' + ts + ', Signature=' + sig },
    body: payload, signal: sleepTimeout(9000)
  });
  if (!r.ok) throw new Error('Shopee respondeu ' + r.status);
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error('Shopee: ' + String(j.errors[0].message || 'erro').slice(0, 120));
  const nodes = (((j.data || {}).productOfferV2 || {}).nodes) || [];
  return nodes.map(n => ({
    title: n.productName, price: num(n.priceMin) || num(n.price), link: n.offerLink || n.productLink,
    img: n.imageUrl, shop: n.shopName, free: false
  })).filter(x => x.price > 0 && x.link);
}

function faixaFiltro(lista, min, max) {
  return lista.filter(x => (!min || x.price >= min) && (!max || x.price <= max)).sort((a, b) => a.price - b.price).slice(0, 8);
}

async function precos(q, min, max) {
  const key = [q.toLowerCase(), min, max].join('|');
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.v;
  const [ml, sp] = await Promise.allSettled([buscarML(q, min, max), buscarShopee(q, min, max)]);
  const avisos = {};
  const out = { ml: [], shopee: [], shein: [], avisos };
  if (ml.status === 'fulfilled') out.ml = faixaFiltro(ml.value, min, max); else avisos.ml = ml.reason.message;
  if (sp.status === 'fulfilled') out.shopee = faixaFiltro(sp.value, min, max); else avisos.shopee = sp.reason.message;
  avisos.shein = 'A Shein não tem API pública: digite o preço manualmente.';
  if (!avisos.ml && !avisos.shopee) cache.set(key, { t: Date.now(), v: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}


// --- Shein (via Apify: a Shein não tem API pública; o ator abre a loja num navegador real) ---
function precoNum(v) {
  if (typeof v === 'number') return v > 0 ? v : 0;
  let t = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return num(t);
}
async function buscarShein(q, min, max) {
  if (!E.APIFY_TOKEN) throw new Error('sem APIFY_TOKEN (preço da Shein não é automático)');
  const ator = E.SHEIN_ACTOR || 'khadinakbar~shein-product-scraper';
  const r = await fetch('https://api.apify.com/v2/acts/' + ator + '/run-sync-get-dataset-items?timeout=100&memory=1024', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + E.APIFY_TOKEN },
    body: JSON.stringify({ searchQueries: [q], country: E.SHEIN_COUNTRY || 'br', maxItems: 20, scrapeProductDetails: false }),
    signal: sleepTimeout(115000)
  });
  if (!r.ok) throw new Error('Shein (Apify) respondeu ' + r.status);
  const items = await r.json();
  if (!Array.isArray(items)) throw new Error('Shein: resposta inesperada');
  const out = [];
  let outraMoeda = false;
  for (const it of items) {
    if (it.currency && !/^(BRL|R\$)$/i.test(String(it.currency))) { outraMoeda = true; continue; }
    const price = precoNum(it.salePrice != null ? it.salePrice : (it.price != null ? it.price : it.retailPrice));
    const img = it.mainImage || it.image || (Array.isArray(it.images) ? it.images[0] : '') || '';
    const link = it.url || it.productUrl || it.link;
    const title = it.title || it.name;
    if (price > 0 && link && title) out.push({ title, price, link, img: String(img).replace(/^\/\//, 'https://'), free: false });
  }
  if (!out.length && outraMoeda) throw new Error('Shein devolveu preços em outra moeda; configure SHEIN_COUNTRY');
  return out;
}


// --- Leitor de produto: segue links curtos e lê nome e foto da página (sem chave, sem conta) ---
const LOJAS_OK = /(^|\.)(shopee\.com\.br|shope\.ee|shp\.ee|mercadolivre\.com\.br|mercadolibre\.com|meli\.la|shein\.com|shein\.top|tiktok\.com)$/i;
const decHtml = t => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
function urlPermitida(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && LOJAS_OK.test(x.hostname); } catch (e) { return false; }
}
async function lerTexto(res, max) {
  const rd = res.body.getReader(), dec = new TextDecoder('utf-8', { fatal: false });
  let t = '', n = 0;
  while (n < max) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length; t += dec.decode(value, { stream: true });
  }
  try { await rd.cancel(); } catch (e) {}
  return t;
}
function metas(html) {
  const out = {};
  for (const tag of (html.match(/<meta\s[^>]*>/gi) || [])) {
    const k = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const v = (tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i) || [])[1];
    if (k && v != null && out[k.toLowerCase()] === undefined) out[k.toLowerCase()] = decHtml(v);
  }
  const t = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  if (t) out.__title = decHtml(t);
  return out;
}
async function lerProduto(u0) {
  const key = 'p|' + u0;
  const c = cache.get(key);
  if (c && Date.now() - c.t < 30 * 60 * 1000) return c.v;
  let u = u0, html = '';
  for (let i = 0; i < 6; i++) {
    if (!urlPermitida(u)) throw new Error('link de loja não permitido');
    const r = await fetch(u, {
      redirect: 'manual', signal: sleepTimeout(9000),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9' }
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
    html = await lerTexto(r, 400000);
    break;
  }
  const m = metas(html);
  let img = m['og:image'] || m['twitter:image'] || m['og:image:url'] || '';
  if (img.startsWith('//')) img = 'https:' + img;
  if (!/^https?:\/\//i.test(img)) img = '';
  const v = {
    titulo: m['og:title'] || m['twitter:title'] || m.__title || '',
    imagem: img,
    preco: precoNum(m['product:price:amount'] || m['og:price:amount'] || ''),
    url: u
  };
  if (v.titulo || v.imagem) cache.set(key, { t: Date.now(), v });
  return v;
}

const PROV = { ml: buscarML, shopee: buscarShopee, shein: buscarShein };
const TTLS = { ml: TTL, shopee: TTL, shein: 30 * 60 * 1000 };
async function porLoja(l, q, min, max) {
  const key = [l, q.toLowerCase(), min, max].join('|');
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTLS[l]) return c.v;
  try {
    const itens = faixaFiltro(await PROV[l](q, min, max), min, max);
    const v = { itens, aviso: itens.length ? '' : 'Nada encontrado nessa faixa de preço.' };
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  } catch (e) { return { itens: [], aviso: String(e.message || 'erro').slice(0, 160) }; }
}

// --- HTTP ---
function cors(res, req) {
  const o = E.ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', o || '*');
  if (o) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function limite(ip, max, tag) {
  const k = (tag || '') + ip, agora = Date.now(), h = (hits.get(k) || []).filter(t => agora - t < 60000);
  h.push(agora); hits.set(k, h); if (hits.size > 4000) hits.clear();
  return h.length <= (max || 30);
}

const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/saude') return json(res, 200, { ok: true, ml: !!(E.ML_CLIENT_ID && E.ML_CLIENT_SECRET), shopee: !!(E.SHOPEE_APP_ID && E.SHOPEE_APP_SECRET), shein: !!E.APIFY_TOKEN, loja: SO || 'todas' });
    if (url.pathname === '/api/produto') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limite(ip, 30, 'p')) return json(res, 429, { erro: 'Muitas buscas. Aguarde um minuto.' });
      const u = String(url.searchParams.get('url') || '').trim().slice(0, 600);
      if (!urlPermitida(u)) return json(res, 400, { erro: 'Link inválido ou de loja não permitida' });
      try { return json(res, 200, await lerProduto(u)); } catch (e) { return json(res, 200, { titulo: '', imagem: '', preco: 0, url: u, erro: String(e.message || 'falha').slice(0, 120) }); }
    }
    const m = url.pathname.match(/^\/api\/loja\/(ml|shopee|shein)$/);
    if (m) {
      if (SO && m[1] !== SO) return json(res, 404, { itens: [], aviso: 'Este servidor atende só: ' + SO });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limite(ip, m[1] === 'shein' ? 6 : 30, m[1])) return json(res, 429, { itens: [], aviso: 'Muitas buscas. Aguarde um minuto.' });
      const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (q.length < 2) return json(res, 400, { itens: [], aviso: 'Informe q' });
      let min = num(url.searchParams.get('min')), max = num(url.searchParams.get('max'));
      if (min && max && min > max) [min, max] = [max, min];
      return json(res, 200, await porLoja(m[1], q, min, max));
    }
    if (url.pathname === '/api/precos') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limite(ip)) return json(res, 429, { erro: 'Muitas buscas. Aguarde um minuto.' });
      const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (q.length < 2) return json(res, 400, { erro: 'Informe q' });
      let min = num(url.searchParams.get('min')), max = num(url.searchParams.get('max'));
      if (min && max && min > max) [min, max] = [max, min];
      return json(res, 200, await precos(q, min, max));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const f = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(f)); }
    }
    json(res, 404, { erro: 'Não encontrado' });
  } catch (e) { json(res, 500, { erro: 'Falha interna' }); }
});

if (require.main === module) server.listen(PORT, () => console.log('Achados Baratos no ar: http://localhost:' + PORT));
module.exports = { server, precos, porLoja, lerProduto, buscarShopee, buscarML, buscarShein };
