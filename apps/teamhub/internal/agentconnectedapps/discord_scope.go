package agentconnectedapps

import (
	"context"
	"net/http"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// discordChannelLookupVersion is the DISCORDBOT_GET_CHANNEL version TeamHub
// reads a channel's server with. It is pinned here, not taken from the
// Agent's call, so the scope check reads the response shape it was written
// against whatever version the Agent pins.
const discordChannelLookupVersion = "20261116_00"

// discordScope says what each Discord read names: nothing beyond the
// connected server, a server by guild_id, or a channel or thread by
// channel_id. The managed Discord bot is one application shared by every
// connection, so the provider alone does not keep a read inside the server
// this connection was installed in.
type discordScope int

const (
	discordConnectedGuild discordScope = iota + 1
	discordGuildArgument
	discordChannelArgument
)

var discordReadScopes = map[string]discordScope{
	"DISCORDBOT_GET_CONNECTED_GUILD":          discordConnectedGuild,
	"DISCORDBOT_GET_GUILD":                    discordGuildArgument,
	"DISCORDBOT_LIST_GUILD_CHANNELS":          discordGuildArgument,
	"DISCORDBOT_GET_ACTIVE_GUILD_THREADS":     discordGuildArgument,
	"DISCORDBOT_GET_CHANNEL":                  discordChannelArgument,
	"DISCORDBOT_LIST_PUBLIC_ARCHIVED_THREADS": discordChannelArgument,
	"DISCORDBOT_LIST_MESSAGES":                discordChannelArgument,
	"DISCORDBOT_GET_MESSAGE":                  discordChannelArgument,
	"DISCORDBOT_LIST_PINNED_MESSAGES":         discordChannelArgument,
}

// discordReadInScope reports whether a read may run at once. Every read
// outside Discord may. A Discord read may only when it provably stays in the
// connection's server (RemoteTeamID); anything TeamHub cannot prove, including
// a lookup the provider refused, is held for the sponsor like a write. A
// lookup that failed transiently returns its error, so the read neither runs
// nor waits on a card.
func (s *Service) discordReadInScope(ctx context.Context, connection externalsource.AgentToolConnection, slug string, arguments map[string]any) (bool, error) {
	scope, discord := discordReadScopes[slug]
	if !discord {
		return true, nil
	}
	switch scope {
	case discordConnectedGuild:
		return true, nil
	case discordGuildArgument:
		guildID, _ := arguments["guild_id"].(string)
		return connection.RemoteTeamID != "" && guildID == connection.RemoteTeamID, nil
	case discordChannelArgument:
		channelID, _ := arguments["channel_id"].(string)
		if channelID == "" || connection.RemoteTeamID == "" {
			return false, nil
		}
		execution, err := s.provider.ExecuteTool(ctx, connection.UpstreamConnectionID, connection.UserID,
			"DISCORDBOT_GET_CHANNEL", discordChannelLookupVersion, map[string]any{"channel_id": channelID})
		if err != nil {
			if refusedLookup(err) {
				return false, nil
			}
			return false, mapToolError(&providerOperationError{phase: "discord_channel_lookup", err: err}, "execute")
		}
		data, ok := execution.Data.(map[string]any)
		if !execution.Successful || !ok {
			return false, nil
		}
		guildID, _ := toolData(data)["guild_id"].(string)
		return guildID == connection.RemoteTeamID, nil
	default:
		return false, nil
	}
}

// refusedLookup reports a client error that retrying will not change, such
// as a channel the bot cannot see; timeouts and rate limits are transient.
func refusedLookup(err error) bool {
	status, ok := composio.ErrorStatus(err)
	return ok && status >= 400 && status < 500 &&
		status != http.StatusRequestTimeout && status != http.StatusTooManyRequests
}
