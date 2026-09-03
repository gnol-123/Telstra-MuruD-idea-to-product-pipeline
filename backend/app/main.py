from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import auth, chat, health
from app.services.dbos_app import setup_dbos

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
app.include_router(chat.router)

# Must come after routers are registered so DBOS can instrument them.
setup_dbos(app)


@app.get("/")
def root():
    return {"app": settings.app_name, "environment": settings.environment}
