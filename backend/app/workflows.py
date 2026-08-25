"""Durable workflows
Using DBOS workflows to wrap the agent call in a checkpointed, retryable step.
DBOS Checkpoints each '@DBOS.step' decorated function, so if the process is
interrupted, it can resume from the last successful step.
"""

from dbos import DBOS

from app.services.agent import get_agent


@DBOS.step(retries_allowed=True, max_attempts=3)
async def run_agent_step(prompt: str) -> str:
    """Call the LLM. Retried on transient failures, checkpointed on success."""
    result = await get_agent().run(prompt)
    return result.output


@DBOS.workflow()
async def chat_workflow(prompt: str) -> str:
    """Durable wrapper around a single agent turn.

    Extra steps added here later (persisting to Supabase, follow-up model calls)
    will each be checkpointed too, so a restart resumes rather than restarts.
    """
    return await run_agent_step(prompt)
