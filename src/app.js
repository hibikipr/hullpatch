// Installed-app features: offline support, an install button, and STL files handed
// to the app by the system (desktop "Open with", or the Android share sheet).

/** Register the service worker (production builds only; it caches the built files). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is a bonus; the page works the same without it.
    });
  });
}

/**
 * Show the install button when the browser offers to install the app (Chrome, Edge,
 * Android). Safari has no such offer; there it's Share → Add to Dock / Home Screen.
 */
export function setUpInstallButton(button) {
  if (!button) return;
  let offer = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    offer = e;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!offer) return;
    button.hidden = true;
    offer.prompt();
    await offer.userChoice.catch(() => null);
    offer = null;
  });
  window.addEventListener('appinstalled', () => {
    button.hidden = true;
    offer = null;
  });
}

/** Pass STL files the system hands to the app to `open(file)`. */
export function receiveFiles(open) {
  // Desktop: the app was chosen to open an .stl file (manifest file_handlers).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const handle = params.files && params.files[0];
      if (handle) open(await handle.getFile());
    });
  }

  // Android: a file was shared to the app. The service worker kept it in the cache
  // and opened the page with ?shared=1.
  const url = new URL(location.href);
  if (url.searchParams.has('shared')) {
    history.replaceState(null, '', url.pathname + url.hash);
    takeSharedFile().then((file) => file && open(file));
  }
}

async function takeSharedFile() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('hullpatch-shared');
    const res = await cache.match('/shared-file');
    if (!res) return null;
    await cache.delete('/shared-file');
    const name = decodeURIComponent(res.headers.get('x-file-name') || 'shared.stl');
    return new File([await res.blob()], name, { type: 'model/stl' });
  } catch {
    return null;
  }
}
