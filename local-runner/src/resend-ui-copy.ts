/** Shared dashboard/setup copy when Resend env is missing on the serve process. */
export const RESEND_ENV_HINT =
  "Set RESEND_API_KEY or PRGENIE_RUNNER_RESEND_KEY_FILE plus PRGENIE_RUNNER_FROM_EMAIL on the server, then restart prgenie serve.";

export const RESEND_SAVE_WARNING =
  "Saved, but emails will not send until Resend is configured on the server (restart serve after setting env).";
