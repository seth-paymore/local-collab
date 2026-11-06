# Signed Windows desktop builds

Windows App Control can block unsigned local builds. A successful application
test does not verify publisher trust. Use a publicly trusted code-signing
certificate and verify the resulting package on the target computer.

The manual **Signed Windows desktop** workflow builds a reviewed full commit,
runs the Node tests, signs every packaged EXE and DLL through Azure Artifact
Signing, and verifies each signature, exact publisher and timestamp before
uploading a seven-day build artifact. It does not publish a release, change the
application version, install the app or update Windows security policy.

## Administrator setup

Create the GitHub environment `desktop-signing` with required reviewers and
restrict its permitted deployment branches to the reviewed release branch.
The reviewer must inspect the exact requested commit before approving a run.
Use a signing identity with only Certificate Profile Signer access to the
intended certificate profile. Do not reuse an identity with broader deployment
or administration permissions.

Configure its federated credential with issuer
`https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and subject
`repo:OWNER/REPOSITORY:environment:desktop-signing`. Adding a repository to this
trust is an access grant that the signing administrator must approve.

Set these environment variables in GitHub, using the existing signing service's
values. These are build configuration, not application runtime settings:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Approved signing application's client ID |
| `AZURE_TENANT_ID` | Its directory ID |
| `AZURE_SUBSCRIPTION_ID` | Signing subscription ID |
| `SIGNING_ENDPOINT` | Regional HTTPS Artifact Signing endpoint |
| `SIGNING_ACCOUNT` | Signing account name |
| `SIGNING_PROFILE` | Public Trust certificate profile name |
| `SIGNING_PUBLISHER` | Exact expected certificate Subject distinguished name |

No certificate private key, client secret or password is stored in the
repository. The signing account, identity and existing applications retain
their current configuration.

## Verification and installation

Dispatch the workflow for the reviewed 40-character source commit after its
workflow is available on the default branch. Download its artifact and verify
the recorded commit, file hashes, Authenticode status, publisher and timestamp.
Retain the entire packaged directory when updating an installation. Preserve
its external configuration binding, shortcuts and note storage.

Launch through the normal desktop shortcut and check that Windows accepts the
package, its existing notes load, Settings opens and the background service
remains available after closing the window. A build artifact alone does not
establish those target-computer checks.

References: [Microsoft signing guidance](https://learn.microsoft.com/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control),
[Artifact Signing integrations](https://learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations),
[official GitHub action](https://github.com/Azure/artifact-signing-action).
