from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import auth, chat, environments, health, oauth, projects
from app.services.dbos_app import setup_dbos
from app.workflows import join_detached

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(environments.router)
app.include_router(chat.router)
app.include_router(oauth.router)

# Must come after routers are registered so DBOS can instrument them.
setup_dbos(app)


async def _join_detached_turns() -> None:
    await join_detached(settings.detached_join_timeout_s)


app.add_event_handler("shutdown", _join_detached_turns)


@app.get("/")
def root():
    return {"app": settings.app_name, "environment": settings.environment}
