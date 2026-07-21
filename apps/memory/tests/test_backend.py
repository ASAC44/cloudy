from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest

from cloudy_memory.backend import GraphitiBackend, owner_group
from cloudy_memory.locks import OwnerLockPool
from cloudy_memory.schemas import EpisodeRequest, TripletRequest


def test_owner_group_is_graphiti_safe_and_deterministic() -> None:
    owner_id = UUID('a91df2b5-5b1a-4415-8460-654613525c79')
    assert owner_group(owner_id) == 'owner_a91df2b55b1a44158460654613525c79'
    assert ':' not in owner_group(owner_id)


def test_triplet_ontology_rejects_impossible_relationships() -> None:
    request = TripletRequest.model_validate(
        {
            'owner_id': str(uuid4()),
            'source': {
                'canonical_ref': 'person:anne',
                'kind': 'Person',
                'name': 'Anne',
                'provenance_type': 'user',
                'confidence': 1,
            },
            'relationship': {
                'canonical_ref': 'invalid:1',
                'kind': 'AFFECTS',
                'fact': 'Anne affects an incident type.',
                'provenance_type': 'derived',
                'confidence': 0.5,
            },
            'target': {
                'canonical_ref': 'incident:deployment',
                'kind': 'IncidentType',
                'name': 'Deployment incident',
                'provenance_type': 'user',
                'confidence': 1,
            },
        }
    )
    with pytest.raises(ValueError, match='not allowed'):
        GraphitiBackend._validate_triplet(request)


def test_episodes_cannot_let_the_model_merge_people() -> None:
    request = EpisodeRequest.model_validate(
        {
            'owner_id': str(uuid4()),
            'episode_id': str(uuid4()),
            'source_description': 'approval ledger',
            'reference_time': '2026-07-22T00:00:00Z',
            'facts': [
                {
                    'canonical_ref': 'person:anne:language',
                    'subject': {
                        'canonical_ref': 'person:anne',
                        'kind': 'Person',
                        'name': 'Anne',
                        'provenance_type': 'user',
                        'confidence': 1,
                    },
                    'predicate': 'USES_LANGUAGE_WITH',
                    'object': {
                        'canonical_ref': 'identity:anne:gmail',
                        'kind': 'ChannelIdentity',
                        'name': 'Anne on Gmail',
                        'provenance_type': 'provider',
                        'confidence': 1,
                        'channel': 'gmail',
                        'verified': True,
                    },
                    'provenance_type': 'approval',
                    'confidence': 1,
                    'language': 'en',
                }
            ],
        }
    )
    with pytest.raises(ValueError, match='deterministic triplets'):
        GraphitiBackend._validate_episode(request)


@pytest.mark.asyncio
async def test_owner_locks_serialize_one_owner_but_not_different_owners() -> None:
    pool = OwnerLockPool()
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    same_owner_entered = asyncio.Event()
    other_owner_entered = asyncio.Event()

    async def first() -> None:
        async with pool.hold('one'):
            first_entered.set()
            await release_first.wait()

    async def same_owner() -> None:
        await first_entered.wait()
        async with pool.hold('one'):
            same_owner_entered.set()

    async def other_owner() -> None:
        await first_entered.wait()
        async with pool.hold('two'):
            other_owner_entered.set()

    tasks = [asyncio.create_task(operation()) for operation in (first, same_owner, other_owner)]
    await first_entered.wait()
    await asyncio.wait_for(other_owner_entered.wait(), timeout=0.2)
    assert not same_owner_entered.is_set()
    release_first.set()
    await asyncio.gather(*tasks)
    assert same_owner_entered.is_set()
