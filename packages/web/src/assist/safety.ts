// The bug designer's scope: date and time, concurrency, data handling, state and UI logic bugs. Security
// topics (vulnerabilities, authentication, identity and permissions, injection, secrets) are refused
// before any provider call, and a model answer that turns to them is refused too. Designs stay at
// component level: an answer holding code blocks or patch text is not used. Injection counts only in its
// security senses ("SQL injection", "inject malicious code"), not "inject a delay" or "fault injection".
//
// Two checks share one term list. securityTopic, the input check, uses the full list on what a visitor
// sends (a query, or a shape sent for a design); bug shapes are checked with it too, because a shape the
// page shows comes back as bug-spec input. designSecurityTopic, the output check, is used only on a
// bug-spec model answer and leaves out "bypass" and "payload": in date/time and concurrency designs they
// are ordinary words ("the cached path bypasses the time-zone conversion", Umami's event payloads), and
// the other terms still catch a design that turns to security.

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
  "(?:sql|nosql|code|(?:os )?command|shell|(?:java)?script|js|html|header|crlf|ldap|xpath|xml|template|prompt|log)[- ]injections?",
  "injections? attacks?",
  // "inject" with a security object within two words; the words between are not prepositions, so
  // "inject latency into queries" stays a testing phrase.
  "inject(?:s|ed|ing)?(?:\\s+(?!(?:in|into|to|on|at|for|before|after|between|across)(?![\\w-]))[\\w-]+){0,2}\\s+(?:sql|code|scripts?|commands?|payloads?|malicious|shellcode|quer(?:y|ies))",
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

/** Terms the output check leaves out: ordinary words in the designs the designer writes. */
const DESIGN_WORDS: readonly string[] = ["bypass\\w*", "payloads?"];

const termsPattern = (terms: readonly string[]): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join("|")})(?![\\p{L}\\p{N}])`, "iu");

const SECURITY = termsPattern(SECURITY_TERMS);
const DESIGN_SECURITY = termsPattern(SECURITY_TERMS.filter((term) => !DESIGN_WORDS.includes(term)));

/** The input check: whether the text names a security topic the designer does not cover. */
export function securityTopic(text: string): boolean {
  return SECURITY.test(text);
}

/** The output check on a model's design: the input check without the terms in DESIGN_WORDS. */
export function designSecurityTopic(text: string): boolean {
  return DESIGN_SECURITY.test(text);
}

/** Code blocks, patch headers and hunks, or lines that read as source code. */
const CODE = /```|^\s*(?:@@ |\+\+\+ |--- |diff --git)|^\s*(?:import|export|const|let|function|def|class)\s+\S+.*[;{=(]\s*$/m;

/** Whether the text holds code or patch text instead of a component-level description. */
export function holdsCode(text: string): boolean {
  return CODE.test(text);
}
