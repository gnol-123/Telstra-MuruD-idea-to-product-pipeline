import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_catalog_cache():
    # Catalog cache is process-wide; one test's fake rows mustn't leak into the next.
    from app.repositories import catalog_cache

    catalog_cache.clear()
    yield
    catalog_cache.clear()
