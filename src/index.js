import 'dotenv/config';
import bolt from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { google } from 'googleapis';
import { Readable } from 'node:stream';

const { App, ExpressReceiver } = bolt;

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  DRIVE_PARENT_FOLDER_ID,
  PORT = 3000,
} = process.env;

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
        'No files in this thread — attach the files (or forward a message that has them) and mention me again.'
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
      `Found ${files.length} file${files.length === 1 ? '' : 's'}:\n${preview}${more}\n\nReply in this thread with the folder name to create.`
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

if (useSocketMode) {
  await boltApp.start();
  console.log('drivebot connected via Socket Mode');
} else {
  await boltApp.start(PORT);
  console.log(`drivebot listening on ${PORT}`);
}
