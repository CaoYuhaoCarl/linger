package agentconnectedapps

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

type discordCall struct {
	slug, version string
	arguments     map[string]any
}

// discordProvider serves one Discord tool and answers TeamHub's channel
// lookup with lookup and lookupErr.
type discordProvider struct {
	fakeToolProvider
	tool      composio.Tool
	lookup    composio.ToolExecution
	lookupErr error
	calls     []discordCall
}

func (provider *discordProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	return provider.tool, nil
}

func (provider *discordProvider) ExecuteTool(_ context.Context, _, _, slug, version string, arguments map[string]any) (composio.ToolExecution, error) {
	provider.calls = append(provider.calls, discordCall{slug: slug, version: version, arguments: arguments})
	if slug == "DISCORDBOT_GET_CHANNEL" && version == discordChannelLookupVersion {
		return provider.lookup, provider.lookupErr
	}
	return composio.ToolExecution{Successful: true, Data: map[string]any{"ok": true}}, nil
}

// ran reports whether the Agent's own call reached the provider.
func (provider *discordProvider) ran() bool {
	for _, call := range provider.calls {
		if call.version == provider.tool.Version {
			return true
		}
	}
	return false
}

func executeDiscord(t *testing.T, provider *discordProvider, slug, remoteTeamID string, arguments map[string]any) (Result, error) {
	t.Helper()
	provider.tool = tool(slug, "discordbot")
	connection := externalsource.AgentToolConnection{
		ID: "connection-1", AppKey: "discordbot", ToolkitSlug: "discordbot", DisplayName: "Discord",
		UpstreamConnectionID: "ca-1", UserID: "owner", RemoteTeamID: remoteTeamID,
	}
	return (&Service{provider: provider}).execute(t.Context(), ExecuteInput{
		ConnectionID: connection.ID, ToolSlug: slug, ToolVersion: provider.tool.Version, Arguments: arguments,
	}, func(context.Context) (externalsource.AgentToolConnection, error) { return connection, nil })
}

func channelIn(guildID string) composio.ToolExecution {
	return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "c1", "guild_id": guildID}}
}

func TestDiscordReadsOfEveryKindAreScoped(t *testing.T) {
	for slug := range readTools {
		if strings.HasPrefix(slug, "DISCORDBOT_") && discordReadScopes[slug] == 0 {
			t.Errorf("%s runs at once without a guild scope check", slug)
		}
	}
	for slug := range discordReadScopes {
		if !readTools[slug] {
			t.Errorf("%s is scoped but not a read", slug)
		}
	}
}

func TestDiscordConnectedGuildReadRunsWithoutLookup(t *testing.T) {
	provider := &discordProvider{}
	result, err := executeDiscord(t, provider, "DISCORDBOT_GET_CONNECTED_GUILD", "g1", map[string]any{})
	if err != nil || result.Confirmation != nil || len(provider.calls) != 1 || !provider.ran() {
		t.Fatalf("result=%+v err=%v calls=%+v", result, err, provider.calls)
	}
}

func TestDiscordGuildReadRunsOnlyInTheConnectedGuild(t *testing.T) {
	provider := &discordProvider{}
	result, err := executeDiscord(t, provider, "DISCORDBOT_LIST_GUILD_CHANNELS", "g1", map[string]any{"guild_id": "g1"})
	if err != nil || result.Confirmation != nil || len(provider.calls) != 1 || !provider.ran() {
		t.Fatalf("matching guild: result=%+v err=%v calls=%+v", result, err, provider.calls)
	}
	for name, test := range map[string]struct {
		remote    string
		arguments map[string]any
	}{
		"another guild":     {"g1", map[string]any{"guild_id": "g2"}},
		"non-string guild":  {"g1", map[string]any{"guild_id": 1}},
		"missing guild":     {"g1", map[string]any{}},
		"no verified guild": {"", map[string]any{"guild_id": ""}},
	} {
		provider := &discordProvider{}
		result, err := executeDiscord(t, provider, "DISCORDBOT_GET_GUILD", test.remote, test.arguments)
		if err != nil || result.Confirmation == nil || len(provider.calls) != 0 {
			t.Fatalf("%s: result=%+v err=%v calls=%+v", name, result, err, provider.calls)
		}
	}
}

func TestDiscordChannelReadLooksUpTheChannelsGuild(t *testing.T) {
	provider := &discordProvider{lookup: composio.ToolExecution{Successful: true, Data: map[string]any{
		"successful": true, "data": map[string]any{"guild_id": "g1"},
	}}}
	result, err := executeDiscord(t, provider, "DISCORDBOT_LIST_MESSAGES", "g1", map[string]any{"channel_id": "c1", "limit": 5})
	if err != nil || result.Confirmation != nil || !provider.ran() || len(provider.calls) != 2 {
		t.Fatalf("result=%+v err=%v calls=%+v", result, err, provider.calls)
	}
	lookup := provider.calls[0]
	if lookup.slug != "DISCORDBOT_GET_CHANNEL" || lookup.version != discordChannelLookupVersion ||
		!reflect.DeepEqual(lookup.arguments, map[string]any{"channel_id": "c1"}) {
		t.Fatalf("lookup=%+v", lookup)
	}
}

func TestDiscordChannelReadOutsideTheGuildIsHeld(t *testing.T) {
	for name, provider := range map[string]*discordProvider{
		"another guild":   {lookup: channelIn("g2")},
		"no guild":        {lookup: composio.ToolExecution{Successful: true, Data: map[string]any{"id": "c1"}}},
		"unsuccessful":    {lookup: composio.ToolExecution{Successful: false}},
		"forbidden":       {lookupErr: composio.RemoteStatusError("execute tool", http.StatusForbidden)},
		"not found":       {lookupErr: composio.RemoteStatusError("execute tool", http.StatusNotFound)},
		"bad argument":    {lookup: channelIn("g1")},
		"no remote guild": {lookup: channelIn("")},
	} {
		arguments, remote := map[string]any{"channel_id": "c1"}, "g1"
		switch name {
		case "bad argument":
			arguments = map[string]any{"channel_id": 7}
		case "no remote guild":
			remote = ""
		}
		result, err := executeDiscord(t, provider, "DISCORDBOT_GET_MESSAGE", remote, arguments)
		if err != nil || result.Confirmation == nil || provider.ran() {
			t.Fatalf("%s: result=%+v err=%v calls=%+v", name, result, err, provider.calls)
		}
	}
}

func TestDiscordChannelLookupFailureIsReturned(t *testing.T) {
	for name, test := range map[string]struct {
		err  error
		code string
	}{
		"server error": {composio.RemoteStatusError("execute tool", http.StatusBadGateway), "provider_unavailable"},
		"rate limited": {composio.RemoteStatusError("execute tool", http.StatusTooManyRequests), "provider_rate_limited"},
		"timeout":      {context.DeadlineExceeded, "provider_unavailable"},
	} {
		provider := &discordProvider{lookupErr: test.err}
		result, err := executeDiscord(t, provider, "DISCORDBOT_GET_CHANNEL", "g1", map[string]any{"channel_id": "c1"})
		var domain *Error
		if !errors.As(err, &domain) || domain.Code != test.code || !domain.Retryable ||
			result.Confirmation != nil || provider.ran() {
			t.Fatalf("%s: result=%+v err=%v calls=%+v", name, result, err, provider.calls)
		}
	}
}
