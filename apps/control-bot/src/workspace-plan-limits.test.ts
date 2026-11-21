import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateWorkspaceLimit,
  evaluateWorkspacePlanLimit,
  evaluateWorkspaceQuotaSnapshot,
  parseWorkspacePlanFeatureConfig,
  type WorkspacePlanFeatureConfig
} from "./workspace-plan-limits.js";

const validConfig: WorkspacePlanFeatureConfig = {
  schemaVersion: 1,
  limits: {
    projects: 3,
    members: 1,
    plansPerProject: 5,
    connectedChatsPerProject: 2
  }
};

test("parses a complete version-one workspace plan configuration", () => {
  assert.deepEqual(parseWorkspacePlanFeatureConfig(validConfig), validConfig);
});

test("supports explicit unlimited limits", () => {
  const config = parseWorkspacePlanFeatureConfig({
    schemaVersion: 1,
    limits: {
      projects: null,
      members: 1,
      plansPerProject: null,
      connectedChatsPerProject: 2
    }
  });

  assert.equal(config.limits.projects, null);
  assert.equal(config.limits.plansPerProject, null);
});

test("rejects missing, unknown and unsupported feature configuration", () => {
  const { members: _members, ...missingMemberLimit } = validConfig.limits;
  assert.throws(
    () => parseWorkspacePlanFeatureConfig({ schemaVersion: 1, limits: missingMemberLimit }),
    /Missing workspace plan limit "members"/
  );
  assert.throws(() => parseWorkspacePlanFeatureConfig(null), /JSON object/);
  assert.throws(
    () => parseWorkspacePlanFeatureConfig({ schemaVersion: 2, limits: validConfig.limits }),
    /Unsupported/
  );
  assert.throws(
    () => parseWorkspacePlanFeatureConfig({ schemaVersion: 1 }),
    /limits object/
  );
  assert.throws(
    () => parseWorkspacePlanFeatureConfig({
      schemaVersion: 1,
      limits: { ...validConfig.limits, project: 3 }
    }),
    /Unknown workspace plan limit/
  );
  assert.throws(
    () => parseWorkspacePlanFeatureConfig({
      schemaVersion: 1,
      limits: { ...validConfig.limits, members: undefined }
    }),
    /Invalid workspace plan limit/
  );
});

test("accepts zero as an explicit disabled-resource limit", () => {
  const config = parseWorkspacePlanFeatureConfig({
    schemaVersion: 1,
    limits: { ...validConfig.limits, projects: 0 }
  });

  assert.equal(config.limits.projects, 0);
  assert.equal(evaluateWorkspacePlanLimit(config, "projects", 0).allowed, false);
});

test("rejects negative, fractional, unsafe and string-valued limits", () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    assert.throws(
      () => parseWorkspacePlanFeatureConfig({
        schemaVersion: 1,
        limits: { ...validConfig.limits, projects: invalid }
      }),
      /Invalid workspace plan limit/
    );
  }
});

test("allows a request up to the configured limit and reports remaining capacity", () => {
  assert.deepEqual(evaluateWorkspaceLimit(5, 3, 2), {
    allowed: true,
    limit: 5,
    currentUsage: 3,
    requested: 2,
    remaining: 2
  });
});

test("blocks a request that would exceed the configured limit", () => {
  assert.deepEqual(evaluateWorkspaceLimit(5, 4, 2), {
    allowed: false,
    limit: 5,
    currentUsage: 4,
    requested: 2,
    remaining: 1
  });
});

test("treats null as unlimited and reports no finite remaining capacity", () => {
  assert.deepEqual(evaluateWorkspaceLimit(null, 10_000, 1), {
    allowed: true,
    limit: null,
    currentUsage: 10_000,
    requested: 1,
    remaining: null
  });
});

test("evaluates workspace-wide and per-project quota dimensions separately", () => {
  const evaluation = evaluateWorkspaceQuotaSnapshot(
    validConfig,
    {
      projects: 2,
      members: 1,
      project: { plans: 4, connectedChats: 1 }
    },
    {
      projects: 1,
      projectPlans: 1
    }
  );

  assert.equal(evaluation.projects.allowed, true);
  assert.equal(evaluation.projects.remaining, 1);
  assert.equal(evaluation.members.allowed, false);
  assert.equal(evaluation.members.remaining, 0);
  assert.equal(evaluation.project.plansPerProject.allowed, true);
  assert.equal(evaluation.project.connectedChatsPerProject.allowed, true);
  assert.equal(evaluation.project.connectedChatsPerProject.requested, 1);
});

test("does not aggregate plans or connected chats across projects", () => {
  const firstProject = evaluateWorkspaceQuotaSnapshot(validConfig, {
    projects: 2,
    members: 2,
    project: { plans: 5, connectedChats: 2 }
  });
  const secondProject = evaluateWorkspaceQuotaSnapshot(validConfig, {
    projects: 2,
    members: 2,
    project: { plans: 1, connectedChats: 1 }
  });

  assert.equal(firstProject.project.plansPerProject.allowed, false);
  assert.equal(firstProject.project.connectedChatsPerProject.allowed, false);
  assert.equal(secondProject.project.plansPerProject.allowed, true);
  assert.equal(secondProject.project.connectedChatsPerProject.allowed, true);
});

test("rejects invalid usage and requested amounts", () => {
  assert.throws(() => evaluateWorkspaceLimit(5, -1), /Current usage/);
  assert.throws(() => evaluateWorkspaceLimit(5, 1.2), /Current usage/);
  assert.throws(() => evaluateWorkspaceLimit(5, 1, 0), /Requested amount/);
  assert.throws(() => evaluateWorkspaceLimit(5, 1, 1.5), /Requested amount/);
});

test("evaluates a resource by its key in the validated plan configuration", () => {
  const allowed = evaluateWorkspacePlanLimit(validConfig, "projects", 2);
  const blocked = evaluateWorkspacePlanLimit(validConfig, "projects", 3);

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.remaining, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
});
