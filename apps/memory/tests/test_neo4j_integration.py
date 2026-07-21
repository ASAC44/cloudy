from __future__ import annotations

import os
from collections.abc import Iterable
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client import LLMConfig, OpenAIClient
from graphiti_core.nodes import EpisodeType, EpisodicNode

from cloudy_memory.backend import GraphitiBackend, owner_group
from cloudy_memory.schemas import EpisodeRequest, SearchRequest, TripletRequest


class StaticEmbedder(EmbedderClient):
    async def create(
        self,
        input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]],
    ) -> list[float]:
        return [0.01] * 1_024

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [[0.01] * 1_024 for _ in input_data_list]


class StaticReranker(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        return [(passage, 1.0) for passage in passages]


def triplet(owner_id, person: str, service: str) -> TripletRequest:
    return TripletRequest.model_validate(
        {
            'owner_id': str(owner_id),
            'source': {
                'canonical_ref': f'person:{person.lower()}',
                'kind': 'Person',
                'name': person,
                'provenance_type': 'user',
                'confidence': 1,
            },
            'relationship': {
                'canonical_ref': f'responsible:{person.lower()}:{service.lower()}',
                'kind': 'RESPONSIBLE_FOR',
                'fact': f'{person} is responsible for {service}.',
                'provenance_type': 'user',
                'confidence': 1,
            },
            'target': {
                'canonical_ref': f'service:{service.lower()}',
                'kind': 'Service',
                'name': service,
                'provenance_type': 'provider',
                'confidence': 1,
            },
        }
    )


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.skipif(
    os.getenv('CLOUDY_MEMORY_NEO4J_TEST') != '1', reason='local Neo4j integration is opt-in'
)
async def test_triplet_replay_and_user_deletion_are_isolated() -> None:
    driver = Neo4jDriver(
        os.getenv('NEO4J_URI', 'bolt://localhost:7687'),
        os.getenv('NEO4J_USER', 'neo4j'),
        os.getenv('NEO4J_PASSWORD', 'cloudy-local-password'),
    )
    graph = Graphiti(
        graph_driver=driver,
        llm_client=OpenAIClient(config=LLMConfig(api_key='not-used', model='not-used')),
        embedder=StaticEmbedder(),
        cross_encoder=StaticReranker(),
        store_raw_episode_content=False,
    )
    backend = GraphitiBackend(graph)
    first_owner = uuid4()
    second_owner = uuid4()
    try:
        await graph.build_indices_and_constraints()
        await backend.delete_user(first_owner)
        await backend.delete_user(second_owner)

        first_ids = await backend.add_triplet(triplet(first_owner, 'Anne', 'Vercel'))
        replay_ids = await backend.add_triplet(triplet(first_owner, 'Anne', 'Vercel'))
        second_ids = await backend.add_triplet(triplet(second_owner, 'Morgan', 'Vercel'))
        assert first_ids == replay_ids

        first_search = await backend.search_action(
            SearchRequest(owner_id=first_owner, query='Who is responsible for Vercel?', limit=5)
        )
        second_search = await backend.search_action(
            SearchRequest(owner_id=second_owner, query='Who is responsible for Vercel?', limit=5)
        )
        assert [evidence.evidence_id for evidence in first_search] == [first_ids[-1]]
        assert [evidence.evidence_id for evidence in second_search] == [second_ids[-1]]

        episode_id = uuid4()
        episode = EpisodicNode(
            name=f'cloudy_episode_{episode_id.hex}',
            group_id=owner_group(first_owner),
            source=EpisodeType.json,
            source_description='approval ledger',
            content='',
            valid_at=datetime.now(UTC),
        )
        await episode.save(driver)
        episode_request = EpisodeRequest.model_validate(
            {
                'owner_id': str(first_owner),
                'episode_id': str(episode_id),
                'source_description': 'approval ledger',
                'reference_time': '2026-07-22T00:00:00Z',
                'facts': [
                    {
                        'canonical_ref': 'decision:topic',
                        'subject': {
                            'canonical_ref': 'decision:1',
                            'kind': 'Decision',
                            'name': 'Approved communication',
                            'provenance_type': 'approval',
                            'confidence': 1,
                            'outcome': 'approved',
                        },
                        'predicate': 'ABOUT',
                        'object': {
                            'canonical_ref': 'topic:incident',
                            'kind': 'Topic',
                            'name': 'Production incident',
                            'provenance_type': 'provider',
                            'confidence': 1,
                        },
                        'provenance_type': 'approval',
                        'confidence': 1,
                    }
                ],
            }
        )
        assert await backend.add_episode(episode_request) == [episode.uuid]
        assert await backend.add_episode(episode_request) == [episode.uuid]

        records, _, _ = await driver.execute_query(
            """
            MATCH (n:Entity)
            WHERE n.group_id IN $groups
            OPTIONAL MATCH (n)-[r:RELATES_TO]->()
            RETURN n.group_id AS group_id, count(DISTINCT n) AS nodes,
                   count(DISTINCT r) AS relationships
            ORDER BY group_id
            """,
            groups=[owner_group(first_owner), owner_group(second_owner)],
            routing_='r',
        )
        assert [(row['nodes'], row['relationships']) for row in records] == [(2, 1), (2, 1)]

        await backend.delete_user(first_owner)
        records, _, _ = await driver.execute_query(
            'MATCH (n:Entity) WHERE n.group_id IN $groups '
            'RETURN collect(DISTINCT n.group_id) AS groups',
            groups=[owner_group(first_owner), owner_group(second_owner)],
            routing_='r',
        )
        assert records[0]['groups'] == [owner_group(second_owner)]
    finally:
        await backend.delete_user(first_owner)
        await backend.delete_user(second_owner)
        await backend.close()
