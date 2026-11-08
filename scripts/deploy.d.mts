/** scripts/deploy.mjs の型（テストから読むため） */
export type Placement = { mode: "smart" } | { mode: "targeted"; region: string };
export const PLACEMENT_CONFIG: string;
export function placementFor(raw: string | undefined): Placement | null;
export function observabilityOff(raw: string | undefined): boolean;
export function minifyOff(raw: string | undefined): boolean;
export function withoutMinify(text: string): string;
export function withPlacement(text: string, placement: Placement): string;
export function withoutObservability(text: string): string;
export function workerNameFor(raw: string | undefined): string | null;
export function bucketNameFor(raw: string | undefined, varName: string): string | null;
export function withWorkerName(text: string, name: string): string;
export function withBucket(text: string, binding: string, bucket: string): string;
