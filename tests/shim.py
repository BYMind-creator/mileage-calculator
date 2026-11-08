# 本機測試用：模擬 Supabase 的 PostgREST（RPC、資料表讀取）與 Storage，搭配真的 PostgreSQL 與真的 supabase-js。
# 角色與 JWT claims 跟 Supabase 一樣：每個請求一個交易，set local role + request.jwt.claims。
import base64, json, os, sys, threading, mimetypes, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import psycopg2

WEB = sys.argv[1]; PORT = int(sys.argv[2]); DB = sys.argv[3]
STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'storage'); os.makedirs(STORE, exist_ok=True)
ANON_KEY = 'test-anon-key'
lock = threading.Lock()
conn = psycopg2.connect(host='/tmp', port=55432, user='postgres', dbname=DB)
FN = {}
def load_fns():
    with conn.cursor() as c:
        c.execute("""select p.proname, coalesce(p.proargnames, '{}'), array(select format_type(t, null) from unnest(p.proargtypes) t),
                            p.proretset, format_type(p.prorettype, null)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'""")
        for name, argn, argt, retset, rett in c.fetchall():
            FN[name] = (list(argn)[:len(argt)], list(argt), retset, rett)
    conn.rollback()
load_fns()

def claims_of(h):
    tok = (h.get('Authorization') or '').replace('Bearer ', '')
    if tok == ANON_KEY or tok.count('.') != 2: return 'anon', {'role': 'anon'}
    pl = tok.split('.')[1]; pl += '=' * (-len(pl) % 4)
    cl = json.loads(base64.urlsafe_b64decode(pl))
    return cl.get('role', 'authenticated'), cl

