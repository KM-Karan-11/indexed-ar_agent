import 'dotenv/config';
import bolt from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import cron from 'node-cron';
import {
  currentInvoiceMonth,
  getDraftsForMonth,
  getOpenInvoices,
  markRaised,
  markPaid,
  updateDueDate,
  formatDraftBlocks,
  formatPaymentNudgeBlocks,
  raisedModal,
  paidModal,
  dueDateModal,
} from './ar.js';

const { App, ExpressReceiver } = bolt;

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  DRIVE_PARENT_FOLDER_ID,
  AR_AUTHORIZED_USERS = '',
  AR_CRON_CHANNEL_ID = '',
  AR_CSM_USER_ID = '',
  AR_MANAGER_ID = '',
  AR_BOOKKEEPER_ID = '',
  AR_OVERDUE_ESCALATION_DAYS = '7',
  AR_CRON_TIMEZONE = 'Asia/Kolkata',
  AR_ENABLE_CRON = 'true',
  PORT = 3000,
} = process.env;

const arAllowlist = AR_AUTHORIZED_USERS.split(',').map((s) => s.trim()).filter(Boolean);
function isArAuthorized(userId) {
  if (arAllowlist.length === 0) return true;
  return arAllowlist.includes(userId);
}

// Update the original list message so a completed row shows ✅ instead of a button.
// Fetches the message's current blocks, finds the section/actions blocks tagged
// with the rowId, strikes through the row text, and removes the button(s).
async function markListRowDone(client, channelId, messageTs, rowId, doneEmoji) {
  try {
    const res = await client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    });
    const msg = res.messages?.[0];
    if (!msg || !Array.isArray(msg.blocks)) return;

    const rowBlockId = `ar_row_${rowId}`;
    const actionsBlockId = `ar_actions_${rowId}`;

    const newBlocks = msg.blocks
      .map((b) => {
        if (b.block_id === rowBlockId) {
          const { accessory, ...rest } = b;
          const t = b.text?.text || '';
          return {
            ...rest,
            text: { ...b.text, text: `${doneEmoji} ~${t}~` },
          };
        }
        if (b.block_id === actionsBlockId) return null;
        return b;
      })
      .filter(Boolean);

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: msg.text || 'AR update',
      blocks: newBlocks,
    });
  } catch (err) {
    console.error('markListRowDone failed:', err.message);
  }
}

async function dmActorAndManager(client, actorId, text) {
  try {
    await client.chat.postMessage({ channel: actorId, text });
  } catch (err) {
    console.error('dm actor failed:', err.message);
  }
  if (AR_MANAGER_ID) {
    try {
      await client.chat.postMessage({ channel: AR_MANAGER_ID, text });
    } catch (err) {
      console.error('cc manager failed:', err.message);
    }
  }
}

const useSocketMode = Boolean(SLACK_APP_TOKEN);

const receiver = useSocketMode
  ? undefined
  : new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });

const boltApp = useSocketMode
  ? new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true })
  : new App({ token: SLACK_BOT_TOKEN, receiver });

const slack = new WebClient(SLACK_BOT_TOKEN);

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

let parentFolderName = 'the configured Drive folder';
try {
  const p = await drive.files.get({
    fileId: DRIVE_PARENT_FOLDER_ID,
    fields: 'name',
    supportsAllDrives: true,
  });
  if (p.data.name) parentFolderName = p.data.name;
} catch (err) {
  console.error('could not fetch parent folder name:', err.message);
}

if (receiver) {
  receiver.app.get('/', (_req, res) => res.send('drivebot ok'));
}

// key: `${channel}:${threadTs}` → { userId, files, files_expected_at }
const awaiting = new Map();
const AWAITING_TTL_MS = 10 * 60 * 1000;

function collectFiles(msg) {
  const out = [...(msg.files || [])];
  for (const att of msg.attachments || []) {
    if (Array.isArray(att.files)) out.push(...att.files);
  }
  return out;
}

async function resolveThreadFiles(channel, threadTs) {
  const thread = await slack.conversations.replies({ channel, ts: threadTs });
  const seen = new Set();
  const files = [];
  for (const msg of thread.messages || []) {
    for (const f of collectFiles(msg)) {
      if (f.id && !seen.has(f.id)) {
        seen.add(f.id);
        files.push(f);
      }
    }
  }
  return files;
}

