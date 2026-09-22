/**
 * Switches to an already-downloaded version before the app starts.
 *
 * The service worker serves every file from one versioned cache, so a new
 * deployment only reaches a visitor once its worker takes over. Waiting for
 * a click meant most visits ran the previous build. At launch nothing is
 * running yet, so when a new version is already waiting and this is the only
 * emulator tab, it takes over and the page reloads before the app boots.
 * Another open tab may hold a running watch, so then the in-app notice asks.
 *
 * Resolves true when the page is reloading and the app should not start.
 */
export async function switchToWaitingVersion(
  container: ServiceWorkerContainer | undefined = navigator.serviceWorker,
  reload: () => void = () => location.reload(),
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    // No controller means a first visit: nothing old is being served.
    if (!container?.controller) return false;
    const waiting = (await container.getRegistration())?.waiting;
    if (!waiting) return false;
    if ((await ask(waiting, 'TABS', timeoutMs)) !== 1) return false;
    const switched = new Promise<boolean>((resolve) => {
      container.addEventListener('controllerchange', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), timeoutMs);
    });
    await ask(waiting, 'APPLY_UPDATE', timeoutMs);
    if (!(await switched)) return false;
    reload();
    return true;
  } catch {
    // Starting on the current version is always safe.
    return false;
  }
}

function ask(worker: ServiceWorker, type: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    channel.port1.onmessage = ({ data }) => {
      if (!data?.done) return;
      clearTimeout(timer);
      channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else resolve(data.value);
    };
    worker.postMessage({ type, id: crypto.randomUUID() }, [channel.port2]);
  });
}
