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
    llm_provider: str = "ollama"
    # Hosted Ollama. A local install is http://localhost:11434/v1.
    ollama_base_url: str = "https://ollama.com/v1"
    ollama_api_key: str = ""
    summary_model: str = "deepseek-v4.1-flash"
    # Read budget for one model call. The SDK default of 600s.
    llm_read_timeout_s: float = 1800.0
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3-flash-preview"
    # Platform Keys for default tools:
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
    # Code preview downloads. A zip is built inside the sandbox, then streamed.
    environment_max_archive_bytes: int = 200_000_000
    # One file uploaded or saved from the code preview.
    environment_max_upload_bytes: int = 25_000_000
    # Model requests one turn may make. Bounds a tool loop that never converges.
    turn_request_limit: int = 100
    # Shutdown grace period to let detached turns (see workflows._DETACHED) finish.
    detached_join_timeout_s: int = 30

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
