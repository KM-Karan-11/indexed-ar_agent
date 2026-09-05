import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('AR module: SUPABASE_URL or SUPABASE_ANON_KEY missing — /ar-check will fail');
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

async function fetchForecastRow() {
  const { data, error } = await sb
    .from('forecast_data')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return data;
}

export function currentInvoiceMonth(d = new Date()) {
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export async function getDraftsForMonth(month) {
  const row = await fetchForecastRow();
  const drafts = (row.ar_fcst || []).filter(
    (r) => r.invoiceMonth === month && !r.invoiceNo
  );
  return drafts;
}

export async function getInvoicedAwaitingPayment(month) {
  const row = await fetchForecastRow();
  return (row.ar_fcst || []).filter(
    (r) => r.invoiceMonth === month && r.invoiceNo && !r.paymentDate
  );
}

export async function markRaised(rowId, invoiceNo, invoiceDate, actorEmail) {
  const row = await fetchForecastRow();
  const ar = row.ar_fcst || [];
  const target = ar.find((r) => String(r.id) === String(rowId));
  if (!target) throw new Error(`AR row ${rowId} not found`);

  const updated = ar.map((r) =>
    String(r.id) === String(rowId)
      ? { ...r, invoiceNo, invoiceDate: invoiceDate || r.invoiceDate, status: 'Invoiced' }
      : r
  );

  const payload = {
    ar_fcst: updated,
    updated_at: new Date().toISOString(),
    updated_by: actorEmail || 'ar-agent',
  };

  const { error } = await sb.from('forecast_data').update(payload).eq('id', 1);
  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  return target;
}

export async function markPaid(rowId, paymentDate, actorEmail) {
  const row = await fetchForecastRow();
  const ar = row.ar_fcst || [];
  const target = ar.find((r) => String(r.id) === String(rowId));
  if (!target) throw new Error(`AR row ${rowId} not found`);

  const updated = ar.map((r) =>
    String(r.id) === String(rowId)
      ? { ...r, paymentDate, status: 'Paid' }
      : r
  );

  const payload = {
    ar_fcst: updated,
    updated_at: new Date().toISOString(),
    updated_by: actorEmail || 'ar-agent',
  };

  const { error } = await sb.from('forecast_data').update(payload).eq('id', 1);
  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  return target;
}

export function formatDraftBlocks(drafts, month) {
  if (drafts.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `No draft invoices to raise for *${month}* — everything's already invoiced.`,
        },
      },
    ];
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `AR: drafts to raise for ${month}` },
    },
    { type: 'divider' },
  ];

  for (const d of drafts) {
    const usd = (d.usdValue || d.amount || 0).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${d.client}* (${d.entity})\n${usd} · ${d.mode || 'unknown mode'} · due ${d.dueDate || d.cashMonth || '—'}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Mark as Raised' },
        style: 'primary',
        action_id: 'ar_mark_raised',
        value: String(d.id),
      },
    });
  }
  return blocks;
}

export function raisedModal(rowId, client, invoiceMonth) {
  return {
    type: 'modal',
    callback_id: 'ar_raised_submit',
    private_metadata: JSON.stringify({ rowId }),
    title: { type: 'plain_text', text: 'Mark invoice raised' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${client}* · ${invoiceMonth}\nEnter the invoice number as it appears in Xero.`,
        },
      },
      {
        type: 'input',
        block_id: 'invoice_no',
        label: { type: 'plain_text', text: 'Invoice #' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'e.g. INV-01-09/2026' },
        },
      },
      {
        type: 'input',
        block_id: 'invoice_date',
        optional: true,
        label: { type: 'plain_text', text: 'Invoice date (optional)' },
        element: {
          type: 'datepicker',
          action_id: 'value',
          initial_date: new Date().toISOString().slice(0, 10),
        },
      },
    ],
  };
}