def run(h, sql, args):
    role, cl = claims_of(h)
    with lock:
        try:
            with conn.cursor() as c:
                c.execute('set local role ' + ('authenticated' if role == 'authenticated' else 'anon'))
                c.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(cl),))
                c.execute(sql, args)
                r = c.fetchone() if c.description else None
            conn.commit(); return 200, (r[0] if r else None)
        except psycopg2.Error as e:
            conn.rollback()
            return 400, {'message': (e.diag.message_primary or str(e)), 'code': e.pgcode, 'details': None, 'hint': None}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self): self.send(204, b'')
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); n = int(self.headers.get('Content-Length') or 0); raw = self.rfile.read(n)
        if u.path.startswith('/rest/v1/rpc/'):
            fn = u.path.rsplit('/', 1)[1]
            if fn not in FN: return self.send(404, {'message': 'function not found', 'code': 'PGRST202'})
            names, types, retset, rett = FN[fn]; body = json.loads(raw or b'{}'); parts = []; vals = []
            for k, v in body.items():
                if k not in names: return self.send(404, {'message': f'unknown arg {k}', 'code': 'PGRST202'})
                ty = types[names.index(k)]
                parts.append(f'{k} => %s::{ty}')
                vals.append(None if v is None else (json.dumps(v) if ty in ('jsonb', 'json') else (str(v).lower() if isinstance(v, bool) else str(v))))
            call = f"public.{fn}({', '.join(parts)})"
            if retset: sql = f"select coalesce(json_agg(x), '[]'::json) from {call} x"
            elif rett == 'void': sql = f"select {call}, null::json"; sql = f"select null::json from (select {call}) s"
            else: sql = f"select to_json({call})"
            code, out = run(self.headers, sql, vals)
            return self.send(code, out)
        if u.path.startswith('/storage/v1/object/trip-photos/'):
            rel = urllib.parse.unquote(u.path.split('/storage/v1/object/trip-photos/', 1)[1])
            if '..' in rel: return self.send(400, {'message': 'bad path'})
            p = os.path.join(STORE, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'wb').write(raw); return self.send(200, {'Key': 'trip-photos/' + rel, 'Id': rel})
        if u.path == '/auth/v1/otp':
            open(os.path.join(STORE, 'last_otp.json'), 'wb').write(raw)   # 測試用：記下最後一次送碼的參數（管道、號碼）
            return self.send(200, {})
        if u.path == '/auth/v1/verify':
            # 測試用：驗證碼固定 123456；通過就建立（或沿用）同 Email 的使用者並回傳 session
            import uuid, time
            b = json.loads(raw or b'{}'); email = (b.get('email') or '').lower(); phone = b.get('phone') or ''
            if phone and b.get('type') == 'sms' and b.get('token') == '123456':
                uid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'tel:' + phone))
                with lock:
                    with conn.cursor() as c:
                        c.execute("insert into auth.users (id, email, is_anonymous) values (%s, null, false) on conflict (id) do nothing", (uid,))
                    conn.commit()
                b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
                tok = b64({'alg': 'none', 'typ': 'JWT'}) + '.' + b64({'sub': uid, 'role': 'authenticated', 'phone': phone, 'is_anonymous': False, 'exp': 4102444800}) + '.x'
                now = int(time.time())
                return self.send(200, {'access_token': tok, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': now + 3600, 'refresh_token': 'r',
                                       'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': '', 'phone': phone.lstrip('+'), 'is_anonymous': False,
                                                'app_metadata': {'provider': 'phone'}, 'user_metadata': {}, 'identities': [], 'created_at': '2026-11-08T00:00:00Z'}})
            if b.get('token') != '123456' or not email:
                return self.send(403, {'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'})
            uid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'mailto:' + email))
            with lock:
                with conn.cursor() as c:
                    c.execute("insert into auth.users (id, email, is_anonymous) values (%s, %s, false) on conflict (id) do nothing", (uid, email))
                conn.commit()
            b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
            tok = b64({'alg': 'none', 'typ': 'JWT'}) + '.' + b64({'sub': uid, 'role': 'authenticated', 'email': email, 'is_anonymous': False, 'exp': 4102444800}) + '.x'
            now = int(time.time())
            return self.send(200, {'access_token': tok, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': now + 3600, 'refresh_token': 'r',
                                   'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email, 'is_anonymous': False,
                                            'app_metadata': {'provider': 'email'}, 'user_metadata': {}, 'identities': [], 'created_at': '2026-11-08T00:00:00Z'}})
        if u.path.startswith('/rest/v1/log'): return self.send(204, b'')
        return self.send(404, {'message': 'not found'})
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith('/rest/v1/') and not u.path.startswith('/rest/v1/rpc/'):
            table = u.path.split('/')[3]; q = urllib.parse.parse_qs(u.query); where = []; vals = []
            for k, v in q.items():
                if k in ('select', 'order', 'limit'): continue
                op, _, val = v[0].partition('.')
                if op == 'eq': where.append(f'{k} = %s'); vals.append(val)
            sql = f"select coalesce(json_agg(t), '[]'::json) from public.{table} t" + (' where ' + ' and '.join(where) if where else '')
            code, out = run(self.headers, sql, vals); return self.send(code, out)
        if u.path.startswith('/storage/v1/object/public/trip-photos/'):
            p = os.path.join(STORE, urllib.parse.unquote(u.path.split('/trip-photos/', 1)[1]))
            if os.path.isfile(p): return self.send(200, open(p, 'rb').read(), mimetypes.guess_type(p)[0] or 'application/octet-stream')
            return self.send(404, b'', 'text/plain')
        if u.path.startswith('/realtime/') or u.path.startswith('/auth/'): return self.send(404, {'message': 'not available in test shim'})
        if u.path.startswith('/t/') or u.path.startswith('/i/'):
            req = urllib.request.Request(f'http://127.0.0.1:{PORT + 1}{self.path}', headers={'X-Forwarded-Host': self.headers.get('Host', ''), 'User-Agent': self.headers.get('User-Agent', '')})
            with urllib.request.urlopen(req) as r: return self.send(r.status, r.read(), r.headers.get('Content-Type'))
        path = u.path if u.path != '/' else '/index.html'
        fp404 = os.path.join(WEB, '404.html')
        if path == '/assets/config.js':
            return self.send(200, f"window.TS_CONFIG={{SUPABASE_URL:'http://127.0.0.1:{PORT}',SUPABASE_ANON_KEY:'{ANON_KEY}',EDITOR_PATH:'editor.html',CONTACT_EMAIL:'t@example.com',TURNSTILE_SITE_KEY:'',STATS_DEFAULT_CHECKED:false,AUTH_PROVIDERS:['google','apple','line','sms','email'],LINE_PROVIDER_ID:'custom:line'}};".encode(), 'application/javascript')
        fp = os.path.normpath(os.path.join(WEB, path.lstrip('/')))
        if not fp.startswith(os.path.abspath(WEB)) or not os.path.isfile(fp): return self.send(404, open(fp404, 'rb').read(), 'text/html')
        ct = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        if fp.endswith('.js'): ct = 'application/javascript'
        return self.send(200, open(fp, 'rb').read(), ct)

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
