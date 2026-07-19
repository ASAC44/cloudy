# Agent Instructions

Run the `$ponytail` skill after implementing a plan only for functions and backend changes. Do not run Ponytail on frontend components, styling, or animations; preserve their intended design and motion. For mixed plans, limit Ponytail review and recommendations to the backend and functional logic.

## Deferred Work Ledger

Record intentionally deferred deployment, configuration, integration, and
operational work in the repository-root `todo.md` before the final response.
Use concrete checkboxes with enough detail to execute and verify the task during
final deployment. Do not add routine completed work, and mark an item complete
only after its outcome has been verified.

## Database Schema

Use the `$database-schema-designer` skill for every database schema design,
review, migration, table, relationship, constraint, or index change. Inspect the
existing schema and real access patterns first, then follow the skill's data
integrity, indexing, backward-compatibility, and verification guidance using the
project's actual database dialect.

Follow ACID guarantees strictly for all database work. Make every multi-step
write atomic by enclosing it in a single transaction with explicit rollback on
failure. Design the entire backend and its infrastructure to prevent race
conditions, lost updates, dirty or stale reads, and stale writes; use the
database's appropriate constraints, locking, isolation level, or optimistic
concurrency checks, and verify concurrent failure paths before completion.

## Frontend Components

Before creating a frontend component, check whether the project already includes a suitable shadcn component and reuse it. If it is missing, add the official shadcn component first. Create a custom component only when shadcn does not provide a component that meets the requirement.

## Visual Preferences

Do not use charcoal or graphite colors as page or component surfaces. Prefer warm neutrals and semantic design tokens. Avoid card-based page layouts; structure pages with typography, whitespace, dividers, lists, tables, and full-width sections instead.
