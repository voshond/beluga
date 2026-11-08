/**
 * Which Beluga this page is (BLG-53): the app on its own computer, the app as a client of a Beluga
 * server (the server's page in the app's window, src-tauri/src/remote.rs), or a browser. Each native
 * bit of docs/web.md's table takes the app's path or the browser's; in the client, files are the
 * server's (the web path) while the window's own bits are the app's.
 */

export type BootMode = 'app' | 'remote-app' | 'browser';
export type NativePath = 'app' | 'web';

export type PageFacts = { readonly shell: boolean; readonly protocol: string; readonly hostname: string; readonly dev: boolean };

export const bootModeOf = ({ shell, protocol, hostname, dev }: PageFacts): BootMode => {
  if (!shell) return 'browser';
  const appPage = protocol === 'tauri:' || hostname === 'tauri.localhost' || dev;
  return appPage ? 'app' : 'remote-app';
};

/** One entry per row of docs/web.md's native table: what the app as a client does there. */
export const REMOTE_APP_PATHS = {
  look: 'app',
  endpoint: 'web',
  clipboard: 'app',
  terminalPaste: 'app',
  notify: 'app',
  noticeList: 'app',
  openExternal: 'app',
  raise: 'app',
  pickFolders: 'web',
  pickImage: 'web',
  addProjectDrop: 'web',
  chatDrop: 'web',
  pastePlain: 'app',
  netAttach: 'web',
  netDrop: 'web',
  chatFiles: 'web',
  files: 'web',
  saveText: 'web',
  taskFiles: 'web',
  taskDrop: 'web',
  sidebarDrop: 'web',
  friendPaste: 'app',
  idle: 'app',
  tray: 'app',
  updates: 'app',
  menuBarPane: 'app',
  globalShortcut: 'app',
  appMenu: 'app',
  webHistory: 'web',
  menuKeys: 'app',
  sounds: 'app',
  access: 'app',
  windowActive: 'app',
  requestPopup: 'web',
  accessFolder: 'web',
  projectIcon: 'web',
  shareFolder: 'web',
} as const satisfies Record<string, NativePath>;

export type NativeRow = keyof typeof REMOTE_APP_PATHS;

export const nativePath = (row: NativeRow, mode: BootMode): NativePath => {
  if (mode === 'app') return 'app';
  if (mode === 'browser') return 'web';
  return REMOTE_APP_PATHS[row];
};

/** The app commands the server's page may call, through the `beluga` plugin (src-tauri/build.rs). */
export const CLIENT_COMMANDS = [
  'focus_window',
  'set_tray_status',
  'set_tray_presence',
  'set_tray_spout',
  'play_tray_spout',
  'set_menu_state',
  'set_menu_keys',
  'set_vibrancy',
  'take_pending_links',
  'system_idle_seconds',
  'sound_install',
  'sound_prune',
  'sound_play_system',
  'notification_access',
  'open_notification_settings',
  'open_focus_settings',
  'privacy_access',
  'privacy_request',
  'update_state',
  'update_check',
  'update_set_mode',
  'update_choose',
  'update_activity',
  'update_dismiss_news',
  'client_config',
  'client_use_local',
  'client_change_server',
  'client_set_device_name',
  'device_run',
  'device_file',
  'device_screenshot',
] as const;

export type ClientCommand = (typeof CLIENT_COMMANDS)[number];

/** What to invoke for an app command: the plugin's in the client, the app's own otherwise. */
export const commandName = (cmd: ClientCommand, mode: BootMode): string => (mode === 'remote-app' ? `plugin:beluga|${cmd}` : cmd);

/** This page's mode, from where it was loaded. */
export const bootMode = (): BootMode =>
  bootModeOf({
    shell: '__TAURI_INTERNALS__' in globalThis,
    protocol: typeof location === 'undefined' ? 'tauri:' : location.protocol,
    hostname: typeof location === 'undefined' ? '' : location.hostname,
    dev: Boolean((import.meta as ImportMeta & { readonly env?: { readonly DEV?: boolean } }).env?.DEV),
  });

/** Running inside the Tauri shell, either way: the window's own bits (notifications, clipboard, tray) are there. */
export const inShell = (): boolean => '__TAURI_INTERNALS__' in globalThis;
/** The app showing a Beluga server's page: the window is the app's, the files are the server's. */
export const remoteApp = (): boolean => bootMode() === 'remote-app';
/** Whether this native bit (a row of docs/web.md's table) takes the app's path here. */
export const native = (row: NativeRow): boolean => nativePath(row, bootMode()) === 'app';

/** An app command, through the `beluga` plugin when this is the server's page (src-tauri/src/remote.rs). */
export async function appInvoke<T>(cmd: ClientCommand, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(commandName(cmd, bootMode()), args);
}
