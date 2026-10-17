/** Raw WGSL may arrive from LF or CRLF checkouts. Normalize only line endings;
 * preserve the diagnostic block content (16 counters and 64-bit reductions). */
export const normalizeShaderEOL = source => source.replace(/\r\n/g, '\n');
export function stripWorkCounting(source) {
  return source.replace(/\/\/ WORK-COUNTING-BEGIN[^\r\n]*\r?\n[\s\S]*?\/\/ WORK-COUNTING-END(?:\r?\n|$)/g, '');
}
