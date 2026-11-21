import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_ROLES,
  MANAGER_ROLES,
  canInviteWorkspaceRole,
  canRemoveWorkspaceMember
} from "./workspace-permissions.js";

test("workspace management roles and administrator roles are distinct", () => {
  assert.deepEqual(MANAGER_ROLES, ["OWNER", "ADMIN", "MANAGER"]);
  assert.deepEqual(ADMIN_ROLES, ["OWNER", "ADMIN"]);
});

test("owner can invite every supported role", () => {
  for (const role of ["ADMIN", "MANAGER", "VIEWER"] as const) {
    assert.equal(canInviteWorkspaceRole("OWNER", role), true);
  }
});

test("admin can invite managers and viewers but cannot appoint another admin", () => {
  assert.equal(canInviteWorkspaceRole("ADMIN", "MANAGER"), true);
  assert.equal(canInviteWorkspaceRole("ADMIN", "VIEWER"), true);
  assert.equal(canInviteWorkspaceRole("ADMIN", "ADMIN"), false);
});

test("manager and viewer cannot invite workspace members", () => {
  assert.equal(canInviteWorkspaceRole("MANAGER", "VIEWER"), false);
  assert.equal(canInviteWorkspaceRole("VIEWER", "VIEWER"), false);
});

test("owner can remove any non-owner member except themself", () => {
  assert.equal(canRemoveWorkspaceMember("OWNER", "ADMIN", false), true);
  assert.equal(canRemoveWorkspaceMember("OWNER", "MANAGER", false), true);
  assert.equal(canRemoveWorkspaceMember("OWNER", "VIEWER", false), true);
  assert.equal(canRemoveWorkspaceMember("OWNER", "OWNER", false), false);
  assert.equal(canRemoveWorkspaceMember("OWNER", "MANAGER", true), false);
});

test("admin cannot remove owner, self, or another admin", () => {
  assert.equal(canRemoveWorkspaceMember("ADMIN", "OWNER", false), false);
  assert.equal(canRemoveWorkspaceMember("ADMIN", "ADMIN", false), false);
  assert.equal(canRemoveWorkspaceMember("ADMIN", "MANAGER", true), false);
  assert.equal(canRemoveWorkspaceMember("ADMIN", "MANAGER", false), true);
});

test("manager and viewer cannot remove workspace members", () => {
  assert.equal(canRemoveWorkspaceMember("MANAGER", "VIEWER", false), false);
  assert.equal(canRemoveWorkspaceMember("VIEWER", "MANAGER", false), false);
});
