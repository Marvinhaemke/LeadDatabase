// Placeholder until `pnpm db:types` is run against the local Supabase
// instance. Run `pnpm db:start && pnpm db:types` to regenerate this file
// with the real schema.
//
// Why it's `any`: Supabase's select-string TS magic walks the
// `Database['public']['Tables'][T]['Row']` type to derive the result
// shape. When the table doesn't list its real columns, the parser
// resolves the result to `never`, which then breaks every `.select()
// .single()` consumer with "Property 'X' does not exist on type
// 'never'". Until real types are generated, the simplest workable
// stand-in is `any` for the whole Database shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type Database = any;