async function uploadFilesToNewFolder({ folderName, files, channel, threadTs }) {
  const reply = (text) =>
    slack.chat.postMessage({ channel, thread_ts: threadTs, text });

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_PARENT_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const uploaded = [];
  for (const f of files) {
    const dl = await fetch(f.url_private_download, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (!dl.ok) {
      uploaded.push(`~${f.name}~ (download failed: ${dl.status})`);
      continue;
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const up = await drive.files.create({
      requestBody: { name: f.name, parents: [folder.data.id] },
      media: {
        mimeType: f.mimetype || 'application/octet-stream',
        body: Readable.from(buf),
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    uploaded.push(`<${up.data.webViewLink}|${f.name}>`);
  }

  await reply(
    `Uploaded to <${folder.data.webViewLink}|${folderName}>:\n${uploaded.join('\n')}`
  );
}

boltApp.event('app_mention', async ({ event, context }) => {
  const parentTs = event.thread_ts || event.ts;
  const key = `${event.channel}:${parentTs}`;
  const reply = (text) =>
    slack.chat.postMessage({ channel: event.channel, thread_ts: parentTs, text });

  try {
    const files = await resolveThreadFiles(event.channel, parentTs);

    if (files.length === 0) {
      await reply(
        `Hi! I'm drivebot — I save files from Slack into the Shared Drive under *${parentFolderName}*.\n\nI don't see any files in this thread yet. Attach the files (or forward a message with them) and mention me again.`
      );
      return;
    }

    awaiting.set(key, {
      userId: event.user,
      files,
      expiresAt: Date.now() + AWAITING_TTL_MS,
    });

    const preview = files
      .slice(0, 5)
      .map((f) => `• ${f.name}`)
      .join('\n');
    const more = files.length > 5 ? `\n…and ${files.length - 5} more` : '';
    await reply(
      `👋 Hi! I'm drivebot — I save files from Slack into the Shared Drive under *${parentFolderName}*.\n\nI found ${files.length} file${files.length === 1 ? '' : 's'} in this thread:\n${preview}${more}\n\nReply here with a folder name and I'll create it and upload the file${files.length === 1 ? '' : 's'} inside — e.g. \`Acme Corp\`.`
    );
  } catch (err) {
    console.error('app_mention error:', err);
    await reply(`Something broke: ${err.message}`);
  }
});

boltApp.message(async ({ event, context }) => {
  if (!event.thread_ts) return;
  if (event.subtype) return;
  if (event.bot_id || event.user === context.botUserId) return;

  const key = `${event.channel}:${event.thread_ts}`;
  const state = awaiting.get(key);
  if (!state) return;
  if (state.expiresAt < Date.now()) {
    awaiting.delete(key);
    return;
  }
  if (event.user !== state.userId) return;

  const text = (event.text || '')
    .replace(new RegExp(`<@${context.botUserId}>`, 'g'), '')
    .trim();
  if (!text) return;

  awaiting.delete(key);

  const reply = (t) =>
    slack.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: t });

  try {
    await uploadFilesToNewFolder({
      folderName: text,
      files: state.files,
      channel: event.channel,
      threadTs: event.thread_ts,
    });
  } catch (err) {
    console.error('upload error:', err);
    await reply(`Something broke: ${err.message}`);
  }
});

// ─── AR agent ──────────────────────────────────────────────────────
async function postDraftsCheck(channelId, { ccManager = false } = {}) {
  const month = currentInvoiceMonth();
  const drafts = await getDraftsForMonth(month);
  const result = await slack.chat.postMessage({
    channel: channelId,
    text: `AR drafts for ${month}`,
    blocks: formatDraftBlocks(drafts, month),
  });
  if (ccManager && AR_MANAGER_ID) {
    try {
      await slack.chat.postMessage({
        channel: AR_MANAGER_ID,
        text: `📣 AR drafts nudge posted in <#${channelId}> — ${drafts.length} draft${drafts.length === 1 ? '' : 's'} for ${month}`,
      });
    } catch (err) {
      console.error('cc manager (drafts) failed:', err.message);
    }
  }
  return result;
}

async function postPaymentCheck(channelId, { ccManager = false } = {}) {
  const open = await getOpenInvoices();
  const due = open.filter((r) => r.daysPastDue !== null && r.daysPastDue >= 0);
  const result = await slack.chat.postMessage({
    channel: channelId,
    text: 'AR: payments to chase',
    blocks: formatPaymentNudgeBlocks(due, {
      csmUserId: AR_CSM_USER_ID,
      escalationDays: Number(AR_OVERDUE_ESCALATION_DAYS),
    }),
  });
  if (ccManager && AR_MANAGER_ID) {
    try {
      await slack.chat.postMessage({
        channel: AR_MANAGER_ID,
        text: `📣 AR payments nudge posted in <#${channelId}> — ${due.length} invoice${due.length === 1 ? '' : 's'} past due`,
      });
    } catch (err) {
      console.error('cc manager (payments) failed:', err.message);
    }
  }
  return result;
}

boltApp.command('/invoice-check', async ({ ack, respond, command }) => {
  await ack();
  try {
    await postDraftsCheck(command.channel_id);
  } catch (err) {
    console.error('invoice-check error:', err);
    await respond({ response_type: 'ephemeral', text: `Invoice check failed: ${err.message}` });
  }
});

boltApp.command('/payment-check', async ({ ack, respond, command }) => {
  await ack();
  try {
    await postPaymentCheck(command.channel_id);
  } catch (err) {
    console.error('payment-check error:', err);
    await respond({ response_type: 'ephemeral', text: `Payment check failed: ${err.message}` });
  }
});

// ── Mark Raised button → modal → write ──
boltApp.action('ar_mark_raised', async ({ ack, body, client }) => {
  await ack();
  try {
    if (!isArAuthorized(body.user.id)) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: '🔒 Only the accountant or their manager can mark invoices as raised.',
      });
      return;
    }
    const rowId = body.actions[0].value;
    const drafts = await getDraftsForMonth(currentInvoiceMonth());
    const target = drafts.find((d) => String(d.id) === String(rowId));
    if (!target) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: 'That invoice was already updated or is no longer a draft.',
      });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: raisedModal(rowId, target.client, target.invoiceMonth, body.channel.id, body.message.ts),
    });
  } catch (err) {
    console.error('ar_mark_raised error:', err);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `Couldn't open the form: ${err.message}`,
    });
  }
});

