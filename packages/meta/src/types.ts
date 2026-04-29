/**
 * Zod schemas for the Meta Marketing API responses we consume.
 *
 * Meta returns numerics as strings ("123.45") on insight endpoints —
 * `z.coerce.number()` handles that without the call sites caring.
 * We use `.passthrough()` everywhere because Meta routinely adds fields
 * we don't care about; we only validate the ones we read.
 */
import { z } from 'zod';

const Numeric = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  .refine((n) => Number.isFinite(n), { message: 'not a finite number' });

export const PagingSchema = z
  .object({
    cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
    next: z.string().optional(),
    previous: z.string().optional(),
  })
  .passthrough();

export const AdAccountSchema = z
  .object({
    id: z.string(), // 'act_<account_id>'
    account_id: z.string().optional(),
    name: z.string().optional(),
    currency: z.string().optional(),
    timezone_name: z.string().optional(),
  })
  .passthrough();

export const CampaignSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    objective: z.string().optional(),
    status: z.string().optional(),
    effective_status: z.string().optional(),
  })
  .passthrough();

export const AdSetSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    campaign_id: z.string(),
    status: z.string().optional(),
    effective_status: z.string().optional(),
    daily_budget: z.string().optional(), // minor units (cents) as string
    lifetime_budget: z.string().optional(),
  })
  .passthrough();

export const AdSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    adset_id: z.string(),
    status: z.string().optional(),
    effective_status: z.string().optional(),
    creative: z.object({ id: z.string() }).optional(),
  })
  .passthrough();

export const InsightRowSchema = z
  .object({
    ad_id: z.string(),
    date_start: z.string(),
    date_stop: z.string(),
    spend: Numeric.optional(),
    impressions: Numeric.optional(),
    clicks: Numeric.optional(),
    reach: Numeric.optional(),
    cpm: Numeric.optional(),
    cpc: Numeric.optional(),
    ctr: Numeric.optional(),
  })
  .passthrough();

export const ListResponse = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      data: z.array(item),
      paging: PagingSchema.optional(),
    })
    .passthrough();

export type AdAccountResponse = z.infer<typeof AdAccountSchema>;
export type CampaignResponse = z.infer<typeof CampaignSchema>;
export type AdSetResponse = z.infer<typeof AdSetSchema>;
export type AdResponse = z.infer<typeof AdSchema>;
export type InsightRow = z.infer<typeof InsightRowSchema>;
