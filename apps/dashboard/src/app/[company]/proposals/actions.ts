'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseAdminClient } from 'db/admin';
import { getCurrentUser } from '@/lib/auth';
import { invalidateSchemaSummary } from 'ai';

const ALLOWED_TYPES = new Set([
  'text',
  'citext',
  'numeric',
  'integer',
  'bigint',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
]);

const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

interface ApplyResult {
  proposal_id: string;
  applied: boolean;
  error: string | null;
  rows_backfilled: number;
}

/**
 * Approve and apply a field proposal: ALTER TABLE + backfill in one
 * transaction inside `apply_field_proposal()`. Admin-only.
 */
export async function approveProposal(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    throw new Error('forbidden: admin only');
  }

  const proposalId = String(formData.get('proposal_id') ?? '');
  const companySlug = String(formData.get('company_slug') ?? '');
  const targetColumnName = String(formData.get('target_column_name') ?? '').trim();
  const targetColumnType = String(formData.get('target_column_type') ?? '').trim();
  const dropAfter = formData.get('drop_attribute_after') === 'on';

  if (!proposalId) throw new Error('proposal_id missing');
  if (!COLUMN_NAME_RE.test(targetColumnName)) {
    redirect(
      `/${companySlug}/proposals/${proposalId}?error=${encodeURIComponent('invalid column name (use lowercase a-z, 0-9, underscore; must start with letter or underscore)')}`,
    );
  }
  if (!ALLOWED_TYPES.has(targetColumnType)) {
    redirect(
      `/${companySlug}/proposals/${proposalId}?error=${encodeURIComponent(`unsupported type: ${targetColumnType}`)}`,
    );
  }

  const admin = createSupabaseAdminClient();

  // Persist the operator's choices BEFORE invoking apply, so the
  // SQL function reads them.
  await admin
    .from('field_proposals')
    .update({
      target_column_name: targetColumnName,
      target_column_type: targetColumnType,
      drop_attribute_after: dropAfter,
    })
    .eq('id', proposalId);

  // @ts-expect-error rpc not in placeholder Database types
  const { data, error } = await admin.rpc('apply_field_proposal', {
    p_proposal_id: proposalId,
    p_actor: user.userId,
  });

  if (error) {
    redirect(
      `/${companySlug}/proposals/${proposalId}?error=${encodeURIComponent(error.message)}`,
    );
  }

  const result = (data?.[0] ?? null) as ApplyResult | null;
  if (!result?.applied) {
    redirect(
      `/${companySlug}/proposals/${proposalId}?error=${encodeURIComponent(result?.error ?? 'apply failed')}`,
    );
  }

  // Invalidate the per-company schema-summary cache so the next ingest
  // call learns about the new typed column.
  const { data: proposal } = await admin
    .from('field_proposals')
    .select('company_id')
    .eq('id', proposalId)
    .single();
  if (proposal?.company_id) {
    invalidateSchemaSummary(proposal.company_id as string);
  }

  revalidatePath(`/${companySlug}/proposals`);
  redirect(
    `/${companySlug}/proposals?applied=${encodeURIComponent(`${targetColumnName} (${result.rows_backfilled} rows backfilled)`)}`,
  );
}

/**
 * Reject a proposal. The data already in `attributes` is left in place;
 * rejection only stops the proposal from cluttering the queue. We can
 * later teach the AI to skip rejected keys via the schema-summary.
 */
export async function rejectProposal(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    throw new Error('forbidden: admin only');
  }

  const proposalId = String(formData.get('proposal_id') ?? '');
  const companySlug = String(formData.get('company_slug') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (!proposalId) throw new Error('proposal_id missing');

  const admin = createSupabaseAdminClient();
  await admin
    .from('field_proposals')
    .update({
      status: 'rejected',
      decided_at: new Date().toISOString(),
      decided_by: user.userId,
      notes,
    })
    .eq('id', proposalId);

  revalidatePath(`/${companySlug}/proposals`);
  redirect(`/${companySlug}/proposals`);
}

/**
 * Re-open a rejected proposal — useful if you change your mind after
 * seeing more data accumulate.
 */
export async function reopenProposal(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    throw new Error('forbidden: admin only');
  }

  const proposalId = String(formData.get('proposal_id') ?? '');
  const companySlug = String(formData.get('company_slug') ?? '');
  if (!proposalId) throw new Error('proposal_id missing');

  const admin = createSupabaseAdminClient();
  await admin
    .from('field_proposals')
    .update({
      status: 'pending',
      decided_at: null,
      decided_by: null,
      notes: null,
    })
    .eq('id', proposalId);

  revalidatePath(`/${companySlug}/proposals`);
  redirect(`/${companySlug}/proposals/${proposalId}`);
}
