# Manual access and channel onboarding — staged acceptance

## Implemented in integration branch

- Manual/trial grant text input accepts a numeric Telegram ID or an @username of an existing `ProjectCustomer` in the same project. Username lookup is case-insensitive and rejects zero or multiple matches. Telegram cannot resolve an arbitrary username to a user ID; never infer an identity from display name.
- Channel list provides a Telegram `startchannel` deep link for the active project bot, requesting `invite_users` and `restrict_members` rights. Telegram owns the chooser and final admin consent. Existing `my_chat_member` webhook is still the authoritative source of channel activation.

## Required acceptance before deployment

1. Existing customer opens project bot and sends a message; owner grants access by @username, checks the recipient's Telegram numeric ID and confirms invite delivery. Repeat with different letter casing.
2. Unknown @username must fail without creating a subscription. Renamed and duplicate usernames must not silently grant access to the wrong person. For new users, use a future claim-link flow; it is not implemented yet.
3. Channel owner presses the new channel button, selects a test channel, grants the requested rights and verifies `my_chat_member` is received and the channel becomes active. Test denial and partial rights.
4. Immediate admin revocation of a joined member remains in moderation review pending an explicitly approved and tested removal policy. The current code deliberately does not call `banChatMember` for ordinary members; CI success does not mean access was removed.
5. Do not enable production automatic kicks without an approved moderation race policy and real Telegram tests covering moderator ban, revoke/rejoin, lost API responses and retries. Never automatically unban a moderator-excluded user.

## Deployment boundary

These changes are in `audit-018/integration`, not `main`. Check the latest CI run and test the actual Codespaces deployment branch before claiming any feature is live.
