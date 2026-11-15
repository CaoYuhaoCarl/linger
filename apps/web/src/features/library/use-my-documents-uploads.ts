import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { rememberUploadedImage } from "@/features/rooms/files/uploaded-image-preview";
import {
  createTeamHubIdempotencyKey,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import { documentUploadRepresentationFormat } from "./document-upload-representation";
import {
  fileUploadBatch,
  tenantUploads,
  type PendingDocumentUpload,
  type UploadBatch,
  type UploadFailure,
  useTenantUploads,
} from "./library-upload-queue";
import {
  type DocumentTreeFolder,
  type ExternalDocumentDrop,
  folderKey,
  nextAvailableFolderName,
  nextAvailableUploadFilename,
  nextPaint,
  runSequentially,
  uploadFailureMessage,
  usedDocumentFilenames,
} from "./my-documents-tree-helpers";
import type { MyDocumentsCreating } from "./use-my-documents-tree-create";

interface MyDocumentsUploadsInput {
  creating: MyDocumentsCreating;
  expandFolder: (folderId?: string) => void;
  items: TeamHubDocumentPlacementNode[];
  onChanged: () => Promise<unknown>;
  setCreating: (creating: MyDocumentsCreating) => void;
  setError: (error: string | null) => void;
  tenantId: string;
}

interface UploadFolderContext {
  client: TeamHubClient;
  items: TeamHubDocumentPlacementNode[];
  onChanged: () => Promise<unknown>;
  tenantId: string;
}

/**
 * Imports, folder uploads and external file drops into the personal tree,
 * tracked in the tenant upload queue that outlives this view.
 */
export function useMyDocumentsUploads({
  creating,
  expandFolder,
  items,
  onChanged,
  setCreating,
  setError,
  tenantId,
}: MyDocumentsUploadsInput) {
  const { client } = useTeamHubRuntime();
  const navigate = useNavigate();
  const [revealDocumentId, setRevealDocumentId] = useState<string | null>(null);
  const [externalDrop, setExternalDrop] = useState<ExternalDocumentDrop | null>(
    null,
  );
  const {
    active: uploadsActive,
    error: uploadError,
    uploads: pendingUploads,
  } = useTenantUploads(tenantId);
  // Retried rows are queued by id so one row and the queue summary can ask at
  // the same time without racing two uploads into the same folder.
  const retryQueueRef = useRef(new Set<string>());
  const retryRunningRef = useRef(false);
  // An upload outlives this view; it must not navigate a reader who moved on.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function importDocument(file: File, parentId?: string) {
    await importDocuments(fileUploadBatch([file]), parentId, true);
  }

  async function importDroppedDocuments(
    batch: Promise<UploadBatch>,
    parentId?: string,
  ) {
    setExternalDrop(null);
    await importDocuments(await batch, parentId, false);
  }

  async function importDocuments(
    batch: UploadBatch,
    parentId: string | undefined,
    openUploadedDocument: boolean,
  ) {
    setExternalDrop(null);
    if (creating) return;
    if (uploadsActive) {
      tenantUploads.setError(
        tenantId,
        "Wait for the current upload to finish before adding more files.",
      );
      return;
    }
    setError(null);
    tenantUploads.setError(tenantId, null);
    const folderPaths = [
      ...batch.folderPaths,
      ...batch.sources.map((source) => source.folderPath),
    ];
    if (batch.sources.length === 0 && batch.folderPaths.length === 0) {
      tenantUploads.setError(
        tenantId,
        batch.readFailures.length > 0
          ? uploadFailureMessage(batch.readFailures)
          : "No supported files were found in the drop.",
      );
      return;
    }
    setCreating("import");
    tenantUploads.setActive(tenantId, true);
    expandFolder(parentId);
    const { preparedFiles, uploads } = prepareUploads(batch, items, parentId);
    tenantUploads.add(
      tenantId,
      uploads.map((upload) => ({
        ...upload,
        onDismiss: () => dismissUpload(upload.id),
        onRetry: () => retryUploads([upload.id]),
      })),
    );
    await nextPaint();
    let uploadedDocumentId: string | undefined;
    const failures: UploadFailure[] = [...batch.readFailures];
    // The rows that stay in the queue: a failed file keeps its bytes so it can
    // be sent again instead of vanishing into a dismissible message.
    const failedUploadIds = new Set<string>();
    try {
      const folderIds = await createUploadFolders(
        { client, items, onChanged, tenantId },
        folderPaths,
        parentId,
        failures,
      );
      await runSequentially(
        preparedFiles,
        async ({ file, folderPath }, index) => {
          const upload = uploads[index]!;
          tenantUploads.patch(tenantId, upload.id, { status: "uploading" });
          try {
            const key = folderKey(folderPath);
            if (!folderIds.has(key)) {
              throw new Error("Its folder could not be created.");
            }
            const targetId = folderIds.get(key);
            const document = await client.uploadPersonalWikiDocument(
              tenantId,
              {
                file,
                ...(targetId ? { parentId: targetId } : {}),
                representationFormat: documentUploadRepresentationFormat(file),
              },
              createTeamHubIdempotencyKey(),
              {
                onProgress: (progress) =>
                  tenantUploads.patch(tenantId, upload.id, { progress }),
              },
            );
            uploadedDocumentId = document.id;
            rememberUploadedImage(client, document, file);
            setRevealDocumentId(document.id);
            await onChanged();
          } catch (uploadError) {
            failedUploadIds.add(upload.id);
            tenantUploads.patch(tenantId, upload.id, {
              error:
                uploadError instanceof Error
                  ? uploadError.message
                  : "The document could not be imported.",
              status: "failed",
            });
          } finally {
            if (!failedUploadIds.has(upload.id)) {
              tenantUploads.remove(tenantId, new Set([upload.id]));
            }
          }
        },
      );
      if (failures.length > 0) {
        tenantUploads.setError(tenantId, uploadFailureMessage(failures));
      } else if (
        openUploadedDocument &&
        uploadedDocumentId &&
        mountedRef.current
      ) {
        void navigate(
          `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(uploadedDocumentId)}`,
        );
      }
    } catch (importError) {
      tenantUploads.setError(
        tenantId,
        importError instanceof Error
          ? importError.message
          : "The document could not be imported.",
      );
    } finally {
      tenantUploads.remove(
        tenantId,
        new Set(
          uploads
            .map((upload) => upload.id)
            .filter((id) => !failedUploadIds.has(id)),
        ),
      );
      tenantUploads.setActive(tenantId, false);
      setCreating(null);
      setExternalDrop(null);
    }
  }

  function dismissUpload(uploadId: string) {
    tenantUploads.remove(tenantId, new Set([uploadId]));
  }

  function dismissFailedUploads() {
    const failed = failedUploadRows(tenantId).map((upload) => upload.id);
    if (failed.length > 0) tenantUploads.remove(tenantId, new Set(failed));
  }

  function retryUpload(uploadId: string) {
    retryUploads([uploadId]);
  }

  function retryFailedUploads() {
    retryUploads(failedUploadRows(tenantId).map((upload) => upload.id));
  }

  function retryUploads(uploadIds: readonly string[]) {
    if (uploadIds.length === 0) return;
    for (const uploadId of uploadIds) retryQueueRef.current.add(uploadId);
    void drainRetryQueue();
  }

  /**
   * Sends each failed row again into the folder the batch was dropped on. A
   * row leaves the queue only once its retry succeeds or the reader dismisses
   * it, so a failure never loses the file the reader picked.
   */
  async function drainRetryQueue(): Promise<void> {
    if (retryRunningRef.current) return;
    retryRunningRef.current = true;
    setCreating("import");
    tenantUploads.setActive(tenantId, true);
    tenantUploads.setError(tenantId, null);
    try {
      await retryQueuedUploads();
    } finally {
      retryRunningRef.current = false;
      tenantUploads.setActive(tenantId, false);
      setCreating(null);
    }
  }

  async function retryQueuedUploads(): Promise<void> {
    if (retryQueueRef.current.size === 0) return;
    const uploadIds = [...retryQueueRef.current];
    retryQueueRef.current.clear();
    await runSequentially(uploadIds, async (uploadId) => {
      const upload = tenantUploads
        .get(tenantId)
        .uploads.find((candidate) => candidate.id === uploadId);
      if (!upload?.file || upload.status !== "failed") return;
      tenantUploads.patch(tenantId, upload.id, {
        error: undefined,
        progress: 0,
        status: "uploading",
      });
      try {
        const document = await client.uploadPersonalWikiDocument(
          tenantId,
          {
            file: upload.file,
            ...(upload.parentId ? { parentId: upload.parentId } : {}),
            representationFormat: documentUploadRepresentationFormat(
              upload.file,
            ),
          },
          createTeamHubIdempotencyKey(),
          {
            onProgress: (progress) =>
              tenantUploads.patch(tenantId, upload.id, { progress }),
          },
        );
        rememberUploadedImage(client, document, upload.file);
        setRevealDocumentId(document.id);
        await onChanged();
        tenantUploads.remove(tenantId, new Set([upload.id]));
      } catch (retryError) {
        tenantUploads.patch(tenantId, upload.id, {
          error:
            retryError instanceof Error
              ? retryError.message
              : "The document could not be imported.",
          status: "failed",
        });
      }
    });
    // A row retried while this pass ran joins the next one.
    await retryQueuedUploads();
  }

  useLayoutEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setExternalDrop(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  return {
    dismissFailedUploads,
    dismissUpload,
    externalDrop,
    importDocument,
    importDocuments,
    importDroppedDocuments,
    pendingUploads,
    retryFailedUploads,
    retryUpload,
    revealDocumentId,
    setExternalDrop,
    uploadError,
    uploadsActive,
  };
}

/** The queued rows whose last attempt failed, in queue order. */
function failedUploadRows(tenantId: string): PendingDocumentUpload[] {
  return tenantUploads
    .get(tenantId)
    .uploads.filter((upload) => upload.status === "failed");
}

/**
 * Gives each file a name that is free in its target folder and builds the
 * queued rows shown while the batch uploads.
 */
function prepareUploads(
  batch: UploadBatch,
  items: TeamHubDocumentPlacementNode[],
  parentId: string | undefined,
) {
  const usedNamesByFolder = new Map<string, Set<string>>([
    [folderKey([]), usedDocumentFilenames(items, parentId)],
  ]);
  const preparedFiles = batch.sources.map(({ file, folderPath }) => {
    const key = folderKey(folderPath);
    const usedNames = usedNamesByFolder.get(key) ?? new Set<string>();
    usedNamesByFolder.set(key, usedNames);
    const filename = nextAvailableUploadFilename(file.name, usedNames);
    usedNames.add(filename.toLocaleLowerCase());
    return {
      file:
        filename === file.name
          ? file
          : new File([file], filename, {
              lastModified: file.lastModified,
              type: file.type,
            }),
      folderPath,
    };
  });
  // Plain-http origins have no crypto.randomUUID; the import must still work
  // there, so fall back to a locally unique id.
  const uploads = preparedFiles.map(({ file, folderPath }, index) => ({
    file,
    filename: [...folderPath, file.name].join("/"),
    id:
      globalThis.crypto?.randomUUID?.() ??
      `upload-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    parentId,
    progress: 0,
    status: "queued" as const,
  }));
  return { preparedFiles, uploads };
}

/**
 * Recreates dropped folder structure under the drop target, parents first.
 * A top-level folder whose name is taken gets a numbered suffix instead of
 * merging into the existing folder. A folder that cannot be created is
 * recorded as a failure; its files then fail without stopping the others.
 */
async function createUploadFolders(
  { client, items, onChanged, tenantId }: UploadFolderContext,
  folderPaths: readonly (readonly string[])[],
  parentId: string | undefined,
  failures: UploadFailure[],
) {
  const folderIds = new Map<string, string | undefined>([
    [folderKey([]), parentId],
  ]);
  const paths = new Map<string, readonly string[]>();
  for (const folderPath of folderPaths) {
    for (let depth = 1; depth <= folderPath.length; depth += 1) {
      const path = folderPath.slice(0, depth);
      if (!paths.has(folderKey(path))) paths.set(folderKey(path), path);
    }
  }
  if (paths.size === 0) return folderIds;
  const takenRootNames = new Set(
    items
      .filter(
        (item) => item.node_kind === "folder" && item.parent_id === parentId,
      )
      .map((item) => (item as DocumentTreeFolder).name.toLocaleLowerCase()),
  );
  const ordered = [...paths.values()].sort((a, b) => a.length - b.length);
  await runSequentially(ordered, async (path) => {
    const parentKey = folderKey(path.slice(0, -1));
    if (!folderIds.has(parentKey)) return;
    const name =
      path.length === 1
        ? nextAvailableFolderName(path[0]!, takenRootNames)
        : path.at(-1)!;
    if (path.length === 1) takenRootNames.add(name.toLocaleLowerCase());
    const folderParentId = folderIds.get(parentKey);
    try {
      const folder = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/me/document-folders", {
          params: { path: { tenantId } },
          body: {
            name,
            ...(folderParentId ? { parent_id: folderParentId } : {}),
          },
        }),
      );
      folderIds.set(folderKey(path), folder.id);
    } catch (createError) {
      failures.push({
        filename: `${path.join("/")}/`,
        message:
          createError instanceof Error
            ? createError.message
            : "The folder could not be created.",
      });
    }
  });
  await onChanged();
  return folderIds;
}
