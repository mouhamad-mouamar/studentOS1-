// Google Drive attachment support via Google's OFFICIAL Picker + Identity
// Services (GIS). No simulation, no hardcoded links, no secrets:
//  - OAuth client ID / API key / app id are public-by-design identifiers, but
//    they must be provided through optional build-time env vars. When absent
//    the feature reports "not configured" instead of degrading silently.
//  - The OAuth *client secret* is never used — the GIS token-client flow does
//    not require one and no secret ever reaches frontend code.
//  - Minimal scope: drive.file — the non-sensitive per-file scope Google
//    documents for the Picker flow ("To obtain the token for any of these
//    views, use the https://www.googleapis.com/auth/drive.file scope"). It
//    grants access ONLY to files the user picks; there is no read-only
//    variant of it (drive.file.readonly does not exist).

const GIS_SRC = 'https://accounts.google.com/gsi/client';
// Documented loader: apis.google.com/js/api.js + gapi.load('picker').
const GAPI_SRC = 'https://apis.google.com/js/api.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const googleClientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
export const googleApiKey = (import.meta as any).env?.VITE_GOOGLE_API_KEY || '';
export const googleAppId = (import.meta as any).env?.VITE_GOOGLE_APP_ID || '';

export const driveConfigured = () => Boolean(googleClientId && googleApiKey && googleAppId);

// Supported course-material types (mirrors the server-side ACCEPT list;
// Google Docs-native types are excluded — the app cannot process them).
const SUPPORTED_EXT = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'mp4', 'mkv', 'mov'];
const SUPPORTED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain', 'text/markdown', 'text/csv',
  'image/png', 'image/jpeg', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a',
  'video/mp4', 'video/x-matroska', 'video/quicktime',
];

export function isDriveFileSupported(name: string, mime?: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return SUPPORTED_EXT.includes(ext) || (mime ? SUPPORTED_MIME.includes(mime) : false);
}

export type DrivePickedFile = { id: string; name: string; mimeType: string; sizeBytes?: number; iconUrl?: string };

let gisPromise: Promise<void> | null = null;
let pickerPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('SCRIPT_LOAD_FAILED'));
    document.head.appendChild(el);
  });
}

function ensureGis(): Promise<void> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  gisPromise = gisPromise || loadScript(GIS_SRC);
  return gisPromise;
}

// Loads the Picker library through the documented gapi loader.
function ensurePicker(): Promise<void> {
  if ((window as any).google?.picker) return Promise.resolve();
  pickerPromise = pickerPromise || loadScript(GAPI_SRC).then(
    () =>
      new Promise<void>((resolve, reject) => {
        try {
          (window as any).gapi.load('picker', {
            callback: () => resolve(),
            onerror: () => reject(new Error('SCRIPT_LOAD_FAILED')),
          });
        } catch {
          reject(new Error('SCRIPT_LOAD_FAILED'));
        }
      }),
  );
  return pickerPromise;
}

// Requests an access token with the minimal scope via GIS. The popup-based
// flow never needs a client secret. Rejects with 'AUTH_DENIED' when the user
// closes the consent window or denies the scope.
export async function requestDriveToken(): Promise<string> {
  await ensureGis();
  return new Promise((resolve, reject) => {
    try {
      const tc = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: googleClientId,
        scope: DRIVE_SCOPE,
        callback: (resp: any) => {
          if (resp?.access_token) resolve(resp.access_token);
          else reject(new Error('AUTH_DENIED'));
        },
        error_callback: (err: any) => {
          reject(new Error(err?.type === 'popup_closed' ? 'AUTH_CANCELLED' : 'AUTH_DENIED'));
        },
      });
      tc.requestAccessToken({ prompt: '' });
    } catch {
      reject(new Error('AUTH_FAILED'));
    }
  });
}

// Opens the official Google Picker. Resolves null when the user cancels.
export async function openDrivePicker(accessToken: string): Promise<DrivePickedFile[] | null> {
  await ensurePicker();
  const g = (window as any).google;
  return new Promise((resolve) => {
    const View = new g.picker.DocsView(g.picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes(SUPPORTED_MIME.join(','));
    const picker = new g.picker.PickerBuilder()
      .addView(View)
      .enableFeature(g.picker.Feature.NAV_ENABLED)
      .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(accessToken)
      .setDeveloperKey(googleApiKey)
      .setAppId(googleAppId)
      .setCallback((data: any) => {
        if (data.action === g.picker.Action.CANCELLED) {
          resolve(null);
        } else if (data.action === g.picker.Action.PICKED) {
          const docs = (data.docs || []).map((d: any) => ({
            id: d.id,
            name: d.name || 'file',
            mimeType: d.mimeType || '',
            sizeBytes: d.sizeBytes != null ? Number(d.sizeBytes) : undefined,
            iconUrl: d.iconUrl,
          }));
          resolve(docs);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Downloads the picked file with the per-file token and wraps it in a File so
// the existing upload pipeline (uploadMaterialFile → materials POST) can be
// reused unchanged. No document processing is duplicated.
export async function downloadDriveFile(accessToken: string, file: DrivePickedFile): Promise<File> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new Error('DRIVE_TOKEN_EXPIRED');
  if (!res.ok) throw new Error('DRIVE_DOWNLOAD_FAILED');
  const blob = await res.blob();
  return new File([blob], file.name, { type: file.mimeType || blob.type });
}

// Best-effort revocation of the per-file token (hygiene on unmount/call end).
export function revokeDriveToken(accessToken: string): void {
  try {
    (window as any).google?.accounts?.oauth2?.revoke(accessToken, () => {});
  } catch {}
}
