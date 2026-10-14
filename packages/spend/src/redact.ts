/** Removes every part of the connection string (user, password, host, port, database, options) from text. */
export function redactor(connectionString: string): (text: string) => string {
  const url = new URL(connectionString);
  // Query values come from URLSearchParams already decoded, so they are not decoded again; their raw,
  // still-encoded forms are taken from the query string itself.
  const rawQueryValues = url.search
    .replace(/^\?/, "")
    .split("&")
    .map((pair) => pair.slice(pair.indexOf("=") + 1));
  const parts = [
    ...[url.username, url.password, url.hostname, url.host, url.port, url.pathname.replace(/^\//, "")].flatMap((part) => [part, decodeOrKeep(part)]),
    ...url.searchParams.values(),
    ...rawQueryValues,
  ]
    .filter((part) => part.length > 0)
    .sort((a, b) => b.length - a.length);
  return (text) => parts.reduce((out, part) => out.split(part).join("[redacted]"), text);
}

function decodeOrKeep(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
