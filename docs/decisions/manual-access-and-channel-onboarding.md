# Manual access and channel onboarding — staged acceptance

## Implemented in integration branch

- Manual/trial grant text input accepts a numeric Telegram ID or an @username of an existing `ProjectCustomer` in the same project. Username lookup is case-insensitive and rejects zero or multiple matches. Telegram cannot resolve an arbitrary username to a user ID; never infer an identity from display name.
- Channel list provides a Telegram `startchannel` deep link for the active project bot, requesting `invite_users` and `restrict_members` rights. Telegram owns the chooser and final admin consent. Existing `my_chat_member` webhook is still the authoritative source of channel activation.

## Required acceptance before deployment

1. Existing customer opens project bot and sends a message; owner grants access by @username, checks the recipient's Telegram numeric ID and confirms invite delivery. Repeat with different letter casing.
2. Unknown @username must fail without creating a subscription. Renamed and duplicate usernames must not silently grant access to the wrong person. For new users, use a future claim-link flow; it is not implemented yet.
3. Channel owner presses the new channel button, selects a test channel, grants the requested rights and verifies `my_chat_member` is received and the channel becomes active. Test denial and partial rights.
4. Immediate admin revocation of a joined channel/supergroup member now calls `banChatMember` (without automatic unban) after verifying no other active grant, then confirms `getChatMember` reports `kicked`. A successful CI run does not establish real Telegram behavior. Legacy groups and moderator/restricted statuses still require manual review.
5. Before production deployment, run real Telegram tests for moderator ban, revoke/rejoin, lost API responses and retries. A permanent ban prevents rejoining until a human explicitly unbans the account; there is no automatic unban. Telegram offers no atomic conditional ban, so concurrent moderator actions remain a race requiring operator policy and acceptance.

## Deployment boundary

These changes are in `audit-018/integration`, not `main`. Check the latest CI run and test the actual Codespaces deployment branch before claiming any feature is live.
