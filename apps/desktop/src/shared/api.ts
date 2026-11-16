// Contract between the remote SPA (through preload) and the main process.
// The SPA detects the desktop shell with `typeof window.lingerDesktop`.

export type RuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "draining"
  | "crashed";

export interface ComputerStatus {
  readonly bridge: string;
  readonly runtime: RuntimeState;
  readonly computerId?: string;
  readonly activeOperations: number;
  readonly preventSleep: boolean;
}

export interface WorkspaceGrantView {
  readonly grantId: string;
  readonly path: string;
  readonly label: string;
  readonly access: "read_write" | "read_only";
  readonly createdAt: string;
}

export interface DesktopSettings {
  readonly serverUrl: string;
  readonly displayName: string;
}

// Signing in with the owner account of the Linger this app installed; the
// password stays in the main process.
export type LocalAccountSignIn =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type DesktopPermissionId = "screen_recording" | "accessibility";

// A permission step this app takes on its own Mac. Linger is this app, so
// every step for it runs here; CuaDriver's own prompt and restart belong to
// the daemon, so only its System Settings pane opens from here.
export type DesktopPermissionStep =
  | {
      readonly action: "prompt";
      readonly subject: "linger";
      readonly permission: DesktopPermissionId;
    }
  | {
      readonly action: "open_settings";
      readonly subject: "linger" | "computer_use";
      readonly permission: DesktopPermissionId;
    }
  | { readonly action: "relaunch"; readonly subject: "linger" };

export type IMessageRuntimeState =
  | "missing"
  | "installing"
  | "ready"
  | "failed";

export type IMessageRuntimeError =
  | "download_failed"
  | "checksum_mismatch"
  | "extract_failed"
  | "executable_missing";

export type IMessageBridgeState =
  | "stopped"
  | "starting"
  | "running"
  | "signed_out"
  | "no_another_me"
  | "other_account"
  | "error";

export type IMessagePermissionState = "granted" | "denied" | "unknown";

// Chatting with Another Me from Messages on this Mac. `ready` holds when it
// is enabled, imsg is installed, every check passes and a handle is set.
export interface IMessageStatus {
  readonly enabled: boolean;
  readonly handles: readonly string[];
  readonly runtime: IMessageRuntimeState;
  readonly runtimeError?: IMessageRuntimeError;
  // `messagesNotSetUp`: Messages was never used on this Mac.
  readonly fullDisk: IMessagePermissionState | "messagesNotSetUp";
  readonly messagesAutomation: IMessagePermissionState;
  readonly iMessageSignedIn: "yes" | "no" | "unknown";
  readonly ready: boolean;
  readonly bridge: IMessageBridgeState;
}

export interface IMessagePatch {
  readonly enabled?: boolean;
  readonly handles?: readonly string[];
}

export type IMessageSetResult =
  | { readonly ok: true; readonly status: IMessageStatus }
  | {
      readonly ok: false;
      readonly code: "invalid_handle" | "too_many_handles";
      readonly message: string;
    };

export type IMessageAction =
  | "request_automation"
  | "open_full_disk_settings"
  | "open_automation_settings"
  | "retry_install";

export interface LingerDesktopApi {
  readonly version: string;
  readonly platform: "darwin" | "win32" | "linux";
  readonly computer: {
    getStatus(): Promise<ComputerStatus>;
    onStatus(callback: (status: ComputerStatus) => void): () => void;
    enroll(): Promise<{ computerId: string }>;
    unenroll(): Promise<void>;
  };
  readonly workspace: {
    pick(): Promise<WorkspaceGrantView | null>;
    list(): Promise<WorkspaceGrantView[]>;
    revoke(grantId: string): Promise<void>;
  };
  readonly settings: {
    get(): Promise<DesktopSettings>;
    set(patch: { displayName?: string }): Promise<DesktopSettings>;
  };
  // The owner account of the Linger installed on this computer.
  readonly localAccount: {
    // Whether the window shows that Linger; false for any other server.
    available(): Promise<boolean>;
    signIn(): Promise<LocalAccountSignIn>;
  };
  // macOS only.
  readonly permissions?: {
    act(step: DesktopPermissionStep): Promise<void>;
  };
  // macOS only.
  readonly imessage?: {
    // Checks again before answering.
    getStatus(): Promise<IMessageStatus>;
    onStatus(callback: (status: IMessageStatus) => void): () => void;
    set(patch: IMessagePatch): Promise<IMessageSetResult>;
    act(action: IMessageAction): Promise<IMessageStatus>;
  };
}

export const IPC = {
  computerStatus: "computer.status",
  computerStatusEvent: "computer.status.event",
  computerEnroll: "computer.enroll",
  computerUnenroll: "computer.unenroll",
  workspacePick: "workspace.pick",
  workspaceList: "workspace.list",
  workspaceRevoke: "workspace.revoke",
  settingsGet: "settings.get",
  settingsSet: "settings.set",
  permissionAct: "permission.act",
  imessageStatus: "imessage.status",
  imessageStatusEvent: "imessage.status.event",
  imessageSet: "imessage.set",
  imessageAct: "imessage.act",
  localAccountAvailable: "local-account.available",
  localAccountSignIn: "local-account.sign-in",
} as const;
