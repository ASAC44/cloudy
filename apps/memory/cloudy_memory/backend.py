from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Protocol, cast
from uuid import UUID, uuid5

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import (
    OpenAIRerankerClient,
)
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client import LLMConfig, OpenAIClient
from graphiti_core.nodes import EntityNode, EpisodeType
from graphiti_core.search.search_filters import SearchFilters
from graphiti_core.utils.maintenance.graph_data_operations import clear_data

from .locks import OwnerLockPool
from .ontology import EDGE_TYPE_MAP, EDGE_TYPES, ENTITY_TYPES
from .schemas import (
    EntityInput,
    EpisodeRequest,
    RebuildRequest,
    RelationshipInput,
    SearchEvidence,
    SearchRequest,
    TripletRequest,
)
from .settings import Settings

GRAPH_UUID_NAMESPACE = UUID('9cc95f4d-1be0-4ca7-a6c6-77d09b031cf8')
ACTION_EDGE_TYPES = [
    'RESPONSIBLE_FOR',
    'PREFERS_CHANNEL',
    'CHOSE_ACTION',
    'REJECTED_ACTION',
    'CONTACTED_VIA',
]
VOICE_EDGE_TYPES = ['USES_LANGUAGE_WITH', 'CONTACTED_VIA', 'ABOUT']


def owner_group(owner_id: UUID) -> str:
    return f'owner_{owner_id.hex}'


class MemoryBackend(Protocol):
    async def ready(self) -> None: ...
    async def close(self) -> None: ...
    async def add_episode(self, request: EpisodeRequest) -> list[str]: ...
    async def add_triplet(self, request: TripletRequest) -> list[str]: ...
    async def search_action(self, request: SearchRequest) -> list[SearchEvidence]: ...
    async def search_voice(self, request: SearchRequest) -> list[SearchEvidence]: ...
    async def delete_user(self, owner_id: UUID) -> None: ...
    async def rebuild_user(self, owner_id: UUID, request: RebuildRequest) -> tuple[int, int]: ...


