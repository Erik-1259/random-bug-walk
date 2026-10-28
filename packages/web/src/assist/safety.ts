// The bug designer's scope: date and time, concurrency, data handling, state and UI logic bugs. Security
// topics (vulnerabilities, authentication, identity and permissions, injection, secrets) are refused
// before any provider call, and a model answer that turns to them is refused too. Designs stay at
// component level: an answer holding code blocks or patch text is not used.

const SECURITY_TERMS: readonly string[] = [
  "secur(?:e|ity)",
  "vulnerab\\w*",
  "exploit\\w*",
  "cve",
  "cwe",
  "attack\\w*",
  "malicious",
  "malware",
  "backdoor\\w*",
  "phishing",
  "inject\\w*",
  "sqli",
  "xss",
  "cross[- ]site",
  "csrf",
  "xsrf",
  "ssrf",
  "rce",
  "remote code",
  "code execution",
  "auth",
  "authn",
  "authz",
  "oauth\\w*",
  "jwt",
  "authenticat\\w*",
  "authori[sz]\\w*",
  "log[- ]?ins?",
  "sign[- ]?ins?",
  "passwords?",
  "passcodes?",
  "credentials?",
  "permissions?",
  "privileges?",
  "access control",
  "role[- ]based",
  "rbac",
  "identity",
  "impersonat\\w*",
  "session (?:fixation|hijack\\w*|token\\w*)",
  "secrets?",
  "api keys?",
  "tokens? (?:leak\\w*|theft)",
  "encrypt\\w*",
  "decrypt\\w*",
  "crypto\\w*",
  "bypass\\w*",
  "escalat\\w*",
  "denial of service",
  "ddos",
  "brute[- ]?forc\\w*",
  "data leak\\w*",
  "information disclosure",
  "sensitive data",
  "pii",
  "payloads?",
  "shellcode",
  "path traversal",
  "directory traversal",
  "deseriali[sz]\\w*",
];

const SECURITY = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SECURITY_TERMS.join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** Whether the text names a security topic the designer does not cover. */
export function securityTopic(text: string): boolean {
  return SECURITY.test(text);
}

/** Code blocks, patch headers and hunks, or lines that read as source code. */
const CODE = /```|^\s*(?:@@ |\+\+\+ |--- |diff --git)|^\s*(?:import|export|const|let|function|def|class)\s+\S+.*[;{=(]\s*$/m;

/** Whether the text holds code or patch text instead of a component-level description. */
export function holdsCode(text: string): boolean {
  return CODE.test(text);
}
