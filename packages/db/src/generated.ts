// Placeholder until `pnpm db:types` is run against the local Supabase instance.
// Run: `pnpm db:start && pnpm db:types` to regenerate this file with the real
// schema. The `any`s here are deliberately permissive so the rest of the
// codebase typechecks before types have been generated locally.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

interface PermissiveTable {
  Row: any;
  Insert: any;
  Update: any;
  Relationships: [];
}

export interface Database {
  public: {
    Tables: Record<string, PermissiveTable>;
    Views: Record<string, PermissiveTable>;
    Functions: Record<string, never>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, never>;
  };
}
