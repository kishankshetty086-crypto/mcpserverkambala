import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables from project root .env
dotenv.config({ path: path.resolve(projectRoot, '.env') });

export interface AppConfig {
  projectRoot: string;
  wcapiBaseUrl: string;
  apiPrefix: string;
  oauthAuthUrl: string;
  clientId: string;
  secretKey: string;
  redirectUri: string;
  port: number;
  sessionFile: string;
}

export const config: AppConfig = {
  projectRoot,
  wcapiBaseUrl: (process.env.WCAPI_BASE_URL || 'https://rama.kambala.co.in').replace(/\/$/, ''),
  apiPrefix: process.env.WCAPI_PREFIX || '/NorenWClientWeb',
  oauthAuthUrl: process.env.OAUTH_AUTH_URL || 'https://rama.kambala.co.in/NorenWeb2.0/authorize/oauth',
  clientId: process.env.CLIENT_ID || 'KKSINV_U',
  secretKey: process.env.SECRET_KEY || 'v7dEItTCfHurgCgnn0g3HfdlfsSOzVdd6uXFPBX2NsnFMx2Z9FKR0YYyzftOE605',
  redirectUri: process.env.REDIRECT_URI || 'http://localhost:3000/oauth/callback',
  port: parseInt(process.env.PORT || '3000', 10),
  sessionFile: path.resolve(projectRoot, process.env.SESSION_FILE || '.session.json'),
};
