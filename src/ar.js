import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('AR module: SUPABASE_URL or SUPABASE_ANON_KEY missing');
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

export function daysBetween(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.floor((now - d) / (24 * 60 * 60 * 1000));
}

export async function getDraftsForMonth(month) {
  const row = await fetchForecastRow();
  return (row.ar_fcst || []).filter(
    (r) => r.invoiceMonth === month && !r.invoiceNo
  );
}

// FP&A pre-fills paymentDate = invoiceDate as an optimistic placeholder for every
// row (not a real payment record). We treat that as "unpaid" unless status is
// explicitly 'Paid' or paymentDate differs from invoiceDate (i.e., someone recorded
// a real payment date). This is a workaround until the FP&A tool changes that
// behavior or we sync from Xero directly.
export function isOpen(r) {
  if (!r.invoiceNo) return false;
  if (r.status === 'Paid') return false;
  if (!r.paymentDate) return true;
  return r.paymentDate === r.invoiceDate;
}

// All open (raised, not truly paid) invoices, sorted by most-overdue first.
// Optional `since` filter (ISO date) narrows to invoices raised on/after that date.
export async function getOpenInvoices({ since, now = new Date() } = {}) {
  const row = await fetchForecastRow();
  const sinceDate = since ? new Date(since) : null;
  return (row.ar_fcst || [])
    .filter(isOpen)
    .filter((r) => {
      if (!sinceDate) return true;
      const inv = r.invoiceDate ? new Date(r.invoiceDate) : null;
      return inv && inv >= sinceDate;
    })
    .map((r) => ({ ...r, daysPastDue: daysBetween(r.dueDate, now) }))
    .sort((a, b) => (b.daysPastDue ?? -Infinity) - (a.daysPastDue ?? -Infinity));
}

export async function markRaised(rowId, invoiceNo, invoiceDate, actorEmail) {
  const row = await fetchForecastRow();
  const ar = row.ar_fcst || [];
  const target = ar.find((r) => String(r.id) === String(rowId));
  if (!target) throw new Error(`AR row ${rowId} not found`);

  const updated = ar.map((r) =>
    String(r.id) === String(rowId)
      ? {
          ...r,
          invoiceNo,
          invoiceDate: invoiceDate || r.invoiceDate,
          paymentDate: '',
          status: 'Invoiced',
        }
      : r
  );

  const { error } = await sb.from('forecast_data').update({
    ar_fcst: updated,
    updated_at: new Date().toISOString(),
    updated_by: actorEmail || 'ar-agent',
  }).eq('id', 1);
  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  return target;
}

export async function updateDueDate(rowId, newDueDate, actorEmail) {
  const row = await fetchForecastRow();
  const ar = row.ar_fcst || [];
  const target = ar.find((r) => String(r.id) === String(rowId));
  if (!target) throw new Error(`AR row ${rowId} not found`);

  const updated = ar.map((r) =>
    String(r.id) === String(rowId) ? { ...r, dueDate: newDueDate } : r
  );

  const { error } = await sb.from('forecast_data').update({
    ar_fcst: updated,
    updated_at: new Date().toISOString(),
    updated_by: actorEmail || 'ar-agent',
  }).eq('id', 1);
  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  return { ...target, previousDueDate: target.dueDate, dueDate: newDueDate };
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

  const { error } = await sb.from('forecast_data').update({
    ar_fcst: updated,
    updated_at: new Date().toISOString(),
    updated_by: actorEmail || 'ar-agent',
  }).eq('id', 1);
  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  return target;
}

function usdFmt(n) {
  return (n || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
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
    { type: 'header', text: { type: 'plain_text', text: `AR: drafts to raise for ${month}` } },
    { type: 'divider' },
  ];

  for (const d of drafts) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${d.client}* (${d.entity})\n${usdFmt(d.usdValue || d.amount)} · ${d.mode || '—'} · due ${d.dueDate || d.cashMonth || '—'}`,
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

export function formatPaymentNudgeBlocks(rows, opts = {}) {
  const { csmUserId, escalationDays = 7 } = opts;
  if (rows.length === 0) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'No outstanding invoices past their due date. 🎉' },
      },
    ];
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'AR: payments to chase' } },
    { type: 'divider' },
  ];

  for (const r of rows) {
    const overdue = r.daysPastDue >= escalationDays;
    const lag =
      r.daysPastDue === 0
        ? 'due today'
        : r.daysPastDue > 0
        ? `${r.daysPastDue}d past due`
        : `due in ${-r.daysPastDue}d`;
    const tag = overdue && csmUserId ? ` · <@${csmUserId}> please chase` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${r.client}* (${r.entity}) · \`${r.invoiceNo}\`\n${usdFmt(r.usdValue || r.amount)} · ${r.mode || '—'} · ${lag}${tag}`,
      },
    });
    blocks.push({
      type: 'actions',
      block_id: `ar_actions_${r.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark as Paid' },
          style: 'primary',
          action_id: 'ar_mark_paid',
          value: String(r.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update due date' },
          action_id: 'ar_update_due',
          value: String(r.id),
        },
      ],
    });
  }
  return blocks;
}

export function raisedModal(rowId, client, invoiceMonth, channelId, messageTs) {
  return {
    type: 'modal',
    callback_id: 'ar_raised_submit',
    private_metadata: JSON.stringify({ rowId, channelId, messageTs }),
    title: { type: 'plain_text', text: 'Mark invoice raised' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${client}* · ${invoiceMonth}\nEnter the invoice number as it appears in Xero.` },
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
        label: { type: 'plain_text', text: 'Invoice date' },
        element: {
          type: 'datepicker',
          action_id: 'value',
          initial_date: new Date().toISOString().slice(0, 10),
        },
      },
    ],
  };
}

export function dueDateModal(rowId, client, invoiceNo, currentDueDate, channelId, messageTs) {
  return {
    type: 'modal',
    callback_id: 'ar_due_submit',
    private_metadata: JSON.stringify({ rowId, channelId, messageTs }),
    title: { type: 'plain_text', text: 'Update due date' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${client}* · \`${invoiceNo}\`\nCurrent due: ${currentDueDate || '—'}\n\nSet a new expected payment date. The bot will resume chasing after this date.`,
        },
      },
      {
        type: 'input',
        block_id: 'new_due_date',
        label: { type: 'plain_text', text: 'New due date' },
        element: {
          type: 'datepicker',
          action_id: 'value',
          initial_date: currentDueDate || new Date().toISOString().slice(0, 10),
        },
      },
    ],
  };
}

export function paidModal(rowId, client, invoiceNo, channelId, messageTs) {
  return {
    type: 'modal',
    callback_id: 'ar_paid_submit',
    private_metadata: JSON.stringify({ rowId, channelId, messageTs }),
    title: { type: 'plain_text', text: 'Mark invoice paid' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${client}* · \`${invoiceNo}\`\nWhen did the payment land?` },
      },
      {
        type: 'input',
        block_id: 'payment_date',
        label: { type: 'plain_text', text: 'Payment date' },
        element: {
          type: 'datepicker',
          action_id: 'value',
          initial_date: new Date().toISOString().slice(0, 10),
        },
      },
    ],
  };
}
