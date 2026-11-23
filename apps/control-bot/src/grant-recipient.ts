import type { UsersShared } from "grammy/types";

export function selectedGrantRecipient(
  pending: { requestId: number; expiresAt: number; selectedUserId?: number },
  shared: UsersShared
) {
  if (pending.expiresAt <= Date.now() || pending.selectedUserId !== undefined ||
      pending.requestId !== shared.request_id || shared.users.length !== 1) return;
  const user = shared.users[0];
  if (user && Number.isSafeInteger(user.user_id) && user.user_id > 0) return user;
}
