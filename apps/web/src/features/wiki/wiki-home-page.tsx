import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Building03Icon,
} from "@hugeicons/core-free-icons";
import {
  lazy,
  type KeyboardEvent,
  type ReactNode,
  Suspense,
  useMemo,
  useRef,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { EmptyNote } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useTabIndicator } from "@/components/ui/tab-indicator";
import { dateTimeFormat } from "@/lib/date-format";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import { documentFileName } from "@/features/library/document-display-name";
import { useWikiDocuments } from "./knowledge-sidebar-trees";
import { WikiDailyCard } from "./wiki-daily-card";
import {
  wikiEntries,
  type WikiEntry,
  wikiPreviewPages,
  type WikiPreviewPage,
} from "./wiki-preview-pages";
import { WikiProfileEditButton } from "./wiki-profile-edit-button";
import { usePersonalWikiRefresh, type WikiRefreshStatus } from "./wiki-refresh";
import { WikiRefreshBanner } from "./wiki-refresh-status";
import { useAnotherMeActorId } from "./wiki-working-card";
import { wikiPreviewPath } from "./wiki-preview-page";
import {
  useWikiDisplayState,
  wikiCollection,
  wikiPageKey,
  wikiPagePath,
  type WikiCollection,
} from "./wiki-display-state";
import { parseEmbeddedWikiGraph } from "@/features/memory/wiki-graph-model";
import {
  reportDate,
  usePeriodReports,
} from "@/features/memory/wiki-period-reports";
import "./wiki-home-page.css";

/** Town palette roles for the People and Companies cards. */
const entityHues = [
  "var(--color-bluebell-700)",
  "var(--color-acorn-700)",
  "var(--color-lavender-700)",
  "var(--color-grass-700)",
  "var(--color-sun-700)",
  "var(--color-rain-700)",
];
const dateFormatter = dateTimeFormat({ day: "numeric", month: "short" });

export function pageName(page: TeamHubDocument) {
  return documentFileName(page).replace(/\.md$/i, "");
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (
    words.length > 1
      ? `${words[0]![0]}${words[words.length - 1]![0]}`
      : (words[0] ?? "?").slice(0, 2)
  ).toUpperCase();
}

/** People and companies take the palette in order; a member keeps one hue. */
function entityColors(key: number | string) {
  let index = typeof key === "number" ? key : 0;
  if (typeof key === "string")
    for (const char of key) index = (index * 31 + char.codePointAt(0)!) | 0;
  const color = entityHues[Math.abs(index) % entityHues.length]!;
  return {
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    color,
  };
}

export function editedLabel(page: TeamHubDocument) {
  const date = new Date(page.updated_at);
  return Number.isNaN(date.valueOf())
    ? ""
    : `Edited ${dateFormatter.format(date)}`;
}

/** Graph nodes by Wiki page key; descriptions and links feed the cards. */
export function useWikiGraphNodes(tenantId: string) {
  const { client } = useTeamHubRuntime();
  const graph = useQuery({
    queryFn: () => client.getPersonalKnowledgeGraphVisualization(tenantId),
    queryKey: ["teamhub", tenantId, "personal-wiki", "graph"],
    retry: false,
  });
  return useMemo(
    () =>
      new Map(
        (graph.data ? parseEmbeddedWikiGraph(graph.data)?.nodes : [])?.map(
          (node) => [node.id, node],
        ),
      ),
    [graph.data],
  );
}

export function useWikiCollectionPages(tenantId: string) {
  const documents = useWikiDocuments(tenantId);
  const display = useWikiDisplayState(tenantId);
  const pages = (
    documents.data?.pages.flatMap((page) => page.items) ?? []
  ).filter(
    (page) =>
      page.from.some((source) => source.binding_kind === "wiki_page") &&
      !/\/index\.md$/i.test(wikiPagePath(page)) &&
      display.decisions[wikiPageKey(wikiPagePath(page))] !== "delete",
  );
  const of = (collection: WikiCollection) =>
    pages.filter((page) => wikiCollection(page) === collection);
  return {
    pending: documents.isPending,
    error: Boolean(documents.error),
    refetch: () => void documents.refetch(),
    of,
    /** The collection's cards with the running refresh's pages in place. */
    entries: (collection: WikiCollection, previews: WikiPreviewPage[]) =>
      wikiEntries(
        of(collection),
        previews.filter((page) => display.decisions[page.key] !== "delete"),
        collection,
      ),
  };
}

const homeTabs = [
  { id: "profile", label: "Profile" },
  { id: "wiki", label: "Wiki" },
] as const;
type WikiHomeTab = (typeof homeTabs)[number]["id"];

