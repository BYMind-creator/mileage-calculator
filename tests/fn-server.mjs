// 本機跑真的 Cloudflare Pages Functions 程式（/t/、/i/），SUPABASE_URL 指向 shim
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const ROOT = process.argv[2], PORT = +process.argv[3], SUPA = process.argv[4];
const t = await import(pathToFileURL(`${ROOT}/functions/t/[id].js`).href);
const i = await import(pathToFileURL(`${ROOT}/functions/i/[id].js`).href);
const env = { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'test-anon-key' };
http.createServer(async (req, res) => {
  const m = /^\/(t|i)\/([^/?#]+)/.exec(req.url);
  if (!m) { res.writeHead(404); return res.end(); }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const request = new Request(`http://${host}${req.url}`, { method: req.method, headers: { 'user-agent': req.headers['user-agent'] || '' } });
  const r = await (m[1] === 't' ? t : i).onRequest({ request, env, params: { id: decodeURIComponent(m[2]) } });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, '127.0.0.1');
