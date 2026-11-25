export function deployedEnvironment(): Record<string, string> {
  return {
    NODE_ENV: "production", PITCHROOM_DEPLOYMENT_ENV: "trial", PITCHROOM_RUNTIME: "live",
    PITCHROOM_RELEASE_SHA: "a".repeat(40), PITCHROOM_SCHEMA_VERSION: "synthetic-schema-1",
    DATABASE_URL: "postgres://trial_user:example@db.example:5432/trial?sslmode=verify-full",
    PITCHROOM_DATABASE_TARGET: "db.example:5432/trial",
    PITCHROOM_ENVIRONMENT_ID: "10000000-0000-4000-8000-000000000001", PITCHROOM_DATABASE_ROLE: "trial_user",
    PITCHROOM_TARGET_RECEIPT_SHA: "b".repeat(64),
    PITCHROOM_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_API_KEY: "test-synthetic-provider-key", OPENAI_MODEL: "synthetic-pinned-model",
    PITCHROOM_LIVE_TRANSFER_ACK: "authorized",
    PITCHROOM_TRANSFER_APPROVAL_ID: "synthetic-approval-1", PITCHROOM_BUDGET_ID: "synthetic-budget-1",
  };
}
