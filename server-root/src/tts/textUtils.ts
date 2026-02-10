const ANSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

export function sanitizeConsoleText(raw: string): string {
  const stripped = stripAnsi(raw);
  const normalized = stripped.replace(/\r/g, "\n");
  // Remove non-printable control chars but preserve newlines.
  return normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function isSpeakable(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}
