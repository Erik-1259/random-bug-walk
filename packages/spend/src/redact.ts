/** Removes every part of the connection string (user, password, host, port, database, options) from text. */
export function redactor(connectionString: string): (text: string) => string {
  const url = new URL(connectionString);
  const parts = [
    url.username,
    url.password,
    url.hostname,
    url.host,
    url.port,
    url.pathname.replace(/^\//, ""),
    ...url.searchParams.values(),
  ]
    .flatMap((part) => [part, decodeURIComponent(part)])
    .filter((part) => part.length > 0)
    .sort((a, b) => b.length - a.length);
  return (text) => parts.reduce((out, part) => out.split(part).join("[redacted]"), text);
}
