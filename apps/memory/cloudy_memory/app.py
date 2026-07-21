from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .auth import HmacAuthMiddleware
from .backend import GraphitiBackend, MemoryBackend
from .schemas import (
    DeleteResponse,
    EpisodeRequest,
    RebuildRequest,
    RebuildResponse,
    SearchRequest,
    SearchResponse,
    TripletRequest,
    WriteResponse,
)
from .settings import Settings

logger = logging.getLogger('cloudy.memory')


def create_app(settings: Settings, backend: MemoryBackend | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        instance = backend or await GraphitiBackend.create(settings)
        app.state.backend = instance
        try:
            yield
        finally:
            if backend is None:
                await instance.close()

    application = FastAPI(
        title='Cloudy memory',
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    application.add_middleware(
        HmacAuthMiddleware,
        secret=settings.internal_secret,
        max_body_bytes=settings.max_body_bytes,
        max_skew_seconds=settings.auth_max_skew_seconds,
    )

    @application.exception_handler(ValueError)
    async def invalid_input(_: Request, error: ValueError) -> JSONResponse:
        logger.info('memory_request_rejected type=%s', type(error).__name__)
        return JSONResponse(status_code=422, content={'error': 'invalid_memory_request'})

    @application.exception_handler(Exception)
    async def internal_error(_: Request, error: Exception) -> JSONResponse:
        logger.error('memory_request_failed type=%s', type(error).__name__)
        return JSONResponse(status_code=503, content={'error': 'memory_unavailable'})

    @application.get('/health')
    async def health() -> dict[str, str]:
        return {'status': 'ok'}

    @application.get('/ready')
    async def ready(request: Request) -> dict[str, str]:
        try:
            await _backend(request).ready()
        except Exception as error:
            raise HTTPException(status_code=503, detail='memory_unavailable') from error
        return {'status': 'ready'}

    @application.post('/internal/v1/episodes', response_model=WriteResponse)
    async def add_episode(payload: EpisodeRequest, request: Request) -> WriteResponse:
        started = time.monotonic()
        graph_ids = await _backend(request).add_episode(payload)
        _log_success('episode', payload.owner_id, started, len(graph_ids))
        return WriteResponse(graph_ids=graph_ids)

    @application.post('/internal/v1/triplets', response_model=WriteResponse)
    async def add_triplet(payload: TripletRequest, request: Request) -> WriteResponse:
        started = time.monotonic()
        graph_ids = await _backend(request).add_triplet(payload)
        _log_success('triplet', payload.owner_id, started, len(graph_ids))
        return WriteResponse(graph_ids=graph_ids)

    @application.post('/internal/v1/search/action', response_model=SearchResponse)
    async def search_action(payload: SearchRequest, request: Request) -> SearchResponse:
        started = time.monotonic()
        evidence = await _backend(request).search_action(payload)
        _log_success('search_action', payload.owner_id, started, len(evidence))
        return SearchResponse(evidence=evidence)

    @application.post('/internal/v1/search/voice', response_model=SearchResponse)
    async def search_voice(payload: SearchRequest, request: Request) -> SearchResponse:
        started = time.monotonic()
        evidence = await _backend(request).search_voice(payload)
        _log_success('search_voice', payload.owner_id, started, len(evidence))
        return SearchResponse(evidence=evidence)

    @application.delete('/internal/v1/users/{owner_id}', response_model=DeleteResponse)
    async def delete_user(owner_id: UUID, request: Request) -> DeleteResponse:
        started = time.monotonic()
        await _backend(request).delete_user(owner_id)
        _log_success('delete_user', owner_id, started, 0)
        return DeleteResponse(deleted=True)

    @application.post('/internal/v1/users/{owner_id}/rebuild', response_model=RebuildResponse)
    async def rebuild_user(
        owner_id: UUID, payload: RebuildRequest, request: Request
    ) -> RebuildResponse:
        started = time.monotonic()
        episodes, triplets = await _backend(request).rebuild_user(owner_id, payload)
        _log_success('rebuild_user', owner_id, started, episodes + triplets)
        return RebuildResponse(episodes=episodes, triplets=triplets)

    return application


def _backend(request: Request) -> MemoryBackend:
    return request.app.state.backend


def _log_success(operation: str, owner_id: UUID, started: float, count: int) -> None:
    logger.info(
        'memory_operation operation=%s owner_id=%s duration_ms=%d count=%d',
        operation,
        owner_id,
        round((time.monotonic() - started) * 1_000),
        count,
    )


def configured_app() -> FastAPI:
    return create_app(Settings.from_env())
