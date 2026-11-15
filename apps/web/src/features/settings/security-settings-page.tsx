import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { ApiKeysSettings } from "./api-keys-settings";
import { ChangePasswordDialog } from "./change-password-dialog";
import { SettingsPageHeading } from "./settings-page-heading";

export function SecuritySettingsPage() {
  const { client } = useTeamHubRuntime();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading
        description="Manage your sign-in password."
        title="Security"
      />

      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-foreground">Password</p>
            <p className="text-sm text-muted-foreground">
              Update the password used to sign in.
            </p>
          </div>
          <Button
            onClick={() => {
              setPasswordChanged(false);
              setChangePasswordOpen(true);
            }}
          >
            Change password
          </Button>
        </div>
        {passwordChanged ? (
          <div className="mt-4">
            <FormFeedback tone="success">Password changed</FormFeedback>
          </div>
        ) : null}
      </section>

      <ApiKeysSettings />

      {changePasswordOpen ? (
        <ChangePasswordDialog
          changePassword={({ currentPassword, newPassword }) =>
            teamHubDone(
              client.api.POST("/v0/account/password", {
                body: {
                  current_password: currentPassword,
                  new_password: newPassword,
                },
              }),
            )
          }
          onChanged={() => setPasswordChanged(true)}
          onClose={() => setChangePasswordOpen(false)}
        />
      ) : null}
    </div>
  );
}
