/** cli/banto-theme.mjs の型（テストから読むため） */
export class CliError extends Error {}
export function wantedLocale(path: string, locale: string): boolean;
export function buildBundle(dir: string, locale: string): Promise<{ bundle: { format: 1; files: Record<string, string>; assets: string[] }; assets: { name: string; path: string }[]; skipped: string[] }>;
export function main(
  argv: string[],
  io?: { log?: (s: string) => void; error?: (s: string) => void; env?: Record<string, string | undefined>; fetch?: typeof fetch; once?: boolean },
): Promise<number>;
