"""
App configuration settings.
Settings are loaded from environment variables, which can be set in a ``.env``
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "MuruDPipeline API"
    environment: str = "development"
    cors_origins: str = "*"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3-flash-preview"
    supabase_url: str = ""
    supabase_key: str = ""
    dbos_database_url: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
