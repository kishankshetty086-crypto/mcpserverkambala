import crypto from 'crypto';
import fs from 'fs';
import express from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { config } from './config.js';

export interface SessionData {
  susertoken: string;
  uid?: string;
  actid?: string;
  lastaccesstime?: string;
  loginTime: string;
}

/**
 * Computes SHA-256 checksum for Kambala OAuth GenAcsTok:
 * SHA256(clientId + secretKey + code)
 */
export function generateChecksum(clientId: string, secretKey: string, code: string): string {
  const combined = `${clientId}${secretKey}${code}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Returns saved session from local storage if available
 */
export function getStoredSession(): SessionData | null {
  if (process.env.SUSERTOKEN) {
    return {
      susertoken: process.env.SUSERTOKEN,
      uid: process.env.TRADER_UID || 'KKSINV',
      actid: process.env.TRADER_ACTID || 'KKSINV',
      loginTime: new Date().toISOString(),
    };
  }
  try {
    if (fs.existsSync(config.sessionFile)) {
      const data = fs.readFileSync(config.sessionFile, 'utf-8');
      return JSON.parse(data) as SessionData;
    }
  } catch (error) {
    console.error('Error reading session file:', error);
  }
  return null;
}

/**
 * Saves active session to local storage
 */
export function saveSession(session: SessionData): void {
  fs.writeFileSync(config.sessionFile, JSON.stringify(session, null, 2), 'utf-8');
}

/**
 * Clears current session
 */
export function clearSession(): void {
  if (fs.existsSync(config.sessionFile)) {
    fs.unlinkSync(config.sessionFile);
  }
}

/**
 * Exchanges auth code for susertoken via /NorenWClientAPI/GenAcsTok
 */
export async function exchangeCodeForToken(code: string): Promise<SessionData> {
  const checksum = generateChecksum(config.clientId, config.secretKey, code);
  const payload = `jData=${JSON.stringify({ code, checksum })}`;

  const response = await axios.post(`${config.wcapiBaseUrl}/NorenWClientAPI/GenAcsTok`, payload, {
    headers: {
      'Content-Type': 'text/plain',
    },
  });

  const data = response.data;
  if (data.stat !== 'Ok' || !data.susertoken) {
    throw new Error(`Token generation failed: ${data.emsg || JSON.stringify(data)}`);
  }

  const session: SessionData = {
    susertoken: data.susertoken,
    lastaccesstime: data.lastaccesstime,
    loginTime: new Date().toISOString(),
  };

  saveSession(session);
  return session;
}

/**
 * Generates OAuth Login URL
 */
export function getOAuthLoginUrl(): string {
  const url = new URL(config.oauthAuthUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  return url.toString();
}

/**
 * Opens a URL in the user's default browser
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

/**
 * Starts temporary local callback listener to intercept the auth code and exchange it.
 */
export function startOAuthListener(port = config.port): Promise<SessionData> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server: ReturnType<typeof app.listen>;

    app.get('/oauth/callback', async (req, res) => {
      const code = req.query.code as string;
      if (!code) {
        res.status(400).send(`
          <html>
            <body style="font-family:sans-serif; text-align:center; padding:50px;">
              <h2 style="color:red;">Login Failed</h2>
              <p>Missing 'code' parameter in authorization callback.</p>
            </body>
          </html>
        `);
        return;
      }

      try {
        const session = await exchangeCodeForToken(code);
        res.send(`
          <html>
            <head><title>Authentication Successful</title></head>
            <body style="font-family:sans-serif; text-align:center; padding:60px; background:#f4f6f9;">
              <div style="max-width:500px; margin:auto; background:white; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                <h2 style="color:#10b981; margin-bottom:10px;">✓ Authentication Successful!</h2>
                <p style="color:#4b5563; font-size:16px;">Kambala WCAPI access token has been generated and saved securely.</p>
                <div style="background:#f3f4f6; padding:12px; border-radius:8px; margin:20px 0; font-size:14px; color:#374151;">
                  <strong>Client ID:</strong> ${config.clientId}<br/>
                  <strong>Session Active:</strong> ${new Date().toLocaleTimeString()}
                </div>
                <p style="color:#6b7280; font-size:14px;">You can now close this browser tab and start chatting in Claude Desktop / AI Assistant.</p>
              </div>
            </body>
          </html>
        `);

        // Close server after short delay
        setTimeout(() => {
          server.close();
          resolve(session);
        }, 1500);
      } catch (err: any) {
        res.status(500).send(`
          <html>
            <body style="font-family:sans-serif; text-align:center; padding:50px;">
              <h2 style="color:red;">Token Exchange Error</h2>
              <p>${err.message}</p>
            </body>
          </html>
        `);
        setTimeout(() => {
          server.close();
          reject(err);
        }, 1500);
      }
    });

    server = app.listen(port, () => {
      console.log(`[OAuth] Temporary callback listener running on http://localhost:${port}/oauth/callback`);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