boltApp.view('ar_raised_submit', async ({ ack, body, view, client }) => {
  if (!isArAuthorized(body.user.id)) {
    await ack({
      response_action: 'errors',
      errors: { invoice_no: 'You are not authorized to mark invoices as raised.' },
    });
    return;
  }

  const { rowId, channelId, messageTs } = JSON.parse(view.private_metadata || '{}');
  const invoiceNo = view.state.values.invoice_no?.value?.value?.trim();
  const invoiceDate = view.state.values.invoice_date?.value?.selected_date;

  if (!invoiceNo) {
    await ack({ response_action: 'errors', errors: { invoice_no: 'Invoice # is required' } });
    return;
  }

  await ack();
  try {
    const updated = await markRaised(rowId, invoiceNo, invoiceDate, body.user.username);
    const msg = `✅ *${updated.client}* marked raised: \`${invoiceNo}\` (${invoiceDate || 'today'}) — by <@${body.user.id}>`;
    if (channelId && messageTs) {
      await client.chat.postMessage({ channel: channelId, thread_ts: messageTs, text: msg });
      await markListRowDone(client, channelId, messageTs, rowId, '✅');
    }
    await dmActorAndManager(client, body.user.id, msg);
  } catch (err) {
    console.error('ar_raised_submit error:', err);
    await dmActorAndManager(client, body.user.id, `❌ Couldn't save to FP&A: ${err.message}`);
  }
});

// ── Mark Paid button → modal → write ──
boltApp.action('ar_mark_paid', async ({ ack, body, client }) => {
  await ack();
  try {
    if (!isArAuthorized(body.user.id)) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: '🔒 Only the accountant or their manager can mark invoices as paid.',
      });
      return;
    }
    const rowId = body.actions[0].value;
    const open = await getOpenInvoices();
    const target = open.find((r) => String(r.id) === String(rowId));
    if (!target) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: 'That invoice was already updated or is no longer open.',
      });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: paidModal(rowId, target.client, target.invoiceNo, body.channel.id, body.message.ts),
    });
  } catch (err) {
    console.error('ar_mark_paid error:', err);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `Couldn't open the form: ${err.message}`,
    });
  }
});

