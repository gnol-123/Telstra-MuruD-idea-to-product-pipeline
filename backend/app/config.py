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
    # Platform keys for default tools. A user's own node secret overrides these.
    brave_api_key: str = ""
    context7_api_key: str = ""
    supabase_url: str = ""
    supabase_key: str = ""
    # Service role key. Bypasses RLS. Required for Supabase Vault
    supabase_service_key: str = ""
    dbos_database_url: str = ""
    # Where Supabase sends the browser back after Google sign-in.
    # Add frontend url to allowedlist on supabase to use Google sign-in.
    oauth_redirect_url: str = ""
    # Google OAuth client, for tool node connect flows (Gmail etc), not sign-in.
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    # Signs the state param on the connect flow. Empty disables oauth2 tool nodes.
    oauth_state_secret: str = ""
    # Frontend origin, to redirect the browser back after the oauth callback.
    frontend_url: str = ""
    # E2B sandboxes. Empty key disables environments: provisioning writes an error status.
    e2b_api_key: str = ""
    e2b_template: str = "base"
    # Sent as lifecycle.auto_resume. A setting so ops can turn it off if the tier rejects it.
    e2b_auto_resume: bool = True
    # Wall clock deadline, pushed on every use so it behaves as an idle timeout.
    environment_idle_timeout_s: int = 300
    environment_command_timeout_s: int = 120
    environment_max_output_chars: int = 20_000
    environment_max_file_chars: int = 200_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
