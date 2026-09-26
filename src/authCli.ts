import { getOAuthLoginUrl, openBrowser, startOAuthListener } from './auth.js';

async function runCliLogin() {
  const loginUrl = getOAuthLoginUrl();
  console.log('=====================================================');
  console.log('  Kambala WCAPI OAuth 2.0 Interactive Login');
  console.log('=====================================================');
  console.log(`Starting OAuth listener...`);
  console.log(`Opening browser to login URL:`);
  console.log(`  ${loginUrl}\n`);

  openBrowser(loginUrl);

  try {
    const session = await startOAuthListener();
    console.log('Login succeeded!');
    console.log('Session saved successfully.');
    console.log('You can now run the MCP server: npm start');
    process.exit(0);
  } catch (error) {
    console.error('Login process failed:', error);
    process.exit(1);
  }
}

runCliLogin();
