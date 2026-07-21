from __future__ import annotations

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.getenv(name, '').strip()
    if not value:
        raise RuntimeError(f'{name} is required')
    return value


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f'{name} must be an integer') from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f'{name} must be between {minimum} and {maximum}')
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    internal_secret: str
    neo4j_uri: str
    neo4j_user: str
    neo4j_password: str
    neo4j_database: str
    openai_api_key: str
    openai_base_url: str | None
    llm_model: str
    small_model: str
    embedding_model: str
    reranker_model: str
    max_body_bytes: int = 65_536
    auth_max_skew_seconds: int = 60
    max_coroutines: int = 4

    def __post_init__(self) -> None:
        if len(self.internal_secret.encode()) < 32:
            raise RuntimeError('MEMORY_INTERNAL_SECRET must contain at least 32 bytes')
        if not self.neo4j_database.replace('-', '').replace('_', '').isalnum():
            raise RuntimeError('NEO4J_DATABASE contains unsupported characters')

    @classmethod
    def from_env(cls) -> Settings:
        base_url = os.getenv('GRAPHITI_OPENAI_BASE_URL', '').strip() or None
        return cls(
            internal_secret=_required('MEMORY_INTERNAL_SECRET'),
            neo4j_uri=_required('NEO4J_URI'),
            neo4j_user=_required('NEO4J_USER'),
            neo4j_password=_required('NEO4J_PASSWORD'),
            neo4j_database=os.getenv('NEO4J_DATABASE', 'neo4j').strip() or 'neo4j',
            openai_api_key=_required('GRAPHITI_OPENAI_API_KEY'),
            openai_base_url=base_url,
            llm_model=_required('GRAPHITI_LLM_MODEL'),
            small_model=_required('GRAPHITI_SMALL_MODEL'),
            embedding_model=_required('GRAPHITI_EMBEDDING_MODEL'),
            reranker_model=_required('GRAPHITI_RERANKER_MODEL'),
            max_body_bytes=_integer('MEMORY_MAX_BODY_BYTES', 65_536, 1_024, 1_048_576),
            auth_max_skew_seconds=_integer('MEMORY_AUTH_MAX_SKEW_SECONDS', 60, 10, 300),
            max_coroutines=_integer('GRAPHITI_MAX_COROUTINES', 4, 1, 32),
        )
