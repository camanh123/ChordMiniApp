const SENSITIVE_ASSIGNMENT = /(PYTHON_API_URL|SONGFORMER_API_URL|SHEETSAGE_API_URL|CHORDMINI_READY_TOKEN|CHORDMINI_DESKTOP_COOKIE|CHORDMINI_INFERENCE_SECRET|NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET|CHORDMINI_STAGING_ALLOWED_UIDS|FIREBASE_SERVICE_ACCOUNT_KEY|GEMINI_API_KEY|GENIUS_API_KEY|MUSIC_AI_API_KEY|CRON_SECRET)=([^\s]+)/gi;

const SECRET_ENV_KEYS = [
  'PYTHON_API_URL',
  'SONGFORMER_API_URL',
  'SHEETSAGE_API_URL',
  'FIREBASE_SERVICE_ACCOUNT_KEY',
  'GEMINI_API_KEY',
  'GENIUS_API_KEY',
  'MUSIC_AI_API_KEY',
  'CRON_SECRET',
  'CHORDMINI_READY_TOKEN',
  'CHORDMINI_DESKTOP_COOKIE',
  'CHORDMINI_INFERENCE_SECRET',
  'NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET',
  'CHORDMINI_STAGING_ALLOWED_UIDS',
] as const;

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return SECRET_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return value ? [value] : [];
  });
}

export function sanitizeDiagnostic(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < 6) {
      continue;
    }
    output = output.split(secret).join('[redacted]');
  }

  return output.replace(SENSITIVE_ASSIGNMENT, '$1=[redacted]');
}