const ProfilePage = lazy(async () => {
  const { WikiProfilePage } = await import("./wiki-profile-page");
  return { default: WikiProfilePage };
});

/**
 * Wiki opens on the reader's Profile; the Wiki tab holds the generated pages.
 */
export function WikiHomePage() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: WikiHomeTab =
    searchParams.get("tab") === "wiki" ? "wiki" : "profile";
  const refresh = usePersonalWikiRefresh(tenantId);
  const { tabRef, indicator } = useTabIndicator(tab);
  const tabButtons = useRef(new Map<WikiHomeTab, HTMLButtonElement>());
  function selectTab(next: WikiHomeTab) {
    setSearchParams(next === "wiki" ? { tab: "wiki" } : {});
  }
  // The tab list is one Tab stop: arrows move focus and selection together.
  function onTabKeyDown(event: KeyboardEvent<HTMLElement>) {
    const current = homeTabs.findIndex((candidate) => candidate.id === tab);
    let next: number | undefined;
    if (event.key === "ArrowLeft")
      next = (current - 1 + homeTabs.length) % homeTabs.length;
    else if (event.key === "ArrowRight") next = (current + 1) % homeTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = homeTabs.length - 1;
    const target = next === undefined ? undefined : homeTabs[next]!;
    if (!target) return;
    event.preventDefault();
    selectTab(target.id);
    tabButtons.current.get(target.id)?.focus();
  }
  return (
    <main className="workspace-content-viewport workspace-scrollbar wiki-landing min-w-0 flex-1 overflow-y-auto bg-app-surface [scrollbar-gutter:stable]">
      {/* Same column, heading and tabs as the Library page. */}
      <div className="workspace-file-browser">
        <h1 className="sr-only">Wiki</h1>
        {/* Profile and Wiki tabs head the page in the Library column. */}
        <header className="wiki-home-header flex items-center gap-3">
          <div
            aria-label="Wiki views"
            className="workspace-file-tabs relative flex max-w-full gap-1 overflow-x-auto"
            role="tablist"
          >
            {homeTabs.map((candidate) => {
              const indicatorRef = tabRef(candidate.id);
              return (
                <button
                  aria-controls={`wiki-home-panel-${candidate.id}`}
                  aria-selected={candidate.id === tab}
                  className="workspace-view-tab inline-flex h-8 shrink-0 items-center rounded-md px-3 text-lg font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  id={`wiki-home-tab-${candidate.id}`}
                  key={candidate.id}
                  onClick={() => selectTab(candidate.id)}
                  onKeyDown={onTabKeyDown}
                  ref={(node) => {
                    indicatorRef(node);
                    if (node) tabButtons.current.set(candidate.id, node);
                    else tabButtons.current.delete(candidate.id);
                  }}
                  role="tab"
                  tabIndex={candidate.id === tab ? 0 : -1}
                  type="button"
                >
                  {candidate.label}
                </button>
              );
            })}
            {indicator}
          </div>
          {tab === "wiki" ? null : (
            <WikiProfileEditButton tenantId={tenantId} />
          )}
        </header>
        <div
          aria-labelledby={`wiki-home-tab-${tab}`}
          id={`wiki-home-panel-${tab}`}
          role="tabpanel"
        >
          {tab === "wiki" ? (
            <WikiOverview refresh={refresh} tenantId={tenantId} />
          ) : (
            <div className="landing-profile-tab">
              <Suspense fallback={<ProfileSkeleton />}>
                <ProfilePage />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Card-shaped placeholders in a section's own grid, so loading never jumps. */
function SectionSkeleton({
  className,
  count,
  height,
  label,
}: {
  className: string;
  count: number;
  height: string;
  label: string;
}) {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">{label}</span>
      <div className={className}>
        {Array.from({ length: count }, (_, index) => (
          <Skeleton className={`${height} w-full rounded-[14px]`} key={index} />
        ))}
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4" role="status">
      <span className="sr-only">Loading Profile…</span>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-40 w-full rounded-[14px]" />
    </div>
  );
}

/** A failed section, with the retry that recovers it. */
function SectionError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div
      aria-label={label}
      className="landing-empty flex flex-wrap items-center gap-3"
      role="alert"
    >
      <span>{label}</span>
      <Button onClick={onRetry} size="compact" tone="secondary">
        Retry
      </Button>
    </div>
  );
}

/** The generated Wiki: Daily reports and the page collections. While a
 * refresh runs, the pages it has written appear in their collections. */
