export const name: string;
export declare const inject: string[];
export interface MigrateResult {
  ok: boolean;
  moved?: boolean;
  code?: string;
  message?: string;
}
export declare function apply(ctx: Record<string, unknown>): void;
