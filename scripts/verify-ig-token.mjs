// Verify an Instagram publishing token BEFORE deploying.
//
//   PowerShell:
//     $env:IG_PUBLISH_TOKEN = Read-Host "Paste token"
//     node scripts/verify-ig-token.mjs
//
// Prints: token validity, granted scopes (flags any missing), and your
// IG_USER_ID. NEVER prints the token. Safe to paste the OUTPUT into chat.

const GRAPH = 'https://graph.facebook.com/v22.0';
const TOKEN = process.env.IG_PUBLISH_TOKEN || process.env.META_WHATSAPP_TOKEN;
const REQUIRED = ['instagram_basic', 'instagram_content_publish', 'pages_show_list'];

async function g(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(JSON.stringify(d.error || d));
  return d;
}

async function main() {
  if (!TOKEN) {
    console.error('Set the token first:  $env:IG_PUBLISH_TOKEN = Read-Host "Paste token"   (no < > brackets)');
    process.exitCode = 1;
    return;
  }

  try {
    const me = await g('me', { fields: 'id,name' });
    console.log(`OK  token valid - ${me.name} (${me.id})`);

    const perms = (await g('me/permissions')).data
      .filter((p) => p.status === 'granted')
      .map((p) => p.permission);
    console.log('\nGranted scopes:');
    perms.forEach((p) => console.log('   -', p));
    const missing = REQUIRED.filter((r) => !perms.includes(r));
    if (missing.length) {
      console.log('\nMISSING required scopes:', missing.join(', '));
      console.log('   -> regenerate the token and tick these.');
    } else {
      console.log('\nOK  all required publishing scopes present.');
    }

    const accts = (await g('me/accounts', {
      fields: 'name,instagram_business_account{id,username,followers_count}',
    })).data || [];
    if (!accts.length) {
      console.log('\nNo Pages visible - token still missing pages_show_list, or no Page role.');
      process.exitCode = 2;
      return;
    }
    console.log('\nPages / Instagram accounts:');
    for (const a of accts) {
      const ig = a.instagram_business_account;
      console.log(
        `   Page "${a.name}"  ->  ${ig ? '@' + ig.username + '  IG_USER_ID=' + ig.id + '  (' + ig.followers_count + ' followers)' : '(no IG connected)'}`,
      );
    }
    const ig = accts.map((a) => a.instagram_business_account).find(Boolean);
    if (ig) console.log(`\n==> Put this in Vercel:  IG_USER_ID = ${ig.id}`);
  } catch (e) {
    console.error('\nCheck failed:', e.message);
    process.exitCode = 1;
  }
}

main();
