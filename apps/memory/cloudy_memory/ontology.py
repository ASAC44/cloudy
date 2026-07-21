from typing import Annotated, Literal

from pydantic import BaseModel, Field

Confidence = Annotated[float, Field(ge=0, le=1)]
OntologyVersion = Literal[1]


class CanonicalEntity(BaseModel):
    """Fields shared by every Cloudy-owned graph entity."""

    canonical_ref: str = Field(min_length=1, max_length=160)
    provenance_type: Literal['provider', 'user', 'approval', 'import', 'derived']
    confidence: Confidence
    ontology_version: OntologyVersion = 1


class Person(CanonicalEntity):
    """A person known to the Cloudy user."""


class ChannelIdentity(CanonicalEntity):
    """A verified provider identity belonging to a person or organization."""

    channel: Literal['gmail', 'telegram', 'slack', 'discord', 'custom']
    verified: bool


class Organization(CanonicalEntity):
    """An organization related to the user's work."""


class Project(CanonicalEntity):
    """A project that can be affected by signals or decisions."""


class Service(CanonicalEntity):
    """A software or external service involved in an event."""


class IncidentType(CanonicalEntity):
    """A recurring class of operational incident."""


class Topic(CanonicalEntity):
    """A bounded subject discussed in communication or decisions."""


class CommunicationEvent(CanonicalEntity):
    """A communication event without exact message content."""

    channel: Literal['gmail', 'telegram', 'slack', 'discord', 'custom']
    outcome: Literal['delivered', 'failed', 'ambiguous', 'intent_only']


class Decision(CanonicalEntity):
    """A user decision and its separate approval and delivery outcomes."""

    outcome: Literal['approved', 'rejected', 'expired', 'cancelled']


class CanonicalRelationship(BaseModel):
    """Fields shared by every Cloudy-owned graph relationship."""

    canonical_ref: str = Field(min_length=1, max_length=160)
    provenance_type: Literal['provider', 'user', 'approval', 'import', 'derived']
    confidence: Confidence
    outcome: str | None = Field(default=None, max_length=80)
    ontology_version: OntologyVersion = 1


class HasIdentity(CanonicalRelationship):
    """A person or organization has a verified channel identity."""


class WorksWith(CanonicalRelationship):
    """Two people or organizations work together."""


class WorksFor(CanonicalRelationship):
    """A person works for an organization."""


class ResponsibleFor(CanonicalRelationship):
    """A person or organization is responsible for a service, project, or topic."""


class Owns(CanonicalRelationship):
    """A person or organization owns a service or project."""


class Affects(CanonicalRelationship):
    """An incident or decision affects a service or project."""


class About(CanonicalRelationship):
    """An event, communication, or decision is about a bounded topic."""


class ContactedVia(CanonicalRelationship):
    """A communication event contacted a verified identity through a channel."""


class ChoseAction(CanonicalRelationship):
    """The user approved a bounded action candidate."""


class RejectedAction(CanonicalRelationship):
    """The user rejected a bounded action candidate."""


class UsesLanguageWith(CanonicalRelationship):
    """The user uses a language with a person or identity."""

    language: str = Field(min_length=2, max_length=40)


class PrefersChannel(CanonicalRelationship):
    """The user prefers a channel for a person or situation."""

    channel: Literal['gmail', 'telegram', 'slack', 'discord', 'custom']


ENTITY_TYPES: dict[str, type[BaseModel]] = {
    model.__name__: model
    for model in (
        Person,
        ChannelIdentity,
        Organization,
        Project,
        Service,
        IncidentType,
        Topic,
        CommunicationEvent,
        Decision,
    )
}

EDGE_TYPES: dict[str, type[BaseModel]] = {
    name: model
    for name, model in {
        'HAS_IDENTITY': HasIdentity,
        'WORKS_WITH': WorksWith,
        'WORKS_FOR': WorksFor,
        'RESPONSIBLE_FOR': ResponsibleFor,
        'OWNS': Owns,
        'AFFECTS': Affects,
        'ABOUT': About,
        'CONTACTED_VIA': ContactedVia,
        'CHOSE_ACTION': ChoseAction,
        'REJECTED_ACTION': RejectedAction,
        'USES_LANGUAGE_WITH': UsesLanguageWith,
        'PREFERS_CHANNEL': PrefersChannel,
    }.items()
}

EDGE_TYPE_MAP: dict[tuple[str, str], list[str]] = {
    ('Organization', 'ChannelIdentity'): ['HAS_IDENTITY'],
    ('Person', 'Person'): ['WORKS_WITH'],
    ('Person', 'Organization'): ['WORKS_WITH', 'WORKS_FOR'],
    ('Person', 'Project'): ['RESPONSIBLE_FOR', 'OWNS'],
    ('Person', 'Service'): ['RESPONSIBLE_FOR', 'OWNS'],
    ('Organization', 'Project'): ['RESPONSIBLE_FOR', 'OWNS'],
    ('Organization', 'Service'): ['RESPONSIBLE_FOR', 'OWNS'],
    ('IncidentType', 'Project'): ['AFFECTS'],
    ('IncidentType', 'Service'): ['AFFECTS'],
    ('CommunicationEvent', 'Topic'): ['ABOUT'],
    ('Decision', 'Topic'): ['ABOUT'],
    ('CommunicationEvent', 'ChannelIdentity'): ['CONTACTED_VIA'],
    ('Decision', 'CommunicationEvent'): ['CHOSE_ACTION', 'REJECTED_ACTION'],
    ('Person', 'ChannelIdentity'): ['HAS_IDENTITY', 'USES_LANGUAGE_WITH', 'PREFERS_CHANNEL'],
}