boltApp.view('ar_paid_submit', async ({ ack, body, view, client }) => {
  if (!isArAuthorized(body.user.id)) {
    await ack({
      response_action: 'errors',
      errors: { payment_date: 'You are not authorized to mark invoices as paid.' },
    });
    return;
  }

  const { rowId, channelId, messageTs } = JSON.parse(view.private_metadata || '{}');
  const paymentDate = view.state.values.payment_date?.value?.selected_date;
  if (!paymentDate) {
    await ack({ response_action: 'errors', errors: { payment_date: 'Payment date is required' } });
    return;
  }

  await ack();
  try {
    const updated = await markPaid(rowId, paymentDate, body.user.username);
    const msg = `💰 *${updated.client}* paid on ${paymentDate} — \`${updated.invoiceNo}\` closed by <@${body.user.id}>`;
    if (channelId && messageTs) {
      await client.chat.postMessage({ channel: channelId, thread_ts: messageTs, text: msg });
      await markListRowDone(client, channelId, messageTs, rowId, '💰');
    }
    await dmActorAndManager(client, body.user.id, msg);
  } catch (err) {
    console.error('ar_paid_submit error:', err);
    await dmActorAndManager(client, body.user.id, `❌ Couldn't save to FP&A: ${err.message}`);
  }
});

// ── Update due date button → modal → write ──
boltApp.action('ar_update_due', async ({ ack, body, client }) => {
  await ack();
  try {
    if (!isArAuthorized(body.user.id)) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: '🔒 Only the accountant or their manager can update due dates.',
      });
      return;
    }
    const rowId = body.actions[0].value;
    const open = await getOpenInvoices();
    const target = open.find((r) => String(r.id) === String(rowId));
    if (!target) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: 'That invoice was already updated or is no longer open.',
      });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: dueDateModal(rowId, target.client, target.invoiceNo, target.dueDate, body.channel.id, body.message.ts),
    });
  } catch (err) {
    console.error('ar_update_due error:', err);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `Couldn't open the form: ${err.message}`,
    });
  }
});

boltApp.view('ar_due_submit', async ({ ack, body, view, client }) => {
  if (!isArAuthorized(body.user.id)) {
    await ack({
      response_action: 'errors',
      errors: { new_due_date: 'You are not authorized to update due dates.' },
    });
    return;
  }

  const { rowId, channelId, messageTs } = JSON.parse(view.private_metadata || '{}');
  const newDueDate = view.state.values.new_due_date?.value?.selected_date;
  if (!newDueDate) {
    await ack({ response_action: 'errors', errors: { new_due_date: 'A date is required' } });
    return;
  }

  await ack();
  try {
    const updated = await updateDueDate(rowId, newDueDate, body.user.username);
    const msg = `📅 *${updated.client}* · \`${updated.invoiceNo}\` — due date moved ${updated.previousDueDate || '—'} → ${newDueDate} by <@${body.user.id}>. Bot will resume chasing after that date.`;
    if (channelId && messageTs) {
      await client.chat.postMessage({ channel: channelId, thread_ts: messageTs, text: msg });
    }
    await dmActorAndManager(client, body.user.id, msg);
  } catch (err) {
    console.error('ar_due_submit error:', err);
    await dmActorAndManager(client, body.user.id, `❌ Couldn't save to FP&A: ${err.message}`);
  }
});

// ── Cron: 1st of month + every Friday, morning IST ──
if (AR_ENABLE_CRON === 'true' && AR_CRON_CHANNEL_ID) {
  cron.schedule(
    '0 9 1 * *',
    async () => {
      try {
        console.log('[cron] 1st-of-month AR post');
        await postDraftsCheck(AR_CRON_CHANNEL_ID, { ccManager: true });
        await postPaymentCheck(AR_CRON_CHANNEL_ID, { ccManager: true });
      } catch (err) {
        console.error('cron 1st-of-month error:', err);
      }
    },
    { timezone: AR_CRON_TIMEZONE }
  );

  cron.schedule(
    '0 11 * * 1',
    async () => {
      try {
        console.log('[cron] Monday AR sweep');
        await postDraftsCheck(AR_CRON_CHANNEL_ID, { ccManager: true });
        await postPaymentCheck(AR_CRON_CHANNEL_ID, { ccManager: true });
      } catch (err) {
        console.error('cron Monday error:', err);
      }
    },
    { timezone: AR_CRON_TIMEZONE }
  );

  console.log(`AR cron scheduled (channel=${AR_CRON_CHANNEL_ID}, tz=${AR_CRON_TIMEZONE})`);
} else if (AR_ENABLE_CRON === 'true') {
  console.warn('AR_ENABLE_CRON is true but AR_CRON_CHANNEL_ID is empty — cron disabled');
}

if (useSocketMode) {
  await boltApp.start();
  console.log('drivebot connected via Socket Mode');
} else {
  await boltApp.start(PORT);
  console.log(`drivebot listening on ${PORT}`);
}
