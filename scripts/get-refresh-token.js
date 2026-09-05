import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

const app = express();
app.get('/oauth-callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.status(400).send('missing code');
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n=== REFRESH TOKEN ===');
    console.log(tokens.refresh_token);
    console.log('\nAdd this to .env and to Railway as GOOGLE_REFRESH_TOKEN');
    res.send('Got it — check your terminal. You can close this tab.');
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log(`\nWaiting for callback on ${REDIRECT_URI} ...\n`);
});
