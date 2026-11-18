package agentruntimestate

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// maxLocalModelsSnapshotBytes bounds one stored snapshot. The contract caps a
// snapshot at 256 models and 65 pools, which stays far below it.
const maxLocalModelsSnapshotBytes = 4 << 20

// RecordLocalModelsInput is the latest model library a Computer reported.
// Snapshot is the JSON object the Agent Service forwarded and Host its host
// object, empty when the snapshot carries none.
type RecordLocalModelsInput struct {
	ComputerID string
	Snapshot   json.RawMessage
	Host       json.RawMessage
	ObservedAt time.Time
}

// LocalModelUser is an active Agent on runtime pi placed on the Computer.
type LocalModelUser struct {
	AgentID      string
	Name         string
	RuntimeModel string
}

// LocalModelsRecord is what TeamHub keeps about a Computer's model library:
// the Computer row, its latest snapshot and summary (nil when it never sent
// one), the last host a snapshot carried, and the Agents on runtime pi the
// viewer may see.
type LocalModelsRecord struct {
	ComputerID       string
	DisplayName      string
	Owner            LocalComputerOwner
	OwnerDisplayName string
	Status           string
	LastSeenAt       *time.Time
	ConnectedAt      *time.Time
	Platform         string
	DaemonVersion    string
	Snapshot         json.RawMessage
	Host             json.RawMessage
	Summary          *LocalModelsSummary
	Users            []LocalModelUser
}

// LocalModelsComputer is one row of the local-models Computer list: the
// Computer, its owner, and the summary of its latest snapshot.
type LocalModelsComputer struct {
	ComputerID       string
	DisplayName      string
	OwnerActorID     string
	OwnerDisplayName string
	Status           string
	LastSeenAt       *time.Time
	ConnectedAt      *time.Time
	Platform         string
	DaemonVersion    string
	Summary          *LocalModelsSummary
	ObservedAt       *time.Time
}

// RecordLocalModels replaces a Computer's stored model library and tells the
// owner's Tenant to refetch it. Ordering is the Agent Service's job: it
// forwards one Computer's snapshots one at a time, newest last.
func (s *Service) RecordLocalModels(ctx context.Context, input RecordLocalModelsInput) error {
	if !validComputerID(input.ComputerID) || input.ObservedAt.IsZero() ||
		!jsonObject(input.Snapshot) || (len(input.Host) > 0 && !jsonObject(input.Host)) {
		return ErrInvalid
	}
	_, err := executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (struct{}, *LocalComputerOwner, error) {
		computer, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && computer.Status == "removed") {
			return struct{}{}, nil, ErrNotFound
		}
		if err != nil {
			return struct{}{}, nil, err
		}
		if err := queries.UpsertLocalComputerModelSnapshot(ctx, store.UpsertLocalComputerModelSnapshotParams{
			ComputerID: input.ComputerID, Snapshot: input.Snapshot, Host: input.Host, ObservedAt: timestamptz(input.ObservedAt),
		}); err != nil {
			return struct{}{}, nil, err
		}
		return struct{}{}, nil, realtime.Invalidate(ctx, queries, realtime.Invalidation{
			TenantID: computer.OwnerTenantID, Resource: realtime.InvalidateLocalModels, ID: input.ComputerID,
		})
	})
	return err
}

// LocalModels reads a Computer's stored model library for a member of the
// Computer's Tenant. A Computer of another Tenant, or a removed one, is
// ErrNotFound.
func (s *Service) LocalModels(ctx context.Context, tenantID, viewerActorID, computerID string) (LocalModelsRecord, error) {
	if s == nil || s.pool == nil || !validComputerID(computerID) || tenantID == "" || viewerActorID == "" {
		return LocalModelsRecord{}, ErrInvalid
	}
	queries := store.New(s.pool)
	computer, err := queries.GetAgentRuntimeLocalComputer(ctx, computerID)
	if isNoRows(err) || (err == nil && (computer.Status == "removed" || computer.OwnerTenantID != tenantID)) {
		return LocalModelsRecord{}, ErrNotFound
	}
	if err != nil {
		return LocalModelsRecord{}, err
	}
	ownerName, err := queries.GetLocalComputerOwnerName(ctx, store.GetLocalComputerOwnerNameParams{
		ActorID: computer.OwnerActorID, TenantID: computer.OwnerTenantID,
	})
	if err != nil {
		return LocalModelsRecord{}, err
	}
	record := LocalModelsRecord{
		ComputerID: computer.ComputerID, DisplayName: computer.DisplayName, Status: computer.Status,
		Owner:            LocalComputerOwner{TenantID: computer.OwnerTenantID, OwnerActorID: computer.OwnerActorID},
		OwnerDisplayName: ownerName, LastSeenAt: optionalTime(computer.LastSeenAt), ConnectedAt: optionalTime(computer.ConnectedAt),
		Platform: computer.Platform.String, DaemonVersion: computer.DaemonVersion.String,
	}
	snapshot, err := queries.GetLocalComputerModelSnapshot(ctx, computerID)
	if err != nil && !isNoRows(err) {
		return LocalModelsRecord{}, err
	}
	if err == nil {
		record.Snapshot, record.Host = snapshot.Snapshot, snapshot.Host
		if record.Summary, err = ParseLocalModelsSummary(snapshot.Summary); err != nil {
			return LocalModelsRecord{}, err
		}
	}
	users, err := queries.ListLocalModelUsersOnComputer(ctx, store.ListLocalModelUsersOnComputerParams{
		TenantID: tenantID, ComputerID: computerID, ViewerActorID: viewerActorID,
	})
	if err != nil {
		return LocalModelsRecord{}, err
	}
	record.Users = make([]LocalModelUser, len(users))
	for index, user := range users {
		record.Users[index] = LocalModelUser{AgentID: user.AgentID, Name: user.DisplayName, RuntimeModel: user.RuntimeModel}
	}
	return record, nil
}

// LocalModelsComputers lists the owner's Computers in the Tenant with their
// stored summaries in one query; it never reads a snapshot.
func (s *Service) LocalModelsComputers(ctx context.Context, tenantID, ownerActorID string) ([]LocalModelsComputer, error) {
	if s == nil || s.pool == nil || tenantID == "" || ownerActorID == "" {
		return nil, ErrInvalid
	}
	rows, err := store.New(s.pool).ListLocalModelsComputers(ctx, store.ListLocalModelsComputersParams{
		TenantID: tenantID, OwnerActorID: ownerActorID,
	})
	if err != nil {
		return nil, err
	}
	computers := make([]LocalModelsComputer, len(rows))
	for index, row := range rows {
		summary, err := ParseLocalModelsSummary(row.Summary)
		if err != nil {
			return nil, err
		}
		computers[index] = LocalModelsComputer{
			ComputerID: row.ComputerID, DisplayName: row.DisplayName,
			OwnerActorID: row.OwnerActorID, OwnerDisplayName: row.OwnerDisplayName,
			Status: row.Status, LastSeenAt: optionalTime(row.LastSeenAt), ConnectedAt: optionalTime(row.ConnectedAt),
			Platform: row.Platform.String, DaemonVersion: row.DaemonVersion.String,
			Summary: summary, ObservedAt: optionalTime(row.ObservedAt),
		}
	}
	return computers, nil
}

func optionalTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	at := value.Time.UTC()
	return &at
}

func jsonObject(value json.RawMessage) bool {
	return len(value) > 0 && len(value) <= maxLocalModelsSnapshotBytes && value[0] == '{' && json.Valid(value)
}
