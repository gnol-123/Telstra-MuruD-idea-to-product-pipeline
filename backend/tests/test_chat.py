from dataclasses import dataclass

import pytest

from app.routers import chat as chat_router


@dataclass
class StubResult:
    output: str


class StubAgent:
    def __init__(self, output: str = "stubbed reply") -> None:
        self.output = output
        self.prompts: list[str] = []

    async def run(self, prompt: str) -> StubResult:
        self.prompts.append(prompt)
        return StubResult(output=self.output)


@pytest.fixture
def stub_agent(monkeypatch) -> StubAgent:
    agent = StubAgent()
    monkeypatch.setattr(chat_router, "get_agent", lambda: agent)
    return agent


def test_chat_returns_agent_output(client, stub_agent):
    resp = client.post("/chat", json={"prompt": "hello"})
    assert resp.status_code == 200
    assert resp.json() == {"output": "stubbed reply"}
    assert stub_agent.prompts == ["hello"]


def test_chat_rejects_missing_prompt(client, stub_agent):
    resp = client.post("/chat", json={})
    assert resp.status_code == 422
