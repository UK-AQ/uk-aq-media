#!/usr/bin/env python3
"""Optional Pro fallback: loopback HTTP -> Workspace App-Password SMTP, stdlib only.

Normal AQ in the News delivery uses direct Cloudflare SMTP/XOAUTH2 without this service.
The SQLite journal is a transport receipt cache, not subscriber/editorial authority.
A process crash during DATA is quarantined as unknown on restart. Never log requests.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import smtplib
import sqlite3
import ssl
import time
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_REQUEST = 200_000
FROM = 'news@ukaq.co.uk'
MAX_MIME = 250_000
BRANDING_PATH = Path(__file__).resolve().parents[2] / 'images' / 'news-email-branding.json'
SUBJECTS = {'confirmation': 'Confirm your AQ in the News subscription',
            'immediate': 'AQ in the News: New article', 'daily': 'Your daily AQ in the News update'}


def required(name):
    value = os.environ.get(name, '')
    if not value:
        raise RuntimeError(f'Missing configuration: {name}')
    return value


def crlf(value):
    return re.sub(r'\r\n|\r|\n', '\r\n', value)


def base64_lines(value):
    return '\r\n'.join(re.findall(r'.{1,76}', base64.b64encode(value).decode('ascii')))


def text_part(content_type, value):
    return (f'Content-Type: {content_type}; charset=UTF-8\r\n'
            f'Content-Transfer-Encoding: base64\r\n\r\n'
            f'{base64_lines(crlf(value).encode("utf-8"))}\r\n')


def compose(data):
    if set(data) - {'kind', 'to', 'text', 'html', 'message_id', 'date', 'manage_url', 'unsubscribe_url', 'eligibility'}:
        raise ValueError('unexpected fields')
    kind = data['kind']
    recipient = data['to']
    if kind not in SUBJECTS or not isinstance(recipient, str) or len(recipient) > 254 or not recipient.isascii():
        raise ValueError('invalid message')
    parts = recipient.split('@')
    if len(parts) != 2 or not 1 <= len(parts[0]) <= 64:
        raise ValueError('invalid recipient')
    local, domain = parts
    if (not re.fullmatch(r"[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*", local)
            or not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+', domain)
            or any(len(label) > 63 for label in domain.split('.'))):
        raise ValueError('invalid recipient')
    if not re.fullmatch(r'<news\.[a-f0-9]{64}@ukaq\.co\.uk>', data['message_id']):
        raise ValueError('invalid message id')
    text, html = data['text'], data['html']
    if (not isinstance(text, str) or not text.startswith('AQ in the News\n')
            or not isinstance(html, str) or not html.startswith('<!doctype html>')
            or 'AQ in the News' not in html or len(text.encode()) > 180_000 or len(html.encode()) > 200_000):
        raise ValueError('invalid content')
    date = datetime.fromisoformat(data['date'].replace('Z', '+00:00'))
    if date.tzinfo is None:
        raise ValueError('invalid date')
    alternative = 'news-alt-' + data['message_id'][6:46]
    related = 'news-related-' + data['message_id'][6:46]
    headers = [f'From: UK AQ News <{FROM}>', f'Reply-To: {FROM}',
               f'To: <{recipient}>', f'Subject: {SUBJECTS[kind]}',
               f'Date: {format_datetime(date)}', f'Message-ID: {data["message_id"]}',
               'MIME-Version: 1.0',
               f'Content-Type: multipart/alternative;\r\n boundary="{alternative}"']
    site = required('NEWS_EMAIL_SITE_ORIGIN').rstrip('/')
    if kind != 'confirmation':
        for purpose, field in [('manage', 'manage_url'), ('unsubscribe', 'unsubscribe_url')]:
            link = data[field]
            if not re.fullmatch(re.escape(site) + r'/news-by-email/#' + purpose + r'=[a-f0-9]{64}', link):
                raise ValueError('invalid subscription link')
            if link not in text or f'href="{link}"' not in html:
                raise ValueError('missing visible subscription link')
        token = data['unsubscribe_url'].split('=', 1)[1]
        endpoint = required('NEWS_EMAIL_PUBLIC_API_ORIGIN')
        parsed = urlparse(endpoint)
        if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or any(c.isspace() for c in endpoint)):
            raise ValueError('invalid public API origin')
        headers.extend([f'List-Unsubscribe: <{endpoint}/one-click/{token}>',
                        'List-Unsubscribe-Post: List-Unsubscribe=One-Click'])
    # The same generated, fixed UK AQ assets are bundled by the Worker. Never take
    # attachment bytes, CIDs or filenames from an HTTP caller or publisher article.
    assets = json.loads(BRANDING_PATH.read_text())
    images = []
    for key, filename, cid in (
            ('heading', 'UK-AQ-NEWS-1line-email-w900.png', 'aq-in-the-news@ukaq.co.uk'),
            ('logo', 'UK-AQ-Logo-v3-2Lines-email.png', 'uk-aq-logo@ukaq.co.uk')):
        asset = assets[key]
        content = base64.b64decode(asset['base64'], validate=True)
        if (asset['filename'] != filename or asset['content_id'] != cid or len(content) > 60_000
                or not content.startswith(b'\x89PNG\r\n\x1a\n') or f'src="cid:{cid}"' not in html):
            raise ValueError('invalid branding')
        message_cid = cid.replace('@', '.' + data['message_id'][6:70] + '@')
        html = html.replace(f'cid:{cid}', f'cid:{message_cid}')
        images.append(f'--{related}\r\nContent-Type: image/png\r\n'
                      f'Content-Transfer-Encoding: base64\r\nContent-ID: <{message_cid}>\r\n'
                      f'Content-Disposition: inline;\r\n filename="{filename}"\r\n\r\n'
                      f'{base64_lines(content)}\r\n')
    wire = ('\r\n'.join(headers) + f'\r\n\r\n--{alternative}\r\n'
            + text_part('text/plain', text) + f'--{alternative}\r\n'
            + f'Content-Type: multipart/related; type="text/html";\r\n boundary="{related}"\r\n\r\n'
            + f'--{related}\r\n' + text_part('text/html', html) + ''.join(images)
            + f'--{related}--\r\n--{alternative}--\r\n').encode('ascii')
    if len(wire) > MAX_MIME:
        raise ValueError('message too large')
    return recipient, wire


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def recipient_eligible(eligibility, message_id):
    """Fresh private source, no cached recipient eligibility or cross-environment fallback."""
    if (not isinstance(eligibility, dict) or set(eligibility) - {
            'subscription_id', 'delivery_mode', 'generation', 'confirmed_at', 'mode_since_at',
            'expected_preference_updated_at', 'digest_cursor_at', 'attempt_count'}
            or not isinstance(eligibility.get('subscription_id'), str)
            or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', eligibility['subscription_id'])
            or eligibility.get('delivery_mode') not in SUBJECTS
            or type(eligibility.get('attempt_count')) is not int or eligibility['attempt_count'] < 1
            or any(not isinstance(v, str) or len(v) > 100 for k, v in eligibility.items() if k != 'attempt_count')):
        return False
    origin = required('SUPABASE_URL')
    base = urlparse(origin)
    if (base.scheme != 'https' or not base.hostname or base.username or base.password or base.port
            or base.path not in ('', '/') or base.query or base.fragment):
        raise ValueError('invalid subscription source')
    body = json.dumps({'p_action': 'send_eligible', 'p_data': eligibility}).encode()
    request = Request(origin.rstrip('/') + '/rest/v1/rpc/uk_aq_news_email_service', data=body,
                      headers={'apikey': required('SB_SECRET_KEY'), 'Content-Type': 'application/json',
                               'Content-Profile': 'uk_aq_public', 'Cache-Control': 'no-store'}, method='POST')
    with build_opener(NoRedirect()).open(request, timeout=15) as response:
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError('subscription source unavailable')
        receipt = json.loads(raw)
    if not isinstance(receipt, dict) or type(receipt.get('ok')) is not bool:
        raise ValueError('invalid subscription eligibility')
    if not receipt['ok']:
        return False
    claim = worker_request('/sender/eligibility', {'message_id': message_id,
                                                'attempt_count': eligibility['attempt_count']})
    if claim.get('held') is True:
        raise RuntimeError('retention_fenced')
    if type(claim.get('ok')) is not bool:
        raise ValueError('invalid claim receipt')
    return claim['ok']


def smtp_submit(recipient, wire, eligibility, message_id):
    client = None
    uncertain = False
    try:
        client = smtplib.SMTP('smtp-relay.gmail.com', 587, timeout=20)
        client.ehlo()
        client.starttls(context=ssl.create_default_context())
        client.ehlo()
        client.login(required('GOOGLE_SMTP_USERNAME'), required('GOOGLE_SMTP_APP_PASSWORD'))
        # Check after connection/auth delays, before a new SMTP envelope.
        if not recipient_eligible(eligibility, message_id):
            return 'cancelled'
        # Explicit envelope stages separate definite pre-DATA failures from ambiguity.
        code, _ = client.mail(FROM)
        if code != 250:
            return 'temporary_failure' if 400 <= code < 500 else 'permanent_failure'
        code, _ = client.rcpt(recipient)
        if code not in (250, 251):
            return 'temporary_failure' if 400 <= code < 500 else 'permanent_failure'
        client.putcmd('data')
        code, _ = client.getreply()
        if code != 354:
            return 'temporary_failure' if 400 <= code < 500 else 'permanent_failure'
        # The Worker and this optional sender do not share a transaction with Supabase.
        if not recipient_eligible(eligibility, message_id):
            return 'cancelled'
        # A disconnect from this point may hide Google's final acceptance response.
        uncertain = True
        wire = re.sub(br'(?m)^\.', b'..', wire)
        if not wire.endswith(b'\r\n'):
            wire += b'\r\n'
        client.send(wire + b'.\r\n')
        code, _ = client.getreply()
        if 200 <= code < 300:
            return 'accepted'
        return 'temporary_failure' if 400 <= code < 500 else 'permanent_failure'
    except smtplib.SMTPResponseException as error:
        return 'temporary_failure' if 400 <= error.smtp_code < 500 else 'permanent_failure'
    except (OSError, smtplib.SMTPException, ValueError, RuntimeError):
        return 'unknown' if uncertain else 'temporary_failure'
    finally:
        if client is not None:
            # Failure on QUIT must never overwrite an already received acceptance.
            client.close()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def worker_request(path, data):
    origin = required('NEWS_EMAIL_PUBLIC_API_ORIGIN')
    base = urlparse(origin)
    if (base.scheme != 'https' or not base.hostname or base.username or base.password or base.port
            or base.path not in ('', '/') or base.query or base.fragment):
        raise ValueError('invalid Worker origin')
    request = Request(origin.rstrip('/') + path, data=json.dumps(data).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + required('NEWS_EMAIL_SENDER_SECRET'),
                               'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
    with build_opener(NoRedirect()).open(request, timeout=15) as response:
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError('Worker unavailable')
        result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError('invalid Worker response')
    return result


class RetentionServer(HTTPServer):
    next_retention = 0

    def service_actions(self):
        if time.monotonic() < self.next_retention:
            return
        self.next_retention = time.monotonic() + 300
        db = self.receipts
        checked = utc_now()
        counts = {'eligible': 0, 'deleted': 0, 'held': 0}
        try:
            # Legacy receipt end times were not recorded. Start one conservative thirty-day window.
            db.execute('UPDATE receipts SET recorded_at=? WHERE message_id IN '
                       '(SELECT message_id FROM receipts WHERE recorded_at IS NULL LIMIT 5)', (checked,))
            cursor = db.execute('SELECT after_at,after_id FROM retention_status WHERE singleton=1').fetchone()
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=720)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            rows = db.execute('SELECT message_id,recorded_at FROM receipts WHERE recorded_at<=? '
                              'AND (recorded_at,message_id)>(?,?) ORDER BY recorded_at,message_id LIMIT 5',
                              (cutoff, cursor[0] or '', cursor[1] or '')).fetchall()
            counts['eligible'] = len(rows)
            if rows:
                result = worker_request('/sender/retention', {'message_ids': [row[0] for row in rows]})
                items = result.get('items')
                if (not isinstance(items, list) or len(items) != len(rows)
                        or any(not isinstance(item, dict) or type(item.get('retire')) is not bool for item in items)
                        or [item.get('message_id') for item in items] != [row[0] for row in rows]):
                    raise ValueError('invalid retention receipt')
                for row, item in zip(rows, items):
                    if item['retire']:
                        counts['deleted'] += db.execute('DELETE FROM receipts WHERE message_id=? AND recorded_at=?', row).rowcount
                    else:
                        counts['held'] += 1
            after_at, after_id = (rows[-1][1], rows[-1][0]) if len(rows) == 5 else ('', '')
            db.execute('UPDATE retention_status SET after_at=?,after_id=?,last_at=?,last_success_at=?,state=?, '
                       'eligible=?,deleted=?,held=? WHERE singleton=1',
                       (after_at, after_id, checked, checked, 'held' if counts['held'] else 'ok',
                        counts['eligible'], counts['deleted'], counts['held']))
            db.commit()
            print(json.dumps({'event': 'news_pro_retention', **counts}), flush=True)
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            db.rollback()
            db.execute("UPDATE retention_status SET last_at=?,state='error' WHERE singleton=1", (checked,))
            db.commit()
            print(json.dumps({'event': 'news_pro_retention_failed', 'code': 'authority_unavailable'}), flush=True)


class Sender(BaseHTTPRequestHandler):
    server_version = 'UKAQNews'
    sys_version = ''

    def log_message(self, *_args):
        pass  # No access logs, bearer tokens, body, recipient or URLs.

    def respond(self, code, result):
        body = json.dumps(result).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ('/send', '/receipt', '/retention/status'):
            self.respond(404, {'error': 'not_found'})
            return
        actual = self.headers.get('Authorization', '')
        if len(actual) > 4096 or not hmac.compare_digest(actual, 'Bearer ' + required('NEWS_EMAIL_SENDER_SECRET')):
            self.respond(401, {'error': 'unauthorized'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_REQUEST or self.headers.get('Transfer-Encoding'):
                self.respond(413, {'error': 'invalid_size'})
                return
            self.connection.settimeout(10)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete body')
            data = json.loads(raw)
            if self.path == '/retention/status':
                row = self.server.receipts.execute('SELECT last_at,last_success_at,state,eligible,deleted,held FROM retention_status WHERE singleton=1').fetchone()
                self.respond(200, dict(zip(('last_at','last_success_at','state','eligible','deleted','held'), row)))
                return
            if self.path == '/receipt':
                mid = data.get('message_id', '')
                if not re.fullmatch(r'<news\.[a-f0-9]{64}@ukaq\.co\.uk>', mid):
                    raise ValueError('invalid message id')
                receipt = self.server.receipts.execute('SELECT outcome FROM receipts WHERE message_id=?', (mid,)).fetchone()
                self.respond(200, {'outcome': receipt[0] if receipt else 'not_found'})
                return
            recipient, wire = compose(data)
            if not isinstance(data.get('eligibility'), dict):
                raise ValueError('invalid eligibility')
            attempt = data['eligibility'].get('attempt_count')
            if type(attempt) is not int or attempt < 1:
                raise ValueError('invalid attempt')
        except (ValueError, KeyError, TypeError, OSError):
            self.respond(400, {'error': 'invalid_news_message'})
            return
        mid = data['message_id']
        fingerprint = hashlib.sha256(raw).hexdigest()
        db = self.server.receipts
        receipt = db.execute('SELECT fingerprint,outcome,attempt_count FROM receipts WHERE message_id=?', (mid,)).fetchone()
        if receipt:
            same_content = receipt[0] == fingerprint
            if not same_content and receipt[2] is not None:
                previous = {**data, 'eligibility': {**data['eligibility'], 'attempt_count': receipt[2]}}
                previous_raw = json.dumps(previous, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                same_content = hashlib.sha256(previous_raw).hexdigest() == receipt[0]
            if not same_content and receipt[1] != 'temporary_failure':
                self.respond(409, {'error': 'message_identity_conflict'})
                return
            retry_authorised = receipt[1] == 'permanent_failure' and receipt[2] is not None and attempt > receipt[2]
            if receipt[1] != 'temporary_failure' and not retry_authorised:
                self.respond(200, {'outcome': receipt[1]})
                return
        # Reject delayed/stale attempts before touching a newer receipt. A failed
        # authority read cannot poison its journal with unknown/cancelled state.
        try:
            if not recipient_eligible(data['eligibility'], mid):
                self.respond(200, {'outcome': 'cancelled'})
                return
        except (OSError, ValueError, RuntimeError):
            self.respond(200, {'outcome': 'temporary_failure'})
            return
        db.execute("INSERT INTO receipts(message_id,fingerprint,outcome,recorded_at,attempt_count) VALUES (?,?,'unknown',?,?) "
                   "ON CONFLICT(message_id) DO UPDATE SET outcome='unknown',fingerprint=excluded.fingerprint,"
                   "recorded_at=excluded.recorded_at,attempt_count=excluded.attempt_count",
                   (mid, fingerprint, utc_now(), attempt))
        db.commit()  # Durable before SMTP. Any crash requires reconciliation.
        outcome = smtp_submit(recipient, wire, data.get('eligibility'), mid)
        db.execute('UPDATE receipts SET outcome=?,recorded_at=? WHERE message_id=?', (outcome, utc_now(), mid))
        db.commit()
        self.respond(200, {'outcome': outcome})


def main():
    for name in ('GOOGLE_SMTP_USERNAME', 'GOOGLE_SMTP_APP_PASSWORD', 'NEWS_EMAIL_SENDER_SECRET',
                 'NEWS_EMAIL_SITE_ORIGIN', 'NEWS_EMAIL_PUBLIC_API_ORIGIN', 'SUPABASE_URL', 'SB_SECRET_KEY'):
        required(name)
    if len(required('NEWS_EMAIL_SENDER_SECRET')) < 32:
        raise RuntimeError('NEWS_EMAIL_SENDER_SECRET must contain at least 32 characters')
    os.umask(0o077)
    path = Path(required('NEWS_EMAIL_RECEIPTS_PATH')).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS receipts (message_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL)')
    db.commit()
    if 'recorded_at' not in {row[1] for row in db.execute('PRAGMA table_info(receipts)')}:
        db.execute('ALTER TABLE receipts ADD COLUMN recorded_at TEXT')
    if 'attempt_count' not in {row[1] for row in db.execute('PRAGMA table_info(receipts)')}:
        db.execute('ALTER TABLE receipts ADD COLUMN attempt_count INTEGER')
    db.execute('CREATE INDEX IF NOT EXISTS receipt_retention ON receipts(recorded_at,message_id)')
    db.execute("CREATE TABLE IF NOT EXISTS retention_status (singleton INTEGER PRIMARY KEY CHECK(singleton=1), "
               "after_at TEXT,after_id TEXT,last_at TEXT,last_success_at TEXT,state TEXT NOT NULL DEFAULT 'not_run', "
               "eligible INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,held INTEGER NOT NULL DEFAULT 0)")
    db.execute('INSERT OR IGNORE INTO retention_status(singleton) VALUES(1)')
    db.commit()
    server = RetentionServer(('127.0.0.1', int(os.environ.get('NEWS_EMAIL_PORT', '8025'))), Sender)
    server.receipts = db
    server.serve_forever()


if __name__ == '__main__':
    main()
