"""Runtime configuration.

Reads from environment variables (and an optional .env file). Defaults match
the hackathon S3 bucket so the service runs with zero config once AWS
credentials are available.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="",
        extra="ignore",
    )

    # S3 location of the cleaned parquet batches.
    aep_s3_bucket: str = "sagemaker-aep-outage-indiansassemble"
    aep_s3_prefix: str = "processed"

    # AWS auth. AWS_PROFILE / AWS_REGION are also read natively by boto3.
    aws_profile: Optional[str] = "default"
    aws_region: str = "us-east-2"

    # Optional local override: a directory holding batchN/*.parquet.
    # When set, the loader reads here instead of S3.
    aep_local_data_dir: Optional[str] = None

    # Comma-separated list of allowed CORS origins ("*" for all).
    aep_cors_origins: str = "*"

    # Chat (Amazon Nova on Bedrock). Sessions live in memory only.
    aep_chat_model_id: str = "us.amazon.nova-2-lite-v1:0"
    aep_chat_session_ttl_min: int = 30
    aep_chat_max_messages: int = 24
    # per-visitor chat limit (messages per 10 minutes, per IP) to protect the Bedrock budget
    aep_chat_rate_per_10min: int = 20

    # Optional: a folder with the built dashboard (web/ + mock/) to serve from this API,
    # so one server hosts both. Unset in local dev (Vite serves the dashboard).
    aep_static_dir: Optional[str] = None

    @property
    def cors_origin_list(self) -> list[str]:
        raw = self.aep_cors_origins.strip()
        if raw == "*" or not raw:
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
