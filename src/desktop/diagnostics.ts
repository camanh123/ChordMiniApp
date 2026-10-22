const SENSITIVE_ASSIGNMENT = /(PYTHON_API_URL|SONGFORMER_API_URL|SHEETSAGE_API_URL|CHORDMINI_READY_TOKEN|CHORDMINI_DESKTOP_COOKIE|FIREBASE_SERVICE_ACCOUNT_KEY|GEMINI_API_KEY|GENIUS_API_KEY|MUSIC_AI_API_KEY|CRON_SECRET)=([^\s]+)/gi;

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
