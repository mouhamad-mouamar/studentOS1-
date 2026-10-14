/*
 * Google Drive attachment tests — LOCAL/MOCK only.
 *  A. googleDrive.ts behavior with a mocked window.google + fetch:
 *     pick flow → File built correctly; picker cancel → null; unsupported
 *     type filter; download 401 → DRIVE_TOKEN_EXPIRED; download failure.
 *  B. Static wiring: MaterialsTab has the Drive button + confirmation card,
 *     existing file input (ACCEPT list) untouched, no client secrets.
 *  C. i18n: drive* keys present and parallel in en + ar.
 * No real Google calls are made. Run: node scripts/drive-attach-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

const ROOT = path.join(__dirname, '..');

(async () => {

// Build the TS to JS for behavior testing (esbuild is present via vite).
const OUT = path.join(process.env.TEMP || '/tmp', 'drive-lib-test-' + Date.now() + '.mjs');
execSync(`npx esbuild src/lib/googleDrive.ts --bundle --format=esm --outfile="${OUT}" --define:import.meta.env='{}'`, { cwd: ROOT, stdio: 'pipe' });

const mod = await import('file:///' + OUT.replace(/\\/g, '/'));
const { isDriveFileSupported, downloadDriveFile, driveConfigured } = mod;

// A1. Supported/unsupported filtering
ok('supported: pdf by extension', isDriveFileSupported('lecture.pdf'));
ok('supported: docx by mime', isDriveFileSupported('notes', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
ok('unsupported: google docs native (no usable ext)', !isDriveFileSupported('Untitled', 'application/vnd.google-apps.document'));
ok('unsupported: exe', !isDriveFileSupported('virus.exe', 'application/x-msdownload'));
ok('unsupported: no ext no mime', !isDriveFileSupported('file'));

// A2. driveConfigured false without env
ok('not configured without env vars', driveConfigured() === false);

// A3. downloadDriveFile builds a File with correct name/type
{
  let calledUrl = '', calledAuth = '';
  global.fetch = async (url, opts) => {
    calledUrl = String(url);
    calledAuth = opts.headers.Authorization;
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }) };
  };
  const f = await downloadDriveFile('TOKEN123', { id: 'abc', name: 'lecture.pdf', mimeType: 'application/pdf' });
  ok('download: Drive v3 alt=media URL used', calledUrl.includes('googleapis.com/drive/v3/files/abc?alt=media'), calledUrl);
  ok('download: per-file Bearer token used', calledAuth === 'Bearer TOKEN123');
  ok('download: File built with name+mime', f instanceof File && f.name === 'lecture.pdf' && f.type === 'application/pdf');
}
// A4. download 401 → DRIVE_TOKEN_EXPIRED
{
  global.fetch = async () => ({ ok: false, status: 401, blob: async () => new Blob() });
  let code = '';
  try { await downloadDriveFile('t', { id: 'x', name: 'a.pdf', mimeType: '' }); } catch (e) { code = e.message; }
  ok('download: 401 → DRIVE_TOKEN_EXPIRED', code === 'DRIVE_TOKEN_EXPIRED', code);
}
// A5. download 500 → DRIVE_DOWNLOAD_FAILED
{
  global.fetch = async () => ({ ok: false, status: 500, blob: async () => new Blob() });
  let code = '';
  try { await downloadDriveFile('t', { id: 'x', name: 'a.pdf', mimeType: '' }); } catch (e) { code = e.message; }
  ok('download: 500 → DRIVE_DOWNLOAD_FAILED', code === 'DRIVE_DOWNLOAD_FAILED', code);
}

// A6. popup_closed_by_user → AUTH_CANCELLED (silent cancel)
{
  (global.window = global.window || {}).google = {
    accounts: {
      oauth2: {
        initTokenClient: ({ callback, error_callback }) => ({
          requestAccessToken: () => error_callback({ type: 'popup_closed_by_user' }),
        }),
      },
    },
  };
  let code = '';
  try { await mod.requestDriveToken(); } catch (e) { code = e.message; }
  ok('auth: popup_closed_by_user → AUTH_CANCELLED (silent)', code === 'AUTH_CANCELLED', code);
}
// A6b. popup_failed_to_open → POPUP_BLOCKED (dedicated message path)
{
  global.window.google.accounts.oauth2.initTokenClient = ({ error_callback }) => ({
    requestAccessToken: () => error_callback({ type: 'popup_failed_to_open' }),
  });
  let code = '';
  try { await mod.requestDriveToken(); } catch (e) { code = e.message; }
  ok('auth: popup_failed_to_open → POPUP_BLOCKED', code === 'POPUP_BLOCKED', code);
}
// A6c. other GIS errors → AUTH_DENIED
{
  global.window.google.accounts.oauth2.initTokenClient = ({ error_callback }) => ({
    requestAccessToken: () => error_callback({ type: 'access_denied' }),
  });
  let code = '';
  try { await mod.requestDriveToken(); } catch (e) { code = e.message; }
  ok('auth: other GIS error → AUTH_DENIED', code === 'AUTH_DENIED', code);
}
// A6d. preload warms both scripts without throwing
{
  delete global.window.google; // drop GIS mock so ensureGis must load scripts
  if (!global.document) global.document = { createElement: () => ({}), head: { appendChild: () => {} } };
  let loaded = [];
  const realAppend = document.head.appendChild.bind(document.head);
  document.head.appendChild = (el) => { if (el && el.src) loaded.push(el.src); return el; };
  mod.preloadDriveAssets();
  await new Promise((r) => setTimeout(r, 0));
  document.head.appendChild = realAppend;
  ok('preload: warms GIS + gapi scripts', loaded.some((s) => s.includes('gsi/client')) && loaded.some((s) => s.includes('apis.google.com/js/api.js')), loaded.join(','));
}
// A7. Token granted → resolved, with NO prompt override (GIS default
// select_account; prompt:'' breaks under Testing-mode consent enforcement)
{
  global.window.google = { accounts: { oauth2: {} } };
  let overrideArg;
  global.window.google.accounts.oauth2.initTokenClient = ({ callback }) => ({
    requestAccessToken: (o) => { overrideArg = o; callback({ access_token: 'AT' }); },
  });
  const tok = await mod.requestDriveToken();
  ok('auth: access token resolved', tok === 'AT');
  ok('auth: no prompt override sent (Testing-mode safe)', overrideArg === undefined, String(overrideArg));
}
// A8. Picker cancel → null; picked → mapped docs
{
  const handlers = {};
  global.window.google = global.window.google || {};
  global.window.google.picker = {
    ViewId: { DOCS: 'docs' },
    Feature: { NAV_ENABLED: 'nav', MULTISELECT_ENABLED: 'multi' },
    Action: { CANCELLED: 'cancel', PICKED: 'picked' },
    DocsView: function (v) { this.setIncludeFolders = () => this; this.setSelectFolderEnabled = () => this; this.setMimeTypes = () => this; },
    PickerBuilder: function () {
      this.addView = () => this; this.enableFeature = () => this;
      this.setOAuthToken = (t) => { handlers.token = t; return this; };
      this.setDeveloperKey = () => this; this.setAppId = () => this;
      this.setCallback = (cb) => { handlers.cb = cb; return this; };
      this.build = () => ({ setVisible: () => {} });
    },
  };
  const p1 = mod.openDrivePicker('AT');
  await new Promise((r) => setTimeout(r, 0));
  handlers.cb({ action: 'cancel' });
  ok('picker: cancel → null', (await p1) === null);
  const p2 = mod.openDrivePicker('AT');
  await new Promise((r) => setTimeout(r, 0));
  handlers.cb({ action: 'picked', docs: [{ id: '1', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: '2048' }] });
  const docs = await p2;
  ok('picker: picked → mapped with token + sizeBytes', docs.length === 1 && docs[0].id === '1' && handlers.token === 'AT' && docs[0].sizeBytes === 2048);
}

// B. Static wiring in MaterialsTab
const tab = fs.readFileSync(path.join(ROOT, 'src/components/course/MaterialsTab.tsx'), 'utf8');
ok('tab: Drive button present', tab.includes("onClick={pickFromDrive}") && tab.includes('t.driveAttach'));
ok('tab: confirmation card with name+type before upload', tab.includes('confirmDriveUpload') && tab.includes('drivePicked.file.name'));
ok('tab: existing file input + ACCEPT untouched', tab.includes("type=\"file\"") && /const ACCEPT = '\.pdf,\.pptx,\.ppt,\.docx,\.doc,\.txt,\.md,\.csv,\.png,\.jpg,\.jpeg,\.webp,\.mp3,\.wav,\.m4a,\.mp4,\.mkv,\.mov';/.test(tab));
ok('tab: reuses uploadMaterialFile (no duplicate pipeline)', tab.includes('uploadMaterialFile'));
ok('tab: upload only after explicit confirm', tab.indexOf('confirmDriveUpload') < tab.indexOf('onClick={confirmDriveUpload}'));
ok('tab: not-configured message shown when unconfigured', tab.includes('driveNotConfigured'));
const driveLib = fs.readFileSync(path.join(ROOT, 'src/lib/googleDrive.ts'), 'utf8');
ok('lib: no client secret handling', !/client_secret|clientSecret/i.test(driveLib));
ok('lib: scope is documented drive.file (per-file, non-sensitive)', /export const DRIVE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/drive\.file';/.test(driveLib));
ok('lib: Picker loaded via documented gapi loader', driveLib.includes('apis.google.com/js/api.js') && driveLib.includes("gapi.load('picker'"));
ok('lib: official scripts (GIS + gapi)', driveLib.includes('accounts.google.com/gsi/client'));
ok('lib: revocation helper present', driveLib.includes('revokeDriveToken') && driveLib.includes('oauth2?.revoke'));
ok('lib: pre-download size metadata mapped', driveLib.includes('sizeBytes'));
ok('tab: pre-download size check before download', tab.indexOf('sizeBytes != null') > -1 && tab.indexOf('sizeBytes != null') < tab.indexOf('downloadDriveFile(driveTokenRef'));
ok('tab: token revoked on unmount', tab.includes('revokeDriveToken(driveTokenRef.current)'));
ok('tab: scripts preloaded on mount when configured', tab.includes('preloadDriveAssets()') && tab.indexOf('preloadDriveAssets()') < tab.indexOf('revokeDriveToken(driveTokenRef.current)'));

// C. i18n parallelism
const i18n = fs.readFileSync(path.join(ROOT, 'src/lib/i18n.tsx'), 'utf8');
const keys = ['driveAttach', 'driveNotConfigured', 'driveAuthDenied', 'driveUnsupported', 'driveTooLarge', 'drivePopupBlocked', 'driveNetworkError', 'driveAddToCourse', 'driveFile'];
for (const k of keys) {
  const n = (i18n.match(new RegExp('    ' + k + ':', 'g')) || []).length;
  ok('i18n: ' + k + ' in en+ar', n === 2, 'count=' + n);
}

fs.unlinkSync(OUT);
if (failed) {
  console.error(`DRIVE ATTACH TEST FAILED: ${failed}`);
  process.exit(1);
}
console.log('DRIVE ATTACH TEST PASSED');
})();
