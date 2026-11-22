-- Project-level access overrides for agency workspaces.
CREATE TYPE "ProjectRole" AS ENUM ('MANAGER', 'VIEWER');

CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key"
    ON "ProjectMember"("projectId", "userId");
CREATE INDEX "ProjectMember_projectId_role_idx"
    ON "ProjectMember"("projectId", "role");
CREATE INDEX "ProjectMember_userId_role_idx"
    ON "ProjectMember"("userId", "role");

ALTER TABLE "ProjectMember"
    ADD CONSTRAINT "ProjectMember_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMember"
    ADD CONSTRAINT "ProjectMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the effective project access of existing agency teammates.
-- New agency members do not inherit workspace-wide access; they need an explicit
-- ProjectMember grant or must be the responsible creator of that project.
INSERT INTO "ProjectMember" ("id", "projectId", "userId", "role", "createdAt", "updatedAt")
SELECT
    'legacy_' || substring(md5(p."id" || ':' || wm."userId") from 1 for 24),
    p."id",
    wm."userId",
    CASE wm."role"::text
        WHEN 'MANAGER' THEN 'MANAGER'::"ProjectRole"
        ELSE 'VIEWER'::"ProjectRole"
    END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Project" p
JOIN "Workspace" w ON w."id" = p."workspaceId"
JOIN "WorkspaceMember" wm ON wm."workspaceId" = w."id"
WHERE w."type"::text = 'AGENCY'
  AND wm."role"::text IN ('MANAGER', 'VIEWER')
ON CONFLICT ("projectId", "userId") DO NOTHING;
