import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agency audit history and exports obey project roles and omit raw metadata", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    AgencyAuditError,
    buildAgencyAuditCsv,
    exportAgencyAuditHistory,
    listAgencyAuditHistory
  } = await import("./agency-audit-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const userIds: string[] = [];
  let workspaceId: string | undefined;
  let personalWorkspaceId: string | undefined;

  try {
    const makeUser = async (offset: number, firstName: string) => {
      const user = await prisma.user.create({
        data: { telegramId: telegramBase + BigInt(offset), firstName }
      });
      userIds.push(user.id);
      return user;
    };
    const owner = await makeUser(1, "Audit Owner");
    const manager = await makeUser(2, "Audit Manager");
    const viewer = await makeUser(3, "Audit Viewer");
    const outsider = await makeUser(4, "Audit Outsider");
    const unassignedViewer = await makeUser(5, "Unassigned Audit Viewer");

    const workspace = await prisma.workspace.create({
      data: {
        name: "Audit agency " + suffix,
        slug: "audit-agency-" + suffix,
        type: "AGENCY",
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: manager.id, role: "MANAGER" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: unassignedViewer.id, role: "VIEWER" }
          ]
        }
      }
    });
    workspaceId = workspace.id;

    const personalWorkspace = await prisma.workspace.create({
      data: {
        name: "Audit personal " + suffix,
        slug: "audit-personal-" + suffix,
        type: "PERSONAL",
        createdById: outsider.id,
        members: { create: { userId: outsider.id, role: "OWNER" } }
      }
    });
    personalWorkspaceId = personalWorkspace.id;

    const assignedProject = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Assigned project",
        slug: "audit-assigned-" + suffix,
        creatorUserId: manager.id
      }
    });
    const managedProject = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Managed project",
        slug: "audit-managed-" + suffix
      }
    });
    const viewerProject = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Viewer-only project",
        slug: "audit-viewer-" + suffix
      }
    });
    const unassignedProject = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Unassigned project",
        slug: "audit-unassigned-" + suffix
      }
    });
    await prisma.projectMember.createMany({
      data: [
        { projectId: managedProject.id, userId: manager.id, role: "MANAGER" },
        { projectId: managedProject.id, userId: viewer.id, role: "MANAGER" },
        { projectId: viewerProject.id, userId: viewer.id, role: "VIEWER" },
        { projectId: viewerProject.id, userId: manager.id, role: "VIEWER" }
      ]
    });

    const now = new Date();
    await prisma.auditLog.createMany({
      data: [
        {
          workspaceId: workspace.id,
          action: "WORKSPACE_MEMBER_CHANGED",
          resourceType: "WorkspaceMember",
          actorUserId: owner.id,
          metadata: { privateValue: "never expose" },
          createdAt: new Date(now.getTime() - 5_000)
        },
        {
          workspaceId: workspace.id,
          projectId: assignedProject.id,
          action: "ASSIGNED_PROJECT_CHANGED",
          resourceType: "CreatorPlan",
          actorUserId: manager.id,
          metadata: { privateValue: "never expose" },
          createdAt: new Date(now.getTime() - 4_000)
        },
        {
          workspaceId: workspace.id,
          projectId: managedProject.id,
          action: "MANAGED_PROJECT_CHANGED",
          resourceType: "ProjectBot",
          actorUserId: manager.id,
          createdAt: new Date(now.getTime() - 3_000)
        },
        {
          workspaceId: workspace.id,
          projectId: viewerProject.id,
          action: "VIEWER_PROJECT_SECRET",
          resourceType: "CreatorPlan",
          actorUserId: owner.id,
          createdAt: new Date(now.getTime() - 2_000)
        },
        {
          workspaceId: workspace.id,
          projectId: unassignedProject.id,
          action: "UNASSIGNED_PROJECT_SECRET",
          resourceType: "CreatorPlan",
          actorUserId: owner.id,
          createdAt: new Date(now.getTime() - 1_000)
        }
      ]
    });

    const managerHistory = await listAgencyAuditHistory({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      limit: 10
    });
    assert.equal(managerHistory.workspaceName, workspace.name);
    assert.deepEqual(
      managerHistory.events.map((event) => event.action).sort(),
      ["ASSIGNED_PROJECT_CHANGED", "MANAGED_PROJECT_CHANGED"]
    );
    assert.equal(managerHistory.events.some((event) => "metadata" in event), false);
    assert.equal(managerHistory.events.every((event) =>
      event.projectName === "Assigned project" || event.projectName === "Managed project"
    ), true);

    const ownerHistory = await listAgencyAuditHistory({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      limit: 10
    });
    assert.equal(ownerHistory.events.length, 5);
    assert.equal(ownerHistory.events.some((event) => event.projectName === "Workspace"), true);

    const managerExport = await exportAgencyAuditHistory({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      periodDays: 7,
      now: new Date(now.getTime() + 60_000)
    });
    assert.equal(managerExport.eventCount, 2);
    assert.equal(managerExport.truncated, false);
    assert.ok(managerExport.csv.startsWith("\uFEFF"));
    assert.ok(managerExport.csv.includes("Assigned project"));
    assert.equal(managerExport.csv.includes("VIEWER_PROJECT_SECRET"), false);
    assert.equal(managerExport.csv.includes("UNASSIGNED_PROJECT_SECRET"), false);
    assert.equal(managerExport.csv.includes("never expose"), false);

    const safeCsv = buildAgencyAuditCsv([{
      id: "csv-1",
      createdAt: now,
      projectName: "=HYPERLINK(\"https://invalid.example\")",
      action: "+CMD",
      resourceType: "CreatorPlan",
      resourceId: "@external",
      actor: "Audit Owner"
    }]);
    assert.ok(safeCsv.includes("'=HYPERLINK"));
    assert.ok(safeCsv.includes("'+CMD"));
    assert.ok(safeCsv.includes("'@external"));

    const projectManagerViewerHistory = await listAgencyAuditHistory({
      workspaceId: workspace.id,
      actorUserId: viewer.id,
      limit: 10
    });
    assert.deepEqual(projectManagerViewerHistory.events.map((event) => event.action), [
      "MANAGED_PROJECT_CHANGED"
    ]);
    await assert.rejects(
      listAgencyAuditHistory({ workspaceId: workspace.id, actorUserId: unassignedViewer.id }),
      (error: unknown) => error instanceof AgencyAuditError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      listAgencyAuditHistory({ workspaceId: personalWorkspace.id, actorUserId: outsider.id }),
      (error: unknown) => error instanceof AgencyAuditError && error.code === "NOT_AN_AGENCY"
    );
    await assert.rejects(
      listAgencyAuditHistory({ workspaceId: workspace.id, actorUserId: outsider.id }),
      (error: unknown) => error instanceof AgencyAuditError && error.code === "ACTOR_NOT_MEMBER"
    );
    await assert.rejects(
      exportAgencyAuditHistory({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        periodDays: 366
      }),
      (error: unknown) => error instanceof AgencyAuditError && error.code === "INVALID_RANGE"
    );
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (personalWorkspaceId) await prisma.workspace.deleteMany({ where: { id: personalWorkspaceId } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
