// Key shapes and the long-run rule from Obversa's sessions-to-kb reader.
// Curate owns these patterns and has no runtime dependency on Obversa.
const SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|xai|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[=:]\s*\S+/gi,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bph[cx]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Named credentials also cover short passwords and JSON tool inputs.
  /\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;"'}]+)/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
];

/** A 40-character hex commit id is retained. Other long hex strings,
 * or long strings with mixed case and at least four digits, are scrubbed. */
function longRun(run: string): boolean {
  return /^[0-9a-f]+$/i.test(run)
    ? run.length >= 32 && run.length !== 40
    : run.length >= 40 && /[A-Z]/.test(run) && /[a-z]/.test(run)
      && (run.match(/\d/g) ?? []).length >= 4;
}

export function scrubChat(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, '[redacted]');
  return out.replace(/[A-Za-z0-9_+=-]{32,}/g, (run) => longRun(run) ? '[redacted]' : run);
}
