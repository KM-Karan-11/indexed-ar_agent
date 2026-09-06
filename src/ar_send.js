import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

async function fetchForecastRow() {
  const { data, error } = await sb
    .from('forecast_data')
    .select('ar_fcst')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return data;
}

async function fetchAllSendStates() {
  const { data, error } = await sb.from('ar_send_state').select('*');
  if (error) throw new Error(`ar_send_state read failed: ${error.message}`);
  const map = new Map();
  for (const r of data || []) map.set(r.row_id, r);
  return map;
}

export async function getSendState(rowId) {
  const { data, error } = await sb
    .from('ar_send_state')
    .select('*')
    .eq('row_id', String(rowId))
    .maybeSingle();
  if (error) throw new Error(`ar_send_state read failed: ${error.message}`);
  return data;
}

export async function upsertSendState(rowId, updates, actor) {
  const payload = {
    row_id: String(rowId),
    ...updates,
    last_updated_by: actor || 'ar-agent',
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from('ar_send_state')
    .upsert(payload)
    .select()
    .maybeSingle();
  if (error) throw new Error(`ar_send_state write failed: ${error.message}`);
  return data;
}

// Local YYYY-MM-DD in Asia/Kolkata so "today" is stable per accountant time zone.
function localDate(date = new Date(), tz = 'Asia/Kolkata') {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

// Sweep of what the daily cron should post. Returns { q1: [rows], q2: [rows] }.
// Q1 = "Send this invoice today?" — post when invoiceDate has arrived and no
// state exists yet.
// Q2 = "Has it been sent?" — post when the user confirmed sending is needed
// but not yet marked as sent, and we haven't nudged today already.
export async function getSendSweep(now = new Date()) {
  const today = localDate(now);
  const [{ ar_fcst = [] }, states] = await Promise.all([
    fetchForecastRow(),
    fetchAllSendStates(),
  ]);

  const q1 = [];
  const q2 = [];

  for (const r of ar_fcst) {
    if (!r.invoiceNo) continue;
    if (!r.invoiceDate) continue;
    if (r.status === 'Paid') continue;

    const state = states.get(String(r.id));

    // Q1 fires only on the exact invoice date and only if we've never asked before.
    // Anything back-dated is treated as historical and silently skipped —
    // no auto-catchup, no noise.
    if (!state) {
      if (r.invoiceDate === today) q1.push(r);
      continue;
    }
    if (state.send_confirmed === 'not_required') continue;
    if (state.sent_to_client === 'yes' || state.sent_to_client === 'not_required') continue;

    if (state.send_confirmed === 'yes') {
      const lastNudge = state.last_nudged_at ? localDate(new Date(state.last_nudged_at)) : null;
      if (lastNudge === today) continue; // already nudged today
      q2.push(r);
    }
  }

  return { q1, q2 };
}

function usdFmt(n) {
  return (n || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// Block builders — Q1 asks whether the invoice needs sending; Q2 asks whether it's been sent.
export function sendQ1Blocks(row) {
  const today = localDate();
  const dateLabel =
    row.invoiceDate === today
      ? `Invoice dated *today*.`
      : `Invoice dated *${row.invoiceDate}*.`;
  return [
    {
      type: 'section',
      block_id: `ar_send_q1_${row.id}`,
      text: {
        type: 'mrkdwn',
        text: `📤 *${row.client}* · \`${row.invoiceNo}\` (${usdFmt(row.usdValue || row.amount)})\n${dateLabel} Does this invoice need to be sent to the client?`,
      },
    },
    {
      type: 'actions',
      block_id: `ar_send_q1_actions_${row.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Yes' },
          style: 'primary',
          action_id: 'ar_send_q1_yes',
          value: String(row.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not required' },
          action_id: 'ar_send_q1_not_required',
          value: String(row.id),
        },
      ],
    },
  ];
}

export function sendQ2Blocks(row, opts = {}) {
  const nudgeSuffix = opts.repeatNudge ? ' _(daily nudge until answered)_' : '';
  return [
    {
      type: 'section',
      block_id: `ar_send_q2_${row.id}`,
      text: {
        type: 'mrkdwn',
        text: `✉️ *${row.client}* · \`${row.invoiceNo}\` (${usdFmt(row.usdValue || row.amount)})\nHas this invoice been sent to the client yet?${nudgeSuffix}`,
      },
    },
    {
      type: 'actions',
      block_id: `ar_send_q2_actions_${row.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Yes' },
          style: 'primary',
          action_id: 'ar_send_q2_yes',
          value: String(row.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No' },
          action_id: 'ar_send_q2_no',
          value: String(row.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not required' },
          action_id: 'ar_send_q2_not_required',
          value: String(row.id),
        },
      ],
    },
  ];
}

// Row info for a single id (used by button handlers to render the follow-up).
export async function getArRow(rowId) {
  const { ar_fcst = [] } = await fetchForecastRow();
  return ar_fcst.find((r) => String(r.id) === String(rowId)) || null;
}
