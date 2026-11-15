package reminder

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestTriggerRulesCarryTheSkillTriggerFile(t *testing.T) {
	rules := TriggerRules()
	if !strings.HasPrefix(rules, "<trigger-rules>\n# Trigger rules") || !strings.HasSuffix(rules, "</trigger-rules>") {
		t.Fatalf("trigger rules=%q", rules[:min(len(rules), 80)])
	}
	// Every wake that may tell carries them in full, so they stay short.
	if lines := strings.Count(rules, "\n"); lines > 60 {
		t.Fatalf("trigger rules have %d lines", lines)
	}
}

func TestTrackingRoutineWakePutsTheRulesBeforeItsOwnNote(t *testing.T) {
	record := store.RoomReminder{
		Instruction:     "Remind the Human about the review.",
		TrackingItemID:  pgtype.Text{String: "ti_review", Valid: true},
		TrackingPurpose: pgtype.Text{String: "pre-meeting reminder", Valid: true},
	}
	body := trackingNote(record) + record.Instruction
	item, rules, note := strings.Index(body, "ti_review"), strings.Index(body, "</trigger-rules>"), strings.Index(body, record.Instruction)
	if item < 0 || rules < item || note < rules {
		t.Fatalf("wake order item=%d rules=%d note=%d", item, rules, note)
	}
	if trackingNote(store.RoomReminder{Instruction: "Water the plants."}) != "" {
		t.Fatal("a plain Routine carried the trigger rules")
	}
}