function WikiOverview({
  refresh,
  tenantId,
}: {
  refresh: WikiRefreshStatus;
  tenantId: string;
}) {
  const { preview, refreshing } = refresh;
  const navigate = useNavigate();
  const collections = useWikiCollectionPages(tenantId);
  const nodes = useWikiGraphNodes(tenantId);
  const reports = usePeriodReports(tenantId, "daily");
  const previews = useMemo(() => wikiPreviewPages(preview), [preview]);
  const anotherMe = useAnotherMeActorId(tenantId);
  const base = `/t/${encodeURIComponent(tenantId)}/library/wiki`;
  const documentPath = (page: TeamHubDocument) =>
    `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(page.id)}`;
  const daily = [...(reports.data ?? [])]
    .filter(reportDate)
    .sort((a, b) => (reportDate(b) ?? "").localeCompare(reportDate(a) ?? ""));
  const projects = collections.entries("projects", previews);
  const topics = collections.entries("topics", previews);
  const people = collections.entries("contacts", previews);
  const companies = collections.entries("clients", previews);
  const peopleById = new Map(
    people.map((entry) => [entry.key, entryName(entry)]),
  );
  const description = (entry: WikiEntry) =>
    entry.preview
      ? entry.preview.description
      : nodes.get(entry.key)?.description;
  const subtitle = (entry: WikiEntry) =>
    description(entry) || (entry.published ? editedLabel(entry.published) : "");
  const card = { documentPath, tenantId };
  // A collection section while its pages load, fail, or hold nothing yet.
  const status = (empty: string, skeleton: ReactNode) =>
    collections.pending ? (
      skeleton
    ) : collections.error ? (
      <SectionError
        label="Pages are unavailable."
        onRetry={collections.refetch}
      />
    ) : refreshing ? null : (
      <EmptyNote className="landing-empty">{empty}</EmptyNote>
    );

  return (
    <>
      <div className="landing-notices">
        <WikiRefreshBanner {...refresh} agentActorId={anotherMe} />
      </div>
      <div className="landing-grid">
        <div className="landing-col landing-col-left">
          <section className="landing-section landing-daily">
            <SectionHeader
              title="Daily report"
              count={daily.length}
              to={`${base}/graph`}
            />
            {reports.isPending ? (
              <SectionSkeleton
                className="daily-list"
                count={2}
                height="h-36"
                label="Loading daily reports…"
              />
            ) : reports.error ? (
              <SectionError
                label="Reports are unavailable."
                onRetry={() => void reports.refetch()}
              />
            ) : daily.length ? (
              <div className="daily-list">
                {daily.slice(0, 2).map((entry) => {
                  const day = reportDate(entry)!;
                  const open = () =>
                    void navigate(
                      `${base}/graph?day=${encodeURIComponent(day)}`,
                    );
                  return (
                    <WikiDailyCard
                      key={entry.id}
                      tenantId={tenantId}
                      day={day}
                      entry={entry}
                      onOpen={open}
                    />
                  );
                })}
              </div>
            ) : (
              <EmptyNote className="landing-empty">
                No daily reports yet.
              </EmptyNote>
            )}
          </section>
          <EntryCards
            {...card}
            className="landing-projects"
            title="Projects"
            to={`${base}/projects`}
            entries={projects}
            empty={status(
              "No projects yet.",
              <SectionSkeleton
                className="projects-grid"
                count={3}
                height="h-32"
                label="Loading projects…"
              />,
            )}
            description={description}
            members={(entry) =>
              [
                ...new Set([
                  ...(nodes.get(entry.key)?.links ?? []),
                  ...(nodes.get(entry.key)?.backlinks ?? []),
                ]),
              ]
                .map((id) => peopleById.get(id))
                .filter((name): name is string => Boolean(name))
                .slice(0, 3)
            }
          />
          <EntryCards
            {...card}
            className="landing-topics"
            title="Topics"
            to={`${base}/topics`}
            entries={topics}
            empty={status(
              "No topics yet.",
              <SectionSkeleton
                className="projects-grid"
                count={3}
                height="h-32"
                label="Loading topics…"
              />,
            )}
            description={description}
            members={() => []}
          />
        </div>
        <div className="landing-col landing-col-right">
          <section className="landing-section landing-people">
            <SectionHeader
              title="People"
              count={people.length}
              to={`${base}/contacts`}
            />
            {people.length ? (
              <div className="people-grid">
                {people.slice(0, 4).map((entry, index) => (
                  <WikiEntryLink
                    {...card}
                    className="person-card"
                    entry={entry}
                    key={entry.key}
                  >
                    <span className="person-avatar" style={entityColors(index)}>
                      {initials(entryName(entry))}
                    </span>
                    <span className="person-name">{entryName(entry)}</span>
                    <span className="person-role">{subtitle(entry)}</span>
                  </WikiEntryLink>
                ))}
              </div>
            ) : (
              status(
                "No people yet.",
                <SectionSkeleton
                  className="people-grid"
                  count={4}
                  height="h-[88px]"
                  label="Loading people…"
                />,
              )
            )}
          </section>
          <section className="landing-section landing-companies">
            <SectionHeader
              title="Companies"
              count={companies.length}
              to={`${base}/clients`}
            />
            {companies.length ? (
              <div className="companies-grid">
                {companies.slice(0, 6).map((entry, index) => (
                  <WikiEntryLink
                    {...card}
                    className="company-card"
                    entry={entry}
                    key={entry.key}
                  >
                    <span className="company-icon" style={entityColors(index)}>
                      <Icon icon={Building03Icon} size={16} />
                    </span>
                    <span className="company-info">
                      <span className="company-name">{entryName(entry)}</span>
                      <span className="company-desc">{subtitle(entry)}</span>
                    </span>
                  </WikiEntryLink>
                ))}
              </div>
            ) : (
              status(
                "No companies yet.",
                <SectionSkeleton
                  className="companies-grid"
                  count={3}
                  height="h-[55px]"
                  label="Loading companies…"
                />,
              )
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function entryName(entry: WikiEntry) {
  return entry.preview ? entry.preview.name : pageName(entry.published);
}

/** A card opens its page: the published Document, or the page the running
 * refresh is writing, in the same page layout. */
export function WikiEntryLink({
  children,
  className,
  documentPath,
  entry,
  tenantId,
}: {
  children: ReactNode;
  className: string;
  documentPath: (page: TeamHubDocument) => string;
  entry: WikiEntry;
  tenantId: string;
}) {
  return (
    <Link
      className={className}
      to={
        entry.published
          ? documentPath(entry.published)
          : wikiPreviewPath(tenantId, entry.preview.path)
      }
    >
      {children}
    </Link>
  );
}

/** Projects and Topics: three cards with a description, edit date and members. */
function EntryCards({
  className,
  title,
  to,
  entries,
  empty,
  documentPath,
  tenantId,
  description,
  members,
}: {
  className: string;
  title: string;
  to: string;
  entries: WikiEntry[];
  empty: ReactNode;
  documentPath: (page: TeamHubDocument) => string;
  tenantId: string;
  description: (entry: WikiEntry) => string | undefined;
  members: (entry: WikiEntry) => string[];
}) {
  return (
    <section className={`landing-section ${className}`}>
      <SectionHeader title={title} count={entries.length} to={to} />
      {entries.length ? (
        <div className="projects-grid">
          {entries.slice(0, 3).map((entry) => (
            <WikiEntryLink
              className="project-card"
              documentPath={documentPath}
              entry={entry}
              key={entry.key}
              tenantId={tenantId}
            >
              <span className="project-card-title">{entryName(entry)}</span>
              <span className="project-card-desc">{description(entry)}</span>
              <span className="project-card-meta">
                <span className="project-card-time">
                  {entry.published ? editedLabel(entry.published) : ""}
                </span>
                <span className="project-involvers">
                  {members(entry).map((name) => (
                    <span
                      className="project-involver"
                      key={name}
                      style={{
                        background: `color-mix(in srgb, ${entityColors(name).color} 18%, var(--app-surface))`,
                      }}
                      title={name}
                    >
                      {initials(name)}
                    </span>
                  ))}
                </span>
              </span>
            </WikiEntryLink>
          ))}
        </div>
      ) : (
        empty
      )}
    </section>
  );
}

function SectionHeader({
  title,
  count,
  to,
}: {
  title: string;
  count: number;
  to: string;
}) {
  return (
    <header className="landing-section-header">
      <h2 className="landing-section-title">
        {title}
        <span className="section-count">{count}</span>
      </h2>
      <Link className="landing-view-all" to={to}>
        View all
        <Icon icon={ArrowRight02Icon} size={14} />
      </Link>
    </header>
  );
}

export function WikiBack() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  return (
    <Link
      aria-label="Back to Wiki"
      className="wiki-back"
      to={`/t/${encodeURIComponent(tenantId)}/library/wiki?tab=wiki`}
    >
      <Icon icon={ArrowLeft02Icon} size={16} />
      Back
    </Link>
  );
}
