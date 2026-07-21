from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

NONCE_PATTERN = re.compile(r'^[A-Za-z0-9_-]{24,128}$')
PUBLIC_PATHS = {'/health', '/ready'}


class ReplayGuard:
    def __init__(self, max_age_seconds: int) -> None:
        self._max_age_seconds = max_age_seconds
        self._seen: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def claim(self, nonce: str, now: int) -> bool:
        async with self._lock:
            cutoff = now - self._max_age_seconds
            self._seen = {
                key: timestamp for key, timestamp in self._seen.items() if timestamp >= cutoff
            }
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
            return True


class HmacAuthMiddleware:
    def __init__(self, app: ASGIApp, *, secret: str, max_body_bytes: int, max_skew_seconds: int):
        self.app = app
        self.secret = secret.encode()
        self.max_body_bytes = max_body_bytes
        self.max_skew_seconds = max_skew_seconds
        self.replays = ReplayGuard(max_skew_seconds)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] != 'http' or scope.get('path') in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get('headers', [])}
        content_length = headers.get(b'content-length')
        if content_length:
            try:
                if int(content_length) > self.max_body_bytes:
                    await self._reject(send, 413, 'request_too_large')
                    return
            except ValueError:
                await self._reject(send, 400, 'invalid_content_length')
                return

        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body.extend(message.get('body', b''))
            if len(body) > self.max_body_bytes:
                await self._reject(send, 413, 'request_too_large')
                return
            more_body = message.get('more_body', False)

        timestamp = self._text_header(headers, b'x-cloudy-timestamp')
        nonce = self._text_header(headers, b'x-cloudy-nonce')
        signature = self._text_header(headers, b'x-cloudy-signature')
        now = int(time.time())
        try:
            signed_at = int(timestamp)
        except (TypeError, ValueError):
            await self._reject(send, 401, 'invalid_signature')
            return
        if abs(now - signed_at) > self.max_skew_seconds or not NONCE_PATTERN.fullmatch(nonce):
            await self._reject(send, 401, 'invalid_signature')
            return

        query = scope.get('query_string', b'')
        target = scope.get('raw_path', scope['path'].encode()) + (b'?' + query if query else b'')
        digest = hashlib.sha256(body).hexdigest()
        canonical = b'\n'.join(
            [timestamp.encode(), nonce.encode(), scope['method'].encode(), target, digest.encode()]
        )
        expected = 'v1=' + hmac.new(self.secret, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected) or not await self.replays.claim(nonce, now):
            await self._reject(send, 401, 'invalid_signature')
            return

        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return {'type': 'http.request', 'body': b'', 'more_body': False}
            delivered = True
            return {'type': 'http.request', 'body': bytes(body), 'more_body': False}

        await self.app(scope, replay, send)

    @staticmethod
    def _text_header(headers: dict[bytes, bytes], name: bytes) -> str:
        try:
            return headers.get(name, b'').decode('ascii')
        except UnicodeDecodeError:
            return ''

    @staticmethod
    async def _reject(send: Send, status: int, code: str) -> None:
        body = json.dumps({'error': code}, separators=(',', ':')).encode()
        await send(
            {
                'type': 'http.response.start',
                'status': status,
                'headers': [
                    (b'content-type', b'application/json'),
                    (b'content-length', str(len(body)).encode()),
                ],
            }
        )
        await send({'type': 'http.response.body', 'body': body})
