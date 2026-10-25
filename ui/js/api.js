const T = window.__TAURI__;

export const invoke = (cmd, args = {}) => T.core.invoke(cmd, args);
export const listen = (event, cb) => T.event.listen(event, (e) => cb(e.payload));
export const fileSrc = (path) => (path ? T.core.convertFileSrc(path) : '');
export const appWindow = T.window.getCurrentWindow();
export const webview = () => T.webview.getCurrentWebview();
export const openUrl = (url) => invoke('open_url', { url }).catch(() => {});
