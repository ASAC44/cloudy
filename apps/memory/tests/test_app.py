from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from cloudy_memory.app import create_app
from cloudy_memory.schemas import (
    EpisodeRequest,
    RebuildRequest,
    SearchEvidence,
    SearchRequest,
    TripletRequest,
)
from cloudy_memory.settings import Settings

SECRET = 'test-secret-that-is-longer-than-thirty-two-bytes'


class FakeBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, UUID]] = []
        self.ready_error: Exception | None = None

    async def ready(self) -> None:
        if self.ready_error:
            raise self.ready_error

    async def close(self) -> None:
        return None

    async def add_episode(self, request: EpisodeRequest) -> list[str]:
        self.calls.append(('episode', request.owner_id))
        return [str(request.episode_id)]

    async def add_triplet(self, request: TripletRequest) -> list[str]:
        self.calls.append(('triplet', request.owner_id))
        return ['source', 'target', 'edge']

    async def search_action(self, request: SearchRequest) -> list[SearchEvidence]:
        self.calls.append(('search_action', request.owner_id))
        return [
            SearchEvidence(
                evidence_id='edge-1',
                relationship='RESPONSIBLE_FOR',
                fact='Anne is responsible for production incidents.',
                source_node_id='person-1',
                target_node_id='service-1',
                confidence=0.9,
            )
        ]

    async def search_voice(self, request: SearchRequest) -> list[SearchEvidence]:
        self.calls.append(('search_voice', request.owner_id))
        return []

    async def delete_user(self, owner_id: UUID) -> None:
        self.calls.append(('delete', owner_id))

    async def rebuild_user(self, owner_id: UUID, request: RebuildRequest) -> tuple[int, int]:
        self.calls.append(('rebuild', owner_id))
        if any(item.owner_id != owner_id for item in [*request.episodes, *request.triplets]):
            raise ValueError('owner mismatch')
        return len(request.episodes), len(request.triplets)


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        'internal_secret': SECRET,
        'neo4j_uri': 'bolt://neo4j:7687',
        'neo4j_user': 'neo4j',
        'neo4j_password': 'password',
        'neo4j_database': 'neo4j',
        'openai_api_key': 'test-key',
        'openai_base_url': None,
        'llm_model': 'test-large',
        'small_model': 'test-small',
        'embedding_model': 'test-embedding',
        'reranker_model': 'test-reranker',
    }
    values.update(overrides)
    return Settings(**values)


def signed_headers(
    method: str,
    target: str,
    body: bytes,
    *,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> dict[str, str]:
    timestamp = timestamp or str(int(time.time()))
    nonce = nonce or f'nonce_{uuid4().hex}'
    canonical = '\n'.join(
        [timestamp, nonce, method.upper(), target, hashlib.sha256(body).hexdigest()]
    ).encode()
    signature = hmac.new(SECRET.encode(), canonical, hashlib.sha256).hexdigest()
    return {
        'content-type': 'application/json',
        'x-cloudy-timestamp': timestamp,
        'x-cloudy-nonce': nonce,
        'x-cloudy-signature': f'v1={signature}',
    }


def post(client: TestClient, path: str, payload: dict[str, Any], *, nonce: str | None = None):
    body = json.dumps(payload, separators=(',', ':')).encode()
    return client.post(path, content=body, headers=signed_headers('POST', path, body, nonce=nonce))


def test_health_is_public_but_internal_routes_require_hmac() -> None:
    backend = FakeBackend()
    with TestClient(create_app(settings(), backend)) as client:
        assert client.get('/health').json() == {'status': 'ok'}
        assert client.get('/ready').json() == {'status': 'ready'}
        response = client.post('/internal/v1/search/action', json={})
    assert response.status_code == 401
    assert backend.calls == []


def test_signed_search_is_owner_scoped_and_replay_is_rejected() -> None:
    owner_id = uuid4()
    payload = {'owner_id': str(owner_id), 'query': 'Who handles production incidents?', 'limit': 5}
    body = json.dumps(payload, separators=(',', ':')).encode()
    nonce = f'nonce_{uuid4().hex}'
    headers = signed_headers('POST', '/internal/v1/search/action', body, nonce=nonce)
    backend = FakeBackend()
    with TestClient(create_app(settings(), backend)) as client:
        response = client.post('/internal/v1/search/action', content=body, headers=headers)
        replay = client.post('/internal/v1/search/action', content=body, headers=headers)
    assert response.status_code == 200
    assert response.json()['evidence'][0]['evidence_id'] == 'edge-1'
    assert replay.status_code == 401
    assert backend.calls == [('search_action', owner_id)]


def test_signature_binds_method_path_and_body() -> None:
    owner_id = uuid4()
    payload = {'owner_id': str(owner_id), 'query': 'voice', 'limit': 5}
    body = json.dumps(payload, separators=(',', ':')).encode()
    headers = signed_headers('POST', '/internal/v1/search/action', body)
    backend = FakeBackend()
    with TestClient(create_app(settings(), backend)) as client:
        response = client.post('/internal/v1/search/voice', content=body, headers=headers)
    assert response.status_code == 401
    assert backend.calls == []


def test_stale_signature_is_rejected() -> None:
    payload = {'owner_id': str(uuid4()), 'query': 'voice', 'limit': 5}
    body = json.dumps(payload, separators=(',', ':')).encode()
    path = '/internal/v1/search/voice'
    headers = signed_headers('POST', path, body, timestamp=str(int(time.time()) - 61))
    backend = FakeBackend()
    with TestClient(create_app(settings(), backend)) as client:
        response = client.post(path, content=body, headers=headers)
    assert response.status_code == 401
    assert backend.calls == []


def test_request_limit_is_enforced_before_json_parsing() -> None:
    backend = FakeBackend()
    body = b'{' + b'x' * 1_100 + b'}'
    path = '/internal/v1/search/action'
    with TestClient(create_app(settings(max_body_bytes=1_024), backend)) as client:
        response = client.post(path, content=body, headers=signed_headers('POST', path, body))
    assert response.status_code == 413
    assert backend.calls == []


def test_rebuild_rejects_items_owned_by_another_user() -> None:
    owner_id = uuid4()
    other_owner = uuid4()
    episode_id = uuid4()
    payload = {
        'episodes': [
            {
                'owner_id': str(other_owner),
                'episode_id': str(episode_id),
                'source_description': 'approval ledger',
                'reference_time': '2026-07-22T00:00:00Z',
                'facts': [
                    {
                        'canonical_ref': 'decision:1:action',
                        'subject': {
                            'canonical_ref': 'decision:1',
                            'kind': 'Decision',
                            'name': 'Approved communication decision',
                            'provenance_type': 'approval',
                            'confidence': 1,
                            'outcome': 'approved',
                        },
                        'predicate': 'CHOSE_ACTION',
                        'object': {
                            'canonical_ref': 'communication:1',
                            'kind': 'CommunicationEvent',
                            'name': 'Contact Anne by Gmail',
                            'provenance_type': 'approval',
                            'confidence': 1,
                            'channel': 'gmail',
                            'outcome': 'intent_only',
                        },
                        'provenance_type': 'approval',
                        'confidence': 1,
                    }
                ],
            }
        ]
    }
    path = f'/internal/v1/users/{owner_id}/rebuild'
    backend = FakeBackend()
    with TestClient(create_app(settings(), backend)) as client:
        response = post(client, path, payload)
    assert response.status_code == 422
    assert backend.calls == [('rebuild', owner_id)]
