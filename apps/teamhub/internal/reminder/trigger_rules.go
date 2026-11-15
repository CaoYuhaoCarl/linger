package reminder

import (
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

// proactiveSkillID is the built-in Skill whose trigger.md every review, event
// and tracking Routine wake carries.
const proactiveSkillID = "simplexai_proactive_response"

var triggerRules = loadTriggerRules()

func loadTriggerRules() string {
	content, err := skill.BuiltinBootstrapFile(proactiveSkillID, "trigger.md")
	if err != nil {
		panic("load the proactive trigger rules: " + err.Error())
	}
	return "<trigger-rules>\n" + strings.TrimSpace(string(content)) + "\n</trigger-rules>"
}

// TriggerRules is what a woken AnotherMe checks, looks up and says when a
// proactive wake may tell the Human: the proactive-response Skill's
// trigger.md, carried in the wake so the Agent need not read the Skill.
func TriggerRules() string { return triggerRules }
