/** scripts/deploy.mjs の型（テストから読むため） */
export type Placement = { mode: "smart" } | { mode: "targeted"; region: string };
export const PLACEMENT_CONFIG: string;
export function placementFor(raw: string | undefined): Placement | null;
export function observabilityOff(raw: string | undefined): boolean;
export function withPlacement(text: string, placement: Placement): string;
export function withoutObservability(text: string): string;
