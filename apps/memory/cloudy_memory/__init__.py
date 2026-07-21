"""Cloudy's private Graphiti memory service."""

import logging
import os

os.environ['GRAPHITI_TELEMETRY_ENABLED'] = 'false'

# Graphiti's Neo4j error logger includes query parameters, which may contain memory facts.
logging.getLogger('graphiti_core.driver.neo4j_driver').setLevel(logging.CRITICAL)
