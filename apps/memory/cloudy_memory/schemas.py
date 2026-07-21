from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EntityKind = Literal[
    'Person',
    'ChannelIdentity',
    'Organization',
    'Project',
    'Service',
    'IncidentType',
    'Topic',
    'CommunicationEvent',
    'Decision',
]
RelationshipKind = Literal[
    'HAS_IDENTITY',
    'WORKS_WITH',
    'WORKS_FOR',
    'RESPONSIBLE_FOR',
    'OWNS',
    'AFFECTS',
    'ABOUT',
    'CONTACTED_VIA',
    'CHOSE_ACTION',
    'REJECTED_ACTION',
    'USES_LANGUAGE_WITH',
    'PREFERS_CHANNEL',
]
Provenance = Literal['provider', 'user', 'approval', 'import', 'derived']
Scalar = str | int | float | bool | None
Confidence = Annotated[float, Field(ge=0, le=1)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class EpisodeEntity(StrictModel):
    canonical_ref: str = Field(min_length=1, max_length=160)
    kind: EntityKind
    name: str = Field(min_length=1, max_length=300)
    provenance_type: Provenance
    confidence: Confidence
    ontology_version: Literal[1] = 1
    channel: Literal['gmail', 'telegram', 'slack', 'discord', 'custom'] | None = None
    verified: bool | None = None
    outcome: str | None = Field(default=None, max_length=80)

    @model_validator(mode='after')
    def validate_kind_fields(self) -> EpisodeEntity:
        if self.kind == 'Decision' and self.outcome not in (
            'approved',
            'rejected',
            'expired',
            'cancelled',
        ):
            raise ValueError('Decision entities require an approval outcome')
        if self.kind == 'CommunicationEvent' and (
            self.channel is None
            or self.outcome not in ('delivered', 'failed', 'ambiguous', 'intent_only')
        ):
            raise ValueError('CommunicationEvent entities require channel and delivery outcome')
        if self.kind == 'ChannelIdentity' and (self.channel is None or self.verified is None):
            raise ValueError('ChannelIdentity entities require channel and verification')
        return self


class EpisodeFact(StrictModel):
    canonical_ref: str = Field(min_length=1, max_length=160)
    subject: EpisodeEntity
    predicate: RelationshipKind
    object: EpisodeEntity
    provenance_type: Provenance
    confidence: Confidence
    outcome: str | None = Field(default=None, max_length=80)
    ontology_version: Literal[1] = 1
    channel: Literal['gmail', 'telegram', 'slack', 'discord', 'custom'] | None = None
    language: str | None = Field(default=None, min_length=2, max_length=40)

    @model_validator(mode='after')
    def validate_relationship_fields(self) -> EpisodeFact:
        if self.predicate == 'PREFERS_CHANNEL' and self.channel is None:
            raise ValueError('PREFERS_CHANNEL facts require a channel')
        if self.predicate == 'USES_LANGUAGE_WITH' and self.language is None:
            raise ValueError('USES_LANGUAGE_WITH facts require a language')
        return self


class EpisodeRequest(StrictModel):
    owner_id: UUID
    episode_id: UUID
    source_description: str = Field(min_length=1, max_length=160)
    reference_time: datetime
    ontology_version: Literal[1] = 1
    facts: list[EpisodeFact] = Field(min_length=1, max_length=50)


class EntityInput(StrictModel):
    canonical_ref: str = Field(min_length=1, max_length=160)
    kind: EntityKind
    name: str = Field(min_length=1, max_length=300)
    provenance_type: Provenance
    confidence: Confidence
    attributes: dict[str, Scalar] = Field(default_factory=dict)

    @field_validator('attributes')
    @classmethod
    def validate_attributes(cls, value: dict[str, Scalar]) -> dict[str, Scalar]:
        if len(value) > 20:
            raise ValueError('attributes may contain at most 20 entries')
        for key, item in value.items():
            if not key.replace('_', '').isalnum() or len(key) > 60:
                raise ValueError('attribute keys must be short alphanumeric identifiers')
            if isinstance(item, str) and len(item) > 500:
                raise ValueError('attribute strings may contain at most 500 characters')
        return value


class RelationshipInput(StrictModel):
    canonical_ref: str = Field(min_length=1, max_length=160)
    kind: RelationshipKind
    fact: str = Field(min_length=1, max_length=1_000)
    provenance_type: Provenance
    confidence: Confidence
    outcome: str | None = Field(default=None, max_length=80)
    valid_at: datetime | None = None
    invalid_at: datetime | None = None


class TripletRequest(StrictModel):
    owner_id: UUID
    source: EntityInput
    relationship: RelationshipInput
    target: EntityInput
    ontology_version: Literal[1] = 1


class SearchRequest(StrictModel):
    owner_id: UUID
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=10, ge=1, le=20)


class SearchEvidence(StrictModel):
    evidence_id: str
    relationship: str
    fact: str
    source_node_id: str
    target_node_id: str
    confidence: float | None = None
    outcome: str | None = None
    valid_at: datetime | None = None
    invalid_at: datetime | None = None


class SearchResponse(StrictModel):
    evidence: list[SearchEvidence]


class RebuildRequest(StrictModel):
    episodes: list[EpisodeRequest] = Field(default_factory=list, max_length=100)
    triplets: list[TripletRequest] = Field(default_factory=list, max_length=500)


class WriteResponse(StrictModel):
    graph_ids: list[str]


class DeleteResponse(StrictModel):
    deleted: bool


class RebuildResponse(StrictModel):
    episodes: int
    triplets: int
