from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "MuruDPipeline API"
    environment: str = "development"
    cors_origins: str = "*"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5"
    supabase_url: str = ""
    supabase_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
