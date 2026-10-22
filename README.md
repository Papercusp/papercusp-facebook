# Facebook Personal Vault

Install this provider from the Cupboard, register the Meta client in Settings → Integrations, then connect your account. It reads the owner-authorized profile, posts and photo metadata as `social-post` records. The shared connector driver delivers them to the owner's private vault. It has no publish capability and does not cover Messenger, friends, private groups or a complete Facebook archive.

Network requests use `host.fetch`; credentials never reach the package. The host owns leases, retry/backoff, durable cursors and delivery deduplication. One sync page makes one Graph request. Scans resume page by page and compare content versions, including edits to older posts. Opaque Graph pagination cursors are retained; vendor URLs and access tokens are not. Meta does not issue a separate refresh token for this grant: the descriptor requires owner reauthorization when the access token expires. Expired grants stop syncing.

The retired app poll's `since` position is deliberately replaced with a complete initial scan. Existing vault documents remain. Connect through the installed provider to replace an old `facebook-personal-vault` credential; new credentials use `provider:facebook`.

Verification: recorded HTTP fakes, the SDK provider conformance kit, package discovery and the real connector/vault delivery ledger. **Not live-verified.** User posts/photos require Meta grants; development mode is limited to app roles and other accounts require review.