class GraphitiBackend:
    def __init__(self, graph: Graphiti) -> None:
        self.graph = graph
        self.locks = OwnerLockPool()

    @classmethod
    async def create(cls, settings: Settings) -> GraphitiBackend:
        llm_config = LLMConfig(
            api_key=settings.openai_api_key,
            model=settings.llm_model,
            small_model=settings.small_model,
            base_url=settings.openai_base_url,
            temperature=0,
        )
        driver = Neo4jDriver(
            settings.neo4j_uri,
            settings.neo4j_user,
            settings.neo4j_password,
            database=settings.neo4j_database,
        )
        graph = Graphiti(
            graph_driver=driver,
            llm_client=OpenAIClient(config=llm_config),
            embedder=OpenAIEmbedder(
                config=OpenAIEmbedderConfig(
                    api_key=settings.openai_api_key,
                    base_url=settings.openai_base_url,
                    embedding_model=settings.embedding_model,
                )
            ),
            cross_encoder=OpenAIRerankerClient(
                config=LLMConfig(
                    api_key=settings.openai_api_key,
                    base_url=settings.openai_base_url,
                    model=settings.reranker_model,
                    small_model=settings.reranker_model,
                )
            ),
            store_raw_episode_content=False,
            max_coroutines=settings.max_coroutines,
        )
        backend = cls(graph)
        try:
            await backend.ready()
            await graph.build_indices_and_constraints()
        except BaseException:
            await graph.close()
            raise
        return backend

    async def ready(self) -> None:
        await cast(Neo4jDriver, self.graph.driver).health_check()

    async def close(self) -> None:
        await self.graph.close()

    async def add_episode(self, request: EpisodeRequest) -> list[str]:
        self._validate_episode(request)
        async with self.locks.hold(str(request.owner_id)):
            return await self._add_episode(request)

    async def _add_episode(self, request: EpisodeRequest) -> list[str]:
        graph_name = f'cloudy_episode_{request.episode_id.hex}'
        driver = cast(Neo4jDriver, self.graph.driver)
        existing, _, _ = await driver.execute_query(
            """
            MATCH (episode:Episodic {group_id: $group_id, name: $name})
            RETURN episode.uuid AS uuid
            LIMIT 1
            """,
            group_id=owner_group(request.owner_id),
            name=graph_name,
            routing_='r',
        )
        if existing:
            episode_uuid = existing[0]['uuid']
            related = await self.graph.get_nodes_and_edges_by_episode([episode_uuid])
            return [
                episode_uuid,
                *[node.uuid for node in related.nodes],
                *[edge.uuid for edge in related.edges],
            ]

        result = await self.graph.add_episode(
            name=graph_name,
            episode_body=json.dumps(
                {
                    'ontology_version': request.ontology_version,
                    'facts': [fact.model_dump() for fact in request.facts],
                },
                separators=(',', ':'),
            ),
            source=EpisodeType.json,
            source_description=request.source_description,
            reference_time=request.reference_time,
            group_id=owner_group(request.owner_id),
            entity_types=ENTITY_TYPES,
            edge_types=EDGE_TYPES,
            edge_type_map=EDGE_TYPE_MAP,
            custom_extraction_instructions=(
                'Use only the supplied facts. Preserve canonical_ref and provenance fields. '
                'Never infer or merge channel identities, people, or organizations.'
            ),
        )
        return [
            result.episode.uuid,
            *[node.uuid for node in result.nodes],
            *[edge.uuid for edge in result.edges],
        ]

    async def add_triplet(self, request: TripletRequest) -> list[str]:
        self._validate_triplet(request)
        async with self.locks.hold(str(request.owner_id)):
            return await self._add_triplet(request)

    async def _add_triplet(self, request: TripletRequest) -> list[str]:
        group_id = owner_group(request.owner_id)
        source = self._entity_node(group_id, request.source)
        target = self._entity_node(group_id, request.target)
        relationship = self._entity_edge(group_id, source, target, request.relationship)
        await asyncio.gather(
            source.generate_name_embedding(self.graph.embedder),
            target.generate_name_embedding(self.graph.embedder),
            relationship.generate_embedding(self.graph.embedder),
        )
        driver = cast(Neo4jDriver, self.graph.driver)
        async with driver.transaction() as transaction:
            await driver.entity_node_ops.save(driver, source, transaction)
            if target.uuid != source.uuid:
                await driver.entity_node_ops.save(driver, target, transaction)
            await driver.entity_edge_ops.save(driver, relationship, transaction)
        return [source.uuid, target.uuid, relationship.uuid]

    async def search_action(self, request: SearchRequest) -> list[SearchEvidence]:
        return await self._search(request, ACTION_EDGE_TYPES)

    async def search_voice(self, request: SearchRequest) -> list[SearchEvidence]:
        return await self._search(request, VOICE_EDGE_TYPES)

    async def _search(self, request: SearchRequest, edge_types: list[str]) -> list[SearchEvidence]:
        group_id = owner_group(request.owner_id)
        async with self.locks.hold(str(request.owner_id)):
            edges = await self.graph.search(
                request.query,
                group_ids=[group_id],
                num_results=request.limit,
                search_filter=SearchFilters(edge_types=edge_types),
            )
        return [self._evidence(edge) for edge in edges if edge.group_id == group_id]

    async def delete_user(self, owner_id: UUID) -> None:
        async with self.locks.hold(str(owner_id)):
            await clear_data(self.graph.driver, group_ids=[owner_group(owner_id)])

    async def rebuild_user(self, owner_id: UUID, request: RebuildRequest) -> tuple[int, int]:
        if any(item.owner_id != owner_id for item in [*request.episodes, *request.triplets]):
            raise ValueError('rebuild owner does not match an item owner')
        async with self.locks.hold(str(owner_id)):
            await clear_data(self.graph.driver, group_ids=[owner_group(owner_id)])
            for episode in sorted(
                request.episodes, key=lambda item: (item.reference_time, str(item.episode_id))
            ):
                self._validate_episode(episode)
                await self._add_episode(episode)
            for triplet in sorted(
                request.triplets, key=lambda item: item.relationship.canonical_ref
            ):
                self._validate_triplet(triplet)
                await self._add_triplet(triplet)
        return len(request.episodes), len(request.triplets)

    @staticmethod
    def _validate_episode(request: EpisodeRequest) -> None:
        for fact in request.facts:
            if fact.subject.kind in ('Person', 'ChannelIdentity') or fact.object.kind in (
                'Person',
                'ChannelIdentity',
            ):
                raise ValueError('people and identities require deterministic triplets')
            allowed = EDGE_TYPE_MAP.get((fact.subject.kind, fact.object.kind), [])
            if fact.predicate not in allowed:
                raise ValueError('episode relationship is not allowed between these entity types')

    @staticmethod
    def _validate_triplet(request: TripletRequest) -> None:
        allowed = EDGE_TYPE_MAP.get((request.source.kind, request.target.kind), [])
        if request.relationship.kind not in allowed:
            raise ValueError('relationship is not allowed between these entity types')

    @staticmethod
    def _entity_node(group_id: str, entity: EntityInput) -> EntityNode:
        canonical = f'{group_id}:entity:{entity.kind}:{entity.canonical_ref}'
        return EntityNode(
            uuid=str(uuid5(GRAPH_UUID_NAMESPACE, canonical)),
            name=entity.name,
            group_id=group_id,
            labels=[entity.kind],
            attributes={
                **entity.attributes,
                'canonical_ref': entity.canonical_ref,
                'provenance_type': entity.provenance_type,
                'confidence': entity.confidence,
                'ontology_version': 1,
            },
        )

    @staticmethod
    def _entity_edge(
        group_id: str,
        source: EntityNode,
        target: EntityNode,
        relationship: RelationshipInput,
    ) -> EntityEdge:
        canonical = f'{group_id}:edge:{relationship.kind}:{relationship.canonical_ref}'
        return EntityEdge(
            uuid=str(uuid5(GRAPH_UUID_NAMESPACE, canonical)),
            group_id=group_id,
            source_node_uuid=source.uuid,
            target_node_uuid=target.uuid,
            name=relationship.kind,
            fact=relationship.fact,
            created_at=datetime.now(UTC),
            valid_at=relationship.valid_at,
            invalid_at=relationship.invalid_at,
            attributes={
                'canonical_ref': relationship.canonical_ref,
                'provenance_type': relationship.provenance_type,
                'confidence': relationship.confidence,
                'outcome': relationship.outcome,
                'ontology_version': 1,
            },
        )

    @staticmethod
    def _evidence(edge: EntityEdge) -> SearchEvidence:
        confidence = edge.attributes.get('confidence')
        outcome = edge.attributes.get('outcome')
        return SearchEvidence(
            evidence_id=edge.uuid,
            relationship=edge.name,
            fact=edge.fact,
            source_node_id=edge.source_node_uuid,
            target_node_id=edge.target_node_uuid,
            confidence=float(confidence) if isinstance(confidence, int | float) else None,
            outcome=str(outcome) if isinstance(outcome, str) else None,
            valid_at=edge.valid_at,
            invalid_at=edge.invalid_at,
        )
