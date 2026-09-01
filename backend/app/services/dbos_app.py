"""DBOS setup.

DBOS gives us durable workflows: if the process crashes mid-request, a workflow
resumes from the last completed step instead of starting over. It stores that
progress in Postgres (our Supabase database), under its own ``dbos`` schema.

``setup_dbos`` is called once from ``app.main``; workflows themselves live in
``app.workflows``.
"""

import logging

from dbos import DBOS, DBOSConfig
from fastapi import FastAPI

from app.config import settings

logger = logging.getLogger(__name__)


def setup_dbos(app: FastAPI) -> DBOS | None:
    """Attach DBOS to the FastAPI app, if a database URL is configured.

    Returns ``None`` when ``DBOS_DATABASE_URL`` is unset so the API still runs
    (and tests still pass) without a database.
    """
    if not settings.dbos_database_url:
        return None

    config: DBOSConfig = {
        "name": "murud-pipeline",
        "database_url": settings.dbos_database_url,
        "system_database_url": settings.dbos_database_url,
        "db_engine_kwargs": {"connect_args": {"prepare_threshold": None}},
    }

    try:
        dbos = DBOS(config=config, fastapi=app)
        DBOS.launch()
    except Exception:
        logger.exception("DBOS failed to start; continuing without durable workflows")
        return None

    return dbos
