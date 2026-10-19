const TIME_ZONE = /^(?:UTC|[A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

export function isValidTimeZone(text: string): boolean {
  if (text.length > 64 || !TIME_ZONE.test(text)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text });
    return true;
  } catch {
    return false;
  }
}
