import { secondaryNavigationHeaderClass } from "@/components/ui/secondary-navigation";
import { Skeleton } from "@/components/ui/skeleton";
import type { TeamHubRoomListItem } from "@/features/teamhub/teamhub-types";

/**
 * The Room list inside the secondary navigation while it first loads. Mirrors
 * the room row (a 32px tile and two text lines) so the rail reads as pending
 * the same way the content column does, instead of a bare line of text.
 */
export function RoomNavigationLoading() {
  return (
    <section aria-hidden="true" className="space-y-1">
      <div className="flex h-7 items-center pl-2">
        <Skeleton className="h-3 w-14" />
      </div>
      {["w-28", "w-20", "w-32", "w-24", "w-16"].map((width) => (
        <div
          className="flex min-h-[56px] items-center gap-2 px-2 py-2.5"
          key={width}
        >
          <Skeleton className="size-8 shrink-0 rounded-[10px]" />
          <div className="min-w-0 flex-1 px-1">
            <Skeleton className={`h-3 ${width}`} />
            <Skeleton className="mt-2 h-2 w-2/3" />
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * The chat column while the lazy Room chat module loads (the header is already
 * painted by the Room surface). Mirrors {@link ChatLoading} so the conversation
 * reads as pending with message skeletons instead of a bare line of text.
 */
export function RoomChatLoading() {
  // Covers the whole Room surface, header included, so the real header does
  // not show its title and actions while the conversation is still loading;
  // everything appears together once the chat is ready.
  return (
    <div
      aria-busy="true"
      aria-label="Loading conversation"
      className="absolute inset-0 z-[12] flex min-h-0 flex-col bg-app-surface"
      role="status"
    >
      <span className="sr-only">Loading conversation…</span>
      <RoomHeaderLoading />
      <ChatLoading />
    </div>
  );
}

export function AuthenticatedRouteLoading({
  pathname,
  rooms,
}: {
  pathname: string;
  rooms: TeamHubRoomListItem[];
}) {
  const route = classifyRoute(pathname, rooms);

  return (
    <div
      aria-busy="true"
      aria-label={`Loading ${route.label}`}
      className="route-loading-surface flex min-h-0 flex-1 overflow-hidden bg-app-surface"
      data-loading-route={route.kind}
      role="status"
    >
      <span className="sr-only">Loading {route.label}...</span>
      {route.kind === "room" ? (
        <RoomLoading />
      ) : route.kind === "dashboard" ? (
        <DashboardLoading />
      ) : route.kind === "library" ? (
        <LibraryLoading />
      ) : route.kind === "connectors" ? (
        <ConnectorsLoading />
      ) : route.kind === "settings" ? (
        <SettingsLoading />
      ) : route.kind === "document" ? (
        <DocumentLoading heading={route.label} />
      ) : (
        <PageLoading />
      )}
    </div>
  );
}

type LoadingRoute =
  | { kind: "connectors"; label: string }
  | { kind: "dashboard"; label: string }
  | { kind: "document"; label: string }
  | { kind: "library"; label: string }
  | { kind: "page"; label: string }
  | { kind: "room"; label: string }
  | { kind: "settings"; label: string };

function classifyRoute(
  pathname: string,
  rooms: TeamHubRoomListItem[],
): LoadingRoute {
  const segments = pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  const documentsIndex = segments.indexOf("documents");
  if (documentsIndex >= 0 && segments[documentsIndex + 1]) {
    return { kind: "document", label: "Document" };
  }
  if (roomsIndex >= 0 && segments[roomsIndex + 1]) {
    const roomId = decodeURIComponent(segments[roomsIndex + 1]!);
    const room = rooms.find((candidate) => candidate.id === roomId);
    return { kind: "room", label: room?.name ?? "Room" };
  }
  if (roomsIndex >= 0) {
    return { kind: "page", label: "Rooms" };
  }
  // Settings sections include Computers, so Settings is read before it.
  if (segments.includes("settings")) {
    return { kind: "settings", label: "Settings" };
  }
  if (segments.includes("computers")) {
    return { kind: "page", label: "Local computers" };
  }
  if (segments.includes("apps")) {
    return { kind: "connectors", label: "Connectors" };
  }
  if (segments.includes("dashboard")) {
    return { kind: "dashboard", label: "Dashboard" };
  }
  // An open meeting keeps the Library sidebar beside the reader, so it loads
  // like a Document rather than like the Library landing pages.
  if (segments.includes("meetings")) {
    return { kind: "document", label: "Meeting" };
  }
  if (segments.includes("library")) {
    return {
      kind: "library",
      label: segments.includes("wiki") ? "Wiki" : "Library",
    };
  }
  return { kind: "page", label: "Library" };
}

/**
 * The Room surface while it loads: header and conversation as shapes only, so
 * no title, avatar or status text arrives ahead of the rest of the Room.
 */
function RoomLoading() {
  return (
    <section
      className="app-room-surface flex min-w-0 flex-1 flex-col border-r border-border/60"
      aria-hidden="true"
    >
      <RoomHeaderLoading />
      <div className="room-surface-card flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatLoading />
      </div>
    </section>
  );
}

/** Mirrors the Room header's geometry: avatar, title, members and actions. */
function RoomHeaderLoading() {
  return (
    <header className="room-chat-header room-header flex h-(--app-header-height) shrink-0 items-center gap-3.5 border-b border-transparent bg-app-surface pl-2.5 pr-4">
      <Skeleton className="size-8 shrink-0 rounded-[10px]" />
      <Skeleton className="h-3.5 w-32" />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <Skeleton className="h-[18px] w-16 rounded-full" />
        <Skeleton className="size-4" />
        <Skeleton className="size-4" />
      </div>
    </header>
  );
}

/** Enough message rows, with varied body lengths, to fill a typical viewport. */
const CHAT_LOADING_ROWS: ReadonlyArray<{ lines: string[] }> = [
  { lines: ["w-3/4", "w-2/5"] },
  { lines: ["w-11/12", "w-4/5", "w-1/3"] },
  { lines: ["w-2/5"] },
  { lines: ["w-5/6", "w-1/2"] },
  { lines: ["w-3/5"] },
  { lines: ["w-11/12", "w-3/4", "w-2/5"] },
  { lines: ["w-1/2"] },
  { lines: ["w-4/5", "w-1/3"] },
];

function ChatLoading() {
  return (
    <div
      className="room-chat-column flex min-h-0 flex-1 flex-col"
      aria-hidden="true"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3">
        {/* Fill the column from the bottom with a full conversation's worth of
            rows (the top overflows and clips) so the loaded timeline — usually
            a screen full of messages — does not pop in above an empty gap. */}
        <div className="room-readable mt-auto space-y-3 pt-3 pb-5">
          {CHAT_LOADING_ROWS.map((row, index) => (
            <div className="room-message-card" key={index}>
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 pt-1 pl-2">
                <div className="flex h-[18px] items-center gap-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-2 w-10" />
                </div>
                {row.lines.map((width, lineIndex) => (
                  <Skeleton
                    className={`${lineIndex === 0 ? "mt-3" : "mt-2"} h-3 ${width}`}
                    key={lineIndex}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="room-composer-dock shrink-0 px-3">
        <div className="room-readable flex h-[50px] items-center gap-4 rounded-[var(--composer-radius)] border border-app-border px-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-28 max-w-[40%]" />
          <Skeleton className="ml-auto size-8 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden="true">
      <header className="shrink-0 border-b border-border/60 px-5 py-4 sm:px-8">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </header>
      <div
        className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden p-4 lg:grid-cols-4"
        data-testid="loading-dashboard-columns"
      >
        {[0, 1, 2, 3].map((column) => (
          <section
            className="min-w-0 rounded-xl bg-app-sidebar p-3"
            key={column}
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-4 h-20 w-full" />
            <Skeleton className="mt-2 h-16 w-full" />
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The Library sidebar is chrome, so it stays in place while the route module
 * loads and only the content column reads as pending. Its geometry follows
 * {@link LibrarySidebar}: a Back to Library header over a tree of rows.
 */
function WorkspaceSidebarLoading() {
  return (
    <>
      <aside
        aria-hidden="true"
        className="workspace-scrollbar shrink-0 overflow-y-auto bg-app-surface px-2 pb-3 max-sm:hidden sm:w-[calc(var(--sidebar-width)+20px)] sm:pl-[10px] sm:pr-[18px]"
        data-testid="loading-workspace-sidebar"
      >
        <div
          className={`${secondaryNavigationHeaderClass} sticky top-0 z-10 bg-app-surface`}
        >
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
        <div className="space-y-0.5 pt-2">
          {TREE_LOADING_ROWS.map((row) => (
            <div
              className={`flex h-8 items-center gap-2 ${row.indent}`}
              key={row.id}
            >
              <Skeleton className="size-3.5 shrink-0 rounded-[3px]" />
              <Skeleton className={`h-3 ${row.width}`} />
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-0.5">
          {TREE_LOADING_MEETINGS.map((width) => (
            <div className="flex h-8 items-center gap-2 px-1.5" key={width}>
              <Skeleton className="size-3.5 shrink-0 rounded-[3px]" />
              <Skeleton className={`h-3 ${width}`} />
            </div>
          ))}
        </div>
      </aside>
      <div className="relative hidden w-px shrink-0 bg-border sm:block" />
    </>
  );
}

/** Collapsible tree rows: a folder, the pages inside it, then two more folders. */
const TREE_LOADING_ROWS: ReadonlyArray<{
  id: string;
  indent: string;
  width: string;
}> = [
  { id: "folder-1", indent: "px-1.5", width: "w-24" },
  { id: "page-1", indent: "pl-6 pr-1.5", width: "w-32" },
  { id: "page-2", indent: "pl-6 pr-1.5", width: "w-20" },
  { id: "page-3", indent: "pl-6 pr-1.5", width: "w-28" },
  { id: "folder-2", indent: "px-1.5", width: "w-20" },
  { id: "folder-3", indent: "px-1.5", width: "w-28" },
];

const TREE_LOADING_MEETINGS: ReadonlyArray<string> = ["w-24", "w-32", "w-20"];

const LIBRARY_LOADING_ROWS: ReadonlyArray<{ id: string; width: string }> = [
  { id: "file-1", width: "w-1/2" },
  { id: "file-2", width: "w-2/5" },
  { id: "file-3", width: "w-3/5" },
  { id: "file-4", width: "w-1/3" },
  { id: "file-5", width: "w-1/2" },
  { id: "file-6", width: "w-2/5" },
];

/**
 * The Library and Wiki landing pages render no sidebar, so their pending state
 * is one centered file browser. Keeping the sidebar out here avoids a horizontal
 * snap when the real page arrives without one.
 */
function LibraryLoading() {
  return (
    <main
      aria-hidden="true"
      className="workspace-content-viewport workspace-scrollbar min-w-0 flex-1 overflow-y-auto bg-app-surface [scrollbar-gutter:stable]"
    >
      <div className="workspace-file-browser">
        <header className="workspace-files-heading">
          <Skeleton className="h-7 w-24" />
          <div className="ml-auto flex items-center gap-1">
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
        </header>
        <section className="workspace-recent">
          <Skeleton className="mb-2 h-3.5 w-16" />
          <div className="workspace-recent-cards">
            {[0, 1, 2, 3].map((card) => (
              <div className="workspace-recent-card" key={card}>
                <div className="workspace-recent-link">
                  <div className="workspace-recent-icon">
                    <Skeleton className="size-4 rounded-[3px]" />
                  </div>
                  <Skeleton className="h-3.5 w-4/5" />
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="mt-2 h-2.5 w-16" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <div
          className="workspace-file-tabs relative flex max-w-full gap-1 overflow-x-auto"
          data-testid="loading-library-tabs"
        >
          {["w-16", "w-24", "w-20"].map((width) => (
            <div
              className="inline-flex h-9 shrink-0 items-center px-3"
              key={width}
            >
              <Skeleton className={`h-3.5 ${width}`} />
            </div>
          ))}
        </div>
        <div className="workspace-file-filters">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-36 rounded-full" />
        </div>
        <div className="workspace-file-list">
          {LIBRARY_LOADING_ROWS.map(({ id, width }) => (
            <div className="workspace-file-row" key={id}>
              <div className="workspace-file-name">
                <Skeleton className="size-4 shrink-0 rounded-[3px]" />
                <Skeleton className={`h-3.5 ${width}`} />
              </div>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="size-4 justify-self-end rounded-[3px]" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

/**
 * Connectors is one centered browser column: a title, the category tabs with
 * the Connected only toggle, then the three-column card grid.
 */
function ConnectorsLoading() {
  return (
    <main
      aria-hidden="true"
      className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-background [scrollbar-gutter:stable]"
    >
      <div className="workspace-file-browser">
        <Skeleton className="mb-5 h-8 w-40" />
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {["w-10", "w-20", "w-24", "w-16"].map((width) => (
              <div
                className="inline-flex h-9 shrink-0 items-center px-3"
                key={width}
              >
                <Skeleton className={`h-3.5 ${width}`} />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
        <div
          className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="loading-connector-cards"
        >
          {[0, 1, 2, 3, 4, 5].map((card) => (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
              key={card}
            >
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

/**
 * Settings is a page in the Space shell: its own sections beside the rail and
 * one centered column of content, so no Library chrome appears here.
 */
function SettingsLoading() {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-0 flex-1 flex-col md:flex-row"
    >
      <aside className="flex shrink-0 flex-col border-b border-border px-3 py-4 md:w-[228px] md:border-r md:border-b-0">
        <div className="flex items-center pt-0.5 pb-3.5">
          <Skeleton className="h-6 w-20" />
        </div>
        <div className="flex gap-0.5 overflow-x-auto md:flex-col">
          {["w-16", "w-20", "w-24"].map((width) => (
            <div
              className="flex h-[33px] shrink-0 items-center gap-2 px-2 py-1.5"
              key={width}
            >
              <Skeleton className="size-3.5 shrink-0 rounded-[3px]" />
              <Skeleton className={`h-3 ${width}`} />
            </div>
          ))}
        </div>
      </aside>
      <div className="workspace-content-viewport workspace-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6 md:px-8">
        <div className="mx-auto w-full max-w-(--app-settings-width) space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

function DocumentLoading({ heading }: { heading: string }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <WorkspaceSidebarLoading />
      <main className="workspace-content-viewport flex min-w-0 flex-1 flex-col bg-app-surface">
        <header
          aria-hidden="true"
          className="flex h-(--app-header-height) shrink-0 items-center gap-2 border-b border-border/60 px-3 sm:px-5"
        >
          <span className="text-sm font-medium text-foreground">{heading}</span>
        </header>
        <div
          aria-label={`Loading ${heading} body`}
          className="workspace-content px-5 py-12 sm:px-0"
          role="status"
        >
          <Skeleton className="h-10 w-3/5" />
          <Skeleton className="mt-4 h-4 w-2/5" />
          <div className="mt-12 space-y-3">
            {["w-full", "w-[94%]", "w-[86%]", "w-[98%]", "w-[72%]"].map(
              (width) => (
                <Skeleton className={`h-4 ${width}`} key={width} />
              ),
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="min-w-0 flex-1 px-6 py-7" aria-hidden="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="workspace-content mt-6 h-24" />
      <Skeleton className="workspace-content mt-3 h-24" />
    </div>
  );
}
